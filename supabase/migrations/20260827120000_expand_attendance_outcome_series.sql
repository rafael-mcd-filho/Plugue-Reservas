-- Phase 1: explicit expected-versus-realized time series for Attendance & Losses.

CREATE OR REPLACE FUNCTION public.get_attendance_outcome_series(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _granularity text DEFAULT 'day',
  _outcome text DEFAULT 'all',
  _entry_method text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
  _effective_outcome text := lower(btrim(COALESCE(_outcome, 'all')));
  _effective_entry_method text := lower(btrim(COALESCE(_entry_method, 'all')));
  _result jsonb;
BEGIN
  PERFORM public._assert_company_advanced_report_access(_company_id);
  PERFORM public._validate_advanced_report_range(_period_start, _period_end, 366);

  IF _granularity IS NULL OR _granularity NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Granularidade invalida.' USING ERRCODE = '22023';
  END IF;
  IF _effective_outcome NOT IN ('all', 'attended', 'no_show', 'cancelled', 'scheduled') THEN
    RAISE EXCEPTION 'outcome invalido.' USING ERRCODE = '22023';
  END IF;
  IF _effective_entry_method NOT IN ('all', 'online', 'affiliate', 'manual', 'waitlist') THEN
    RAISE EXCEPTION 'entry_method invalido.' USING ERRCODE = '22023';
  END IF;

  _time_zone := public._company_report_time_zone(_company_id);

  WITH bounds AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', _period_start::timestamp)::date
        WHEN 'month' THEN date_trunc('month', _period_start::timestamp)::date
        ELSE _period_start
      END AS first_bucket,
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', _period_end::timestamp)::date
        WHEN 'month' THEN date_trunc('month', _period_end::timestamp)::date
        ELSE _period_end
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
  filtered AS MATERIALIZED (
    SELECT
      rows.*,
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', rows.date::timestamp)::date
        WHEN 'month' THEN date_trunc('month', rows.date::timestamp)::date
        ELSE rows.date
      END AS period
    FROM public._attendance_losses_rows(
      _company_id,
      _period_start,
      _period_end,
      _time_zone
    ) AS rows
    WHERE (_effective_outcome = 'all' OR rows.outcome = _effective_outcome)
      AND (_effective_entry_method = 'all' OR rows.entry_method = _effective_entry_method)
  ),
  raw AS (
    SELECT
      buckets.period,
      count(filtered.id)::integer AS reservations,
      count(filtered.id) FILTER (WHERE filtered.outcome = 'attended')::integer AS attended,
      count(filtered.id) FILTER (WHERE filtered.outcome = 'no_show')::integer AS no_show,
      count(filtered.id) FILTER (WHERE filtered.outcome = 'cancelled')::integer AS cancelled,
      count(filtered.id) FILTER (WHERE filtered.outcome = 'scheduled')::integer AS scheduled,
      COALESCE(sum(filtered.party_size), 0)::integer AS reserved_people,
      COALESCE(sum(COALESCE(filtered.checked_in_party_size, filtered.party_size)) FILTER (WHERE filtered.outcome = 'attended'), 0)::integer AS attended_people,
      COALESCE(sum(filtered.party_size) FILTER (WHERE filtered.outcome = 'no_show'), 0)::integer AS no_show_people,
      COALESCE(sum(filtered.party_size) FILTER (WHERE filtered.outcome = 'cancelled'), 0)::integer AS cancelled_people,
      COALESCE(sum(filtered.party_size) FILTER (WHERE filtered.outcome = 'scheduled'), 0)::integer AS scheduled_people
    FROM buckets
    LEFT JOIN filtered ON filtered.period = buckets.period
    GROUP BY buckets.period
  ),
  metrics AS (
    SELECT
      raw.*,
      (raw.no_show_people + raw.cancelled_people)::integer AS lost_people,
      raw.reservations AS expected_reservations,
      raw.attended AS realized_reservations,
      raw.reserved_people AS expected_people,
      raw.attended_people AS realized_people,
      COALESCE(round(100.0 * raw.attended / NULLIF(raw.attended + raw.no_show, 0), 1), 0) AS attendance_rate,
      COALESCE(round(100.0 * raw.no_show / NULLIF(raw.attended + raw.no_show, 0), 1), 0) AS no_show_rate,
      COALESCE(round(100.0 * (raw.no_show + raw.cancelled) / NULLIF(raw.attended + raw.no_show + raw.cancelled, 0), 1), 0) AS loss_rate,
      COALESCE(round(100.0 * raw.attended / NULLIF(raw.reservations, 0), 1), 0) AS realized_reservation_rate,
      COALESCE(round(100.0 * raw.attended_people / NULLIF(raw.reserved_people, 0), 1), 0) AS realized_people_rate
    FROM raw
  )
  SELECT jsonb_build_object(
    'series', COALESCE((
      SELECT jsonb_agg(to_jsonb(metrics) ORDER BY metrics.period)
      FROM metrics
    ), '[]'::jsonb),
    'meta', jsonb_build_object(
      'period_start', _period_start,
      'period_end', _period_end,
      'time_zone', _time_zone,
      'granularity', _granularity,
      'outcome', _effective_outcome,
      'entry_method', _effective_entry_method,
      'attendance_rate_formula', 'attended / (attended + no_show)',
      'realized_rate_formula', 'attended / all_reservations',
      'generated_at', statement_timestamp()
    )
  ) INTO _result;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_attendance_outcome_series(uuid, date, date, text, text, text) IS
  'Serie temporal de resultados em reservas e pessoas, com formulas distintas para comparecimento e realizacao.';

REVOKE ALL ON FUNCTION public.get_attendance_outcome_series(uuid, date, date, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_attendance_outcome_series(uuid, date, date, text, text, text)
  TO authenticated, service_role;
