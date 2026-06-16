-- Complete public reservation capacity contract after active-map hotfix.
--
-- Restores the full availability response expected by the app while preserving
-- the active table-map capacity guard introduced after the capacity foundation.
-- The public create RPC now resolves duration and limits from the configured
-- schedule slot, so client-provided values cannot bypass rule settings.

ALTER TABLE public.reservation_schedule_rule_slots
  DROP CONSTRAINT IF EXISTS reservation_schedule_rule_slots_rule_id_time_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_schedule_rule_slots_block_time
  ON public.reservation_schedule_rule_slots(block_id, time)
  WHERE block_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_schedule_rule_slots_rule_time_legacy
  ON public.reservation_schedule_rule_slots(rule_id, time)
  WHERE block_id IS NULL;

DROP FUNCTION IF EXISTS public.get_public_reservation_availability(uuid, date, integer);

CREATE OR REPLACE FUNCTION public.get_public_reservation_availability(
  _company_id uuid,
  _date date,
  _party_size integer
)
RETURNS TABLE (
  time_slot time,
  available boolean,
  unavailable_reason text,
  total_tables integer,
  occupied_tables integer,
  available_tables integer,
  total_guests integer,
  reservation_count integer,
  max_party_size_per_reservation integer,
  max_reservations_per_slot integer,
  availability_mode text,
  duration_minutes integer,
  max_guests_per_slot integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company AS (
    SELECT
      c.id,
      GREATEST(COALESCE(c.reservation_duration, 30), 1) AS duration_minutes,
      COALESCE(c.max_guests_per_slot, 0) AS max_guests_per_slot
    FROM public.companies c
    WHERE c.id = _company_id
      AND c.status = 'active'
    LIMIT 1
  ),
  schedule AS (
    SELECT resolved.*
    FROM public.get_public_reservation_schedule(_company_id, _date) resolved
    WHERE resolved.source <> 'blocked'
  ),
  allowed_slots AS (
    SELECT
      slot_value::time AS time_slot,
      schedule.rule_id,
      schedule.block_id,
      schedule.availability_mode,
      schedule.default_duration_minutes,
      schedule.max_party_size_per_reservation AS rule_max_party_size
    FROM schedule
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(schedule.slots, '[]'::jsonb)) slot_value
  ),
  resolved_slots AS (
    SELECT
      allowed.time_slot,
      COALESCE(allowed.availability_mode, 'tables') AS availability_mode,
      GREATEST(COALESCE(slot.duration_minutes, allowed.default_duration_minutes, company.duration_minutes, 30), 1) AS duration_minutes,
      COALESCE(slot.max_party_size_per_reservation, allowed.rule_max_party_size) AS max_party_size_per_reservation,
      slot.max_reservations_per_slot,
      slot.max_guests_per_slot,
      company.max_guests_per_slot AS company_max_guests_per_slot,
      EXISTS (
        SELECT 1
        FROM public.blocked_dates bd
        WHERE bd.company_id = _company_id
          AND bd.date = _date
          AND (
            bd.all_day = true
            OR (
              bd.all_day = false
              AND allowed.time_slot >= COALESCE(bd.start_time, '00:00'::time)
              AND allowed.time_slot < COALESCE(bd.end_time, '23:59:59'::time)
            )
          )
      ) AS is_blocked
    FROM allowed_slots allowed
    CROSS JOIN company
    LEFT JOIN LATERAL (
      SELECT rule_slot.*
      FROM public.reservation_schedule_rule_slots rule_slot
      WHERE rule_slot.time = allowed.time_slot
        AND (
          rule_slot.block_id = allowed.block_id
          OR (
            rule_slot.block_id IS NULL
            AND rule_slot.rule_id = allowed.rule_id
          )
        )
      ORDER BY
        CASE WHEN rule_slot.block_id = allowed.block_id THEN 0 ELSE 1 END,
        rule_slot.sort_order ASC,
        rule_slot.created_at ASC
      LIMIT 1
    ) slot ON true
  ),
  slot_context AS (
    SELECT
      resolved.*,
      active_map.id AS active_table_map_id
    FROM resolved_slots resolved
    LEFT JOIN LATERAL public.get_active_table_map(
      _company_id,
      (_date + resolved.time_slot)::timestamptz
    ) active_map ON true
  ),
  slot_metrics AS (
    SELECT
      context.*,
      (
        SELECT COALESCE(sum(r.party_size), 0)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
          AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
          AND (
            _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
          ) > (_date + context.time_slot)
      ) AS overlapping_guest_count,
      (
        SELECT count(*)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND r.time = context.time_slot
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      ) AS same_time_reservation_count,
      CASE
        WHEN context.availability_mode = 'capacity' THEN COALESCE(context.max_guests_per_slot, 0)
        ELSE (
          SELECT count(*)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
        )
      END AS total_units,
      CASE
        WHEN context.availability_mode = 'capacity' THEN (
          SELECT COALESCE(sum(r.party_size), 0)::integer
          FROM public.reservations r
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
        ELSE (
          SELECT count(DISTINCT r.table_id)::integer
          FROM public.reservations r
          JOIN public.restaurant_tables rt ON rt.id = r.table_id
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
      END AS occupied_units,
      CASE
        WHEN context.availability_mode = 'capacity' THEN GREATEST(COALESCE(context.max_guests_per_slot, 0) - (
          SELECT COALESCE(sum(r.party_size), 0)::integer
          FROM public.reservations r
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        ), 0)
        ELSE (
          SELECT count(*)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
            AND NOT EXISTS (
              SELECT 1
              FROM public.reservations r
              WHERE r.company_id = _company_id
                AND r.date = _date
                AND r.table_id = rt.id
                AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
                AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
                AND (
                  _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
                ) > (_date + context.time_slot)
            )
        )
      END AS available_units,
      (
        SELECT count(*)::integer
        FROM public.restaurant_tables rt
        WHERE rt.company_id = _company_id
          AND rt.status = 'available'
          AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
      ) AS active_table_reservation_capacity,
      (
        SELECT count(*)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
          AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
          AND (
            _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
          ) > (_date + context.time_slot)
      ) AS active_reservation_count
    FROM slot_context context
  ),
  normalized_metrics AS (
    SELECT
      metrics.*,
      CASE
        WHEN metrics.availability_mode = 'tables' THEN LEAST(
          metrics.available_units,
          GREATEST(metrics.active_table_reservation_capacity - metrics.active_reservation_count, 0)
        )
        ELSE metrics.available_units
      END AS effective_available_units,
      CASE
        WHEN metrics.availability_mode = 'capacity' THEN metrics.max_guests_per_slot
        ELSE COALESCE(metrics.max_guests_per_slot, NULLIF(metrics.company_max_guests_per_slot, 0))
      END AS effective_max_guests_per_slot
    FROM slot_metrics metrics
  )
  SELECT
    metrics.time_slot,
    CASE
      WHEN metrics.is_blocked THEN false
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN false
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.same_time_reservation_count >= metrics.max_reservations_per_slot THEN false
      WHEN metrics.availability_mode = 'capacity'
        AND COALESCE(metrics.max_guests_per_slot, 0) <= 0 THEN false
      WHEN metrics.availability_mode = 'capacity'
        AND metrics.overlapping_guest_count + _party_size > COALESCE(metrics.max_guests_per_slot, 0) THEN false
      WHEN metrics.availability_mode = 'tables'
        AND COALESCE(metrics.effective_max_guests_per_slot, 0) > 0
        AND metrics.overlapping_guest_count + _party_size > metrics.effective_max_guests_per_slot THEN false
      WHEN metrics.availability_mode = 'tables'
        AND metrics.effective_available_units <= 0 THEN false
      ELSE true
    END AS available,
    CASE
      WHEN metrics.is_blocked THEN 'blocked'
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN 'party_size_limit'
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.same_time_reservation_count >= metrics.max_reservations_per_slot THEN 'reservation_limit'
      WHEN metrics.availability_mode = 'capacity'
        AND COALESCE(metrics.max_guests_per_slot, 0) <= 0 THEN 'capacity_limit_missing'
      WHEN metrics.availability_mode = 'capacity'
        AND metrics.overlapping_guest_count + _party_size > COALESCE(metrics.max_guests_per_slot, 0) THEN 'guest_limit'
      WHEN metrics.availability_mode = 'tables'
        AND COALESCE(metrics.effective_max_guests_per_slot, 0) > 0
        AND metrics.overlapping_guest_count + _party_size > metrics.effective_max_guests_per_slot THEN 'guest_limit'
      WHEN metrics.availability_mode = 'tables'
        AND metrics.effective_available_units <= 0 THEN 'no_table'
      ELSE NULL
    END AS unavailable_reason,
    metrics.total_units AS total_tables,
    CASE
      WHEN metrics.availability_mode = 'tables' THEN GREATEST(metrics.total_units - metrics.effective_available_units, 0)
      ELSE metrics.occupied_units
    END AS occupied_tables,
    metrics.effective_available_units AS available_tables,
    metrics.overlapping_guest_count AS total_guests,
    metrics.same_time_reservation_count AS reservation_count,
    metrics.max_party_size_per_reservation,
    metrics.max_reservations_per_slot,
    metrics.availability_mode,
    metrics.duration_minutes,
    metrics.effective_max_guests_per_slot AS max_guests_per_slot
  FROM normalized_metrics metrics
  WHERE _party_size BETWEEN 1 AND 20
  ORDER BY metrics.time_slot;
$$;

REVOKE ALL ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.create_public_reservation(
  _reservation jsonb,
  _status text DEFAULT 'confirmed'
)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company public.companies%ROWTYPE;
  _created public.reservations%ROWTYPE;
  _schedule record;
  _company_id uuid;
  _table_id uuid;
  _active_table_map_id uuid;
  _date date;
  _time time;
  _party_size integer;
  _duration_minutes integer;
  _occupied_guests integer;
  _reservation_count integer;
  _active_table_reservation_capacity integer;
  _active_reservation_count integer;
  _max_party_size_per_reservation integer;
  _max_reservations_per_slot integer;
  _max_guests_per_slot integer;
  _effective_max_guests_per_slot integer;
  _availability_mode text;
BEGIN
  IF jsonb_typeof(COALESCE(_reservation, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Dados da reserva invalidos.';
  END IF;

  IF _status NOT IN ('confirmed', 'pending_payment') THEN
    RAISE EXCEPTION 'Status inicial da reserva invalido.';
  END IF;

  BEGIN
    _company_id := NULLIF(_reservation ->> 'company_id', '')::uuid;
    _table_id := NULLIF(_reservation ->> 'table_id', '')::uuid;
    _date := NULLIF(_reservation ->> 'date', '')::date;
    _time := NULLIF(_reservation ->> 'time', '')::time;
    _party_size := COALESCE(NULLIF(_reservation ->> 'party_size', '')::integer, 1);
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Dados da reserva invalidos.';
  END;

  IF _company_id IS NULL OR _date IS NULL OR _time IS NULL THEN
    RAISE EXCEPTION 'Dados da reserva incompletos.';
  END IF;

  IF NULLIF(btrim(COALESCE(_reservation ->> 'guest_name', '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(_reservation ->> 'guest_phone', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe nome e WhatsApp.';
  END IF;

  IF _party_size < 1 OR _party_size > 20 THEN
    RAISE EXCEPTION 'Quantidade de pessoas invalida.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('reservation-date|%s|%s', _company_id::text, _date::text), 0)
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('reservation-slot|%s|%s|%s', _company_id::text, _date::text, _time::text), 0)
  );

  SELECT *
  INTO _company
  FROM public.companies c
  WHERE c.id = _company_id
    AND c.status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa nao encontrada ou indisponivel.';
  END IF;

  SELECT *
  INTO _schedule
  FROM public.get_public_reservation_schedule(_company_id, _date)
  LIMIT 1;

  IF NOT FOUND
     OR _schedule.source IS NULL
     OR _schedule.source = 'blocked'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(COALESCE(_schedule.slots, '[]'::jsonb)) slot_value
       WHERE slot_value = to_char(_time, 'HH24:MI')
     ) THEN
    RAISE EXCEPTION 'Horario indisponivel para reserva online.';
  END IF;

  _availability_mode := COALESCE(_schedule.availability_mode, 'tables');

  SELECT
    GREATEST(COALESCE(slot.duration_minutes, _schedule.default_duration_minutes, _company.reservation_duration, 30), 1),
    COALESCE(slot.max_party_size_per_reservation, _schedule.max_party_size_per_reservation),
    slot.max_reservations_per_slot,
    slot.max_guests_per_slot
  INTO
    _duration_minutes,
    _max_party_size_per_reservation,
    _max_reservations_per_slot,
    _max_guests_per_slot
  FROM (SELECT 1) singleton
  LEFT JOIN LATERAL (
    SELECT rule_slot.*
    FROM public.reservation_schedule_rule_slots rule_slot
    WHERE rule_slot.time = _time
      AND (
        rule_slot.block_id = _schedule.block_id
        OR (
          rule_slot.block_id IS NULL
          AND rule_slot.rule_id = _schedule.rule_id
        )
      )
    ORDER BY
      CASE WHEN rule_slot.block_id = _schedule.block_id THEN 0 ELSE 1 END,
      rule_slot.sort_order ASC,
      rule_slot.created_at ASC
    LIMIT 1
  ) slot ON true;

  _effective_max_guests_per_slot := COALESCE(_max_guests_per_slot, NULLIF(_company.max_guests_per_slot, 0), 0);

  IF _availability_mode = 'capacity' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(format('reservation-capacity|%s|%s', _company_id::text, _date::text), 0)
    );
  END IF;

  IF _max_party_size_per_reservation IS NOT NULL
     AND _party_size > _max_party_size_per_reservation THEN
    RAISE EXCEPTION 'Este horario aceita reservas online de ate % pessoas.', _max_party_size_per_reservation;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_dates bd
    WHERE bd.company_id = _company_id
      AND bd.date = _date
      AND (
        bd.all_day = true
        OR (
          bd.all_day = false
          AND _time >= COALESCE(bd.start_time, '00:00'::time)
          AND _time < COALESCE(bd.end_time, '23:59:59'::time)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Horario bloqueado para reservas.';
  END IF;

  SELECT count(*)::integer
  INTO _reservation_count
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.time = _time
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at);

  IF _max_reservations_per_slot IS NOT NULL
     AND _reservation_count >= _max_reservations_per_slot THEN
    RAISE EXCEPTION 'Limite de reservas atingido para este horario.';
  END IF;

  IF _availability_mode = 'capacity' THEN
    IF COALESCE(_max_guests_per_slot, 0) <= 0 THEN
      RAISE EXCEPTION 'Capacidade nao configurada para este horario.';
    END IF;

    SELECT COALESCE(sum(r.party_size), 0)::integer
    INTO _occupied_guests
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.date = _date
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      AND (_date + r.time) < (_date + _time + make_interval(mins => _duration_minutes))
      AND (
        _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
      ) > (_date + _time);

    IF _occupied_guests + _party_size > _max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;
  ELSE
    SELECT COALESCE(sum(r.party_size), 0)::integer
    INTO _occupied_guests
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.date = _date
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      AND (_date + r.time) < (_date + _time + make_interval(mins => _duration_minutes))
      AND (
        _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
      ) > (_date + _time);

    IF _effective_max_guests_per_slot > 0
       AND _occupied_guests + _party_size > _effective_max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;

    SELECT active_map.id
    INTO _active_table_map_id
    FROM public.get_active_table_map(_company_id, (_date + _time)::timestamptz) active_map
    LIMIT 1;

    SELECT count(*)::integer
    INTO _active_table_reservation_capacity
    FROM public.restaurant_tables rt
    WHERE rt.company_id = _company_id
      AND rt.status = 'available'
      AND (_active_table_map_id IS NULL OR rt.table_map_id = _active_table_map_id);

    SELECT count(*)::integer
    INTO _active_reservation_count
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.date = _date
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      AND (_date + r.time) < (_date + _time + make_interval(mins => _duration_minutes))
      AND (
        _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
      ) > (_date + _time);

    IF _active_table_reservation_capacity <= 0
       OR _active_reservation_count >= _active_table_reservation_capacity THEN
      RAISE EXCEPTION 'Limite de reservas atingido para este horario.';
    END IF;

    IF _table_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.restaurant_tables rt
      WHERE rt.id = _table_id
        AND rt.company_id = _company_id
        AND rt.status = 'available'
        AND rt.capacity >= _party_size
        AND (_active_table_map_id IS NULL OR rt.table_map_id = _active_table_map_id)
    ) THEN
      RAISE EXCEPTION 'Mesa indisponivel para este numero de pessoas.';
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(format('reservation-table|%s|%s', _table_id::text, _date::text), 0)
    );

    IF EXISTS (
      SELECT 1
      FROM public.reservations r
      WHERE r.company_id = _company_id
        AND r.date = _date
        AND r.table_id = _table_id
        AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
        AND (_date + r.time) < (_date + _time + make_interval(mins => _duration_minutes))
        AND (
          _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
        ) > (_date + _time)
    ) THEN
      RAISE EXCEPTION 'Mesa indisponivel para este horario.';
    END IF;
  END IF;

  INSERT INTO public.reservations (
    id,
    public_tracking_code,
    company_id,
    table_id,
    guest_name,
    guest_phone,
    guest_email,
    guest_birthdate,
    date,
    time,
    party_size,
    duration_minutes,
    status,
    occasion,
    notes,
    visitor_id,
    origin_tracking_session_id,
    origin_tracking_journey_id,
    origin_anonymous_id,
    origin_affiliate_link_id,
    origin_affiliate_code,
    origin_affiliate_name,
    origin_fbp,
    origin_fbc,
    attribution_snapshot,
    source,
    applied_schedule_rule_id,
    created_in_mode
  )
  VALUES (
    COALESCE(NULLIF(_reservation ->> 'id', '')::uuid, gen_random_uuid()),
    COALESCE(NULLIF(_reservation ->> 'public_tracking_code', ''), replace(gen_random_uuid()::text, '-', '')),
    _company_id,
    CASE WHEN _availability_mode = 'capacity' THEN NULL ELSE _table_id END,
    btrim(_reservation ->> 'guest_name'),
    btrim(_reservation ->> 'guest_phone'),
    NULLIF(lower(btrim(COALESCE(_reservation ->> 'guest_email', ''))), ''),
    NULLIF(_reservation ->> 'guest_birthdate', '')::date,
    _date,
    _time,
    _party_size,
    _duration_minutes,
    _status,
    NULLIF(btrim(COALESCE(_reservation ->> 'occasion', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'notes', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'visitor_id', '')), ''),
    NULLIF(_reservation ->> 'origin_tracking_session_id', '')::uuid,
    NULLIF(_reservation ->> 'origin_tracking_journey_id', '')::uuid,
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_anonymous_id', '')), ''),
    NULLIF(_reservation ->> 'origin_affiliate_link_id', '')::uuid,
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_affiliate_code', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_affiliate_name', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_fbp', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_fbc', '')), ''),
    CASE
      WHEN jsonb_typeof(_reservation -> 'attribution_snapshot') = 'object'
        THEN _reservation -> 'attribution_snapshot'
      ELSE '{}'::jsonb
    END,
    'reservation',
    _schedule.rule_id,
    _availability_mode
  )
  RETURNING *
  INTO _created;

  RETURN _created;
EXCEPTION
  WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Dados da reserva invalidos.';
END;
$$;

REVOKE ALL ON FUNCTION public.create_public_reservation(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(jsonb, text) TO anon;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(jsonb, text) TO service_role;
