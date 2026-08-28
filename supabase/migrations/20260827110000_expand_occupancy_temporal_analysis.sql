-- Phase 1: event-time waitlist series for Occupancy & Capacity.

CREATE OR REPLACE FUNCTION public.get_occupancy_waitlist_series(
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
  events AS MATERIALIZED (
    SELECT
      waitlist.created_at AS event_at,
      'entry'::text AS event_kind,
      waitlist.party_size::bigint AS people,
      NULL::numeric AS wait_minutes
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.created_at >= _start_at
      AND waitlist.created_at < _end_at

    UNION ALL

    SELECT
      waitlist.seated_at,
      'seated',
      COALESCE(waitlist.seated_party_size, waitlist.party_size)::bigint,
      GREATEST(
        0,
        extract(epoch FROM (waitlist.seated_at - waitlist.created_at))::numeric / 60.0
      )
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.seated_at >= _start_at
      AND waitlist.seated_at < _end_at

    UNION ALL

    -- Keep the status-specific timestamp precedence used by the operational
    -- flow, but expose each timestamp directly to PostgreSQL.  The four arms
    -- are mutually exclusive, so a row with both timestamps is counted only
    -- once while legacy rows with only the fallback timestamp remain visible.
    SELECT
      waitlist.expired_at,
      'dropped',
      waitlist.party_size::bigint,
      NULL::numeric
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'expired'
      AND waitlist.expired_at >= _start_at
      AND waitlist.expired_at < _end_at

    UNION ALL

    SELECT
      waitlist.removed_at,
      'dropped',
      waitlist.party_size::bigint,
      NULL::numeric
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'expired'
      AND waitlist.expired_at IS NULL
      AND waitlist.removed_at >= _start_at
      AND waitlist.removed_at < _end_at

    UNION ALL

    SELECT
      waitlist.removed_at,
      'dropped',
      waitlist.party_size::bigint,
      NULL::numeric
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'removed'
      AND waitlist.removed_at >= _start_at
      AND waitlist.removed_at < _end_at

    UNION ALL

    SELECT
      waitlist.expired_at,
      'dropped',
      waitlist.party_size::bigint,
      NULL::numeric
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'removed'
      AND waitlist.removed_at IS NULL
      AND waitlist.expired_at >= _start_at
      AND waitlist.expired_at < _end_at
  ),
  bucketed AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', events.event_at AT TIME ZONE _time_zone)::date
        WHEN 'month' THEN date_trunc('month', events.event_at AT TIME ZONE _time_zone)::date
        ELSE (events.event_at AT TIME ZONE _time_zone)::date
      END AS period,
      events.event_kind,
      events.people,
      events.wait_minutes
    FROM events
  ),
  series AS (
    SELECT
      buckets.period,
      count(*) FILTER (WHERE bucketed.event_kind = 'entry')::bigint AS entries,
      COALESCE(sum(bucketed.people) FILTER (WHERE bucketed.event_kind = 'entry'), 0)::bigint AS entry_people,
      count(*) FILTER (WHERE bucketed.event_kind = 'seated')::bigint AS seated,
      COALESCE(sum(bucketed.people) FILTER (WHERE bucketed.event_kind = 'seated'), 0)::bigint AS seated_people,
      count(*) FILTER (WHERE bucketed.event_kind = 'dropped')::bigint AS dropped,
      COALESCE(sum(bucketed.people) FILTER (WHERE bucketed.event_kind = 'dropped'), 0)::bigint AS dropped_people,
      COALESCE(round(avg(bucketed.wait_minutes) FILTER (WHERE bucketed.event_kind = 'seated'), 1), 0) AS average_wait_minutes
    FROM buckets
    LEFT JOIN bucketed ON bucketed.period = buckets.period
    GROUP BY buckets.period
  )
  SELECT jsonb_build_object(
    'series', COALESCE((
      SELECT jsonb_agg(to_jsonb(series) ORDER BY series.period)
      FROM series
    ), '[]'::jsonb),
    'meta', jsonb_build_object(
      'period_start', _start_date,
      'period_end', _end_date,
      'time_zone', _time_zone,
      'granularity', _granularity,
      'event_semantics', 'event_timestamp',
      'generated_at', statement_timestamp()
    )
  ) INTO _result;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_occupancy_waitlist_series(uuid, date, date, text) IS
  'Fluxo temporal da fila por horario real de entrada, atendimento e saida, sem taxa de conversao entre coortes diferentes.';

REVOKE ALL ON FUNCTION public.get_occupancy_waitlist_series(uuid, date, date, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_occupancy_waitlist_series(uuid, date, date, text)
  TO authenticated, service_role;
