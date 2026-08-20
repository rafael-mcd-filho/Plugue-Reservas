-- Asynchronous, idempotent read model for the reservation funnel.
--
-- The source of truth remains public.tracking_events.  There is deliberately no
-- trigger on tracking_events: reporting can never block event capture or the
-- existing Meta queue trigger.  Projection is advanced by the private batch
-- functions below and scheduled in a separate migration.

CREATE TABLE IF NOT EXISTS public.tracking_funnel_sessions (
  company_id uuid NOT NULL
    REFERENCES public.companies(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  -- Empty identifiers exist in the legacy log.  Preserve them exactly so the
  -- read model has the same unique-visitor semantics as the raw query.
  anonymous_id text NOT NULL,
  first_event_created_at timestamptz NOT NULL,
  first_page_view_at timestamptz,
  date_selected_at timestamptz,
  time_selected_at timestamptz,
  form_filled_at timestamptz,
  completed_at timestamptz,
  max_stage smallint NOT NULL DEFAULT 0 CHECK (max_stage BETWEEN 0 AND 5),
  reservation_id uuid,
  last_event_created_at timestamptz NOT NULL,
  projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, session_id),
  CHECK (last_event_created_at >= first_event_created_at)
);

COMMENT ON TABLE public.tracking_funnel_sessions IS
  'Read model privado por sessão. Usa occurred_at somente no envelope seguro de created_at e não participa do envio Meta.';

-- The table is empty on creation, so these indexes do not need CONCURRENTLY.
CREATE INDEX IF NOT EXISTS idx_tracking_funnel_sessions_company_cohort
  ON public.tracking_funnel_sessions(company_id, first_page_view_at, session_id)
  INCLUDE (date_selected_at, time_selected_at, form_filled_at, completed_at)
  WHERE first_page_view_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracking_funnel_sessions_global_cohort
  ON public.tracking_funnel_sessions(first_page_view_at, company_id, session_id)
  INCLUDE (date_selected_at, time_selected_at, form_filled_at, completed_at)
  WHERE first_page_view_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tracking_funnel_projection_state (
  company_id uuid PRIMARY KEY
    REFERENCES public.companies(id) ON DELETE CASCADE,
  cursor_created_at timestamptz,
  cursor_event_id uuid,
  covered_through_at timestamptz,
  is_ready boolean NOT NULL DEFAULT false,
  projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  processed_events bigint NOT NULL DEFAULT 0 CHECK (processed_events >= 0),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  consecutive_errors integer NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  reconciliation_window_start_at timestamptz,
  reconciliation_window_end_at timestamptz,
  reconciliation_cursor_session_id uuid,
  last_reconciliation_started_at timestamptz,
  last_reconciled_at timestamptz,
  next_reconciliation_attempt_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  reconciliation_errors integer NOT NULL DEFAULT 0 CHECK (reconciliation_errors >= 0),
  last_reconciliation_error text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (cursor_created_at IS NULL AND cursor_event_id IS NULL)
    OR (cursor_created_at IS NOT NULL AND cursor_event_id IS NOT NULL)
  ),
  CHECK (
    (reconciliation_window_start_at IS NULL AND reconciliation_window_end_at IS NULL)
    OR (
      reconciliation_window_start_at IS NOT NULL
      AND reconciliation_window_end_at IS NOT NULL
      AND reconciliation_window_end_at > reconciliation_window_start_at
    )
  )
);

