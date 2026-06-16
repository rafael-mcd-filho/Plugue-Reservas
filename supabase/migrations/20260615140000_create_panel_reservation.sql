-- Fase 4 do plano: criacao manual segura.
--
-- Substitui o INSERT direto em public.reservations feito pelo painel. Valida
-- capacidade, limite de reservas por horario e conflito de mesa, e auto-atribui
-- a menor mesa disponivel no modo por mesas. Reserva sem mesa so e permitida
-- como excecao explicita (_allow_unassigned), registrando um motivo.
--
-- Decisoes de projeto (documentadas):
--  * Diferente do fluxo publico, o painel NAO bloqueia por blocked_dates nem
--    pelo limite "online" max_party_size_per_reservation: a equipe pode lancar
--    reservas por telefone/excecao. Os limites que evitam furar capacidade
--    (pessoas simultaneas, reservas por horario e conflito de mesa) continuam
--    sendo aplicados.
--  * Se o horario nao for um slot publicado, caimos nos padroes da empresa
--    (modo do dia, duracao e limite de pessoas da empresa) e ainda assim
--    impedimos conflito de mesa.

CREATE OR REPLACE FUNCTION public.create_panel_reservation(
  _company_id uuid,
  _date date,
  _time time,
  _party_size integer,
  _guest_name text,
  _guest_phone text,
  _guest_email text DEFAULT NULL,
  _guest_birthdate date DEFAULT NULL,
  _occasion text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _table_id uuid DEFAULT NULL,
  _allow_unassigned boolean DEFAULT false,
  _assignment_note text DEFAULT NULL,
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
  _is_published_slot boolean := false;
  _availability_mode text;
  _duration_minutes integer;
  _max_reservations_per_slot integer;
  _slot_max_guests_per_slot integer;
  _effective_max_guests_per_slot integer;
  _active_table_map_id uuid;
  _resolved_table_id uuid := NULL;
  _assignment_note_value text := NULL;
  _occupied_guests integer;
  _arrival_count integer;
  _normalized_email text;
  _normalized_name text;
  _normalized_phone text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
    OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, _company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF _status NOT IN ('confirmed') THEN
    RAISE EXCEPTION 'Status inicial invalido para reserva manual.';
  END IF;

  _normalized_name := NULLIF(btrim(COALESCE(_guest_name, '')), '');
  _normalized_phone := NULLIF(btrim(COALESCE(_guest_phone, '')), '');
  _normalized_email := NULLIF(lower(btrim(COALESCE(_guest_email, ''))), '');

  IF _normalized_name IS NULL OR _normalized_phone IS NULL THEN
    RAISE EXCEPTION 'Informe nome e WhatsApp do cliente.';
  END IF;

  IF _date IS NULL OR _time IS NULL THEN
    RAISE EXCEPTION 'Informe data e horario da reserva.';
  END IF;

  IF _party_size IS NULL OR _party_size < 1 OR _party_size > 50 THEN
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

  SELECT *
  INTO _schedule
  FROM public.get_public_reservation_schedule(_company_id, _date)
  LIMIT 1;

  _is_published_slot := COALESCE(_schedule.source, '') <> 'blocked'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(_schedule.slots, '[]'::jsonb)) slot_value
      WHERE slot_value = to_char(_time, 'HH24:MI')
    );

  _availability_mode := COALESCE(_schedule.availability_mode, 'tables');

  -- Configuracao do slot (so existe quando o horario e um slot publicado).
  SELECT
    GREATEST(COALESCE(slot.duration_minutes, _schedule.default_duration_minutes, _company.reservation_duration, 30), 1),
    slot.max_reservations_per_slot,
    slot.max_guests_per_slot
  INTO
    _duration_minutes,
    _max_reservations_per_slot,
    _slot_max_guests_per_slot
  FROM (SELECT 1) singleton
  LEFT JOIN public.reservation_schedule_rule_slots slot
    ON slot.block_id = _schedule.block_id
   AND slot.time = _time;

  _duration_minutes := GREATEST(COALESCE(_duration_minutes, _company.reservation_duration, 30), 1);
  _effective_max_guests_per_slot := COALESCE(_slot_max_guests_per_slot, NULLIF(_company.max_guests_per_slot, 0), 0);

  IF _availability_mode = 'capacity' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(format('reservation-capacity|%s|%s', _company_id::text, _date::text), 0)
    );
  END IF;

  -- Limite de reservas por horario (apenas para slots publicados).
  IF _is_published_slot AND _max_reservations_per_slot IS NOT NULL THEN
    _arrival_count := public.count_slot_arrival_reservations(_company_id, _date, _time, NULL);
    IF _arrival_count >= _max_reservations_per_slot THEN
      RAISE EXCEPTION 'Limite de reservas atingido para este horario.';
    END IF;
  END IF;

  IF _availability_mode = 'capacity' THEN
    IF COALESCE(_slot_max_guests_per_slot, 0) <= 0 THEN
      RAISE EXCEPTION 'Capacidade nao configurada para este horario.';
    END IF;

    _occupied_guests := public.count_overlapping_reservation_guests(_company_id, _date, _time, _duration_minutes, NULL);
    IF _occupied_guests + _party_size > _slot_max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;

    _resolved_table_id := NULL;
  ELSE
    _occupied_guests := public.count_overlapping_reservation_guests(_company_id, _date, _time, _duration_minutes, NULL);
    IF _effective_max_guests_per_slot > 0
       AND _occupied_guests + _party_size > _effective_max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;

    SELECT active_map.id
    INTO _active_table_map_id
    FROM public.get_active_table_map(_company_id, (_date + _time)::timestamptz) active_map
    LIMIT 1;

    IF _table_id IS NOT NULL THEN
      -- Mesa escolhida explicitamente: precisa caber e estar livre.
      IF NOT EXISTS (
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

      IF public.reservation_table_conflict_id(_company_id, _date, _time, _duration_minutes, _table_id, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'Mesa indisponivel para este horario.';
      END IF;

      _resolved_table_id := _table_id;
    ELSE
      -- Auto-atribuir a menor mesa que cabe e esta livre.
      _resolved_table_id := public.pick_best_fit_reservation_table(
        _company_id, _date, _time, _duration_minutes, _party_size, _active_table_map_id, NULL
      );

      IF _resolved_table_id IS NULL THEN
        IF COALESCE(_allow_unassigned, false) THEN
          _resolved_table_id := NULL;
          _assignment_note_value := COALESCE(NULLIF(btrim(_assignment_note), ''), 'Alocar mesa depois');
        ELSE
          RAISE EXCEPTION 'Nenhuma mesa disponivel para este horario. Use "alocar depois" para registrar mesmo assim.';
        END IF;
      ELSE
        PERFORM pg_advisory_xact_lock(
          hashtextextended(format('reservation-table|%s|%s', _resolved_table_id::text, _date::text), 0)
        );

        -- Revalida apos o lock para evitar corrida.
        IF public.reservation_table_conflict_id(_company_id, _date, _time, _duration_minutes, _resolved_table_id, NULL) IS NOT NULL THEN
          _resolved_table_id := public.pick_best_fit_reservation_table(
            _company_id, _date, _time, _duration_minutes, _party_size, _active_table_map_id, NULL
          );

          IF _resolved_table_id IS NULL THEN
            IF COALESCE(_allow_unassigned, false) THEN
              _assignment_note_value := COALESCE(NULLIF(btrim(_assignment_note), ''), 'Alocar mesa depois');
            ELSE
              RAISE EXCEPTION 'Nenhuma mesa disponivel para este horario. Use "alocar depois" para registrar mesmo assim.';
            END IF;
          END IF;
        END IF;
      END IF;
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
    source,
    applied_schedule_rule_id,
    created_in_mode,
    table_assignment_note
  )
  VALUES (
    gen_random_uuid(),
    replace(gen_random_uuid()::text, '-', ''),
    _company_id,
    CASE WHEN _availability_mode = 'capacity' THEN NULL ELSE _resolved_table_id END,
    _normalized_name,
    _normalized_phone,
    _normalized_email,
    _guest_birthdate,
    _date,
    _time,
    _party_size,
    _duration_minutes,
    _status,
    NULLIF(btrim(COALESCE(_occasion, '')), ''),
    NULLIF(btrim(COALESCE(_notes, '')), ''),
    'reservation',
    CASE WHEN _is_published_slot THEN _schedule.rule_id ELSE NULL END,
    _availability_mode,
    CASE WHEN _availability_mode = 'tables' THEN _assignment_note_value ELSE NULL END
  )
  RETURNING *
  INTO _created;

  RETURN _created;
END;
$$;

REVOKE ALL ON FUNCTION public.create_panel_reservation(
  uuid, date, time, integer, text, text, text, date, text, text, uuid, boolean, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_panel_reservation(
  uuid, date, time, integer, text, text, text, date, text, text, uuid, boolean, text, text
) TO authenticated;
