-- Phase 1: temporal lenses for Demanda & Conversao.
--
-- This is a read-only companion to get_demand_conversion_report. It does not
-- write tracking data and has no dependency on Meta/CAPI delivery.

CREATE OR REPLACE FUNCTION public.get_demand_temporal_analysis(
  _company_id uuid,
  _start_date date,
  _end_date date,
  _granularity text DEFAULT 'day'
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
  _result jsonb;
BEGIN
  PERFORM public._assert_company_advanced_report_access(_company_id);
  PERFORM public._validate_advanced_report_range(_start_date, _end_date, 366);

  IF _granularity IS NULL OR _granularity NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Granularidade invalida.' USING ERRCODE = '22023';
  END IF;

  _time_zone := public._company_report_time_zone(_company_id);
  _start_at := _start_date::timestamp AT TIME ZONE _time_zone;
  _end_at := (_end_date + 1)::timestamp AT TIME ZONE _time_zone;

  WITH bounds AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', _start_date::timestamp)::date
        WHEN 'month' THEN date_trunc('month', _start_date::timestamp)::date
        ELSE _start_date
      END AS first_bucket,
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', _end_date::timestamp)::date
        WHEN 'month' THEN date_trunc('month', _end_date::timestamp)::date
        ELSE _end_date
      END AS last_bucket,
      CASE _granularity
        WHEN 'week' THEN interval '1 week'
        WHEN 'month' THEN interval '1 month'
        ELSE interval '1 day'
      END AS bucket_step
  ),
  buckets AS MATERIALIZED (
    SELECT generated.bucket::date AS period
    FROM bounds
    CROSS JOIN LATERAL generate_series(
      bounds.first_bucket::timestamp,
      bounds.last_bucket::timestamp,
      bounds.bucket_step
    ) AS generated(bucket)
  ),
  entry_modes(entry_mode, sort_order) AS (
    VALUES
      ('online'::text, 1),
      ('affiliate'::text, 2),
      ('manual'::text, 3),
      ('waitlist'::text, 4)
  ),
  created_facts AS MATERIALIZED (
    SELECT
      reservations.id,
      reservations.party_size,
      reservations.date,
      (reservations.created_at AT TIME ZONE _time_zone)::date AS local_date,
      public._demand_conversion_entry_mode(
        reservations.source,
        reservations.origin_waitlist_id,
        reservations.origin_affiliate_link_id,
        reservations.origin_tracking_session_id,
        reservations.origin_anonymous_id,
        reservations.attribution_snapshot
      ) AS entry_mode
    FROM public.reservations
    WHERE reservations.company_id = _company_id
      AND reservations.created_at >= _start_at
      AND reservations.created_at < _end_at
  ),
  created_bucketed AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', created_facts.local_date::timestamp)::date
        WHEN 'month' THEN date_trunc('month', created_facts.local_date::timestamp)::date
        ELSE created_facts.local_date
      END AS period,
      created_facts.entry_mode,
      count(*)::bigint AS reservations,
      COALESCE(sum(created_facts.party_size), 0)::bigint AS people
    FROM created_facts
    GROUP BY 1, 2
  ),
  created_series AS (
    SELECT
      buckets.period,
      COALESCE(sum(created_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'online'), 0)::bigint AS online_reservations,
      COALESCE(sum(created_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'online'), 0)::bigint AS online_people,
      COALESCE(sum(created_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'affiliate'), 0)::bigint AS affiliate_reservations,
      COALESCE(sum(created_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'affiliate'), 0)::bigint AS affiliate_people,
      COALESCE(sum(created_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'manual'), 0)::bigint AS manual_reservations,
      COALESCE(sum(created_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'manual'), 0)::bigint AS manual_people,
      COALESCE(sum(created_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'waitlist'), 0)::bigint AS waitlist_reservations,
      COALESCE(sum(created_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'waitlist'), 0)::bigint AS waitlist_people
    FROM buckets
    CROSS JOIN entry_modes
    LEFT JOIN created_bucketed
      ON created_bucketed.period = buckets.period
      AND created_bucketed.entry_mode = entry_modes.entry_mode
    GROUP BY buckets.period
  ),
  visit_facts AS MATERIALIZED (
    SELECT
      reservations.id,
      reservations.party_size,
      reservations.date AS local_date,
      public._demand_conversion_entry_mode(
        reservations.source,
        reservations.origin_waitlist_id,
        reservations.origin_affiliate_link_id,
        reservations.origin_tracking_session_id,
        reservations.origin_anonymous_id,
        reservations.attribution_snapshot
      ) AS entry_mode
    FROM public.reservations
    WHERE reservations.company_id = _company_id
      AND reservations.date BETWEEN _start_date AND _end_date
  ),
  visit_bucketed AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', visit_facts.local_date::timestamp)::date
        WHEN 'month' THEN date_trunc('month', visit_facts.local_date::timestamp)::date
        ELSE visit_facts.local_date
      END AS period,
      visit_facts.entry_mode,
      count(*)::bigint AS reservations,
      COALESCE(sum(visit_facts.party_size), 0)::bigint AS people
    FROM visit_facts
    GROUP BY 1, 2
  ),
  visit_series AS (
    SELECT
      buckets.period,
      COALESCE(sum(visit_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'online'), 0)::bigint AS online_reservations,
      COALESCE(sum(visit_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'online'), 0)::bigint AS online_people,
      COALESCE(sum(visit_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'affiliate'), 0)::bigint AS affiliate_reservations,
      COALESCE(sum(visit_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'affiliate'), 0)::bigint AS affiliate_people,
      COALESCE(sum(visit_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'manual'), 0)::bigint AS manual_reservations,
      COALESCE(sum(visit_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'manual'), 0)::bigint AS manual_people,
      COALESCE(sum(visit_bucketed.reservations) FILTER (WHERE entry_modes.entry_mode = 'waitlist'), 0)::bigint AS waitlist_reservations,
      COALESCE(sum(visit_bucketed.people) FILTER (WHERE entry_modes.entry_mode = 'waitlist'), 0)::bigint AS waitlist_people
    FROM buckets
    CROSS JOIN entry_modes
    LEFT JOIN visit_bucketed
      ON visit_bucketed.period = buckets.period
      AND visit_bucketed.entry_mode = entry_modes.entry_mode
    GROUP BY buckets.period
  ),
  lead_time_bucketed AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', created_facts.local_date::timestamp)::date
        WHEN 'month' THEN date_trunc('month', created_facts.local_date::timestamp)::date
        ELSE created_facts.local_date
      END AS period,
      count(*)::bigint AS scheduled_reservations,
      COALESCE(round(avg(GREATEST(created_facts.date - created_facts.local_date, 0)), 1), 0) AS average_lead_days,
      count(*) FILTER (
        WHERE GREATEST(created_facts.date - created_facts.local_date, 0) = 0
      )::bigint AS same_day_reservations
    FROM created_facts
    -- Preserve the historical dashboard definition: queue conversions are not
    -- scheduled reservations and therefore do not enter lead-time analysis.
    WHERE created_facts.entry_mode <> 'waitlist'
    GROUP BY 1
  ),
  lead_time_series AS (
    SELECT
      buckets.period,
      COALESCE(lead_time_bucketed.scheduled_reservations, 0)::bigint AS scheduled_reservations,
      COALESCE(lead_time_bucketed.average_lead_days, 0) AS average_lead_days,
      COALESCE(lead_time_bucketed.same_day_reservations, 0)::bigint AS same_day_reservations,
      COALESCE(round(
        100.0 * lead_time_bucketed.same_day_reservations
          / NULLIF(lead_time_bucketed.scheduled_reservations, 0),
        1
      ), 0) AS same_day_rate
    FROM buckets
    LEFT JOIN lead_time_bucketed USING (period)
  )
  SELECT jsonb_build_object(
    'entry_mode_created_trend', COALESCE((
      SELECT jsonb_agg(to_jsonb(created_series) ORDER BY created_series.period)
      FROM created_series
    ), '[]'::jsonb),
    'entry_mode_visit_trend', COALESCE((
      SELECT jsonb_agg(to_jsonb(visit_series) ORDER BY visit_series.period)
      FROM visit_series
    ), '[]'::jsonb),
    'lead_time_trend', COALESCE((
      SELECT jsonb_agg(to_jsonb(lead_time_series) ORDER BY lead_time_series.period)
      FROM lead_time_series
    ), '[]'::jsonb),
    'meta', jsonb_build_object(
      'period_start', _start_date,
      'period_end', _end_date,
      'time_zone', _time_zone,
      'granularity', _granularity,
      'generated_at', statement_timestamp()
    )
  ) INTO _result;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_demand_temporal_analysis(uuid, date, date, text) IS
  'Series temporais de forma de entrada por captacao e agenda, mais antecedencia das reservas agendadas.';

REVOKE ALL ON FUNCTION public.get_demand_temporal_analysis(uuid, date, date, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_demand_temporal_analysis(uuid, date, date, text)
  TO authenticated, service_role;