CREATE TABLE IF NOT EXISTS public.tracking_funnel_company_rollout (
  company_id uuid PRIMARY KEY
    REFERENCES public.companies(id) ON DELETE CASCADE,
  requested_source text NOT NULL DEFAULT 'fast'
    CHECK (requested_source IN ('fast', 'read_model')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tracking_funnel_global_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  requested_source text NOT NULL DEFAULT 'fast'
    CHECK (requested_source IN ('fast', 'read_model')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tracking_funnel_global_projection_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  is_ready boolean NOT NULL DEFAULT false,
  covered_through_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.tracking_funnel_global_rollout(singleton, requested_source)
VALUES (true, 'fast')
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO public.tracking_funnel_global_projection_state(singleton, is_ready)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

-- One-time discovery for historical tenants.  Subsequent projector runs only
-- inspect the recent append window, avoiding a recurring full-log scan.
INSERT INTO public.tracking_funnel_projection_state(company_id)
SELECT DISTINCT events.company_id
FROM public.tracking_events events
WHERE events.tracking_source = 'public'
  AND events.event_name IN (
    'page_view', 'date_select', 'time_select',
    'form_fill', 'lead_captured', 'reservation_created'
  )
ON CONFLICT (company_id) DO NOTHING;

ALTER TABLE public.tracking_funnel_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracking_funnel_projection_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracking_funnel_company_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracking_funnel_global_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracking_funnel_global_projection_state ENABLE ROW LEVEL SECURITY;

-- No direct client policies: all reads go through the fail-closed report RPCs.
REVOKE ALL ON TABLE public.tracking_funnel_sessions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tracking_funnel_projection_state
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tracking_funnel_company_rollout
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tracking_funnel_global_rollout
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tracking_funnel_global_projection_state
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._tracking_funnel_stage_number(_event_name text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE _event_name
    WHEN 'page_view' THEN 1::smallint
    WHEN 'date_select' THEN 2::smallint
    WHEN 'time_select' THEN 3::smallint
    WHEN 'form_fill' THEN 4::smallint
    WHEN 'lead_captured' THEN 4::smallint
    WHEN 'reservation_created' THEN 5::smallint
    ELSE 0::smallint
  END;
$$;

-- Recompute every affected session from the raw log.  This function is the
-- repair path for deletes/corrections and is also used as the overlap pass that
-- catches transactions which commit after the cursor has moved.
CREATE OR REPLACE FUNCTION public._reconcile_tracking_funnel_company(
  _company_id uuid,
  _window_start timestamptz,
  _window_end timestamptz,
  _max_sessions integer DEFAULT 10000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _affected integer := 0;
  _deleted integer := 0;
BEGIN
  IF _company_id IS NULL
    OR _window_start IS NULL
    OR _window_end IS NULL
    OR _window_end <= _window_start THEN
    RAISE EXCEPTION 'Parâmetros de reconciliação inválidos.' USING ERRCODE = '22023';
  END IF;

  IF _max_sessions IS NULL OR _max_sessions < 1 OR _max_sessions > 50000 THEN
    RAISE EXCEPTION 'max_sessions deve estar entre 1 e 50000.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-company:' || _company_id::text, 0)
  ) THEN
    RETURN 0;
  END IF;

  -- A session whose last projected event was removed must disappear too.
  DELETE FROM public.tracking_funnel_sessions projected
  WHERE projected.company_id = _company_id
    AND (
      projected.first_event_created_at >= _window_start
        AND projected.first_event_created_at < _window_end
      OR projected.first_page_view_at >= _window_start
        AND projected.first_page_view_at < _window_end
      OR projected.date_selected_at >= _window_start
        AND projected.date_selected_at < _window_end
      OR projected.time_selected_at >= _window_start
        AND projected.time_selected_at < _window_end
      OR projected.form_filled_at >= _window_start
        AND projected.form_filled_at < _window_end
      OR projected.completed_at >= _window_start
        AND projected.completed_at < _window_end
      OR projected.last_event_created_at >= _window_start
        AND projected.last_event_created_at < _window_end
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.tracking_events raw_event
      WHERE raw_event.company_id = projected.company_id
        AND raw_event.session_id = projected.session_id
        AND raw_event.tracking_source = 'public'
        AND raw_event.event_name IN (
          'page_view', 'date_select', 'time_select',
          'form_fill', 'lead_captured', 'reservation_created'
        )
    );
  GET DIAGNOSTICS _deleted = ROW_COUNT;

  WITH affected_sessions AS MATERIALIZED (
    SELECT candidates.session_id
    FROM (
      SELECT DISTINCT events.session_id
      FROM public.tracking_events events
      WHERE events.company_id = _company_id
        AND events.tracking_source = 'public'
        AND events.session_id IS NOT NULL
        AND events.event_name IN (
          'page_view', 'date_select', 'time_select',
          'form_fill', 'lead_captured', 'reservation_created'
        )
        AND events.created_at >= _window_start
        AND events.created_at < _window_end

      UNION

      -- Projected milestone timestamps let reconciliation notice deletion of an
      -- isolated raw event: after deletion there is no raw row left to select.
      SELECT projected.session_id
      FROM public.tracking_funnel_sessions projected
      WHERE projected.company_id = _company_id
        AND (
          projected.first_event_created_at >= _window_start
            AND projected.first_event_created_at < _window_end
          OR projected.first_page_view_at >= _window_start
            AND projected.first_page_view_at < _window_end
          OR projected.date_selected_at >= _window_start
            AND projected.date_selected_at < _window_end
          OR projected.time_selected_at >= _window_start
            AND projected.time_selected_at < _window_end
          OR projected.form_filled_at >= _window_start
            AND projected.form_filled_at < _window_end
          OR projected.completed_at >= _window_start
            AND projected.completed_at < _window_end
          OR projected.last_event_created_at >= _window_start
            AND projected.last_event_created_at < _window_end
        )
    ) candidates
    ORDER BY candidates.session_id
    LIMIT _max_sessions
  ),
  rebuilt AS (
    SELECT
      events.company_id,
      events.session_id,
      (array_agg(events.anonymous_id ORDER BY events.created_at, events.id))[1] AS anonymous_id,
      min(events.created_at) AS first_event_created_at,
      min(events.created_at) FILTER (WHERE events.event_name = 'page_view') AS first_page_view_at,
      min(events.created_at) FILTER (WHERE events.event_name = 'date_select') AS date_selected_at,
      min(events.created_at) FILTER (WHERE events.event_name = 'time_select') AS time_selected_at,
      min(events.created_at) FILTER (
        WHERE events.event_name IN ('form_fill', 'lead_captured')
      ) AS form_filled_at,
      min(events.created_at) FILTER (
        WHERE events.event_name = 'reservation_created'
      ) AS completed_at,
      max(public._tracking_funnel_stage_number(events.event_name))::smallint AS max_stage,
      (array_agg(
        events.reservation_id
        ORDER BY events.created_at DESC, events.id DESC
      ) FILTER (WHERE events.reservation_id IS NOT NULL))[1] AS reservation_id,
      max(events.created_at) AS last_event_created_at
    FROM affected_sessions
    JOIN public.tracking_events events
      ON events.company_id = _company_id
     AND events.session_id = affected_sessions.session_id
     AND events.tracking_source = 'public'
     AND events.event_name IN (
       'page_view', 'date_select', 'time_select',
       'form_fill', 'lead_captured', 'reservation_created'
     )
    GROUP BY events.company_id, events.session_id
  )
  INSERT INTO public.tracking_funnel_sessions AS target (
    company_id,
    session_id,
    anonymous_id,
    first_event_created_at,
    first_page_view_at,
    date_selected_at,
    time_selected_at,
    form_filled_at,
    completed_at,
    max_stage,
    reservation_id,
    last_event_created_at,
    projection_version,
    updated_at
  )
  SELECT
    rebuilt.company_id,
    rebuilt.session_id,
    rebuilt.anonymous_id,
    rebuilt.first_event_created_at,
    rebuilt.first_page_view_at,
    rebuilt.date_selected_at,
    rebuilt.time_selected_at,
    rebuilt.form_filled_at,
    rebuilt.completed_at,
    rebuilt.max_stage,
    rebuilt.reservation_id,
    rebuilt.last_event_created_at,
    1,
    clock_timestamp()
  FROM rebuilt
  ON CONFLICT (company_id, session_id) DO UPDATE
  SET
    anonymous_id = EXCLUDED.anonymous_id,
    first_event_created_at = EXCLUDED.first_event_created_at,
    first_page_view_at = EXCLUDED.first_page_view_at,
    date_selected_at = EXCLUDED.date_selected_at,
    time_selected_at = EXCLUDED.time_selected_at,
    form_filled_at = EXCLUDED.form_filled_at,
    completed_at = EXCLUDED.completed_at,
    max_stage = EXCLUDED.max_stage,
    reservation_id = EXCLUDED.reservation_id,
    last_event_created_at = EXCLUDED.last_event_created_at,
    projection_version = EXCLUDED.projection_version,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS _affected = ROW_COUNT;

  UPDATE public.tracking_funnel_projection_state
  SET
    last_reconciled_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE company_id = _company_id;

  RETURN _affected + _deleted;
END;
$$;

-- Keep the existing cleanup semantics byte-for-byte in spirit and add only the
-- read-model cleanup.  In particular, this does not introduce any new Meta
-- queue behavior: the queue branches below are the pre-existing contract.
CREATE OR REPLACE FUNCTION public.clear_company_event_data(
  _company_id uuid,
  _scope text DEFAULT 'meta_queue'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _deleted_meta_attempts integer := 0;
  _deleted_meta_queue integer := 0;
  _deleted_tracking_events integer := 0;
  _deleted_tracking_journeys integer := 0;
  _deleted_tracking_sessions integer := 0;
  _deleted_funnel_sessions integer := 0;
  _deleted_funnel_states integer := 0;
  _deleted integer := 0;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa obrigatória.';
  END IF;

  IF _scope NOT IN ('meta_queue', 'event_log', 'all') THEN
    RAISE EXCEPTION 'Escopo de limpeza inválido.';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'superadmin')
    OR public.has_role_in_company(auth.uid(), 'admin', _company_id)
  ) THEN
    RAISE EXCEPTION 'Sem permissão para limpar eventos desta empresa.';
  END IF;

  IF _scope = 'meta_queue' THEN
    DELETE FROM public.meta_event_attempts
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_attempts := _deleted_meta_attempts + _deleted;

    DELETE FROM public.meta_event_queue
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_queue := _deleted_meta_queue + _deleted;
  END IF;

  IF _scope = 'event_log' THEN
    DELETE FROM public.meta_event_attempts
    WHERE queue_id IN (
      SELECT id
      FROM public.meta_event_queue
      WHERE company_id = _company_id
        AND tracking_event_id IS NOT NULL
    );
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_attempts := _deleted_meta_attempts + _deleted;

    DELETE FROM public.meta_event_queue
    WHERE company_id = _company_id
      AND tracking_event_id IS NOT NULL;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_queue := _deleted_meta_queue + _deleted;

    DELETE FROM public.tracking_events
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_events := _deleted_tracking_events + _deleted;

    DELETE FROM public.tracking_funnel_sessions
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_sessions := _deleted_funnel_sessions + _deleted;

    DELETE FROM public.tracking_funnel_projection_state
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_states := _deleted_funnel_states + _deleted;
  END IF;

  IF _scope = 'all' THEN
    DELETE FROM public.meta_event_attempts
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_attempts := _deleted_meta_attempts + _deleted;

    DELETE FROM public.meta_event_queue
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_queue := _deleted_meta_queue + _deleted;

    DELETE FROM public.tracking_events
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_events := _deleted_tracking_events + _deleted;

    DELETE FROM public.tracking_journeys
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_journeys := _deleted_tracking_journeys + _deleted;

    DELETE FROM public.tracking_sessions
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_sessions := _deleted_tracking_sessions + _deleted;

    DELETE FROM public.tracking_funnel_sessions
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_sessions := _deleted_funnel_sessions + _deleted;

    DELETE FROM public.tracking_funnel_projection_state
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_states := _deleted_funnel_states + _deleted;
  END IF;

  RETURN jsonb_build_object(
    'meta_attempts', _deleted_meta_attempts,
    'meta_queue', _deleted_meta_queue,
    'tracking_events', _deleted_tracking_events,
    'tracking_journeys', _deleted_tracking_journeys,
    'tracking_sessions', _deleted_tracking_sessions,
    'tracking_funnel_sessions', _deleted_funnel_sessions,
    'tracking_funnel_projection_states', _deleted_funnel_states
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._run_tracking_funnel_projection(
  _company_limit integer DEFAULT 25,
  _batch_size integer DEFAULT 2000,
  _overlap interval DEFAULT interval '30 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _company record;
  _result jsonb;
  _results jsonb := '[]'::jsonb;
  _processed_companies integer := 0;
  _global_has_all_states boolean := false;
  _global_covered_through timestamptz;
BEGIN
  IF _company_limit IS NULL OR _company_limit < 1 OR _company_limit > 200 THEN
    RAISE EXCEPTION 'company_limit deve estar entre 1 e 200.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-projector-global', 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked', 'companies', '[]'::jsonb);
  END IF;

  -- Discover newly active companies from a bounded append window.  Historical
  -- companies were seeded once when the table was created.
  INSERT INTO public.tracking_funnel_projection_state(company_id)
  SELECT DISTINCT events.company_id
  FROM public.tracking_events events
  WHERE events.tracking_source = 'public'
    AND events.created_at >= clock_timestamp() - interval '2 days'
    AND events.event_name IN (
      'page_view', 'date_select', 'time_select',
      'form_fill', 'lead_captured', 'reservation_created'
    )
  ON CONFLICT (company_id) DO NOTHING;

  FOR _company IN
    SELECT state.company_id
    FROM public.tracking_funnel_projection_state state
    ORDER BY
      state.is_ready,
      state.covered_through_at NULLS FIRST,
      state.company_id
    LIMIT _company_limit
  LOOP
    BEGIN
      _result := public._project_tracking_funnel_company_batch(
        _company.company_id,
        _batch_size,
        _overlap
      );
    EXCEPTION
      WHEN OTHERS THEN
        -- The company projector runs inside this exception subtransaction.  Its
        -- writes were rolled back, so persist diagnostics here before moving to
        -- the next tenant.
        UPDATE public.tracking_funnel_projection_state
        SET
          is_ready = false,
          last_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
          updated_at = clock_timestamp()
        WHERE company_id = _company.company_id;

        _result := jsonb_build_object(
          'status', 'error',
          'company_id', _company.company_id,
          'sqlstate', SQLSTATE,
          'error', left(SQLERRM, 500)
        );
    END;

    _results := _results || jsonb_build_array(_result);
    _processed_companies := _processed_companies + 1;
  END LOOP;

  SELECT
    COALESCE(
      bool_and(state.covered_through_at IS NOT NULL AND state.projection_version = 1),
      true
    ),
    min(state.covered_through_at)
  INTO _global_has_all_states, _global_covered_through
  FROM public.tracking_funnel_projection_state state;

  UPDATE public.tracking_funnel_global_projection_state
  SET
    is_ready = _global_has_all_states,
    covered_through_at = CASE
      WHEN _global_has_all_states THEN COALESCE(_global_covered_through, clock_timestamp())
      ELSE NULL
    END,
    updated_at = clock_timestamp()
  WHERE singleton;

  RETURN jsonb_build_object(
    'status', 'ok',
    'processed_companies', _processed_companies,
    'companies', _results,
    'finished_at', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._run_tracking_funnel_reconciliation(
  _lookback interval DEFAULT interval '7 days',
  _company_limit integer DEFAULT 200,
  _max_sessions_per_company integer DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _company record;
  _reconciled integer;
  _total integer := 0;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _lookback IS NULL OR _lookback < interval '1 hour' OR _lookback > interval '366 days' THEN
    RAISE EXCEPTION 'lookback deve estar entre 1 hora e 366 dias.' USING ERRCODE = '22023';
  END IF;

  IF _company_limit IS NULL OR _company_limit < 1 OR _company_limit > 1000 THEN
    RAISE EXCEPTION 'company_limit deve estar entre 1 e 1000.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-reconciler-global', 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked');
  END IF;

  FOR _company IN
    SELECT state.company_id
    FROM public.tracking_funnel_projection_state state
    ORDER BY state.last_reconciled_at NULLS FIRST, state.company_id
    LIMIT _company_limit
  LOOP
    _reconciled := public._reconcile_tracking_funnel_company(
      _company.company_id,
      _now - _lookback,
      _now + interval '1 microsecond',
      _max_sessions_per_company
    );
    _total := _total + _reconciled;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'ok',
    'sessions_reconciled', _total,
    'finished_at', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._tracking_funnel_counts_read_model_company(
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
  cohort_progress AS (
    SELECT
      CASE
        WHEN COALESCE(_unique_only, false)
          THEN sessions.company_id::text || ':visitor:' || sessions.anonymous_id
        ELSE sessions.company_id::text || ':session:' || sessions.session_id::text
      END AS identity_key,
      max(
        CASE
          WHEN sessions.completed_at >= sessions.first_page_view_at
            AND sessions.completed_at >= _start_at
            AND sessions.completed_at < _end_at THEN 5
          WHEN sessions.form_filled_at >= sessions.first_page_view_at
            AND sessions.form_filled_at >= _start_at
            AND sessions.form_filled_at < _end_at THEN 4
          WHEN sessions.time_selected_at >= sessions.first_page_view_at
            AND sessions.time_selected_at >= _start_at
            AND sessions.time_selected_at < _end_at THEN 3
          WHEN sessions.date_selected_at >= sessions.first_page_view_at
            AND sessions.date_selected_at >= _start_at
            AND sessions.date_selected_at < _end_at THEN 2
          ELSE 1
        END
      )::integer AS max_stage_in_window
    FROM public.tracking_funnel_sessions sessions
    WHERE sessions.company_id = _company_id
      AND sessions.first_page_view_at >= _start_at
      AND sessions.first_page_view_at < _end_at
    GROUP BY identity_key
  )
  SELECT
    step_definitions.step,
    count(cohort_progress.identity_key) FILTER (
      WHERE cohort_progress.max_stage_in_window >= step_definitions.stage_number
    )::bigint AS event_count
  FROM step_definitions
  LEFT JOIN cohort_progress ON true
  GROUP BY
    step_definitions.step,
    step_definitions.stage_number,
    step_definitions.sort_order
  ORDER BY step_definitions.sort_order;
$$;

CREATE OR REPLACE FUNCTION public._tracking_funnel_counts_read_model_global(
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
  cohort_progress AS (
    SELECT
      CASE
        WHEN COALESCE(_unique_only, false)
          THEN sessions.company_id::text || ':visitor:' || sessions.anonymous_id
        ELSE sessions.company_id::text || ':session:' || sessions.session_id::text
      END AS identity_key,
      max(
        CASE
          WHEN sessions.completed_at >= sessions.first_page_view_at
            AND sessions.completed_at >= _start_at
            AND sessions.completed_at < _end_at THEN 5
          WHEN sessions.form_filled_at >= sessions.first_page_view_at
            AND sessions.form_filled_at >= _start_at
            AND sessions.form_filled_at < _end_at THEN 4
          WHEN sessions.time_selected_at >= sessions.first_page_view_at
            AND sessions.time_selected_at >= _start_at
            AND sessions.time_selected_at < _end_at THEN 3
          WHEN sessions.date_selected_at >= sessions.first_page_view_at
            AND sessions.date_selected_at >= _start_at
            AND sessions.date_selected_at < _end_at THEN 2
          ELSE 1
        END
      )::integer AS max_stage_in_window
    FROM public.tracking_funnel_sessions sessions
    WHERE sessions.first_page_view_at >= _start_at
      AND sessions.first_page_view_at < _end_at
    GROUP BY identity_key
  )
  SELECT
    step_definitions.step,
    count(cohort_progress.identity_key) FILTER (
      WHERE cohort_progress.max_stage_in_window >= step_definitions.stage_number
    )::bigint AS event_count
  FROM step_definitions
  LEFT JOIN cohort_progress ON true
  GROUP BY
    step_definitions.step,
    step_definitions.stage_number,
    step_definitions.sort_order
  ORDER BY step_definitions.sort_order;
$$;

CREATE OR REPLACE FUNCTION public._tracking_funnel_company_read_model_ready(
  _company_id uuid,
  _required_through timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT
      state.projection_version = 1
      AND state.covered_through_at >= LEAST(_required_through, statement_timestamp()) - interval '5 minutes'
    FROM public.tracking_funnel_projection_state state
    WHERE state.company_id = _company_id
  ), false);
$$;

CREATE OR REPLACE FUNCTION public._tracking_funnel_global_read_model_ready(
  _required_through timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT
      state.is_ready
      AND state.covered_through_at >= LEAST(_required_through, statement_timestamp()) - interval '5 minutes'
    FROM public.tracking_funnel_global_projection_state state
    WHERE state.singleton
  ), false);
$$;

-- Replace the stable public contracts with DB-side rollout and automatic raw
-- fallback.  A source switch is a single private-table update and needs no
-- frontend rebuild.  Authentication is evaluated before the fallback block.
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
  _requested_source text := 'fast';
BEGIN
  PERFORM public._assert_tracking_funnel_company_access(_company_id);

  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date THEN
    RAISE EXCEPTION 'Intervalo de datas inválido.' USING ERRCODE = '22023';
  END IF;

  _start_at := _start_date::timestamp AT TIME ZONE 'America/Fortaleza';
  _end_at := (_end_date + 1)::timestamp AT TIME ZONE 'America/Fortaleza';
  PERFORM public._validate_tracking_funnel_range(_start_at, _end_at);

  SELECT rollout.requested_source
  INTO _requested_source
  FROM public.tracking_funnel_company_rollout rollout
  WHERE rollout.company_id = _company_id;
  _requested_source := COALESCE(_requested_source, 'fast');

  IF _requested_source = 'read_model'
    AND public._tracking_funnel_company_read_model_ready(_company_id, _end_at) THEN
    BEGIN
      RETURN QUERY
      SELECT counts.step, counts.event_count, 'read_model'::text
      FROM public._tracking_funnel_counts_read_model_company(
        _company_id,
        _start_at,
        _end_at,
        COALESCE(_unique_only, false)
      ) counts;
      RETURN;
    EXCEPTION
      WHEN OTHERS THEN
        -- Read failures are isolated from the user path; raw truth remains the
        -- safe rollback while the projector is repaired.
        NULL;
    END;
  END IF;

  RETURN QUERY
  SELECT
    counts.step,
    counts.event_count,
    CASE WHEN _requested_source = 'read_model' THEN 'fast_fallback' ELSE 'fast' END::text
  FROM public._tracking_funnel_counts_fast_company(
    _company_id,
    _start_at,
    _end_at,
    COALESCE(_unique_only, false)
  ) counts;
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
  _requested_source text := 'fast';
BEGIN
  PERFORM public._assert_tracking_funnel_global_access();

  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date THEN
    RAISE EXCEPTION 'Intervalo de datas inválido.' USING ERRCODE = '22023';
  END IF;

  _start_at := _start_date::timestamp AT TIME ZONE 'America/Fortaleza';
  _end_at := (_end_date + 1)::timestamp AT TIME ZONE 'America/Fortaleza';
  PERFORM public._validate_tracking_funnel_range(_start_at, _end_at);

  SELECT rollout.requested_source
  INTO _requested_source
  FROM public.tracking_funnel_global_rollout rollout
  WHERE rollout.singleton;
  _requested_source := COALESCE(_requested_source, 'fast');

  IF _requested_source = 'read_model'
    AND public._tracking_funnel_global_read_model_ready(_end_at) THEN
    BEGIN
      RETURN QUERY
      SELECT counts.step, counts.event_count, 'read_model'::text
      FROM public._tracking_funnel_counts_read_model_global(
        _start_at,
        _end_at,
        COALESCE(_unique_only, false)
      ) counts;
      RETURN;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END IF;

  RETURN QUERY
  SELECT
    counts.step,
    counts.event_count,
    CASE WHEN _requested_source = 'read_model' THEN 'fast_fallback' ELSE 'fast' END::text
  FROM public._tracking_funnel_counts_fast_global(
    _start_at,
    _end_at,
    COALESCE(_unique_only, false)
  ) counts;
END;
$$;

CREATE OR REPLACE FUNCTION public._project_tracking_funnel_company_batch(
  _company_id uuid,
  _batch_size integer DEFAULT 2000,
  _overlap interval DEFAULT interval '30 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _cursor_at timestamptz;
  _cursor_id uuid;
  _batch_last_at timestamptz;
  _batch_last_id uuid;
  _batch_count integer := 0;
  _projected_count integer := 0;
  _reconciled_count integer := 0;
  _has_more boolean := false;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id é obrigatório.' USING ERRCODE = '22023';
  END IF;

  IF _batch_size IS NULL OR _batch_size < 1 OR _batch_size > 10000 THEN
    RAISE EXCEPTION 'batch_size deve estar entre 1 e 10000.' USING ERRCODE = '22023';
  END IF;

  IF _overlap IS NULL OR _overlap < interval '1 minute' OR _overlap > interval '24 hours' THEN
    RAISE EXCEPTION 'overlap deve estar entre 1 minuto e 24 horas.' USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('tracking-funnel-company:' || _company_id::text, 0)
  ) THEN
    RETURN jsonb_build_object('status', 'locked', 'company_id', _company_id);
  END IF;

  INSERT INTO public.tracking_funnel_projection_state(
    company_id,
    last_started_at,
    updated_at
  )
  VALUES (_company_id, _now, _now)
  ON CONFLICT (company_id) DO UPDATE
  SET
    last_started_at = EXCLUDED.last_started_at,
    last_error = NULL,
    updated_at = EXCLUDED.updated_at;

  SELECT state.cursor_created_at, state.cursor_event_id
  INTO _cursor_at, _cursor_id
  FROM public.tracking_funnel_projection_state state
  WHERE state.company_id = _company_id
  FOR UPDATE;

  SELECT candidate.created_at, candidate.id
  INTO _batch_last_at, _batch_last_id
  FROM (
    SELECT events.created_at, events.id
    FROM public.tracking_events events
    WHERE events.company_id = _company_id
      AND events.tracking_source = 'public'
      AND events.event_name IN (
        'page_view', 'date_select', 'time_select',
        'form_fill', 'lead_captured', 'reservation_created'
      )
      AND (
        _cursor_at IS NULL
        OR events.created_at > _cursor_at
        OR (events.created_at = _cursor_at AND events.id > _cursor_id)
      )
    ORDER BY events.created_at, events.id
    LIMIT _batch_size
  ) candidate
  ORDER BY candidate.created_at DESC, candidate.id DESC
  LIMIT 1;

  IF _batch_last_at IS NOT NULL THEN
    WITH batch_events AS MATERIALIZED (
      SELECT events.*
      FROM public.tracking_events events
      WHERE events.company_id = _company_id
        AND events.tracking_source = 'public'
        AND events.event_name IN (
          'page_view', 'date_select', 'time_select',
          'form_fill', 'lead_captured', 'reservation_created'
        )
        AND (
          _cursor_at IS NULL
          OR events.created_at > _cursor_at
          OR (events.created_at = _cursor_at AND events.id > _cursor_id)
        )
        AND (
          events.created_at < _batch_last_at
          OR (events.created_at = _batch_last_at AND events.id <= _batch_last_id)
        )
      ORDER BY events.created_at, events.id
    ),
    batch_stats AS (
      SELECT count(*)::integer AS event_count
      FROM batch_events
    ),
    session_updates AS (
      SELECT
        events.company_id,
        events.session_id,
        (array_agg(events.anonymous_id ORDER BY events.created_at, events.id))[1] AS anonymous_id,
        min(events.created_at) AS first_event_created_at,
        min(events.created_at) FILTER (WHERE events.event_name = 'page_view') AS first_page_view_at,
        min(events.created_at) FILTER (WHERE events.event_name = 'date_select') AS date_selected_at,
        min(events.created_at) FILTER (WHERE events.event_name = 'time_select') AS time_selected_at,
        min(events.created_at) FILTER (
          WHERE events.event_name IN ('form_fill', 'lead_captured')
        ) AS form_filled_at,
        min(events.created_at) FILTER (
          WHERE events.event_name = 'reservation_created'
        ) AS completed_at,
        max(public._tracking_funnel_stage_number(events.event_name))::smallint AS max_stage,
        (array_agg(
          events.reservation_id
          ORDER BY events.created_at DESC, events.id DESC
        ) FILTER (WHERE events.reservation_id IS NOT NULL))[1] AS reservation_id,
        max(events.created_at) AS last_event_created_at
      FROM batch_events events
      WHERE events.session_id IS NOT NULL
      GROUP BY events.company_id, events.session_id
    ),
    upserted AS (
      INSERT INTO public.tracking_funnel_sessions AS target (
        company_id,
        session_id,
        anonymous_id,
        first_event_created_at,
        first_page_view_at,
        date_selected_at,
        time_selected_at,
        form_filled_at,
        completed_at,
        max_stage,
        reservation_id,
        last_event_created_at,
        projection_version,
        updated_at
      )
      SELECT
        session_updates.company_id,
        session_updates.session_id,
        session_updates.anonymous_id,
        session_updates.first_event_created_at,
        session_updates.first_page_view_at,
        session_updates.date_selected_at,
        session_updates.time_selected_at,
        session_updates.form_filled_at,
        session_updates.completed_at,
        session_updates.max_stage,
        session_updates.reservation_id,
        session_updates.last_event_created_at,
        1,
        _now
      FROM session_updates
      ON CONFLICT (company_id, session_id) DO UPDATE
      SET
        anonymous_id = COALESCE(NULLIF(target.anonymous_id, ''), EXCLUDED.anonymous_id),
        first_event_created_at = LEAST(
          target.first_event_created_at,
          EXCLUDED.first_event_created_at
        ),
        first_page_view_at = LEAST(target.first_page_view_at, EXCLUDED.first_page_view_at),
        date_selected_at = LEAST(target.date_selected_at, EXCLUDED.date_selected_at),
        time_selected_at = LEAST(target.time_selected_at, EXCLUDED.time_selected_at),
        form_filled_at = LEAST(target.form_filled_at, EXCLUDED.form_filled_at),
        completed_at = LEAST(target.completed_at, EXCLUDED.completed_at),
        max_stage = GREATEST(target.max_stage, EXCLUDED.max_stage),
        reservation_id = COALESCE(EXCLUDED.reservation_id, target.reservation_id),
        last_event_created_at = GREATEST(
          target.last_event_created_at,
          EXCLUDED.last_event_created_at
        ),
        projection_version = GREATEST(
          target.projection_version,
          EXCLUDED.projection_version
        ),
        updated_at = EXCLUDED.updated_at
      RETURNING 1
    )
    SELECT
      (SELECT event_count FROM batch_stats),
      (SELECT count(*)::integer FROM upserted)
    INTO _batch_count, _projected_count;

    SELECT EXISTS (
      SELECT 1
      FROM public.tracking_events events
      WHERE events.company_id = _company_id
        AND events.tracking_source = 'public'
        AND events.event_name IN (
          'page_view', 'date_select', 'time_select',
          'form_fill', 'lead_captured', 'reservation_created'
        )
        AND (
          events.created_at > _batch_last_at
          OR (events.created_at = _batch_last_at AND events.id > _batch_last_id)
        )
    ) INTO _has_more;

    UPDATE public.tracking_funnel_projection_state
    SET
      cursor_created_at = _batch_last_at,
      cursor_event_id = _batch_last_id,
      covered_through_at = CASE WHEN _has_more THEN _batch_last_at ELSE _now END,
      is_ready = NOT _has_more,
      processed_events = processed_events + _batch_count,
      last_completed_at = _now,
      last_error = NULL,
      updated_at = _now
    WHERE company_id = _company_id;
  ELSE
    UPDATE public.tracking_funnel_projection_state
    SET
      covered_through_at = _now,
      is_ready = true,
      last_completed_at = _now,
      last_error = NULL,
      updated_at = _now
    WHERE company_id = _company_id;
  END IF;

  -- The same advisory lock is re-entrant in this transaction.  Recompute the
  -- overlap from raw truth to catch a transaction that started before the cursor
  -- but committed afterwards.
  _reconciled_count := public._reconcile_tracking_funnel_company(
    _company_id,
    COALESCE(_batch_last_at, _cursor_at, _now) - _overlap,
    _now + interval '1 microsecond',
    10000
  );

  RETURN jsonb_build_object(
    'status', CASE WHEN _has_more THEN 'partial' ELSE 'ready' END,
    'company_id', _company_id,
    'events_processed', _batch_count,
    'sessions_projected', _projected_count,
    'sessions_reconciled', _reconciled_count,
    'has_more', _has_more,
    'cursor_created_at', COALESCE(_batch_last_at, _cursor_at),
    'covered_through_at', CASE WHEN _has_more THEN _batch_last_at ELSE _now END
  );
EXCEPTION
  WHEN OTHERS THEN
    UPDATE public.tracking_funnel_projection_state
    SET
      is_ready = false,
      last_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
      updated_at = clock_timestamp()
    WHERE company_id = _company_id;
    RETURN jsonb_build_object(
      'status', 'error',
      'company_id', _company_id,
      'sqlstate', SQLSTATE,
      'error', left(SQLERRM, 500)
    );
END;
$$;

COMMENT ON FUNCTION public._project_tracking_funnel_company_batch(uuid, integer, interval)
IS 'Projeta tracking_events em lote, com cursor por empresa, advisory lock e reconciliacao de overlap; nao e trigger.';

COMMENT ON FUNCTION public._reconcile_tracking_funnel_company(uuid, timestamptz, timestamptz, integer)
IS 'Reconstroi sessoes afetadas a partir do log bruto; suporta correcao, late commit e backfill idempotente.';

COMMENT ON FUNCTION public.get_tracking_funnel_report(uuid, date, date, boolean)
IS 'Funil company por datas inclusivas Fortaleza. Retorna 5 rows e data_source fast/read_model/fast_fallback.';

COMMENT ON FUNCTION public.get_global_tracking_funnel_report(date, date, boolean)
IS 'Funil global exclusivo para superadmin, com rollout e fallback no banco.';

REVOKE ALL ON FUNCTION public._tracking_funnel_stage_number(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._reconcile_tracking_funnel_company(
  uuid, timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._project_tracking_funnel_company_batch(
  uuid, integer, interval
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._run_tracking_funnel_projection(integer, integer, interval)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._run_tracking_funnel_reconciliation(interval, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._reconcile_tracking_funnel_company(
  uuid, timestamptz, timestamptz, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public._project_tracking_funnel_company_batch(
  uuid, integer, interval
) TO service_role;
GRANT EXECUTE ON FUNCTION public._run_tracking_funnel_projection(integer, integer, interval)
  TO service_role;
GRANT EXECUTE ON FUNCTION public._run_tracking_funnel_reconciliation(interval, integer, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public._tracking_funnel_counts_read_model_company(
  uuid, timestamptz, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tracking_funnel_counts_read_model_global(
  timestamptz, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tracking_funnel_company_read_model_ready(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tracking_funnel_global_read_model_ready(timestamptz)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_tracking_funnel_report(uuid, date, date, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tracking_funnel_report(uuid, date, date, boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_global_tracking_funnel_report(date, date, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_global_tracking_funnel_report(date, date, boolean)
  TO authenticated;

REVOKE ALL ON FUNCTION public.clear_company_event_data(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_company_event_data(uuid, text)
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tracking_funnel_company_rollout
  TO service_role;
GRANT SELECT, UPDATE ON TABLE public.tracking_funnel_global_rollout
  TO service_role;
