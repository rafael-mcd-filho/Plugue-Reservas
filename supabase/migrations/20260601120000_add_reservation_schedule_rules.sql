-- Regras explicitas de horarios de reserva online.
-- A tabela antiga de overrides permanece durante a transicao, mas deixa de ser
-- consultada pelo frontend depois desta migration.

CREATE TABLE IF NOT EXISTS public.reservation_schedule_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  scope text NOT NULL,
  weekdays integer[],
  start_date date,
  end_date date,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  max_party_size_per_reservation integer,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_schedule_rules_name_not_blank
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT reservation_schedule_rules_scope_check
    CHECK (scope IN ('weekly', 'date_specific', 'date_range')),
  CONSTRAINT reservation_schedule_rules_max_party_size_check
    CHECK (max_party_size_per_reservation IS NULL OR max_party_size_per_reservation BETWEEN 1 AND 20),
  CONSTRAINT reservation_schedule_rules_weekdays_check
    CHECK (
      (
        scope = 'weekly'
        AND weekdays IS NOT NULL
        AND cardinality(weekdays) > 0
        AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
      )
      OR (
        scope <> 'weekly'
        AND weekdays IS NULL
      )
    ),
  CONSTRAINT reservation_schedule_rules_date_check
    CHECK (
      (
        scope = 'weekly'
        AND start_date IS NULL
        AND end_date IS NULL
      )
      OR (
        scope = 'date_specific'
        AND start_date IS NOT NULL
        AND (end_date IS NULL OR end_date = start_date)
      )
      OR (
        scope = 'date_range'
        AND start_date IS NOT NULL
        AND end_date IS NOT NULL
        AND end_date >= start_date
      )
    )
);

CREATE TABLE IF NOT EXISTS public.reservation_schedule_rule_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.reservation_schedule_rules(id) ON DELETE CASCADE,
  time time NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, time)
);

CREATE INDEX IF NOT EXISTS idx_reservation_schedule_rules_company_scope_enabled
  ON public.reservation_schedule_rules(company_id, scope, enabled, archived_at);

CREATE INDEX IF NOT EXISTS idx_reservation_schedule_rules_company_dates
  ON public.reservation_schedule_rules(company_id, start_date, end_date)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reservation_schedule_rule_slots_rule_order
  ON public.reservation_schedule_rule_slots(rule_id, sort_order, time);

ALTER TABLE public.reservation_schedule_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_schedule_rule_slots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view reservation schedule rules" ON public.reservation_schedule_rules;
CREATE POLICY "Company staff can view reservation schedule rules"
ON public.reservation_schedule_rules
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can manage reservation schedule rules" ON public.reservation_schedule_rules;
CREATE POLICY "Company admins can manage reservation schedule rules"
ON public.reservation_schedule_rules
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company staff can view reservation schedule rule slots" ON public.reservation_schedule_rule_slots;
CREATE POLICY "Company staff can view reservation schedule rule slots"
ON public.reservation_schedule_rule_slots
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.id = rule_id
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, rsr.company_id)
        OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, rsr.company_id)
      )
  )
);

DROP POLICY IF EXISTS "Company admins can manage reservation schedule rule slots" ON public.reservation_schedule_rule_slots;
CREATE POLICY "Company admins can manage reservation schedule rule slots"
ON public.reservation_schedule_rule_slots
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.id = rule_id
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, rsr.company_id)
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.id = rule_id
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, rsr.company_id)
      )
  )
);

CREATE OR REPLACE FUNCTION public.touch_reservation_schedule_rule_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_reservation_schedule_rule_updated_at ON public.reservation_schedule_rules;
CREATE TRIGGER trg_touch_reservation_schedule_rule_updated_at
BEFORE UPDATE ON public.reservation_schedule_rules
FOR EACH ROW
EXECUTE FUNCTION public.touch_reservation_schedule_rule_updated_at();

-- Preserva o UUID do override para tornar a conversao idempotente.
INSERT INTO public.reservation_schedule_rules (
  id,
  company_id,
  name,
  scope,
  start_date,
  end_date,
  enabled,
  priority,
  created_at,
  updated_at
)
SELECT
  rso.id,
  rso.company_id,
  COALESCE(NULLIF(btrim(rso.label), ''), 'Regra pontual de ' || to_char(rso.date, 'DD/MM/YYYY')),
  'date_specific',
  rso.date,
  rso.date,
  true,
  100,
  rso.created_at,
  rso.updated_at
FROM public.reservation_schedule_overrides rso
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.reservation_schedule_rule_slots (rule_id, time, sort_order)
SELECT
  rso.id,
  generated.slot_at::time,
  (row_number() OVER (PARTITION BY rso.id ORDER BY generated.slot_at))::integer * 10
