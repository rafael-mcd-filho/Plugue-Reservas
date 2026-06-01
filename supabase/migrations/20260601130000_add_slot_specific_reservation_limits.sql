-- Limites operacionais por horario e disponibilidade publica centralizada.
-- Mantem os limites da regra como padrao e permite sobrescrever por slot.

ALTER TABLE public.reservation_schedule_rule_slots
  ADD COLUMN IF NOT EXISTS max_party_size_per_reservation integer,
  ADD COLUMN IF NOT EXISTS max_reservations_per_slot integer;

ALTER TABLE public.reservation_schedule_rule_slots
  DROP CONSTRAINT IF EXISTS reservation_schedule_rule_slots_max_party_size_check,
  ADD CONSTRAINT reservation_schedule_rule_slots_max_party_size_check
    CHECK (max_party_size_per_reservation IS NULL OR max_party_size_per_reservation BETWEEN 1 AND 20),
  DROP CONSTRAINT IF EXISTS reservation_schedule_rule_slots_max_reservations_check,
  ADD CONSTRAINT reservation_schedule_rule_slots_max_reservations_check
    CHECK (max_reservations_per_slot IS NULL OR max_reservations_per_slot BETWEEN 1 AND 500);

-- Centraliza quais reservas ainda ocupam capacidade. Reservas aguardando
-- pagamento contam enquanto a cobranca estiver valida ou durante a janela
-- curta entre a criacao da reserva e a criacao da cobranca.
CREATE OR REPLACE FUNCTION public.is_reservation_occupying_capacity(
  _reservation_id uuid,
  _status text,
  _created_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _status NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
    AND (
      _status <> 'pending_payment'
      OR EXISTS (
        SELECT 1
        FROM public.reservation_payments rp
        WHERE rp.reservation_id = _reservation_id
          AND rp.status IN ('awaiting_method', 'pending')
          AND rp.expires_at > now()
      )
      OR (
        _created_at > now() - interval '2 minutes'
        AND NOT EXISTS (
          SELECT 1
          FROM public.reservation_payments rp
          WHERE rp.reservation_id = _reservation_id
        )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.is_reservation_occupying_capacity(uuid, text, timestamptz) FROM PUBLIC;

-- O modal usa esta RPC ao escolher a mesa. A verificacao passa a considerar
-- toda a duracao da reserva, evitando reutilizar uma mesa ainda ocupada.
CREATE OR REPLACE FUNCTION public.get_occupied_table_ids(
  _company_id uuid,
  _date date,
  _time time
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_slot AS (
    SELECT GREATEST(COALESCE(c.reservation_duration, 30), 1) AS duration_minutes
    FROM public.companies c
    WHERE c.id = _company_id
      AND c.status = 'active'
    LIMIT 1
  )
  SELECT COALESCE(array_agg(DISTINCT r.table_id), '{}'::uuid[])
  FROM public.reservations r
  CROSS JOIN requested_slot requested
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.table_id IS NOT NULL
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
    AND (_date + r.time) < (_date + _time + make_interval(mins => requested.duration_minutes))
    AND (
      _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
    ) > (_date + _time);
$$;

REVOKE ALL ON FUNCTION public.get_occupied_table_ids(uuid, date, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO anon;
GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO authenticated;

-- Retorna a disponibilidade efetiva de todos os horarios permitidos na data.
-- Limites de chegada sao avaliados pelo horario inicial. A ocupacao de mesas
-- considera sobreposicao da duracao completa das reservas.
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
  max_reservations_per_slot integer
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
      schedule.max_party_size_per_reservation AS rule_max_party_size
    FROM schedule
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(schedule.slots, '[]'::jsonb)) slot_value
  ),
  resolved_slots AS (
    SELECT
      allowed.time_slot,
      COALESCE(slot.max_party_size_per_reservation, allowed.rule_max_party_size) AS max_party_size_per_reservation,
      slot.max_reservations_per_slot,
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
    LEFT JOIN public.reservation_schedule_rule_slots slot
      ON slot.rule_id = allowed.rule_id
     AND slot.time = allowed.time_slot
  ),
  slot_context AS (
    SELECT
      resolved.*,
      company.duration_minutes,
      company.max_guests_per_slot,
      active_map.id AS active_table_map_id
    FROM resolved_slots resolved
    CROSS JOIN company
    LEFT JOIN LATERAL public.get_active_table_map(
      _company_id,
      (_date + resolved.time_slot)::timestamptz
    ) active_map ON true
  ),
  slot_metrics AS (
    SELECT
      context.*,
      (
        SELECT count(*)::integer
        FROM public.restaurant_tables rt
        WHERE rt.company_id = _company_id
          AND rt.status = 'available'
          AND rt.capacity >= _party_size
          AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
      ) AS total_tables,
      (
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
      ) AS occupied_tables,
      (
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
      ) AS available_tables,
      (
        SELECT COALESCE(sum(r.party_size), 0)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND r.time = context.time_slot
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      ) AS total_guests,
      (
        SELECT count(*)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND r.time = context.time_slot
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      ) AS reservation_count
    FROM slot_context context
  )
  SELECT
    metrics.time_slot,
    CASE
      WHEN metrics.is_blocked THEN false
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN false
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.reservation_count >= metrics.max_reservations_per_slot THEN false
      WHEN metrics.max_guests_per_slot > 0
        AND metrics.total_guests + _party_size > metrics.max_guests_per_slot THEN false
      WHEN metrics.available_tables <= 0 THEN false
      ELSE true
    END AS available,
    CASE
      WHEN metrics.is_blocked THEN 'blocked'
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN 'party_size_limit'
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.reservation_count >= metrics.max_reservations_per_slot THEN 'reservation_limit'
      WHEN metrics.max_guests_per_slot > 0
        AND metrics.total_guests + _party_size > metrics.max_guests_per_slot THEN 'guest_limit'
      WHEN metrics.available_tables <= 0 THEN 'no_table'
      ELSE NULL
    END AS unavailable_reason,
    metrics.total_tables,
    metrics.occupied_tables,
    metrics.available_tables,
    metrics.total_guests,
    metrics.reservation_count,
    metrics.max_party_size_per_reservation,
    metrics.max_reservations_per_slot
  FROM slot_metrics metrics
  WHERE _party_size BETWEEN 1 AND 20
  ORDER BY metrics.time_slot;
$$;

REVOKE ALL ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) TO authenticated;

DROP FUNCTION IF EXISTS public.upsert_reservation_schedule_rule(
  uuid, text, text, text[], uuid, integer[], date, date, boolean, integer, integer
);

CREATE OR REPLACE FUNCTION public.upsert_reservation_schedule_rule(
  _company_id uuid,
  _name text,
  _scope text,
  _slots text[],
  _rule_id uuid DEFAULT NULL,
  _weekdays integer[] DEFAULT NULL,
  _start_date date DEFAULT NULL,
  _end_date date DEFAULT NULL,
  _enabled boolean DEFAULT true,
  _priority integer DEFAULT 100,
  _max_party_size_per_reservation integer DEFAULT NULL,
  _slot_settings jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _saved_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF _slots IS NULL OR cardinality(_slots) = 0 THEN
    RAISE EXCEPTION 'Adicione pelo menos um horario.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(_slots) slot_value
    WHERE slot_value !~ '^[0-2][0-9]:[0-5][0-9]$'
      OR split_part(slot_value, ':', 1)::integer > 23
  ) THEN
    RAISE EXCEPTION 'Existe um horario invalido.';
  END IF;

  IF (
    SELECT count(*)
    FROM unnest(_slots)
  ) <> (
    SELECT count(DISTINCT slot_value)
    FROM unnest(_slots) slot_value
  ) THEN
    RAISE EXCEPTION 'Nao repita horarios na mesma regra.';
  END IF;

  IF jsonb_typeof(COALESCE(_slot_settings, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Configuracao dos horarios invalida.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(_slot_settings, '[]'::jsonb)) setting
    WHERE NULLIF(setting ->> 'max_party_size_per_reservation', '') IS NOT NULL
      AND NOT CASE
        WHEN setting ->> 'max_party_size_per_reservation' ~ '^[0-9]+$'
          THEN (setting ->> 'max_party_size_per_reservation')::integer BETWEEN 1 AND 20
        ELSE false
      END
  ) THEN
    RAISE EXCEPTION 'O maximo de pessoas por reserva do horario deve estar entre 1 e 20.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(_slot_settings, '[]'::jsonb)) setting
    WHERE NULLIF(setting ->> 'max_reservations_per_slot', '') IS NOT NULL
      AND NOT CASE
        WHEN setting ->> 'max_reservations_per_slot' ~ '^[0-9]+$'
          THEN (setting ->> 'max_reservations_per_slot')::integer BETWEEN 1 AND 500
        ELSE false
      END
  ) THEN
    RAISE EXCEPTION 'O maximo de reservas do horario deve estar entre 1 e 500.';
  END IF;

  IF _rule_id IS NULL THEN
    INSERT INTO public.reservation_schedule_rules (
      company_id,
      name,
      scope,
      weekdays,
      start_date,
      end_date,
      enabled,
      priority,
      max_party_size_per_reservation
    )
    VALUES (
      _company_id,
      btrim(_name),
      _scope,
      CASE WHEN _scope = 'weekly' THEN _weekdays ELSE NULL END,
      CASE WHEN _scope IN ('date_specific', 'date_range') THEN _start_date ELSE NULL END,
      CASE
        WHEN _scope = 'date_specific' THEN _start_date
        WHEN _scope = 'date_range' THEN _end_date
        ELSE NULL
      END,
      COALESCE(_enabled, true),
      COALESCE(_priority, 100),
      _max_party_size_per_reservation
    )
    RETURNING id
    INTO _saved_id;
  ELSE
    UPDATE public.reservation_schedule_rules rsr
    SET
      name = btrim(_name),
      scope = _scope,
      weekdays = CASE WHEN _scope = 'weekly' THEN _weekdays ELSE NULL END,
      start_date = CASE WHEN _scope IN ('date_specific', 'date_range') THEN _start_date ELSE NULL END,
      end_date = CASE
        WHEN _scope = 'date_specific' THEN _start_date
        WHEN _scope = 'date_range' THEN _end_date
        ELSE NULL
      END,
      enabled = COALESCE(_enabled, true),
      priority = COALESCE(_priority, 100),
      max_party_size_per_reservation = _max_party_size_per_reservation
    WHERE rsr.id = _rule_id
      AND rsr.company_id = _company_id
      AND rsr.archived_at IS NULL
    RETURNING rsr.id
    INTO _saved_id;

    IF _saved_id IS NULL THEN
      RAISE EXCEPTION 'Regra nao encontrada.';
    END IF;

    DELETE FROM public.reservation_schedule_rule_slots
    WHERE rule_id = _saved_id;
  END IF;

  INSERT INTO public.reservation_schedule_rule_slots (
    rule_id,
    time,
    sort_order,
    max_party_size_per_reservation,
    max_reservations_per_slot
  )
  SELECT
    _saved_id,
    slot_value::time,
    (row_number() OVER (ORDER BY slot_value::time))::integer * 10,
    NULLIF(setting.item ->> 'max_party_size_per_reservation', '')::integer,
    NULLIF(setting.item ->> 'max_reservations_per_slot', '')::integer
  FROM unnest(_slots) AS slots(slot_value)
  LEFT JOIN LATERAL (
    SELECT item
    FROM jsonb_array_elements(COALESCE(_slot_settings, '[]'::jsonb)) item
    WHERE item ->> 'time' = slot_value
    LIMIT 1
  ) setting ON true
  ORDER BY slot_value::time;

  RETURN _saved_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_reservation_schedule_rule(
  uuid, text, text, text[], uuid, integer[], date, date, boolean, integer, integer, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_reservation_schedule_rule(
  uuid, text, text, text[], uuid, integer[], date, date, boolean, integer, integer, jsonb
) TO authenticated;

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
  _max_party_size_per_reservation integer;
  _max_reservations_per_slot integer;
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

  _duration_minutes := GREATEST(
    COALESCE(NULLIF(_reservation ->> 'duration_minutes', '')::integer, _company.reservation_duration, 30),
    1
  );

  SELECT *
  INTO _schedule
  FROM public.get_public_reservation_schedule(_company_id, _date)
  LIMIT 1;

  IF _schedule.source IS NULL
     OR _schedule.source = 'blocked'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(COALESCE(_schedule.slots, '[]'::jsonb)) slot_value
       WHERE slot_value = to_char(_time, 'HH24:MI')
     ) THEN
    RAISE EXCEPTION 'Horario indisponivel para reserva online.';
  END IF;

  SELECT
    COALESCE(slot.max_party_size_per_reservation, _schedule.max_party_size_per_reservation),
    slot.max_reservations_per_slot
  INTO
    _max_party_size_per_reservation,
    _max_reservations_per_slot
  FROM (SELECT 1) singleton
  LEFT JOIN public.reservation_schedule_rule_slots slot
    ON slot.rule_id = _schedule.rule_id
   AND slot.time = _time;

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

  SELECT count(*)::integer, COALESCE(sum(r.party_size), 0)::integer
  INTO _reservation_count, _occupied_guests
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.time = _time
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at);

  IF _max_reservations_per_slot IS NOT NULL
     AND _reservation_count >= _max_reservations_per_slot THEN
    RAISE EXCEPTION 'Limite de reservas atingido para este horario.';
  END IF;

  IF COALESCE(_company.max_guests_per_slot, 0) > 0
     AND _occupied_guests + _party_size > _company.max_guests_per_slot THEN
    RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
  END IF;

  SELECT active_map.id
  INTO _active_table_map_id
  FROM public.get_active_table_map(_company_id, (_date + _time)::timestamptz) active_map
  LIMIT 1;

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
    source
  )
  VALUES (
    COALESCE(NULLIF(_reservation ->> 'id', '')::uuid, gen_random_uuid()),
    COALESCE(NULLIF(_reservation ->> 'public_tracking_code', ''), replace(gen_random_uuid()::text, '-', '')),
    _company_id,
    _table_id,
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
    'reservation'
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
