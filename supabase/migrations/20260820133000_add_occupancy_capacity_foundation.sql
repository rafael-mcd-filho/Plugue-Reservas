-- Occupancy & Capacity advanced report.
--
-- Capacity is frozen as append-only, versioned slot snapshots. The hourly
-- pipeline only captures the company-local current/future calendar, so a past
-- slot is never silently recalculated after its service date. When no snapshot
-- exists (dates before this feature was introduced), report RPCs deliberately
-- fall back to the current configuration and mark the result as estimated.
--
-- This model never attempts to infer table dwell time, turnover, or release.

CREATE TABLE IF NOT EXISTS public.occupancy_capacity_slot_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  service_date date NOT NULL,
  time_slot time NOT NULL,
  version integer NOT NULL,
  is_published boolean NOT NULL DEFAULT true,
  availability_mode text NOT NULL,
  published_capacity integer NOT NULL,
  duration_minutes integer NOT NULL,
  published_table_count integer NOT NULL DEFAULT 0,
  active_table_map_id uuid,
  active_table_map_name text,
  schedule_source text,
  rule_id uuid,
  rule_name text,
  block_id uuid,
  block_name text,
  configuration_hash text NOT NULL,
  configuration_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT occupancy_capacity_snapshot_mode_check
    CHECK (availability_mode IN ('capacity', 'tables')),
  CONSTRAINT occupancy_capacity_snapshot_capacity_check
    CHECK (published_capacity >= 0),
  CONSTRAINT occupancy_capacity_snapshot_duration_check
    CHECK (duration_minutes > 0),
  CONSTRAINT occupancy_capacity_snapshot_table_count_check
    CHECK (published_table_count >= 0),
  CONSTRAINT occupancy_capacity_snapshot_version_check
    CHECK (version > 0),
  CONSTRAINT occupancy_capacity_snapshot_configuration_object_check
    CHECK (jsonb_typeof(configuration_snapshot) = 'object'),
  UNIQUE (company_id, service_date, time_slot, version)
);

ALTER TABLE public.occupancy_capacity_slot_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.occupancy_capacity_snapshot_pipeline_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_company_id uuid,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO public.occupancy_capacity_snapshot_pipeline_state(singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.occupancy_capacity_snapshot_pipeline_state ENABLE ROW LEVEL SECURITY;

-- No interactive role reads/writes the physical projection. All access is
-- mediated by fail-closed SECURITY DEFINER RPCs below.
REVOKE ALL ON TABLE public.occupancy_capacity_slot_snapshots
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.occupancy_capacity_slot_snapshots
  TO service_role;
REVOKE ALL ON TABLE public.occupancy_capacity_snapshot_pipeline_state
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.occupancy_capacity_snapshot_pipeline_state
  TO service_role;

CREATE OR REPLACE FUNCTION public._occupancy_capacity_current_slots(
  _company_id uuid,
  _start_date date,
  _end_date date
)
RETURNS TABLE (
  company_id uuid,
  service_date date,
  time_slot time,
  availability_mode text,
  published_capacity integer,
  duration_minutes integer,
  published_table_count integer,
  active_table_map_id uuid,
  active_table_map_name text,
  schedule_source text,
  rule_id uuid,
  rule_name text,
  block_id uuid,
  block_name text,
  configuration_snapshot jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH company_config AS (
    SELECT
      companies.id,
      public._company_report_time_zone(companies.id) AS time_zone,
      GREATEST(COALESCE(companies.reservation_duration, 30), 1) AS default_duration_minutes,
      NULLIF(companies.max_guests_per_slot, 0) AS company_guest_limit
    FROM public.companies
    WHERE companies.id = _company_id
      AND companies.status = 'active'
  ),
  requested_days AS (
    SELECT generated.day::date AS service_date
    FROM generate_series(_start_date, _end_date, interval '1 day') AS generated(day)
    WHERE _start_date IS NOT NULL
      AND _end_date IS NOT NULL
      AND _end_date >= _start_date
  ),
  resolved_schedule AS (
    SELECT
      company_config.*,
      requested_days.service_date,
      schedule.source AS schedule_source,
      schedule.rule_id,
      schedule.rule_name,
      schedule.block_id,
      schedule.block_name,
      COALESCE(schedule.availability_mode, 'tables') AS availability_mode,
      schedule.default_duration_minutes AS schedule_duration_minutes,
      COALESCE(schedule.slots, '[]'::jsonb) AS slots
    FROM company_config
    CROSS JOIN requested_days
    LEFT JOIN LATERAL public.get_public_reservation_schedule(
      company_config.id,
      requested_days.service_date
    ) AS schedule ON true
    WHERE COALESCE(schedule.source, '') <> 'blocked'
  ),
  slot_list AS (
    SELECT
      resolved_schedule.*,
      slot_value::time AS time_slot
    FROM resolved_schedule
    CROSS JOIN LATERAL jsonb_array_elements_text(resolved_schedule.slots) AS slot_value
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.blocked_dates
      WHERE blocked_dates.company_id = resolved_schedule.id
        AND blocked_dates.date = resolved_schedule.service_date
        AND (
          blocked_dates.all_day
          OR (
            NOT blocked_dates.all_day
            AND slot_value::time >= COALESCE(blocked_dates.start_time, '00:00'::time)
            AND slot_value::time < COALESCE(blocked_dates.end_time, '23:59:59'::time)
          )
        )
    )
  ),
  slot_configuration AS (
    SELECT
      slot_list.*,
      rule_slot.duration_minutes AS slot_duration_minutes,
      rule_slot.max_guests_per_slot AS slot_guest_limit,
      active_map.id AS resolved_table_map_id,
      active_map.name AS resolved_table_map_name,
      COALESCE(table_totals.total_seats, 0)::integer AS total_table_seats,
      COALESCE(table_totals.table_count, 0)::integer AS total_table_count
    FROM slot_list
    LEFT JOIN LATERAL (
      SELECT reservation_schedule_rule_slots.*
      FROM public.reservation_schedule_rule_slots
      WHERE reservation_schedule_rule_slots.time = slot_list.time_slot
        AND (
          (
            slot_list.block_id IS NOT NULL
            AND reservation_schedule_rule_slots.block_id = slot_list.block_id
          )
          OR (
            slot_list.block_id IS NULL
            AND reservation_schedule_rule_slots.block_id IS NULL
            AND reservation_schedule_rule_slots.rule_id = slot_list.rule_id
          )
        )
      ORDER BY
        reservation_schedule_rule_slots.sort_order,
        reservation_schedule_rule_slots.created_at,
        reservation_schedule_rule_slots.id
      LIMIT 1
    ) AS rule_slot ON true
    LEFT JOIN LATERAL public.get_active_table_map(
      slot_list.id,
      (slot_list.service_date + slot_list.time_slot) AT TIME ZONE slot_list.time_zone
    ) AS active_map ON true
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(sum(restaurant_tables.capacity), 0)::integer AS total_seats,
        count(*)::integer AS table_count
      FROM public.restaurant_tables
      WHERE restaurant_tables.company_id = slot_list.id
        AND restaurant_tables.status = 'available'
        AND (
          active_map.id IS NULL
          OR restaurant_tables.table_map_id = active_map.id
        )
    ) AS table_totals ON true
  )
  SELECT
    slot_configuration.id AS company_id,
    slot_configuration.service_date,
    slot_configuration.time_slot,
    slot_configuration.availability_mode,
    CASE
      WHEN slot_configuration.availability_mode = 'capacity'
        THEN GREATEST(COALESCE(
          slot_configuration.slot_guest_limit,
          slot_configuration.company_guest_limit,
          0
        ), 0)
      WHEN slot_configuration.total_table_seats <= 0 THEN 0
      WHEN COALESCE(
        slot_configuration.slot_guest_limit,
        slot_configuration.company_guest_limit
      ) IS NULL THEN slot_configuration.total_table_seats
      ELSE LEAST(
        slot_configuration.total_table_seats,
        COALESCE(
          slot_configuration.slot_guest_limit,
          slot_configuration.company_guest_limit
        )
      )
    END::integer AS published_capacity,
    GREATEST(
      COALESCE(
        slot_configuration.slot_duration_minutes,
        slot_configuration.schedule_duration_minutes,
        slot_configuration.default_duration_minutes,
        30
      ),
      1
    )::integer AS duration_minutes,
    CASE
      WHEN slot_configuration.availability_mode = 'tables'
        THEN slot_configuration.total_table_count
      ELSE 0
    END::integer AS published_table_count,
    slot_configuration.resolved_table_map_id AS active_table_map_id,
    slot_configuration.resolved_table_map_name AS active_table_map_name,
    slot_configuration.schedule_source,
    slot_configuration.rule_id,
    slot_configuration.rule_name,
    slot_configuration.block_id,
    slot_configuration.block_name,
    jsonb_build_object(
      'availability_mode', slot_configuration.availability_mode,
      'slot_guest_limit', slot_configuration.slot_guest_limit,
      'company_guest_limit', slot_configuration.company_guest_limit,
      'table_seats', slot_configuration.total_table_seats,
      'table_count', slot_configuration.total_table_count,
      'active_table_map_id', slot_configuration.resolved_table_map_id,
      'active_table_map_name', slot_configuration.resolved_table_map_name,
      'schedule_source', slot_configuration.schedule_source,
      'rule_id', slot_configuration.rule_id,
      'rule_name', slot_configuration.rule_name,
      'block_id', slot_configuration.block_id,
      'block_name', slot_configuration.block_name
    ) AS configuration_snapshot
  FROM slot_configuration;
