-- Fase 5 do plano: edicao segura.
--
-- Substitui o UPDATE direto em public.reservations feito pelo painel
-- (CalendarView e Reservations). Quando data, horario, pessoas ou duracao
-- mudam, revalida capacidade e mesa. Mantem a mesa atual se continuar valida,
-- senao auto-atribui a melhor mesa; sem mesa disponivel exige "alocar depois".
--
-- Edicoes que mexem apenas em contato/ocasiao/observacoes nao disparam
-- revalidacao de capacidade (permitindo corrigir dados de reservas legadas).

CREATE OR REPLACE FUNCTION public.update_panel_reservation(
  _reservation_id uuid,
  _date date,
  _time time,
  _party_size integer,
  _guest_name text,
  _guest_phone text,
  _guest_email text DEFAULT NULL,
  _occasion text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _table_id uuid DEFAULT NULL,
  _keep_table boolean DEFAULT true,
  _allow_unassigned boolean DEFAULT false,
  _assignment_note text DEFAULT NULL
)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _reservation public.reservations%ROWTYPE;
  _company public.companies%ROWTYPE;
  _updated public.reservations%ROWTYPE;
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
  _normalized_name text;
  _normalized_phone text;
  _normalized_email text;
  _slot_changed boolean;
  _candidate_table_id uuid;
  _candidate_valid boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF _date IS NULL OR _time IS NULL THEN
    RAISE EXCEPTION 'Informe data e horario da reserva.';
  END IF;

  IF _party_size IS NULL OR _party_size < 1 OR _party_size > 50 THEN
    RAISE EXCEPTION 'Quantidade de pessoas invalida.';
  END IF;

  _normalized_name := NULLIF(btrim(COALESCE(_guest_name, '')), '');
  _normalized_phone := NULLIF(btrim(COALESCE(_guest_phone, '')), '');
  _normalized_email := NULLIF(lower(btrim(COALESCE(_guest_email, ''))), '');

  IF _normalized_name IS NULL OR _normalized_phone IS NULL THEN
    RAISE EXCEPTION 'Informe nome e WhatsApp do cliente.';
  END IF;

  SELECT *
  INTO _reservation
  FROM public.reservations
  WHERE id = _reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reserva nao encontrada.';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _reservation.company_id)
    OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, _reservation.company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  SELECT *
  INTO _company
  FROM public.companies c
  WHERE c.id = _reservation.company_id
  LIMIT 1;

  _slot_changed := (_reservation.date IS DISTINCT FROM _date)
    OR (_reservation.time IS DISTINCT FROM _time)
    OR (_reservation.party_size IS DISTINCT FROM _party_size);

  -- Edicao apenas de contato/ocasiao/observacoes: nao revalida capacidade.
  IF NOT _slot_changed AND _table_id IS NULL THEN
    UPDATE public.reservations
    SET
      guest_name = _normalized_name,
      guest_phone = _normalized_phone,
      guest_email = _normalized_email,
      occasion = NULLIF(btrim(COALESCE(_occasion, '')), ''),
      notes = NULLIF(btrim(COALESCE(_notes, '')), ''),
      updated_at = now()
    WHERE id = _reservation_id
    RETURNING *
    INTO _updated;

    RETURN _updated;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('reservation-slot|%s|%s|%s', _reservation.company_id::text, _date::text, _time::text), 0)
  );

  SELECT *
  INTO _schedule
  FROM public.get_public_reservation_schedule(_reservation.company_id, _date)
  LIMIT 1;

  _is_published_slot := COALESCE(_schedule.source, '') <> 'blocked'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(_schedule.slots, '[]'::jsonb)) slot_value
      WHERE slot_value = to_char(_time, 'HH24:MI')
    );

  _availability_mode := COALESCE(_schedule.availability_mode, 'tables');

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
      hashtextextended(format('reservation-capacity|%s|%s', _reservation.company_id::text, _date::text), 0)
    );
  END IF;

  -- Limite de reservas por horario (exclui a propria reserva).
  IF _is_published_slot AND _max_reservations_per_slot IS NOT NULL THEN
    _arrival_count := public.count_slot_arrival_reservations(_reservation.company_id, _date, _time, _reservation_id);
    IF _arrival_count >= _max_reservations_per_slot THEN
      RAISE EXCEPTION 'Limite de reservas atingido para este horario.';
    END IF;
  END IF;

  IF _availability_mode = 'capacity' THEN
    IF COALESCE(_slot_max_guests_per_slot, 0) <= 0 THEN
      RAISE EXCEPTION 'Capacidade nao configurada para este horario.';
    END IF;

    _occupied_guests := public.count_overlapping_reservation_guests(_reservation.company_id, _date, _time, _duration_minutes, _reservation_id);
    IF _occupied_guests + _party_size > _slot_max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;

    _resolved_table_id := NULL;
  ELSE
    _occupied_guests := public.count_overlapping_reservation_guests(_reservation.company_id, _date, _time, _duration_minutes, _reservation_id);
    IF _effective_max_guests_per_slot > 0
       AND _occupied_guests + _party_size > _effective_max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;

    SELECT active_map.id
    INTO _active_table_map_id
    FROM public.get_active_table_map(_reservation.company_id, (_date + _time)::timestamptz) active_map
    LIMIT 1;

    -- Mesa candidata: escolha explicita, senao mesa atual (se _keep_table).
    _candidate_table_id := COALESCE(
      _table_id,
      CASE WHEN COALESCE(_keep_table, true) THEN _reservation.table_id ELSE NULL END
    );

    _candidate_valid := false;
    IF _candidate_table_id IS NOT NULL THEN
      _candidate_valid := EXISTS (
        SELECT 1
        FROM public.restaurant_tables rt
        WHERE rt.id = _candidate_table_id
          AND rt.company_id = _reservation.company_id
          AND rt.status = 'available'
          AND rt.capacity >= _party_size
          AND (_active_table_map_id IS NULL OR rt.table_map_id = _active_table_map_id)
      )
      AND public.reservation_table_conflict_id(
        _reservation.company_id, _date, _time, _duration_minutes, _candidate_table_id, _reservation_id
      ) IS NULL;
    END IF;

    IF _candidate_valid THEN
      _resolved_table_id := _candidate_table_id;
    ELSIF _table_id IS NOT NULL THEN
      -- Mesa pedida explicitamente mas invalida: nao silenciar.
      RAISE EXCEPTION 'Mesa indisponivel para este horario.';
    ELSE
      -- Auto-atribui a melhor mesa livre.
      _resolved_table_id := public.pick_best_fit_reservation_table(
        _reservation.company_id, _date, _time, _duration_minutes, _party_size, _active_table_map_id, _reservation_id
      );

      IF _resolved_table_id IS NULL THEN
        IF COALESCE(_allow_unassigned, false) THEN
          _resolved_table_id := NULL;
          _assignment_note_value := COALESCE(
            NULLIF(btrim(_assignment_note), ''),
            _reservation.table_assignment_note,
            'Alocar mesa depois'
          );
        ELSE
          RAISE EXCEPTION 'Nenhuma mesa disponivel para este horario. Use "alocar depois" para registrar mesmo assim.';
        END IF;
      END IF;
    END IF;

    IF _resolved_table_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(format('reservation-table|%s|%s', _resolved_table_id::text, _date::text), 0)
      );

      IF public.reservation_table_conflict_id(
        _reservation.company_id, _date, _time, _duration_minutes, _resolved_table_id, _reservation_id
      ) IS NOT NULL THEN
        RAISE EXCEPTION 'Mesa indisponivel para este horario.';
      END IF;
    END IF;
  END IF;

  UPDATE public.reservations
  SET
    guest_name = _normalized_name,
    guest_phone = _normalized_phone,
    guest_email = _normalized_email,
    date = _date,
    time = _time,
    party_size = _party_size,
    duration_minutes = _duration_minutes,
    occasion = NULLIF(btrim(COALESCE(_occasion, '')), ''),
    notes = NULLIF(btrim(COALESCE(_notes, '')), ''),
    table_id = CASE WHEN _availability_mode = 'capacity' THEN NULL ELSE _resolved_table_id END,
    created_in_mode = _availability_mode,
    applied_schedule_rule_id = CASE WHEN _is_published_slot THEN _schedule.rule_id ELSE _reservation.applied_schedule_rule_id END,
    table_assignment_note = CASE WHEN _availability_mode = 'tables' THEN _assignment_note_value ELSE NULL END,
    updated_at = now()
  WHERE id = _reservation_id
  RETURNING *
  INTO _updated;

  RETURN _updated;
END;
$$;

REVOKE ALL ON FUNCTION public.update_panel_reservation(
  uuid, date, time, integer, text, text, text, text, text, uuid, boolean, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_panel_reservation(
  uuid, date, time, integer, text, text, text, text, text, uuid, boolean, boolean, text
) TO authenticated;
