-- Demand & Conversion advanced report.
--
-- This read-only contract combines the asynchronous funnel read model with
-- reservations created in the selected company calendar period. It does not
-- write tracking events and is deliberately disconnected from Meta/CAPI.

CREATE OR REPLACE FUNCTION public._demand_conversion_entry_mode(
  _source text,
  _origin_waitlist_id uuid,
  _origin_affiliate_link_id uuid,
  _origin_tracking_session_id uuid,
  _origin_anonymous_id text,
  _attribution_snapshot jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN _source = 'waitlist' OR _origin_waitlist_id IS NOT NULL THEN 'waitlist'
    WHEN _origin_affiliate_link_id IS NOT NULL THEN 'affiliate'
    WHEN _origin_tracking_session_id IS NOT NULL
      OR NULLIF(btrim(COALESCE(_origin_anonymous_id, '')), '') IS NOT NULL
      OR NULLIF(btrim(COALESCE(_attribution_snapshot ->> 'tracking_source', '')), '') = 'public_web'
      THEN 'online'
    ELSE 'manual'
  END;
$$;

CREATE OR REPLACE FUNCTION public._validate_demand_conversion_filters(
  _granularity text,
  _page integer,
  _page_size integer,
  _search text,
  _entry_mode text,
  _maximum_page_size integer DEFAULT 100
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _granularity IS NULL OR _granularity NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Granularidade inválida.' USING ERRCODE = '22023';
  END IF;

  IF _page IS NULL OR _page < 1 THEN
    RAISE EXCEPTION 'Página inválida.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > _maximum_page_size THEN
    RAISE EXCEPTION 'Tamanho de página inválido.' USING ERRCODE = '22023';
  END IF;

  IF length(COALESCE(_search, '')) > 200 THEN
    RAISE EXCEPTION 'A busca pode ter no máximo 200 caracteres.' USING ERRCODE = '22023';
  END IF;

  IF _entry_mode IS NULL OR _entry_mode NOT IN ('all', 'online', 'affiliate', 'manual', 'waitlist') THEN
    RAISE EXCEPTION 'Forma de entrada inválida.' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_demand_conversion_report(
  _company_id uuid,
  _start_date date,
  _end_date date,
  _unique_only boolean DEFAULT false,
  _include_comparison boolean DEFAULT true,
  _granularity text DEFAULT 'day',
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 15,
  _search text DEFAULT NULL,
  _entry_mode text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
  _start_at timestamptz;
  _end_at timestamptz;
  _comparison_start_date date;
  _comparison_end_date date;
  _comparison_start_at timestamptz;
  _comparison_end_at timestamptz;
  _normalized_search text := NULLIF(btrim(COALESCE(_search, '')), '');
  _details_total bigint;
  _effective_page integer;
  _result jsonb;
BEGIN
  PERFORM public._assert_company_advanced_report_access(_company_id);
  PERFORM public._validate_advanced_report_range(_start_date, _end_date, 366);
  PERFORM public._validate_demand_conversion_filters(
    _granularity,
    _page,
    _page_size,
    _search,
    _entry_mode,
    100
  );

  _time_zone := public._company_report_time_zone(_company_id);
  _start_at := _start_date::timestamp AT TIME ZONE _time_zone;
  _end_at := (_end_date + 1)::timestamp AT TIME ZONE _time_zone;
  _comparison_end_date := _start_date - 1;
  _comparison_start_date := _comparison_end_date - ((_end_date - _start_date + 1) - 1);
  _comparison_start_at := _comparison_start_date::timestamp AT TIME ZONE _time_zone;
  _comparison_end_at := (_comparison_end_date + 1)::timestamp AT TIME ZONE _time_zone;

  IF NOT public._tracking_funnel_company_read_model_ready(_company_id, _end_at) THEN
    RAISE EXCEPTION 'O funil analítico ainda está sendo preparado. Tente novamente em alguns instantes.'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)
  INTO _details_total
  FROM public.reservations reservations
  WHERE reservations.company_id = _company_id
    AND reservations.created_at >= _start_at
    AND reservations.created_at < _end_at
    AND (
      _normalized_search IS NULL
      OR reservations.guest_name ILIKE '%' || _normalized_search || '%'
      OR (
        NULLIF(regexp_replace(_normalized_search, '\D', '', 'g'), '') IS NOT NULL
        AND regexp_replace(COALESCE(reservations.guest_phone, ''), '\D', '', 'g')
          LIKE '%' || regexp_replace(_normalized_search, '\D', '', 'g') || '%'
      )
    )
    AND (
      _entry_mode = 'all'
      OR public._demand_conversion_entry_mode(
        reservations.source,
        reservations.origin_waitlist_id,
        reservations.origin_affiliate_link_id,
        reservations.origin_tracking_session_id,
        reservations.origin_anonymous_id,
        reservations.attribution_snapshot
      ) = _entry_mode
    );

  _effective_page := LEAST(
    _page,
    GREATEST(1, CEIL(_details_total::numeric / _page_size)::integer)
  );

  WITH
  cohort_sessions AS MATERIALIZED (
    SELECT
      sessions.company_id,
      sessions.session_id,
      sessions.anonymous_id,
      sessions.first_page_view_at,
      sessions.date_selected_at,
      sessions.time_selected_at,
      sessions.form_filled_at,
      sessions.completed_at,
      CASE
        WHEN sessions.completed_at >= sessions.first_page_view_at
          AND sessions.completed_at < _end_at THEN 5
        WHEN sessions.form_filled_at >= sessions.first_page_view_at
          AND sessions.form_filled_at < _end_at THEN 4
        WHEN sessions.time_selected_at >= sessions.first_page_view_at
          AND sessions.time_selected_at < _end_at THEN 3
        WHEN sessions.date_selected_at >= sessions.first_page_view_at
          AND sessions.date_selected_at < _end_at THEN 2
        ELSE 1
      END::integer AS max_stage
    FROM public.tracking_funnel_sessions sessions
    WHERE sessions.company_id = _company_id
      AND sessions.first_page_view_at >= _start_at
      AND sessions.first_page_view_at < _end_at
  ),
  identity_progress AS MATERIALIZED (
    SELECT
      CASE
        WHEN COALESCE(_unique_only, false)
          AND NULLIF(btrim(COALESCE(cohort_sessions.anonymous_id, '')), '') IS NOT NULL
          THEN 'visitor:' || cohort_sessions.anonymous_id
        ELSE 'session:' || cohort_sessions.session_id::text
      END AS identity_key,
      min(cohort_sessions.first_page_view_at) AS first_page_view_at,
      max(cohort_sessions.max_stage)::integer AS max_stage
    FROM cohort_sessions
    GROUP BY identity_key
  ),
  comparison_cohort_sessions AS MATERIALIZED (
    SELECT
      sessions.session_id,
      sessions.anonymous_id,
      sessions.first_page_view_at,
      CASE
        WHEN sessions.completed_at >= sessions.first_page_view_at
          AND sessions.completed_at < _comparison_end_at THEN 5
        WHEN sessions.form_filled_at >= sessions.first_page_view_at
          AND sessions.form_filled_at < _comparison_end_at THEN 4
        WHEN sessions.time_selected_at >= sessions.first_page_view_at
          AND sessions.time_selected_at < _comparison_end_at THEN 3
        WHEN sessions.date_selected_at >= sessions.first_page_view_at
          AND sessions.date_selected_at < _comparison_end_at THEN 2
        ELSE 1
      END::integer AS max_stage
    FROM public.tracking_funnel_sessions sessions
    WHERE COALESCE(_include_comparison, true)
      AND sessions.company_id = _company_id
      AND sessions.first_page_view_at >= _comparison_start_at
      AND sessions.first_page_view_at < _comparison_end_at
  ),
  comparison_identity_progress AS MATERIALIZED (
    SELECT
      CASE
        WHEN COALESCE(_unique_only, false)
          AND NULLIF(btrim(COALESCE(comparison_cohort_sessions.anonymous_id, '')), '') IS NOT NULL
          THEN 'visitor:' || comparison_cohort_sessions.anonymous_id
        ELSE 'session:' || comparison_cohort_sessions.session_id::text
      END AS identity_key,
      max(comparison_cohort_sessions.max_stage)::integer AS max_stage
    FROM comparison_cohort_sessions
    GROUP BY identity_key
  ),
  step_definitions(step, label, stage_number, sort_order) AS (
    VALUES
      ('page_view'::text, 'Página pública'::text, 1, 1),
      ('date_select'::text, 'Seleção de data'::text, 2, 2),
      ('time_select'::text, 'Seleção de horário'::text, 3, 3),
      ('form_fill'::text, 'Dados pessoais'::text, 4, 4),
      ('completed'::text, 'Reserva finalizada'::text, 5, 5)
  ),
  funnel_counts AS (
    SELECT
      step_definitions.step,
      step_definitions.label,
      step_definitions.stage_number,
      step_definitions.sort_order,
      count(identity_progress.identity_key) FILTER (
        WHERE identity_progress.max_stage >= step_definitions.stage_number
      )::bigint AS identities
    FROM step_definitions
    LEFT JOIN identity_progress ON true
    GROUP BY
      step_definitions.step,
      step_definitions.label,
      step_definitions.stage_number,
      step_definitions.sort_order
  ),
  comparison_funnel_counts AS (
    SELECT
      step_definitions.step,
      count(comparison_identity_progress.identity_key) FILTER (
        WHERE comparison_identity_progress.max_stage >= step_definitions.stage_number
      )::bigint AS identities
    FROM step_definitions
    LEFT JOIN comparison_identity_progress ON true
    GROUP BY step_definitions.step, step_definitions.stage_number, step_definitions.sort_order
  ),
  funnel_with_neighbors AS (
    SELECT
      funnel_counts.*,
      lag(funnel_counts.identities) OVER (ORDER BY funnel_counts.sort_order) AS previous_identities,
      lead(funnel_counts.identities) OVER (ORDER BY funnel_counts.sort_order) AS next_identities,
      first_value(funnel_counts.identities) OVER (ORDER BY funnel_counts.sort_order) AS first_identities
    FROM funnel_counts
  ),
  funnel_json AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'step', funnel_with_neighbors.step,
        'label', funnel_with_neighbors.label,
        'count', funnel_with_neighbors.identities,
        'conversion_from_previous', CASE
          WHEN funnel_with_neighbors.previous_identities IS NULL THEN 100
          WHEN funnel_with_neighbors.previous_identities = 0 THEN 0
          ELSE round(100.0 * funnel_with_neighbors.identities / funnel_with_neighbors.previous_identities, 1)
        END,
        'conversion_from_start', CASE
          WHEN funnel_with_neighbors.first_identities = 0 THEN 0
          ELSE round(
            100.0 * funnel_with_neighbors.identities
              / funnel_with_neighbors.first_identities,
            1
          )
        END,
        'dropoff', GREATEST(
          funnel_with_neighbors.identities - COALESCE(funnel_with_neighbors.next_identities, funnel_with_neighbors.identities),
          0
        ),
        'dropoff_rate', CASE
          WHEN funnel_with_neighbors.next_identities IS NULL OR funnel_with_neighbors.identities = 0 THEN 0
          ELSE round(
            100.0 * GREATEST(funnel_with_neighbors.identities - funnel_with_neighbors.next_identities, 0)
              / funnel_with_neighbors.identities,
            1
          )
        END
      ) ORDER BY funnel_with_neighbors.sort_order
    ) AS value
    FROM funnel_with_neighbors
  ),
  transition_definitions(transition_key, from_label, to_label, from_stage) AS (
    VALUES
      ('page_to_date'::text, 'Página pública'::text, 'Seleção de data'::text, 1),
      ('date_to_time'::text, 'Seleção de data'::text, 'Seleção de horário'::text, 2),
      ('time_to_form'::text, 'Seleção de horário'::text, 'Dados pessoais'::text, 3),
      ('form_to_completed'::text, 'Dados pessoais'::text, 'Reserva finalizada'::text, 4)
  ),
  session_transition_values AS (
    SELECT
      transition_definitions.transition_key,
      transition_definitions.from_label,
      transition_definitions.to_label,
      transition_definitions.from_stage,
      -- Timing is measured per journey/session even when funnel counts use
      -- unique visitors; otherwise repeat visits collapse to the shortest one.
      'session:' || cohort_sessions.session_id::text AS identity_key,
      EXTRACT(EPOCH FROM (
        CASE transition_definitions.from_stage
          WHEN 1 THEN cohort_sessions.date_selected_at
          WHEN 2 THEN cohort_sessions.time_selected_at
          WHEN 3 THEN cohort_sessions.form_filled_at
          ELSE cohort_sessions.completed_at
        END
        - CASE transition_definitions.from_stage
          WHEN 1 THEN cohort_sessions.first_page_view_at
          WHEN 2 THEN cohort_sessions.date_selected_at
          WHEN 3 THEN cohort_sessions.time_selected_at
          ELSE cohort_sessions.form_filled_at
        END
      ))::numeric AS duration_seconds
    FROM cohort_sessions
    CROSS JOIN transition_definitions
    WHERE CASE transition_definitions.from_stage
      WHEN 1 THEN cohort_sessions.date_selected_at IS NOT NULL
        AND cohort_sessions.date_selected_at >= cohort_sessions.first_page_view_at
        AND cohort_sessions.date_selected_at < _end_at
      WHEN 2 THEN cohort_sessions.time_selected_at IS NOT NULL
        AND cohort_sessions.date_selected_at IS NOT NULL
        AND cohort_sessions.time_selected_at >= cohort_sessions.date_selected_at
        AND cohort_sessions.time_selected_at < _end_at
      WHEN 3 THEN cohort_sessions.form_filled_at IS NOT NULL
        AND cohort_sessions.time_selected_at IS NOT NULL
        AND cohort_sessions.form_filled_at >= cohort_sessions.time_selected_at
        AND cohort_sessions.form_filled_at < _end_at
      ELSE cohort_sessions.completed_at IS NOT NULL
        AND cohort_sessions.form_filled_at IS NOT NULL
        AND cohort_sessions.completed_at >= cohort_sessions.form_filled_at
        AND cohort_sessions.completed_at < _end_at
    END
  ),
  identity_transition_values AS (
    SELECT
      session_transition_values.transition_key,
      session_transition_values.from_label,
      session_transition_values.to_label,
      session_transition_values.from_stage,
      session_transition_values.identity_key,
      min(session_transition_values.duration_seconds) AS duration_seconds
    FROM session_transition_values
    WHERE session_transition_values.duration_seconds >= 0
    GROUP BY
      session_transition_values.transition_key,
      session_transition_values.from_label,
      session_transition_values.to_label,
      session_transition_values.from_stage,
      session_transition_values.identity_key
  ),
  timing_stats AS (
    SELECT
      transition_definitions.transition_key,
      transition_definitions.from_label,
      transition_definitions.to_label,
      transition_definitions.from_stage,
      COALESCE(round(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY identity_transition_values.duration_seconds
      ))::bigint, 0) AS median_seconds,
      count(identity_transition_values.identity_key)::bigint AS sample_size
    FROM transition_definitions
    LEFT JOIN identity_transition_values
      ON identity_transition_values.transition_key = transition_definitions.transition_key
    GROUP BY
      transition_definitions.transition_key,
      transition_definitions.from_label,
      transition_definitions.to_label,
      transition_definitions.from_stage
  ),
  timing_json AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'key', timing_stats.transition_key,
        'from_label', timing_stats.from_label,
        'to_label', timing_stats.to_label,
        'median_seconds', timing_stats.median_seconds,
        'sample_size', timing_stats.sample_size
      ) ORDER BY timing_stats.from_stage
    ), '[]'::jsonb) AS value
    FROM timing_stats
  ),
  reservation_facts_base AS MATERIALIZED (
    SELECT
      reservations.id,
      reservations.guest_name,
      reservations.guest_phone,
      reservations.guest_email,
      reservations.date,
      reservations.time,
      reservations.party_size,
      reservations.status,
      reservations.source,
      reservations.origin_affiliate_code,
      reservations.origin_affiliate_name,
      reservations.created_at,
      reservations.checked_in_at,
      reservations.checked_in_party_size,
      reservations.updated_at,
      reservations.occasion,
      reservations.notes,
      reservations.table_id,
      reservations.created_in_mode,
      reservations.public_tracking_code,
      public._demand_conversion_entry_mode(
        reservations.source,
        reservations.origin_waitlist_id,
        reservations.origin_affiliate_link_id,
        reservations.origin_tracking_session_id,
        reservations.origin_anonymous_id,
        reservations.attribution_snapshot
      ) AS entry_mode,
      GREATEST(
        reservations.date - (reservations.created_at AT TIME ZONE _time_zone)::date,
        0
      )::integer AS lead_days,
      (reservations.created_at AT TIME ZONE _time_zone)::date AS created_local_date
    FROM public.reservations reservations
    WHERE reservations.company_id = _company_id
      AND reservations.created_at >= _start_at
      AND reservations.created_at < _end_at
  ),
  reservation_facts AS MATERIALIZED (
    SELECT reservation_facts_base.*
    FROM reservation_facts_base
    WHERE _entry_mode = 'all' OR reservation_facts_base.entry_mode = _entry_mode
  ),
  comparison_reservation_facts_base AS MATERIALIZED (
    SELECT
      reservations.id,
      reservations.party_size,
      GREATEST(
        reservations.date - (reservations.created_at AT TIME ZONE _time_zone)::date,
        0
      )::integer AS lead_days,
      public._demand_conversion_entry_mode(
        reservations.source,
        reservations.origin_waitlist_id,
        reservations.origin_affiliate_link_id,
        reservations.origin_tracking_session_id,
        reservations.origin_anonymous_id,
        reservations.attribution_snapshot
      ) AS entry_mode
    FROM public.reservations reservations
    WHERE COALESCE(_include_comparison, true)
      AND reservations.company_id = _company_id
      AND reservations.created_at >= _comparison_start_at
      AND reservations.created_at < _comparison_end_at
  ),
  comparison_reservation_facts AS MATERIALIZED (
    SELECT comparison_reservation_facts_base.*
    FROM comparison_reservation_facts_base
    WHERE _entry_mode = 'all'
      OR comparison_reservation_facts_base.entry_mode = _entry_mode
  ),
  series_buckets AS (
    SELECT generate_series(
      date_trunc(_granularity, _start_date::timestamp),
      date_trunc(_granularity, _end_date::timestamp),
      CASE _granularity
        WHEN 'day' THEN interval '1 day'
        WHEN 'week' THEN interval '1 week'
        ELSE interval '1 month'
      END
    )::date AS bucket
  ),
  funnel_series AS (
    SELECT
      date_trunc(_granularity, identity_progress.first_page_view_at AT TIME ZONE _time_zone)::date AS bucket,
      count(*)::bigint AS page_views,
      count(*) FILTER (WHERE identity_progress.max_stage >= 2)::bigint AS date_selections,
      count(*) FILTER (WHERE identity_progress.max_stage >= 3)::bigint AS time_selections,
      count(*) FILTER (WHERE identity_progress.max_stage >= 4)::bigint AS forms,
      count(*) FILTER (WHERE identity_progress.max_stage >= 5)::bigint AS completed
    FROM identity_progress
    GROUP BY bucket
  ),
  reservation_series AS (
    SELECT
      date_trunc(_granularity, reservation_facts.created_local_date::timestamp)::date AS bucket,
      count(*)::bigint AS reservations,
      COALESCE(sum(reservation_facts.party_size), 0)::bigint AS people
    FROM reservation_facts
    GROUP BY bucket
  ),
  trend_json AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'period', series_buckets.bucket,
        'page_views', COALESCE(funnel_series.page_views, 0),
        'date_selections', COALESCE(funnel_series.date_selections, 0),
        'time_selections', COALESCE(funnel_series.time_selections, 0),
        'forms', COALESCE(funnel_series.forms, 0),
        'completed', COALESCE(funnel_series.completed, 0),
        'created_reservations', COALESCE(reservation_series.reservations, 0),
        'created_people', COALESCE(reservation_series.people, 0)
      ) ORDER BY series_buckets.bucket
    ), '[]'::jsonb) AS value
    FROM series_buckets
    LEFT JOIN funnel_series ON funnel_series.bucket = series_buckets.bucket
    LEFT JOIN reservation_series ON reservation_series.bucket = series_buckets.bucket
  ),
  lead_time_definitions(band_key, label, min_days, max_days, sort_order) AS (
    VALUES
      ('same_day'::text, 'No mesmo dia'::text, 0, 0, 1),
      ('one_day'::text, '1 dia antes'::text, 1, 1, 2),
      ('two_to_seven'::text, '2 a 7 dias'::text, 2, 7, 3),
      ('eight_to_fourteen'::text, '8 a 14 dias'::text, 8, 14, 4),
      ('fifteen_to_thirty'::text, '15 a 30 dias'::text, 15, 30, 5),
      ('thirty_one_plus'::text, '31 dias ou mais'::text, 31, NULL::integer, 6)
  ),
  lead_time_stats AS (
    SELECT
      lead_time_definitions.band_key,
      lead_time_definitions.label,
      lead_time_definitions.sort_order,
      count(reservation_facts.id)::bigint AS reservations,
      COALESCE(sum(reservation_facts.party_size), 0)::bigint AS people,
      CASE
        WHEN (SELECT count(*) FROM reservation_facts) = 0 THEN 0
        ELSE round(100.0 * count(reservation_facts.id) / (SELECT count(*) FROM reservation_facts), 1)
      END AS percentage
    FROM lead_time_definitions
    LEFT JOIN reservation_facts
      ON reservation_facts.lead_days >= lead_time_definitions.min_days
      AND (
        lead_time_definitions.max_days IS NULL
        OR reservation_facts.lead_days <= lead_time_definitions.max_days
      )
    GROUP BY
      lead_time_definitions.band_key,
      lead_time_definitions.label,
      lead_time_definitions.sort_order
  ),
  lead_time_json AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'key', lead_time_stats.band_key,
        'label', lead_time_stats.label,
        'reservations', lead_time_stats.reservations,
        'people', lead_time_stats.people,
        'percentage', lead_time_stats.percentage
      ) ORDER BY lead_time_stats.sort_order
    ), '[]'::jsonb) AS value
    FROM lead_time_stats
  ),
  entry_definitions(entry_mode, label, sort_order) AS (
    VALUES
      ('online'::text, 'Online'::text, 1),
      ('affiliate'::text, 'Filiados e parceiros'::text, 2),
      ('manual'::text, 'Criada no painel'::text, 3),
      ('waitlist'::text, 'Convertida da fila'::text, 4)
  ),
  entry_mode_stats AS (
    SELECT
      entry_definitions.entry_mode,
      entry_definitions.label,
      entry_definitions.sort_order,
      count(reservation_facts_base.id)::bigint AS reservations,
      COALESCE(sum(reservation_facts_base.party_size), 0)::bigint AS people,
      CASE
        WHEN (SELECT count(*) FROM reservation_facts_base) = 0 THEN 0
        ELSE round(
          100.0 * count(reservation_facts_base.id) / (SELECT count(*) FROM reservation_facts_base),
          1
        )
      END AS percentage
    FROM entry_definitions
    LEFT JOIN reservation_facts_base
      ON reservation_facts_base.entry_mode = entry_definitions.entry_mode
    GROUP BY
      entry_definitions.entry_mode,
      entry_definitions.label,
      entry_definitions.sort_order
  ),
  entry_mode_json AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'key', entry_mode_stats.entry_mode,
        'label', entry_mode_stats.label,
        'reservations', entry_mode_stats.reservations,
        'people', entry_mode_stats.people,
        'percentage', entry_mode_stats.percentage
      ) ORDER BY entry_mode_stats.sort_order
    ), '[]'::jsonb) AS value
    FROM entry_mode_stats
  ),
  party_size_definitions(band_key, label, min_size, max_size, sort_order) AS (
    VALUES
      ('one_two'::text, '1–2 pessoas'::text, 1, 2, 1),
      ('three_four'::text, '3–4 pessoas'::text, 3, 4, 2),
      ('five_six'::text, '5–6 pessoas'::text, 5, 6, 3),
      ('seven_plus'::text, '7+ pessoas'::text, 7, NULL::integer, 4)
  ),
  party_size_stats AS (
    SELECT
      party_size_definitions.band_key,
      party_size_definitions.label,
      party_size_definitions.sort_order,
      count(reservation_facts.id)::bigint AS reservations,
      COALESCE(sum(reservation_facts.party_size), 0)::bigint AS people,
      CASE
        WHEN (SELECT count(*) FROM reservation_facts) = 0 THEN 0
        ELSE round(100.0 * count(reservation_facts.id) / (SELECT count(*) FROM reservation_facts), 1)
      END AS percentage
    FROM party_size_definitions
    LEFT JOIN reservation_facts
      ON reservation_facts.party_size >= party_size_definitions.min_size
      AND (
        party_size_definitions.max_size IS NULL
        OR reservation_facts.party_size <= party_size_definitions.max_size
      )
    GROUP BY
      party_size_definitions.band_key,
      party_size_definitions.label,
      party_size_definitions.sort_order
  ),
  comparison_party_size_stats AS (
    SELECT
      party_size_definitions.band_key,
      party_size_definitions.label,
      party_size_definitions.sort_order,
      count(comparison_reservation_facts.id)::bigint AS reservations,
      COALESCE(sum(comparison_reservation_facts.party_size), 0)::bigint AS people,
      CASE
        WHEN (SELECT count(*) FROM comparison_reservation_facts) = 0 THEN 0
        ELSE round(
          100.0 * count(comparison_reservation_facts.id)
            / (SELECT count(*) FROM comparison_reservation_facts),
          1
        )
      END AS percentage
    FROM party_size_definitions
    LEFT JOIN comparison_reservation_facts
      ON comparison_reservation_facts.party_size >= party_size_definitions.min_size
      AND (
        party_size_definitions.max_size IS NULL
        OR comparison_reservation_facts.party_size <= party_size_definitions.max_size
      )
    GROUP BY
      party_size_definitions.band_key,
      party_size_definitions.label,
      party_size_definitions.sort_order
  ),
  party_size_json AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'key', party_size_stats.band_key,
        'label', party_size_stats.label,
        'reservations', party_size_stats.reservations,
        'people', party_size_stats.people,
        'percentage', party_size_stats.percentage
      ) ORDER BY party_size_stats.sort_order
    ), '[]'::jsonb) AS value
    FROM party_size_stats
  ),
  comparison_party_size_json AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'key', comparison_party_size_stats.band_key,
        'label', comparison_party_size_stats.label,
        'reservations', comparison_party_size_stats.reservations,
        'people', comparison_party_size_stats.people,
        'percentage', comparison_party_size_stats.percentage
      ) ORDER BY comparison_party_size_stats.sort_order
    ), '[]'::jsonb) AS value
    FROM comparison_party_size_stats
  ),
  filtered_details AS (
    SELECT reservation_facts.*
    FROM reservation_facts
    WHERE (
      _normalized_search IS NULL
      OR reservation_facts.guest_name ILIKE '%' || _normalized_search || '%'
      OR (
        NULLIF(regexp_replace(_normalized_search, '\D', '', 'g'), '') IS NOT NULL
        AND regexp_replace(COALESCE(reservation_facts.guest_phone, ''), '\D', '', 'g')
          LIKE '%' || regexp_replace(_normalized_search, '\D', '', 'g') || '%'
      )
    )
      AND (_entry_mode = 'all' OR reservation_facts.entry_mode = _entry_mode)
  ),
  paged_details AS (
    SELECT filtered_details.*
    FROM filtered_details
    ORDER BY filtered_details.created_at DESC, filtered_details.id DESC
    LIMIT _page_size
    OFFSET (_effective_page - 1) * _page_size
  ),
  details_json AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', paged_details.id,
        'guest_name', paged_details.guest_name,
        'guest_phone', paged_details.guest_phone,
        'guest_email', paged_details.guest_email,
        'reservation_date', paged_details.date,
        'reservation_time', paged_details.time,
        'party_size', paged_details.party_size,
        'status', paged_details.status,
        'entry_mode', paged_details.entry_mode,
        'lead_days', paged_details.lead_days,
        'created_at', paged_details.created_at,
        'source', paged_details.source,
        'origin_affiliate_code', paged_details.origin_affiliate_code,
        'origin_affiliate_name', paged_details.origin_affiliate_name,
        'checked_in_at', paged_details.checked_in_at,
        'checked_in_party_size', paged_details.checked_in_party_size,
        'updated_at', paged_details.updated_at,
        'occasion', paged_details.occasion,
        'notes', paged_details.notes,
        'table_id', paged_details.table_id,
        'created_in_mode', paged_details.created_in_mode,
        'public_tracking_code', paged_details.public_tracking_code
      ) ORDER BY paged_details.created_at DESC, paged_details.id DESC
    ), '[]'::jsonb) AS value
    FROM paged_details
  ),
  aggregate_summary AS (
    SELECT
      count(*)::bigint AS created_reservations,
      COALESCE(sum(reservation_facts.party_size), 0)::bigint AS created_people,
      COALESCE(round(avg(reservation_facts.lead_days), 1), 0) AS average_lead_days
    FROM reservation_facts
  ),
  comparison_aggregate_summary AS (
    SELECT
      count(*)::bigint AS created_reservations,
      COALESCE(sum(comparison_reservation_facts.party_size), 0)::bigint AS created_people,
      COALESCE(round(avg(comparison_reservation_facts.lead_days), 1), 0) AS average_lead_days
    FROM comparison_reservation_facts
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'sessions', (SELECT identities FROM funnel_counts WHERE step = 'page_view'),
      'completed', (SELECT identities FROM funnel_counts WHERE step = 'completed'),
      'overall_conversion_rate', CASE
        WHEN (SELECT identities FROM funnel_counts WHERE step = 'page_view') = 0 THEN 0
        ELSE round(
          100.0 * (SELECT identities FROM funnel_counts WHERE step = 'completed')
            / (SELECT identities FROM funnel_counts WHERE step = 'page_view'),
          1
        )
      END,
      'created_reservations', aggregate_summary.created_reservations,
      'created_people', aggregate_summary.created_people,
      'average_lead_days', aggregate_summary.average_lead_days
    ),
    'comparison', CASE
      WHEN COALESCE(_include_comparison, true) THEN jsonb_build_object(
        'period_start', _comparison_start_date,
        'period_end', _comparison_end_date,
        'summary', jsonb_build_object(
          'sessions', (SELECT identities FROM comparison_funnel_counts WHERE step = 'page_view'),
          'completed', (SELECT identities FROM comparison_funnel_counts WHERE step = 'completed'),
          'overall_conversion_rate', CASE
            WHEN (SELECT identities FROM comparison_funnel_counts WHERE step = 'page_view') = 0 THEN 0
            ELSE round(
              100.0 * (SELECT identities FROM comparison_funnel_counts WHERE step = 'completed')
                / (SELECT identities FROM comparison_funnel_counts WHERE step = 'page_view'),
              1
            )
          END,
          'created_reservations', comparison_aggregate_summary.created_reservations,
          'created_people', comparison_aggregate_summary.created_people,
          'average_lead_days', comparison_aggregate_summary.average_lead_days
        ),
        'party_size_bands', comparison_party_size_json.value
      )
      ELSE NULL
    END,
    'funnel', funnel_json.value,
    'trend', trend_json.value,
    'transition_times', timing_json.value,
    'lead_time_bands', lead_time_json.value,
    'entry_modes', entry_mode_json.value,
    'party_size_bands', party_size_json.value,
    'details', details_json.value,
    'meta', jsonb_build_object(
      'period_start', _start_date,
      'period_end', _end_date,
      'time_zone', _time_zone,
      'unique_only', COALESCE(_unique_only, false),
      'comparison_enabled', COALESCE(_include_comparison, true),
      'comparison_start', CASE WHEN COALESCE(_include_comparison, true) THEN _comparison_start_date ELSE NULL END,
      'comparison_end', CASE WHEN COALESCE(_include_comparison, true) THEN _comparison_end_date ELSE NULL END,
      'granularity', _granularity,
      'page', _effective_page,
      'page_size', _page_size,
      'details_total', _details_total,
      'entry_mode', _entry_mode,
      'search', _normalized_search,
      'generated_at', statement_timestamp(),
      'funnel_source', 'tracking_funnel_sessions'
    )
  )
  INTO _result
  FROM aggregate_summary
  CROSS JOIN funnel_json
  CROSS JOIN trend_json
  CROSS JOIN timing_json
  CROSS JOIN lead_time_json
  CROSS JOIN entry_mode_json
  CROSS JOIN party_size_json
  CROSS JOIN comparison_party_size_json
  CROSS JOIN comparison_aggregate_summary
  CROSS JOIN details_json;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_demand_conversion_report(
  uuid, date, date, boolean, boolean, text, integer, integer, text, text
) IS
  'Relatório avançado de demanda e conversão com funil, tendência, antecedência, formas de entrada e detalhe paginado.';

REVOKE ALL ON FUNCTION public._demand_conversion_entry_mode(
  text, uuid, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._validate_demand_conversion_filters(
  text, integer, integer, text, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_demand_conversion_report(
  uuid, date, date, boolean, boolean, text, integer, integer, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public._demand_conversion_entry_mode(
  text, uuid, uuid, uuid, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public._validate_demand_conversion_filters(
  text, integer, integer, text, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_demand_conversion_report(
  uuid, date, date, boolean, boolean, text, integer, integer, text, text
) TO authenticated, service_role;