$$;

CREATE OR REPLACE FUNCTION public._capture_occupancy_capacity_snapshots(
  _company_id uuid,
  _start_date date,
  _end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
  _local_now timestamp;
  _local_today date;
  _service_date date;
  _slot record;
  _latest record;
  _desired_times time[];
  _configuration_hash text;
  _inserted integer := 0;
  _unchanged integer := 0;
  _unpublished integer := 0;
BEGIN
  PERFORM public._validate_advanced_report_range(_start_date, _end_date, 366);
  _time_zone := public._company_report_time_zone(_company_id);
  _local_now := clock_timestamp() AT TIME ZONE _time_zone;
  _local_today := _local_now::date;

  IF _start_date < _local_today THEN
    RAISE EXCEPTION '%', U&'Snapshots anteriores ao dia local atual n\00E3o podem ser recalculados.'
      USING ERRCODE = '22023';
  END IF;

  -- Serializes version allocation and keeps concurrent cron/manual runs
  -- idempotent for the same company.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('occupancy-capacity|' || _company_id::text, 0)
  );

  FOR _service_date IN
    SELECT generated.day::date
    FROM generate_series(_start_date, _end_date, interval '1 day') AS generated(day)
  LOOP
    _desired_times := '{}'::time[];

    FOR _slot IN
      SELECT *
      FROM public._occupancy_capacity_current_slots(
        _company_id,
        _service_date,
        _service_date
      )
      ORDER BY time_slot
    LOOP
      -- Once a slot has started, its latest frozen version is historical. A
      -- midday configuration change must not rewrite or tombstone the morning.
      IF _service_date = _local_today AND _slot.time_slot <= _local_now::time THEN
        _unchanged := _unchanged + 1;
        CONTINUE;
      END IF;

      _desired_times := array_append(_desired_times, _slot.time_slot);
      _configuration_hash := md5(
        concat_ws(
          '|',
          _slot.availability_mode,
          _slot.published_capacity,
          _slot.duration_minutes,
          _slot.published_table_count,
          COALESCE(_slot.active_table_map_id::text, ''),
          COALESCE(_slot.active_table_map_name, ''),
          COALESCE(_slot.schedule_source, ''),
          COALESCE(_slot.rule_id::text, ''),
          COALESCE(_slot.rule_name, ''),
          COALESCE(_slot.block_id::text, ''),
          COALESCE(_slot.block_name, ''),
          _slot.configuration_snapshot::text,
          'published'
        )
      );

      SELECT snapshots.version, snapshots.configuration_hash, snapshots.is_published
      INTO _latest
      FROM public.occupancy_capacity_slot_snapshots AS snapshots
      WHERE snapshots.company_id = _company_id
        AND snapshots.service_date = _service_date
        AND snapshots.time_slot = _slot.time_slot
      ORDER BY snapshots.version DESC
      LIMIT 1;

      IF FOUND
        AND _latest.configuration_hash = _configuration_hash
        AND _latest.is_published THEN
        _unchanged := _unchanged + 1;
        CONTINUE;
      END IF;

      INSERT INTO public.occupancy_capacity_slot_snapshots (
        company_id,
        service_date,
        time_slot,
        version,
        is_published,
        availability_mode,
        published_capacity,
        duration_minutes,
        published_table_count,
        active_table_map_id,
        active_table_map_name,
        schedule_source,
        rule_id,
        rule_name,
        block_id,
        block_name,
        configuration_hash,
        configuration_snapshot
      ) VALUES (
        _company_id,
        _service_date,
        _slot.time_slot,
        COALESCE(_latest.version, 0) + 1,
        true,
        _slot.availability_mode,
        _slot.published_capacity,
        _slot.duration_minutes,
        _slot.published_table_count,
        _slot.active_table_map_id,
        _slot.active_table_map_name,
        _slot.schedule_source,
        _slot.rule_id,
        _slot.rule_name,
        _slot.block_id,
        _slot.block_name,
        _configuration_hash,
        _slot.configuration_snapshot
      );
      _inserted := _inserted + 1;
    END LOOP;

    -- A removed future slot receives an append-only tombstone version. This
    -- avoids reviving it through the estimated fallback before the next run.
    FOR _latest IN
      WITH latest_versions AS (
        SELECT DISTINCT ON (snapshots.time_slot)
          snapshots.*
        FROM public.occupancy_capacity_slot_snapshots AS snapshots
        WHERE snapshots.company_id = _company_id
          AND snapshots.service_date = _service_date
        ORDER BY snapshots.time_slot, snapshots.version DESC
      )
      SELECT *
      FROM latest_versions
      WHERE latest_versions.is_published
        AND NOT (latest_versions.time_slot = ANY(_desired_times))
        AND (
          _service_date > _local_today
          OR latest_versions.time_slot > _local_now::time
        )
      ORDER BY latest_versions.time_slot
    LOOP
      _configuration_hash := md5(
        concat_ws('|', _latest.configuration_hash, 'unpublished')
      );

      INSERT INTO public.occupancy_capacity_slot_snapshots (
        company_id,
        service_date,
        time_slot,
        version,
        is_published,
        availability_mode,
        published_capacity,
        duration_minutes,
        published_table_count,
        active_table_map_id,
        active_table_map_name,
        schedule_source,
        rule_id,
        rule_name,
        block_id,
        block_name,
        configuration_hash,
        configuration_snapshot
      ) VALUES (
        _company_id,
        _service_date,
        _latest.time_slot,
        _latest.version + 1,
        false,
        _latest.availability_mode,
        0,
        _latest.duration_minutes,
        0,
        _latest.active_table_map_id,
        _latest.active_table_map_name,
        _latest.schedule_source,
        _latest.rule_id,
        _latest.rule_name,
        _latest.block_id,
        _latest.block_name,
        _configuration_hash,
        _latest.configuration_snapshot || jsonb_build_object('unpublished', true)
      );
      _unpublished := _unpublished + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'company_id', _company_id,
    'start_date', _start_date,
    'end_date', _end_date,
    'inserted_versions', _inserted,
    'unchanged_slots', _unchanged,
    'unpublished_slots', _unpublished,
    'time_zone', _time_zone
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._run_occupancy_capacity_snapshot_pipeline(
  _horizon_days integer DEFAULT 90,
  _company_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _company record;
  _start_date date;
  _end_date date;
  _results jsonb := '[]'::jsonb;
  _processed integer := 0;
  _last_company_id uuid;
BEGIN
  IF _horizon_days IS NULL OR _horizon_days < 0 OR _horizon_days > 365 THEN
    RAISE EXCEPTION '%', U&'Horizonte de snapshots inv\00E1lido.' USING ERRCODE = '22023';
  END IF;

  IF _company_limit IS NULL OR _company_limit < 1 OR _company_limit > 1000 THEN
    RAISE EXCEPTION '%', U&'Limite de empresas inv\00E1lido.' USING ERRCODE = '22023';
  END IF;

  -- Cron/manual runs never wait behind an older pipeline. Skipping an overlap
  -- is safe because the next scheduled execution resumes from the same cursor.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('occupancy-capacity-snapshot-pipeline', 0)
  ) THEN
    RETURN jsonb_build_object(
      'skipped', true,
      'reason', 'pipeline_already_running',
      'horizon_days', _horizon_days,
      'requested_company_limit', _company_limit,
      'finished_at', clock_timestamp()
    );
  END IF;

  SELECT pipeline_state.last_company_id
  INTO _last_company_id
  FROM public.occupancy_capacity_snapshot_pipeline_state AS pipeline_state
  WHERE pipeline_state.singleton
  FOR UPDATE;

  UPDATE public.occupancy_capacity_snapshot_pipeline_state
  SET last_started_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE singleton;

  FOR _company IN
    WITH round_robin AS (
      SELECT
        companies.id,
        public._company_report_time_zone(companies.id) AS time_zone,
        CASE WHEN _last_company_id IS NULL OR companies.id > _last_company_id THEN 0 ELSE 1 END AS pass
      FROM public.companies
      WHERE companies.status = 'active'
        AND public.company_feature_enabled(
          companies.id,
          'advanced_reports'
        ) IS TRUE
    )
    SELECT round_robin.id, round_robin.time_zone
    FROM round_robin
    ORDER BY round_robin.pass, round_robin.id
    LIMIT _company_limit
  LOOP
    _start_date := (clock_timestamp() AT TIME ZONE _company.time_zone)::date;
    _end_date := _start_date + _horizon_days;

    BEGIN
      _results := _results || jsonb_build_array(
        public._capture_occupancy_capacity_snapshots(
          _company.id,
          _start_date,
          _end_date
        )
      );
      _processed := _processed + 1;
    EXCEPTION WHEN OTHERS THEN
      _results := _results || jsonb_build_array(jsonb_build_object(
        'company_id', _company.id,
        'error', SQLERRM,
        'sqlstate', SQLSTATE
      ));
    END;

    -- Advance even when one tenant fails so it cannot starve the next tenant.
    UPDATE public.occupancy_capacity_snapshot_pipeline_state
    SET last_company_id = _company.id, updated_at = clock_timestamp()
    WHERE singleton;
  END LOOP;

  UPDATE public.occupancy_capacity_snapshot_pipeline_state
  SET last_finished_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE singleton;

  RETURN jsonb_build_object(
    'skipped', false,
    'processed_companies', _processed,
    'requested_company_limit', _company_limit,
    'horizon_days', _horizon_days,
    'results', _results,
    'finished_at', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_occupancy_capacity_snapshots(
  _company_id uuid,
  _horizon_days integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
  _start_date date;
BEGIN
  PERFORM public._assert_company_advanced_report_access(_company_id);
  IF _horizon_days IS NULL OR _horizon_days < 0 OR _horizon_days > 365 THEN
    RAISE EXCEPTION '%', U&'Horizonte de snapshots inv\00E1lido.' USING ERRCODE = '22023';
  END IF;

  _time_zone := public._company_report_time_zone(_company_id);
  _start_date := (clock_timestamp() AT TIME ZONE _time_zone)::date;
  RETURN public._capture_occupancy_capacity_snapshots(
    _company_id,
    _start_date,
    _start_date + _horizon_days
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._occupancy_capacity_slot_basis(
  _company_id uuid,
  _start_date date,
  _end_date date
)
RETURNS TABLE (
  service_date date,
  time_slot time,
  availability_mode text,
  published_capacity integer,
  duration_minutes integer,
  published_table_count integer,
  active_table_map_id uuid,
  active_table_map_name text,
  snapshot_version integer,
  captured_at timestamptz,
  data_quality text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH requested_days AS (
    SELECT generated.day::date AS service_date
    FROM generate_series(_start_date, _end_date, interval '1 day') AS generated(day)
    WHERE _start_date IS NOT NULL
      AND _end_date IS NOT NULL
      AND _end_date >= _start_date
  ),
  latest_snapshots AS MATERIALIZED (
    SELECT DISTINCT ON (snapshots.service_date, snapshots.time_slot)
      snapshots.*
    FROM public.occupancy_capacity_slot_snapshots AS snapshots
    WHERE snapshots.company_id = _company_id
      AND snapshots.service_date BETWEEN _start_date AND _end_date
    ORDER BY snapshots.service_date, snapshots.time_slot, snapshots.version DESC
  ),
  snapshot_dates AS (
    SELECT DISTINCT latest_snapshots.service_date
    FROM latest_snapshots
  ),
  missing_dates AS (
    SELECT requested_days.service_date
    FROM requested_days
    WHERE NOT EXISTS (
      SELECT 1
      FROM snapshot_dates
      WHERE snapshot_dates.service_date = requested_days.service_date
    )
  ),
  frozen AS (
    SELECT
      latest_snapshots.service_date,
      latest_snapshots.time_slot,
      latest_snapshots.availability_mode,
      latest_snapshots.published_capacity,
      latest_snapshots.duration_minutes,
      latest_snapshots.published_table_count,
      latest_snapshots.active_table_map_id,
      latest_snapshots.active_table_map_name,
      latest_snapshots.version AS snapshot_version,
      latest_snapshots.captured_at,
      'snapshot'::text AS data_quality
    FROM latest_snapshots
    WHERE latest_snapshots.is_published
  ),
  estimated AS (
    SELECT
      current_slots.service_date,
      current_slots.time_slot,
      current_slots.availability_mode,
      current_slots.published_capacity,
      current_slots.duration_minutes,
      current_slots.published_table_count,
      current_slots.active_table_map_id,
      current_slots.active_table_map_name,
      NULL::integer AS snapshot_version,
      NULL::timestamptz AS captured_at,
      'estimated_current_configuration'::text AS data_quality
    FROM missing_dates
    CROSS JOIN LATERAL public._occupancy_capacity_current_slots(
      _company_id,
      missing_dates.service_date,
      missing_dates.service_date
    ) AS current_slots
  )
  SELECT * FROM frozen
  UNION ALL
  SELECT * FROM estimated;
$$;

CREATE OR REPLACE FUNCTION public._validate_occupancy_capacity_filters(
  _granularity text,
  _page integer,
  _page_size integer,
  _availability_mode text,
  _outcome text,
  _maximum_page_size integer DEFAULT 100
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _granularity IS NULL OR _granularity NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION '%', U&'Granularidade inv\00E1lida.' USING ERRCODE = '22023';
  END IF;
  IF _page IS NULL OR _page < 1 THEN
    RAISE EXCEPTION '%', U&'P\00E1gina inv\00E1lida.' USING ERRCODE = '22023';
  END IF;
  IF _page_size IS NULL OR _page_size < 1 OR _page_size > _maximum_page_size THEN
    RAISE EXCEPTION '%', U&'Tamanho de p\00E1gina inv\00E1lido.' USING ERRCODE = '22023';
  END IF;
  IF _availability_mode IS NULL OR _availability_mode NOT IN ('all', 'capacity', 'tables') THEN
    RAISE EXCEPTION '%', U&'Modo de capacidade inv\00E1lido.' USING ERRCODE = '22023';
  END IF;
  IF _outcome IS NULL OR _outcome NOT IN ('all', 'scheduled', 'checked_in', 'no_show', 'cancelled') THEN
    RAISE EXCEPTION '%', U&'Resultado de reserva inv\00E1lido.' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_occupancy_capacity_report(
  _company_id uuid,
  _start_date date,
  _end_date date,
  _granularity text DEFAULT 'day',
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 20,
  _availability_mode text DEFAULT 'all',
  _outcome text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
  _waitlist_start_at timestamptz;
  _waitlist_end_at timestamptz;
  _result jsonb;
BEGIN
  PERFORM public._assert_company_advanced_report_access(_company_id);
  PERFORM public._validate_advanced_report_range(_start_date, _end_date, 366);
  PERFORM public._validate_occupancy_capacity_filters(
    _granularity,
    _page,
    _page_size,
    _availability_mode,
    _outcome,
    100
  );
  _time_zone := public._company_report_time_zone(_company_id);
  _waitlist_start_at := _start_date::timestamp AT TIME ZONE _time_zone;
  _waitlist_end_at := (_end_date + 1)::timestamp AT TIME ZONE _time_zone;

  WITH
  all_basis AS MATERIALIZED (
    SELECT *
    FROM public._occupancy_capacity_slot_basis(_company_id, _start_date, _end_date)
  ),
  basis AS MATERIALIZED (
    SELECT *
    FROM all_basis
    WHERE _availability_mode = 'all'
      OR availability_mode = _availability_mode
  ),
  reservation_facts AS MATERIALIZED (
    SELECT
      reservations.id,
      reservations.company_id,
      reservations.guest_name,
      reservations.guest_phone,
      reservations.guest_email,
      reservations.date,
      reservations.time,
      reservations.party_size,
      reservations.status,
      reservations.table_id,
      restaurant_tables.id AS resolved_table_id,
      reservations.checked_in_at,
      reservations.checked_in_party_size,
      reservations.created_at,
      reservations.public_tracking_code,
      restaurant_tables.number AS table_number,
      restaurant_tables.section AS section_code,
      table_sections.name AS section_name,
      COALESCE(
        CASE
          WHEN reservations.created_in_mode IN ('capacity', 'tables')
            THEN reservations.created_in_mode
          ELSE NULL
        END,
        basis.availability_mode,
        CASE WHEN reservations.table_id IS NULL THEN 'capacity' ELSE 'tables' END
      ) AS effective_mode,
      basis.published_capacity,
      basis.data_quality,
      basis.service_date IS NOT NULL AS has_capacity_basis,
      CASE
        WHEN lower(btrim(reservations.status)) IN ('checked_in', 'completed') THEN 'checked_in'
        WHEN lower(btrim(reservations.status)) IN ('no-show', 'no_show') THEN 'no_show'
        WHEN lower(btrim(reservations.status)) IN (
          'cancelled', 'payment_expired', 'payment_cancelled'
        ) THEN 'cancelled'
        ELSE 'scheduled'
      END AS outcome,
      public.is_reservation_occupying_capacity(
        reservations.id, reservations.status, reservations.created_at
      ) AS occupies_capacity
    FROM public.reservations
    LEFT JOIN all_basis AS basis
      ON basis.service_date = reservations.date
     AND basis.time_slot = reservations.time
    LEFT JOIN public.restaurant_tables
      ON restaurant_tables.id = reservations.table_id
     AND restaurant_tables.company_id = reservations.company_id
    LEFT JOIN public.table_sections
      ON table_sections.company_id = restaurant_tables.company_id
     AND table_sections.code = restaurant_tables.section
    WHERE reservations.company_id = _company_id
      AND reservations.date BETWEEN _start_date AND _end_date
  ),
  reservations_classified AS MATERIALIZED (
    SELECT
      reservation_facts.*,
      (
        reservation_facts.outcome = 'no_show'
        OR COALESCE(reservation_facts.occupies_capacity, false)
      ) AS is_demand,
      CASE
        WHEN reservation_facts.outcome = 'checked_in'
          THEN COALESCE(reservation_facts.checked_in_party_size, reservation_facts.party_size)
        ELSE 0
      END::integer AS checked_in_people,
      CASE
        WHEN reservation_facts.has_capacity_basis
          AND (
            reservation_facts.outcome = 'no_show'
            OR COALESCE(reservation_facts.occupies_capacity, false)
          )
          THEN reservation_facts.party_size
        ELSE 0
      END::integer AS demand_people
    FROM reservation_facts
    WHERE _availability_mode = 'all'
      OR reservation_facts.effective_mode = _availability_mode
  ),
  slot_reservations AS (
    SELECT
      basis.service_date,
      basis.time_slot,
      basis.availability_mode,
      basis.published_capacity,
      basis.data_quality,
      count(reservations_classified.id) FILTER (
        WHERE reservations_classified.is_demand
      )::bigint AS reservations,
      COALESCE(sum(reservations_classified.demand_people), 0)::bigint AS reserved_people,
      count(reservations_classified.id) FILTER (
        WHERE reservations_classified.outcome = 'checked_in'
      )::bigint AS checked_in_reservations,
      COALESCE(sum(reservations_classified.checked_in_people), 0)::bigint AS checked_in_people,
      count(reservations_classified.id) FILTER (
        WHERE reservations_classified.outcome = 'no_show'
      )::bigint AS no_show_reservations,
      COALESCE(sum(reservations_classified.party_size) FILTER (
        WHERE reservations_classified.outcome = 'no_show'
      ), 0)::bigint AS no_show_people
    FROM basis
    LEFT JOIN reservations_classified
      ON reservations_classified.date = basis.service_date
     AND reservations_classified.time = basis.time_slot
    GROUP BY
      basis.service_date,
      basis.time_slot,
      basis.availability_mode,
      basis.published_capacity,
      basis.data_quality
  ),
  reservation_days AS (
    SELECT
      reservations_classified.date AS service_date,
       count(*) FILTER (WHERE has_capacity_basis AND is_demand)::bigint AS reservations,
      COALESCE(sum(demand_people), 0)::bigint AS reserved_people,
       count(*) FILTER (WHERE has_capacity_basis AND outcome = 'checked_in')::bigint AS checked_in_reservations,
       COALESCE(sum(checked_in_people) FILTER (WHERE has_capacity_basis), 0)::bigint AS checked_in_people,
       count(*) FILTER (WHERE has_capacity_basis AND outcome = 'no_show')::bigint AS no_show_reservations,
       COALESCE(sum(party_size) FILTER (WHERE has_capacity_basis AND outcome = 'no_show'), 0)::bigint AS no_show_people
    FROM reservations_classified
    GROUP BY reservations_classified.date
  ),
  capacity_days AS (
    SELECT
      basis.service_date,
      COALESCE(sum(basis.published_capacity), 0)::bigint AS published_capacity,
      count(*)::bigint AS slot_count,
      count(*) FILTER (WHERE basis.availability_mode = 'capacity')::bigint AS capacity_slots,
      count(*) FILTER (WHERE basis.availability_mode = 'tables')::bigint AS table_slots,
      count(*) FILTER (WHERE basis.data_quality = 'snapshot')::bigint AS snapshot_slots,
      count(*) FILTER (
        WHERE basis.data_quality = 'estimated_current_configuration'
      )::bigint AS estimated_slots
    FROM basis
    GROUP BY basis.service_date
  ),
  requested_days AS (
    SELECT generated.day::date AS service_date
    FROM generate_series(_start_date, _end_date, interval '1 day') AS generated(day)
  ),
  daily AS (
    SELECT
      requested_days.service_date,
      COALESCE(capacity_days.published_capacity, 0)::bigint AS published_capacity,
      COALESCE(capacity_days.slot_count, 0)::bigint AS slot_count,
      COALESCE(capacity_days.capacity_slots, 0)::bigint AS capacity_slots,
      COALESCE(capacity_days.table_slots, 0)::bigint AS table_slots,
      COALESCE(capacity_days.snapshot_slots, 0)::bigint AS snapshot_slots,
      COALESCE(capacity_days.estimated_slots, 0)::bigint AS estimated_slots,
      COALESCE(reservation_days.reservations, 0)::bigint AS reservations,
      COALESCE(reservation_days.reserved_people, 0)::bigint AS reserved_people,
      COALESCE(reservation_days.checked_in_reservations, 0)::bigint AS checked_in_reservations,
      COALESCE(reservation_days.checked_in_people, 0)::bigint AS checked_in_people,
      COALESCE(reservation_days.no_show_reservations, 0)::bigint AS no_show_reservations,
      COALESCE(reservation_days.no_show_people, 0)::bigint AS no_show_people
    FROM requested_days
    LEFT JOIN capacity_days USING (service_date)
    LEFT JOIN reservation_days USING (service_date)
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
  grouped_daily AS (
    SELECT
      date_trunc(_granularity, daily.service_date::timestamp)::date AS bucket,
      sum(daily.published_capacity)::bigint AS published_capacity,
      sum(daily.slot_count)::bigint AS slot_count,
      sum(daily.reservations)::bigint AS reservations,
      sum(daily.reserved_people)::bigint AS reserved_people,
      sum(daily.checked_in_reservations)::bigint AS checked_in_reservations,
      sum(daily.checked_in_people)::bigint AS checked_in_people,
      sum(daily.no_show_reservations)::bigint AS no_show_reservations,
      sum(daily.no_show_people)::bigint AS no_show_people
    FROM daily
    GROUP BY bucket
  ),
  series_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'period', series_buckets.bucket,
      'published_capacity', COALESCE(grouped_daily.published_capacity, 0),
      'slot_count', COALESCE(grouped_daily.slot_count, 0),
      'reservations', COALESCE(grouped_daily.reservations, 0),
      'reserved_people', COALESCE(grouped_daily.reserved_people, 0),
      'checked_in_reservations', COALESCE(grouped_daily.checked_in_reservations, 0),
      'checked_in_people', COALESCE(grouped_daily.checked_in_people, 0),
      'no_show_reservations', COALESCE(grouped_daily.no_show_reservations, 0),
      'no_show_people', COALESCE(grouped_daily.no_show_people, 0),
      'capacity_pressure_rate', CASE
        WHEN COALESCE(grouped_daily.published_capacity, 0) = 0 THEN 0
        ELSE round(100.0 * grouped_daily.reserved_people / grouped_daily.published_capacity, 1)
      END,
      'check_in_capacity_rate', CASE
        WHEN COALESCE(grouped_daily.published_capacity, 0) = 0 THEN 0
        ELSE round(100.0 * grouped_daily.checked_in_people / grouped_daily.published_capacity, 1)
      END
    ) ORDER BY series_buckets.bucket), '[]'::jsonb) AS value
    FROM series_buckets
    LEFT JOIN grouped_daily ON grouped_daily.bucket = series_buckets.bucket
  ),
  heatmap_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'weekday', heatmap.weekday,
      'weekday_label', heatmap.weekday_label,
      'time_slot', heatmap.time_slot,
      'slot_count', heatmap.slot_count,
      'published_capacity', heatmap.published_capacity,
      'reserved_people', heatmap.reserved_people,
      'checked_in_people', heatmap.checked_in_people,
      'no_show_reservations', heatmap.no_show_reservations,
      'capacity_pressure_rate', CASE
        WHEN heatmap.published_capacity = 0 THEN 0
        ELSE round(100.0 * heatmap.reserved_people / heatmap.published_capacity, 1)
      END,
      'check_in_capacity_rate', CASE
        WHEN heatmap.published_capacity = 0 THEN 0
        ELSE round(100.0 * heatmap.checked_in_people / heatmap.published_capacity, 1)
      END,
      'data_quality', CASE
        WHEN heatmap.estimated_slots = 0 THEN 'snapshot'
        WHEN heatmap.snapshot_slots = 0 THEN 'estimated_current_configuration'
        ELSE 'mixed'
      END
    ) ORDER BY heatmap.weekday, heatmap.time_slot), '[]'::jsonb) AS value
    FROM (
      SELECT
        EXTRACT(DOW FROM slot_reservations.service_date)::integer AS weekday,
        (ARRAY['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', U&'S\00E1b'])[
          EXTRACT(DOW FROM slot_reservations.service_date)::integer + 1
        ] AS weekday_label,
        slot_reservations.time_slot,
        count(*)::bigint AS slot_count,
        sum(slot_reservations.published_capacity)::bigint AS published_capacity,
        sum(slot_reservations.reserved_people)::bigint AS reserved_people,
        sum(slot_reservations.checked_in_people)::bigint AS checked_in_people,
        sum(slot_reservations.no_show_reservations)::bigint AS no_show_reservations,
        count(*) FILTER (WHERE slot_reservations.data_quality = 'snapshot')::bigint AS snapshot_slots,
        count(*) FILTER (
          WHERE slot_reservations.data_quality = 'estimated_current_configuration'
        )::bigint AS estimated_slots
      FROM slot_reservations
      GROUP BY weekday, weekday_label, slot_reservations.time_slot
    ) AS heatmap
  ),
  waitlist_facts AS MATERIALIZED (
    SELECT
      waitlist.id,
      waitlist.party_size,
      waitlist.status,
      waitlist.created_at,
      waitlist.seated_at,
      waitlist.expired_at,
      waitlist.removed_at,
      (waitlist.created_at AT TIME ZONE _time_zone)::date AS local_date,
      date_trunc('hour', waitlist.created_at AT TIME ZONE _time_zone)::time AS local_hour
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.created_at >= _waitlist_start_at
      AND waitlist.created_at < _waitlist_end_at
  ),
  waitlist_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'hour', waitlist_hour.local_hour,
      'entries', waitlist_hour.entries,
      'people', waitlist_hour.people,
      'seated', waitlist_hour.seated,
      'dropped', waitlist_hour.dropped,
      'average_wait_minutes', waitlist_hour.average_wait_minutes
    ) ORDER BY waitlist_hour.local_hour), '[]'::jsonb) AS value
    FROM (
      SELECT
        waitlist_facts.local_hour,
        count(*)::bigint AS entries,
        COALESCE(sum(waitlist_facts.party_size), 0)::bigint AS people,
        count(*) FILTER (
          WHERE waitlist_facts.status = 'seated' OR waitlist_facts.seated_at IS NOT NULL
        )::bigint AS seated,
        count(*) FILTER (
          WHERE waitlist_facts.status IN ('expired', 'removed')
        )::bigint AS dropped,
        COALESCE(round(avg(
          EXTRACT(EPOCH FROM (waitlist_facts.seated_at - waitlist_facts.created_at)) / 60.0
        ) FILTER (WHERE waitlist_facts.seated_at IS NOT NULL), 1), 0) AS average_wait_minutes
      FROM waitlist_facts
      GROUP BY waitlist_facts.local_hour
    ) AS waitlist_hour
  ),
  no_show_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'hour', no_show_hour.local_hour,
      'reservations', no_show_hour.reservations,
      'people', no_show_hour.people,
      'eligible_reservations', no_show_hour.eligible_reservations,
      'rate', CASE
        WHEN no_show_hour.eligible_reservations = 0 THEN 0
        ELSE round(100.0 * no_show_hour.reservations / no_show_hour.eligible_reservations, 1)
      END
    ) ORDER BY no_show_hour.local_hour), '[]'::jsonb) AS value
    FROM (
      SELECT
        make_time(
          EXTRACT(HOUR FROM reservations_classified.time)::integer,
          0,
          0
        ) AS local_hour,
        count(*) FILTER (WHERE outcome = 'no_show')::bigint AS reservations,
        COALESCE(sum(party_size) FILTER (WHERE outcome = 'no_show'), 0)::bigint AS people,
        count(*) FILTER (WHERE outcome IN ('checked_in', 'no_show'))::bigint AS eligible_reservations
      FROM reservations_classified
      GROUP BY local_hour
    ) AS no_show_hour
  ),
  table_breakdown_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'section_code', table_breakdown.section_code,
      'section_name', table_breakdown.section_name,
      'table_id', table_breakdown.table_id,
      'table_number', table_breakdown.table_number,
      'reservations', table_breakdown.reservations,
      'reserved_people', table_breakdown.reserved_people,
      'checked_in_reservations', table_breakdown.checked_in_reservations,
      'checked_in_people', table_breakdown.checked_in_people
    ) ORDER BY table_breakdown.section_name, table_breakdown.table_number), '[]'::jsonb) AS value
    FROM (
      SELECT
        reservations_classified.section_code,
        COALESCE(
          reservations_classified.section_name,
          initcap(replace(reservations_classified.section_code, '-', ' ')),
          U&'Sem se\00E7\00E3o'
        ) AS section_name,
        reservations_classified.resolved_table_id AS table_id,
        reservations_classified.table_number,
        count(*)::bigint AS reservations,
        COALESCE(sum(demand_people), 0)::bigint AS reserved_people,
        count(*) FILTER (WHERE outcome = 'checked_in')::bigint AS checked_in_reservations,
        COALESCE(sum(checked_in_people), 0)::bigint AS checked_in_people
      FROM reservations_classified
      WHERE reservations_classified.effective_mode = 'tables'
        AND reservations_classified.resolved_table_id IS NOT NULL
        AND reservations_classified.is_demand
      GROUP BY 1, 2, 3, 4
    ) AS table_breakdown
  ),
  filtered_details AS (
    SELECT *
    FROM reservations_classified
    WHERE (_availability_mode = 'all' OR effective_mode = _availability_mode)
      AND (_outcome = 'all' OR outcome = _outcome)
  ),
  detail_stats AS (
    SELECT count(*)::bigint AS details_total
    FROM filtered_details
  ),
  page_context AS (
    SELECT
      detail_stats.details_total,
      LEAST(
        _page,
        GREATEST(1, CEIL(detail_stats.details_total::numeric / _page_size)::integer)
      ) AS effective_page
    FROM detail_stats
  ),
  paged_details AS (
    SELECT *
    FROM filtered_details
    ORDER BY date DESC, time DESC, id DESC
    LIMIT _page_size
    OFFSET ((SELECT effective_page FROM page_context) - 1) * _page_size
  ),
  details_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', paged_details.id,
      'guest_name', paged_details.guest_name,
      'guest_phone', paged_details.guest_phone,
      'guest_email', paged_details.guest_email,
      'date', paged_details.date,
      'time', paged_details.time,
      'party_size', paged_details.party_size,
      'status', paged_details.status,
      'outcome', paged_details.outcome,
      'availability_mode', paged_details.effective_mode,
      'published_capacity', paged_details.published_capacity,
      'data_quality', paged_details.data_quality,
      'capacity_basis_available', paged_details.has_capacity_basis,
      'counts_toward_capacity', paged_details.is_demand,
      'checked_in_at', paged_details.checked_in_at,
      'checked_in_party_size', paged_details.checked_in_party_size,
      'table_id', paged_details.resolved_table_id,
      'table_number', paged_details.table_number,
      'section_code', paged_details.section_code,
      'section_name', paged_details.section_name,
      'created_at', paged_details.created_at,
      'public_tracking_code', paged_details.public_tracking_code
    ) ORDER BY paged_details.date DESC, paged_details.time DESC, paged_details.id DESC), '[]'::jsonb) AS value
    FROM paged_details
  ),
  aggregate_summary AS (
    SELECT
      sum(daily.published_capacity)::bigint AS published_capacity,
      sum(daily.slot_count)::bigint AS slot_count,
      sum(daily.capacity_slots)::bigint AS capacity_slots,
      sum(daily.table_slots)::bigint AS table_slots,
      sum(daily.snapshot_slots)::bigint AS snapshot_slots,
      sum(daily.estimated_slots)::bigint AS estimated_slots,
      sum(daily.reservations)::bigint AS reservations,
      sum(daily.reserved_people)::bigint AS reserved_people,
      sum(daily.checked_in_reservations)::bigint AS checked_in_reservations,
      sum(daily.checked_in_people)::bigint AS checked_in_people,
      sum(daily.no_show_reservations)::bigint AS no_show_reservations,
      sum(daily.no_show_people)::bigint AS no_show_people
    FROM daily
  ),
  waitlist_summary AS (
    SELECT
      count(*)::bigint AS entries,
      COALESCE(sum(waitlist_facts.party_size), 0)::bigint AS people,
      count(*) FILTER (
        WHERE waitlist_facts.status = 'seated' OR waitlist_facts.seated_at IS NOT NULL
      )::bigint AS seated,
      count(*) FILTER (
        WHERE waitlist_facts.status IN ('expired', 'removed')
      )::bigint AS dropped,
      COALESCE(round(avg(
        EXTRACT(EPOCH FROM (waitlist_facts.seated_at - waitlist_facts.created_at)) / 60.0
      ) FILTER (WHERE waitlist_facts.seated_at IS NOT NULL), 1), 0) AS average_wait_minutes
    FROM waitlist_facts
  ),
  unmatched_summary AS (
    SELECT
      count(*) FILTER (
        WHERE NOT has_capacity_basis AND is_demand
      )::bigint AS reservations,
      COALESCE(sum(party_size) FILTER (
        WHERE NOT has_capacity_basis AND is_demand
      ), 0)::bigint AS people
    FROM reservations_classified
  ),
  assignment_coverage AS (
    SELECT
      count(*) FILTER (
        WHERE effective_mode = 'tables' AND is_demand
      )::bigint AS eligible_reservations,
      count(*) FILTER (
        WHERE effective_mode = 'tables' AND is_demand AND resolved_table_id IS NOT NULL
      )::bigint AS assigned_reservations,
      count(*) FILTER (
        WHERE effective_mode = 'tables' AND is_demand AND resolved_table_id IS NULL
      )::bigint AS unassigned_reservations
    FROM reservations_classified
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'published_capacity', aggregate_summary.published_capacity,
      'slot_count', aggregate_summary.slot_count,
      'capacity_slots', aggregate_summary.capacity_slots,
      'table_slots', aggregate_summary.table_slots,
      'snapshot_slots', aggregate_summary.snapshot_slots,
      'estimated_slots', aggregate_summary.estimated_slots,
      'reservations', aggregate_summary.reservations,
      'reserved_people', aggregate_summary.reserved_people,
      'checked_in_reservations', aggregate_summary.checked_in_reservations,
      'checked_in_people', aggregate_summary.checked_in_people,
      'no_show_reservations', aggregate_summary.no_show_reservations,
      'no_show_people', aggregate_summary.no_show_people,
      'unmatched_reservations', unmatched_summary.reservations,
      'unmatched_people', unmatched_summary.people,
      'capacity_pressure_rate', CASE
        WHEN aggregate_summary.published_capacity = 0 THEN 0
        ELSE round(100.0 * aggregate_summary.reserved_people / aggregate_summary.published_capacity, 1)
      END,
      'check_in_capacity_rate', CASE
        WHEN aggregate_summary.published_capacity = 0 THEN 0
        ELSE round(100.0 * aggregate_summary.checked_in_people / aggregate_summary.published_capacity, 1)
      END,
      'waitlist_entries', waitlist_summary.entries,
      'waitlist_people', waitlist_summary.people,
      'waitlist_seated', waitlist_summary.seated,
      'waitlist_dropped', waitlist_summary.dropped,
      'average_wait_minutes', waitlist_summary.average_wait_minutes
    ),
    'series', series_json.value,
    'heatmap', heatmap_json.value,
    'waitlist_by_hour', waitlist_json.value,
    'no_show_by_hour', no_show_json.value,
    'table_breakdown', table_breakdown_json.value,
    'table_assignment', jsonb_build_object(
      'eligible_reservations', assignment_coverage.eligible_reservations,
      'assigned_reservations', assignment_coverage.assigned_reservations,
      'unassigned_reservations', assignment_coverage.unassigned_reservations,
      'coverage_rate', CASE
        WHEN assignment_coverage.eligible_reservations = 0 THEN 0
        ELSE round(
          100.0 * assignment_coverage.assigned_reservations
            / assignment_coverage.eligible_reservations,
          1
        )
      END
    ),
    'details', details_json.value,
    'meta', jsonb_build_object(
      'period_start', _start_date,
      'period_end', _end_date,
      'time_zone', _time_zone,
      'granularity', _granularity,
      'page', page_context.effective_page,
      'page_size', _page_size,
      'details_total', page_context.details_total,
      'unmatched_reservations', unmatched_summary.reservations,
      'unmatched_people', unmatched_summary.people,
      'availability_mode', _availability_mode,
      'outcome', _outcome,
      'generated_at', statement_timestamp(),
      'capacity_history', CASE
        WHEN aggregate_summary.slot_count = 0 OR aggregate_summary.published_capacity <= 0 THEN 'unavailable'
        WHEN aggregate_summary.estimated_slots = 0 THEN 'snapshot'
        WHEN aggregate_summary.snapshot_slots = 0 THEN 'estimated_current_configuration'
        ELSE 'mixed'
      END,
      'estimation_notice', CASE
        WHEN aggregate_summary.slot_count = 0 OR aggregate_summary.published_capacity <= 0
          THEN U&'Nenhuma capacidade publicada foi encontrada no per\00EDodo. Taxas de press\00E3o e ocupa\00E7\00E3o ficam indispon\00EDveis at\00E9 existir uma base de capacidade.'
        WHEN aggregate_summary.estimated_slots > 0
          THEN U&'Parte do per\00EDodo usa uma estimativa baseada na configura\00E7\00E3o atual; n\00E3o representa um snapshot hist\00F3rico.'
        ELSE NULL
      END,
      'unmatched_notice', CASE
        WHEN unmatched_summary.reservations > 0
          THEN format(
            U&'%s reserva(s), somando %s pessoa(s), n\00E3o coincidem com um slot de capacidade publicado e foram exclu\00EDdas das taxas de press\00E3o e ocupa\00E7\00E3o.',
            unmatched_summary.reservations,
            unmatched_summary.people
          )
        ELSE NULL
      END
    )
  ) INTO _result
  FROM aggregate_summary
  CROSS JOIN waitlist_summary
  CROSS JOIN unmatched_summary
  CROSS JOIN assignment_coverage
  CROSS JOIN page_context
  CROSS JOIN series_json
  CROSS JOIN heatmap_json
  CROSS JOIN waitlist_json
  CROSS JOIN no_show_json
  CROSS JOIN table_breakdown_json
  CROSS JOIN details_json;

  RETURN _result;
