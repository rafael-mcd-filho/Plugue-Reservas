-- Fast, fail-closed funnel reporting over the append-only tracking event log.
--
-- This migration intentionally leaves get_tracking_funnel_counts(...) untouched
-- for rollback.  The new public contract uses a half-open server-time range and
-- has separate company/global entry points so PostgreSQL never has to plan an
-- optional tenant predicate.
--
-- Temporal contract: public callers pass inclusive calendar dates.  Boundaries
-- are resolved on the server in America/Fortaleza and all funnel stages use
-- a guarded effective timestamp: occurred_at only inside [created_at-24h,
-- created_at+5min], otherwise created_at.  A session belongs to the date of its
-- first page view; only milestones before the exclusive period end are counted. A
-- conversion after period_end is therefore not retroactively added to that
-- historical result.

CREATE OR REPLACE FUNCTION public._assert_tracking_funnel_company_access(
  _company_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id é obrigatório.' USING ERRCODE = '22023';
  END IF;

  IF auth.role() IS NOT DISTINCT FROM 'service_role' THEN
    RETURN;
  END IF;

  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autorizado.' USING ERRCODE = '42501';
  END IF;

  -- The platform dashboard exposes company drill-downs to superadmins even when
  -- the tenant feature is disabled.  Match that existing route contract.
  IF public.has_role(auth.uid(), 'superadmin'::public.app_role) THEN
    RETURN;
  END IF;

  IF NOT public.has_company_panel_permission(
    auth.uid(),
    _company_id,
    'dashboard_view'
  ) THEN
    RAISE EXCEPTION 'Sem permissão para visualizar o dashboard desta empresa.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.company_feature_enabled(_company_id, 'advanced_reports') THEN
    RAISE EXCEPTION 'Relatórios avançados não estão habilitados para esta empresa.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._assert_tracking_funnel_global_access()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Global data is deliberately stricter than company data.  service_role is
  -- not an interactive superadmin and therefore cannot use this report RPC.
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR auth.uid() IS NULL
    OR NOT public.has_role(auth.uid(), 'superadmin'::public.app_role) THEN
    RAISE EXCEPTION 'Apenas superadmins podem visualizar o funil global.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._validate_tracking_funnel_range(
  _start_at timestamptz,
  _end_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _start_at IS NULL OR _end_at IS NULL OR _end_at <= _start_at THEN
    RAISE EXCEPTION 'Intervalo de datas inválido.' USING ERRCODE = '22023';
  END IF;

  IF _end_at - _start_at > interval '366 days' THEN
    RAISE EXCEPTION 'O período não pode ultrapassar 366 dias.'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Durable client retries can arrive after the original browser timestamp.  Use
-- that timestamp only inside a narrow trust envelope; arbitrary client clocks
-- fall back to the immutable server insertion time.  Cursors always continue
-- to use created_at, never this derived value.
CREATE OR REPLACE FUNCTION public._tracking_funnel_effective_at(
  _occurred_at timestamptz,
  _created_at timestamptz
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN _occurred_at >= _created_at - interval '24 hours'
      AND _occurred_at <= _created_at + interval '5 minutes'
      THEN _occurred_at
    ELSE _created_at
  END;
$$;

-- The company implementation contains a literal equality predicate.  Keep it
-- separate from the global implementation to preserve a predictable index plan.
CREATE OR REPLACE FUNCTION public._tracking_funnel_counts_fast_company(
  _company_id uuid,
  _start_at timestamptz,
  _end_at timestamptz,
  _unique_only boolean DEFAULT false
)
RETURNS TABLE(step text, event_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH step_definitions(step, stage_number, sort_order) AS (
    VALUES
      ('page_view'::text, 1, 1),
      ('date_select'::text, 2, 2),
      ('time_select'::text, 3, 3),
      ('form_fill'::text, 4, 4),
      ('completed'::text, 5, 5)
  ),
  page_candidates AS MATERIALIZED (
    SELECT
      te.company_id,
      te.session_id,
      te.anonymous_id,
      te.created_at,
      te.id,
      public._tracking_funnel_effective_at(te.occurred_at, te.created_at) AS effective_at
    FROM public.tracking_events te
    WHERE te.company_id = _company_id
      AND te.tracking_source = 'public'
      AND te.event_name = 'page_view'
      AND te.session_id IS NOT NULL
      -- Sargable superset for the trusted effective-time envelope.
      AND te.created_at >= _start_at - interval '5 minutes'
      AND te.created_at < _end_at + interval '24 hours'
  ),
  cohort_sessions AS MATERIALIZED (
    SELECT
      pages.company_id,
      pages.session_id,
      (array_agg(
        pages.anonymous_id
        ORDER BY pages.effective_at, pages.created_at, pages.id
      ))[1] AS anonymous_id,
      min(pages.effective_at) AS cohort_at
    FROM page_candidates pages
    WHERE pages.effective_at >= _start_at
      AND pages.effective_at < _end_at
      AND NOT EXISTS (
        SELECT 1
        FROM public.tracking_events earlier_page
        WHERE earlier_page.company_id = pages.company_id
          AND earlier_page.session_id = pages.session_id
          AND earlier_page.tracking_source = 'public'
          AND earlier_page.event_name = 'page_view'
          AND earlier_page.created_at < _start_at + interval '24 hours'
          AND public._tracking_funnel_effective_at(
            earlier_page.occurred_at,
            earlier_page.created_at
          ) < _start_at
      )
    GROUP BY pages.company_id, pages.session_id
  ),
  identity_progress AS (
    SELECT
      CASE
        WHEN COALESCE(_unique_only, false)
          THEN cohort_sessions.company_id::text || ':visitor:' || cohort_sessions.anonymous_id
        ELSE cohort_sessions.company_id::text || ':session:' || cohort_sessions.session_id::text
      END AS identity_key,
      max(
        CASE
          WHEN events.event_name = 'page_view' THEN 1
          WHEN events.event_name = 'date_select' THEN 2
          WHEN events.event_name = 'time_select' THEN 3
          WHEN events.event_name IN ('form_fill', 'lead_captured') THEN 4
          WHEN events.event_name = 'reservation_created' THEN 5
          ELSE 0
        END
      )::integer AS max_stage
    FROM cohort_sessions
    JOIN public.tracking_events events
      ON events.company_id = cohort_sessions.company_id
     AND events.session_id = cohort_sessions.session_id
     AND events.tracking_source = 'public'
     AND events.created_at >= _start_at - interval '5 minutes'
     AND events.created_at < _end_at + interval '24 hours'
     AND events.event_name IN (
       'page_view',
       'date_select',
       'time_select',
       'form_fill',
       'lead_captured',
       'reservation_created'
     )
     AND public._tracking_funnel_effective_at(
       events.occurred_at,
       events.created_at
     ) >= cohort_sessions.cohort_at
     AND public._tracking_funnel_effective_at(
       events.occurred_at,
       events.created_at
     ) < _end_at
    GROUP BY identity_key
  )
  SELECT
    step_definitions.step,
    count(identity_progress.identity_key) FILTER (
      WHERE identity_progress.max_stage >= step_definitions.stage_number
    )::bigint AS event_count
  FROM step_definitions
  LEFT JOIN identity_progress ON true
  GROUP BY
    step_definitions.step,
    step_definitions.stage_number,
    step_definitions.sort_order
  ORDER BY step_definitions.sort_order;
$$;

CREATE OR REPLACE FUNCTION public._tracking_funnel_counts_fast_global(
  _start_at timestamptz,
  _end_at timestamptz,
  _unique_only boolean DEFAULT false
)
RETURNS TABLE(step text, event_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH step_definitions(step, stage_number, sort_order) AS (
    VALUES
      ('page_view'::text, 1, 1),
      ('date_select'::text, 2, 2),
      ('time_select'::text, 3, 3),
      ('form_fill'::text, 4, 4),
      ('completed'::text, 5, 5)
  ),
  page_candidates AS MATERIALIZED (
    SELECT
      te.company_id,
      te.session_id,
      te.anonymous_id,
      te.created_at,
      te.id,
      public._tracking_funnel_effective_at(te.occurred_at, te.created_at) AS effective_at
    FROM public.tracking_events te
    WHERE te.tracking_source = 'public'
      AND te.event_name = 'page_view'
      AND te.session_id IS NOT NULL
      AND te.created_at >= _start_at - interval '5 minutes'
      AND te.created_at < _end_at + interval '24 hours'
  ),
  cohort_sessions AS MATERIALIZED (
    SELECT
      pages.company_id,
      pages.session_id,
      (array_agg(
        pages.anonymous_id
        ORDER BY pages.effective_at, pages.created_at, pages.id
      ))[1] AS anonymous_id,
      min(pages.effective_at) AS cohort_at
    FROM page_candidates pages
    WHERE pages.effective_at >= _start_at
      AND pages.effective_at < _end_at
      AND NOT EXISTS (
        SELECT 1
        FROM public.tracking_events earlier_page
        WHERE earlier_page.company_id = pages.company_id
          AND earlier_page.session_id = pages.session_id
          AND earlier_page.tracking_source = 'public'
          AND earlier_page.event_name = 'page_view'
          AND earlier_page.created_at < _start_at + interval '24 hours'
          AND public._tracking_funnel_effective_at(
            earlier_page.occurred_at,
            earlier_page.created_at
          ) < _start_at
      )
    GROUP BY pages.company_id, pages.session_id
  ),
  identity_progress AS (
    SELECT
      CASE
        WHEN COALESCE(_unique_only, false)
          THEN cohort_sessions.company_id::text || ':visitor:' || cohort_sessions.anonymous_id
        ELSE cohort_sessions.company_id::text || ':session:' || cohort_sessions.session_id::text
      END AS identity_key,
      max(
        CASE
          WHEN events.event_name = 'page_view' THEN 1
          WHEN events.event_name = 'date_select' THEN 2
          WHEN events.event_name = 'time_select' THEN 3
          WHEN events.event_name IN ('form_fill', 'lead_captured') THEN 4
          WHEN events.event_name = 'reservation_created' THEN 5
          ELSE 0
        END
      )::integer AS max_stage
    FROM cohort_sessions
    JOIN public.tracking_events events
      ON events.company_id = cohort_sessions.company_id
     AND events.session_id = cohort_sessions.session_id
     AND events.tracking_source = 'public'
     AND events.created_at >= _start_at - interval '5 minutes'
     AND events.created_at < _end_at + interval '24 hours'
     AND events.event_name IN (
       'page_view',
       'date_select',
       'time_select',
       'form_fill',
       'lead_captured',
       'reservation_created'
     )
     AND public._tracking_funnel_effective_at(
       events.occurred_at,
       events.created_at
     ) >= cohort_sessions.cohort_at
     AND public._tracking_funnel_effective_at(
       events.occurred_at,
       events.created_at
     ) < _end_at
    GROUP BY identity_key
  )
  SELECT
    step_definitions.step,
    count(identity_progress.identity_key) FILTER (
      WHERE identity_progress.max_stage >= step_definitions.stage_number
    )::bigint AS event_count
  FROM step_definitions
  LEFT JOIN identity_progress ON true
  GROUP BY
    step_definitions.step,
    step_definitions.stage_number,
    step_definitions.sort_order
  ORDER BY step_definitions.sort_order;
$$;

-- Stable frontend contract.  The read-model migration replaces only the body
-- of these two functions; callers and return shape remain unchanged.
CREATE OR REPLACE FUNCTION public.get_tracking_funnel_report(
  _company_id uuid,
  _start_date date,
  _end_date date,
  _unique_only boolean DEFAULT false
)
RETURNS TABLE(step text, event_count bigint, data_source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _start_at timestamptz;
  _end_at timestamptz;
BEGIN
  PERFORM public._assert_tracking_funnel_company_access(_company_id);

  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date THEN
    RAISE EXCEPTION 'Intervalo de datas inválido.' USING ERRCODE = '22023';
  END IF;

  _start_at := _start_date::timestamp AT TIME ZONE 'America/Fortaleza';
  _end_at := (_end_date + 1)::timestamp AT TIME ZONE 'America/Fortaleza';
  PERFORM public._validate_tracking_funnel_range(_start_at, _end_at);

  RETURN QUERY
  SELECT counts.step, counts.event_count, 'fast'::text
  FROM public._tracking_funnel_counts_fast_company(
    _company_id,
    _start_at,
    _end_at,
    COALESCE(_unique_only, false)
  ) AS counts;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_global_tracking_funnel_report(
  _start_date date,
  _end_date date,
  _unique_only boolean DEFAULT false
)
RETURNS TABLE(step text, event_count bigint, data_source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _start_at timestamptz;
  _end_at timestamptz;
BEGIN
  PERFORM public._assert_tracking_funnel_global_access();

  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date THEN
    RAISE EXCEPTION 'Intervalo de datas inválido.' USING ERRCODE = '22023';
  END IF;

  _start_at := _start_date::timestamp AT TIME ZONE 'America/Fortaleza';
  _end_at := (_end_date + 1)::timestamp AT TIME ZONE 'America/Fortaleza';
  PERFORM public._validate_tracking_funnel_range(_start_at, _end_at);

  RETURN QUERY
  SELECT counts.step, counts.event_count, 'fast'::text
  FROM public._tracking_funnel_counts_fast_global(
    _start_at,
    _end_at,
    COALESCE(_unique_only, false)
  ) AS counts;
END;
$$;

COMMENT ON FUNCTION public.get_tracking_funnel_report(
  uuid, date, date, boolean
)
IS 'Funil company-scoped por datas inclusivas em America/Fortaleza; usa [start,end) e effective_at protegido por created_at.';

COMMENT ON FUNCTION public.get_global_tracking_funnel_report(
  date, date, boolean
)
IS 'Funil global exclusivo para superadmin por datas inclusivas em America/Fortaleza.';

REVOKE ALL ON FUNCTION public._assert_tracking_funnel_company_access(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._assert_tracking_funnel_global_access()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._validate_tracking_funnel_range(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tracking_funnel_effective_at(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tracking_funnel_counts_fast_company(
  uuid, timestamptz, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tracking_funnel_counts_fast_global(
  timestamptz, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_tracking_funnel_report(
  uuid, date, date, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tracking_funnel_report(
  uuid, date, date, boolean
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_global_tracking_funnel_report(
  date, date, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_global_tracking_funnel_report(
  date, date, boolean
) TO authenticated;