FROM public.reservation_schedule_overrides rso
CROSS JOIN LATERAL generate_series(
  timestamp '2000-01-01' + rso.start_time,
  timestamp '2000-01-01' + rso.end_time,
  make_interval(mins => rso.slot_interval_minutes)
) AS generated(slot_at)
ON CONFLICT (rule_id, time) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_public_reservation_schedule(
  _company_id uuid,
  _date date
)
RETURNS TABLE (
  source text,
  rule_id uuid,
  rule_name text,
  slots jsonb,
  max_party_size_per_reservation integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company public.companies%ROWTYPE;
  _rule public.reservation_schedule_rules%ROWTYPE;
  _opening_hour jsonb;
  _open_time time;
  _close_time time;
  _duration_minutes integer;
  _day_key text;
BEGIN
  SELECT *
  INTO _company
  FROM public.companies c
  WHERE c.id = _company_id
    AND c.status = 'active'
  LIMIT 1;

  IF NOT FOUND OR _date IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_dates bd
    WHERE bd.company_id = _company_id
      AND bd.date = _date
      AND bd.all_day = true
  ) THEN
    RETURN QUERY
    SELECT 'blocked'::text, NULL::uuid, NULL::text, '[]'::jsonb, NULL::integer;
    RETURN;
  END IF;

  SELECT rsr.*
  INTO _rule
  FROM public.reservation_schedule_rules rsr
  WHERE rsr.company_id = _company_id
    AND rsr.scope = 'date_specific'
    AND rsr.start_date = _date
    AND rsr.enabled = true
    AND rsr.archived_at IS NULL
  ORDER BY rsr.priority ASC, rsr.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT rsr.*
    INTO _rule
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.company_id = _company_id
      AND rsr.scope = 'date_range'
      AND rsr.start_date <= _date
      AND rsr.end_date >= _date
      AND rsr.enabled = true
      AND rsr.archived_at IS NULL
    ORDER BY rsr.priority ASC, rsr.created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    SELECT rsr.*
    INTO _rule
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.company_id = _company_id
      AND rsr.scope = 'weekly'
      AND EXTRACT(DOW FROM _date)::integer = ANY(rsr.weekdays)
      AND rsr.enabled = true
      AND rsr.archived_at IS NULL
    ORDER BY rsr.priority ASC, rsr.created_at DESC
    LIMIT 1;
  END IF;

  IF FOUND THEN
    RETURN QUERY
    SELECT
      _rule.scope,
      _rule.id,
      _rule.name,
      COALESCE(
        (
          SELECT jsonb_agg(to_char(rsrslot.time, 'HH24:MI') ORDER BY rsrslot.time)
          FROM public.reservation_schedule_rule_slots rsrslot
          WHERE rsrslot.rule_id = _rule.id
        ),
        '[]'::jsonb
      ),
      _rule.max_party_size_per_reservation;
    RETURN;
  END IF;

  _day_key := (ARRAY['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'])[EXTRACT(DOW FROM _date)::integer + 1];

  SELECT item
  INTO _opening_hour
  FROM jsonb_array_elements(COALESCE(_company.opening_hours, '[]'::jsonb)) item
  WHERE lower(
    translate(
      COALESCE(item ->> 'day', ''),
      'áàâãäéèêëíìîïóòôõöúùûüç',
      'aaaaaeeeeiiiiooooouuuuc'
    )
  ) = _day_key
  LIMIT 1;

  IF _opening_hour IS NULL OR COALESCE((_opening_hour ->> 'closed')::boolean, false) THEN
    RETURN QUERY
    SELECT 'default'::text, NULL::uuid, NULL::text, '[]'::jsonb, NULL::integer;
    RETURN;
  END IF;

  BEGIN
    _open_time := (_opening_hour ->> 'open')::time;
    _close_time := (_opening_hour ->> 'close')::time;
  EXCEPTION
    WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RETURN QUERY
      SELECT 'default'::text, NULL::uuid, NULL::text, '[]'::jsonb, NULL::integer;
      RETURN;
  END;

  _duration_minutes := GREATEST(COALESCE(_company.reservation_duration, 30), 1);

  IF _close_time <= _open_time THEN
    RETURN QUERY
    SELECT 'default'::text, NULL::uuid, NULL::text, '[]'::jsonb, NULL::integer;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'default'::text,
    NULL::uuid,
    NULL::text,
    COALESCE(
      (
        SELECT jsonb_agg(to_char(generated.slot_at, 'HH24:MI') ORDER BY generated.slot_at)
        FROM generate_series(
          _date + _open_time,
          (_date + _close_time) - interval '1 second',
          make_interval(mins => _duration_minutes)
        ) generated(slot_at)
      ),
      '[]'::jsonb
    ),
    NULL::integer;
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_reservation_schedule(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_schedule(uuid, date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_schedule(uuid, date) TO authenticated;

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
  _max_party_size_per_reservation integer DEFAULT NULL
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

  INSERT INTO public.reservation_schedule_rule_slots (rule_id, time, sort_order)
  SELECT
    _saved_id,
    slot_value::time,
    (row_number() OVER (ORDER BY slot_value::time))::integer * 10
  FROM unnest(_slots) AS slots(slot_value)
  ORDER BY slot_value::time;

  RETURN _saved_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_reservation_schedule_rule(uuid, text, text, text[], uuid, integer[], date, date, boolean, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_reservation_schedule_rule(uuid, text, text, text[], uuid, integer[], date, date, boolean, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.archive_reservation_schedule_rule(
  _rule_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company_id uuid;
BEGIN
  SELECT rsr.company_id
  INTO _company_id
  FROM public.reservation_schedule_rules rsr
  WHERE rsr.id = _rule_id
    AND rsr.archived_at IS NULL;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Regra nao encontrada.';
  END IF;

  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  UPDATE public.reservation_schedule_rules
  SET
    archived_at = now(),
    enabled = false
  WHERE id = _rule_id;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_reservation_schedule_rule(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_reservation_schedule_rule(uuid) TO authenticated;

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
  _date date;
  _time time;
  _party_size integer;
  _occupied_guests integer;
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
    hashtextextended(format('%s|%s|%s', _company_id::text, _date::text, _time::text), 0)
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

  IF _schedule.source IS NULL
     OR _schedule.source = 'blocked'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(COALESCE(_schedule.slots, '[]'::jsonb)) slot_value
       WHERE slot_value = to_char(_time, 'HH24:MI')
     ) THEN
    RAISE EXCEPTION 'Horario indisponivel para reserva online.';
  END IF;

  IF _schedule.max_party_size_per_reservation IS NOT NULL
     AND _party_size > _schedule.max_party_size_per_reservation THEN
    RAISE EXCEPTION 'Esta agenda aceita reservas online de ate % pessoas.', _schedule.max_party_size_per_reservation;
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

  IF _table_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.restaurant_tables rt
    WHERE rt.id = _table_id
      AND rt.company_id = _company_id
      AND rt.status = 'available'
      AND rt.capacity >= _party_size
  ) THEN
    RAISE EXCEPTION 'Mesa indisponivel para este numero de pessoas.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.date = _date
      AND r.time = _time
      AND r.table_id = _table_id
      AND r.status NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
      AND (
        r.status <> 'pending_payment'
        OR EXISTS (
          SELECT 1
          FROM public.reservation_payments rp
          WHERE rp.reservation_id = r.id
            AND rp.status IN ('awaiting_method', 'pending')
            AND rp.expires_at > now()
        )
        OR (
          r.created_at > now() - interval '2 minutes'
          AND NOT EXISTS (
            SELECT 1
            FROM public.reservation_payments rp
            WHERE rp.reservation_id = r.id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Mesa indisponivel para este horario.';
  END IF;

  SELECT COALESCE(sum(r.party_size), 0)::integer
  INTO _occupied_guests
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.time = _time
    AND r.status NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
    AND (
      r.status <> 'pending_payment'
      OR EXISTS (
        SELECT 1
        FROM public.reservation_payments rp
        WHERE rp.reservation_id = r.id
          AND rp.status IN ('awaiting_method', 'pending')
          AND rp.expires_at > now()
      )
      OR (
        r.created_at > now() - interval '2 minutes'
        AND NOT EXISTS (
          SELECT 1
          FROM public.reservation_payments rp
          WHERE rp.reservation_id = r.id
        )
      )
    );

  IF COALESCE(_company.max_guests_per_slot, 0) > 0
     AND _occupied_guests + _party_size > _company.max_guests_per_slot THEN
    RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
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
    GREATEST(COALESCE(NULLIF(_reservation ->> 'duration_minutes', '')::integer, _company.reservation_duration, 30), 1),
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

-- Escritas publicas passam obrigatoriamente pela RPC transacional. Usuarios
-- autenticados do painel continuam podendo criar reservas manuais da empresa.
DROP POLICY IF EXISTS "Anyone can create reservations" ON public.reservations;

DROP POLICY IF EXISTS "Company staff can create reservations" ON public.reservations;
CREATE POLICY "Company staff can create reservations"
ON public.reservations
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);