END;
$$;

COMMENT ON TABLE public.occupancy_capacity_slot_snapshots IS
  U&'Snapshots append-only e versionados da capacidade publicada por empresa, data e hor\00E1rio.';
COMMENT ON FUNCTION public.get_occupancy_capacity_report(
  uuid, date, date, text, integer, integer, text, text
) IS
  U&'Relat\00F3rio de ocupa\00E7\00E3o/capacidade sem infer\00EAncia de perman\00EAncia ou giro; hist\00F3rico sem snapshot \00E9 explicitamente estimado.';

REVOKE ALL ON FUNCTION public._occupancy_capacity_current_slots(uuid, date, date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._capture_occupancy_capacity_snapshots(uuid, date, date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._run_occupancy_capacity_snapshot_pipeline(integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._occupancy_capacity_slot_basis(uuid, date, date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._validate_occupancy_capacity_filters(
  text, integer, integer, text, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_occupancy_capacity_snapshots(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_occupancy_capacity_report(
  uuid, date, date, text, integer, integer, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public._occupancy_capacity_current_slots(uuid, date, date)
  TO service_role;
GRANT EXECUTE ON FUNCTION public._capture_occupancy_capacity_snapshots(uuid, date, date)
  TO service_role;
GRANT EXECUTE ON FUNCTION public._run_occupancy_capacity_snapshot_pipeline(integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public._occupancy_capacity_slot_basis(uuid, date, date)
  TO service_role;
GRANT EXECUTE ON FUNCTION public._validate_occupancy_capacity_filters(
  text, integer, integer, text, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_occupancy_capacity_snapshots(uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_occupancy_capacity_report(
  uuid, date, date, text, integer, integer, text, text
) TO authenticated, service_role;
