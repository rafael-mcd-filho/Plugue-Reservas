-- Complemento das Fases 4/6: atribuicao automatica de mesa ao SENTAR da fila.
--
-- A atribuicao de mesa acontece exclusivamente ao sentar (seat_waitlist_entry),
-- nunca ao entrar ('waiting') nem ao chamar ('called') a fila.
--
-- Ao sentar, resolvemos o modo do horario e:
--   * modo por mesas    -> auto-atribui a menor mesa livre sem conflito; se nao
--                          houver mesa livre, senta SEM mesa (nao bloqueia um
--                          walk-in ja presente) e marca "alocar depois".
--   * modo por capacidade -> table_id = NULL e created_in_mode = 'capacity'.
-- Em ambos passamos a gravar created_in_mode e a duracao resolvida do slot
-- (antes ficava fixa em 30). Nao bloqueamos por limite de pessoas: o cliente ja
-- esta presente; apenas evitamos conflito de mesa.

CREATE OR REPLACE FUNCTION public.seat_waitlist_entry(
  _waitlist_id uuid,
  _seated_party_size integer,
  _companions jsonb DEFAULT '[]'::jsonb,
  _guest_email text DEFAULT NULL,
  _guest_birthdate text DEFAULT NULL,
  _reservation_date text DEFAULT NULL,
  _reservation_time text DEFAULT NULL
)
RETURNS public.waitlist
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry public.waitlist%ROWTYPE;
  _updated public.waitlist%ROWTYPE;
  _reservation public.reservations%ROWTYPE;
  _reservation_id uuid;
  _companion jsonb;
  _companions_payload jsonb := COALESCE(_companions, '[]'::jsonb);
  _name text;
  _phone text;
  _email text;
  _birthdate_text text;
  _inserted integer := 0;
  _normalized_guest_email text := NULLIF(lower(btrim(COALESCE(_guest_email, ''))), '');
  _normalized_guest_birthdate text := NULLIF(btrim(COALESCE(_guest_birthdate, '')), '');
  _normalized_reservation_date text := NULLIF(btrim(COALESCE(_reservation_date, '')), '');
  _normalized_reservation_time text := NULLIF(btrim(COALESCE(_reservation_time, '')), '');
  _reservation_date_value date;
  _reservation_time_value time without time zone;
  _availability_mode text;
  _duration_minutes integer;
  _active_table_map_id uuid;
  _resolved_table_id uuid;
  _assignment_note_value text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  IF _seated_party_size IS NULL OR _seated_party_size < 1 OR _seated_party_size > 50 THEN
    RAISE EXCEPTION 'Quantidade presente invalida';
  END IF;

  IF jsonb_typeof(_companions_payload) <> 'array' THEN
    RAISE EXCEPTION 'Lista de acompanhantes invalida';
  END IF;

  _reservation_date_value := CASE
    WHEN _normalized_reservation_date IS NULL THEN now()::date
    ELSE _normalized_reservation_date::date
  END;

  _reservation_time_value := CASE
    WHEN _normalized_reservation_time IS NULL THEN date_trunc('minute', localtimestamp)::time
    ELSE _normalized_reservation_time::time
  END;

  SELECT *
  INTO _entry
  FROM public.waitlist
  WHERE id = _waitlist_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entrada da fila nao encontrada';
  END IF;

  IF NOT (
    has_role(auth.uid(), 'superadmin')
    OR has_role_in_company(auth.uid(), 'admin', _entry.company_id)
    OR has_role_in_company(auth.uid(), 'operator', _entry.company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  IF _entry.status NOT IN ('waiting', 'called', 'seated') THEN
    RAISE EXCEPTION 'Apenas entradas ativas da fila podem ser marcadas como sentadas';
  END IF;

  DELETE FROM public.waitlist_companions
  WHERE waitlist_id = _waitlist_id;

  FOR _companion IN
    SELECT value
    FROM jsonb_array_elements(_companions_payload)
  LOOP
    _name := NULLIF(btrim(COALESCE(_companion->>'name', '')), '');
    _phone := NULLIF(btrim(COALESCE(_companion->>'phone', '')), '');
    _email := NULLIF(lower(btrim(COALESCE(_companion->>'email', ''))), '');
    _birthdate_text := NULLIF(btrim(COALESCE(_companion->>'birthdate', '')), '');

    IF _name IS NULL AND _phone IS NULL AND _email IS NULL AND _birthdate_text IS NULL THEN
      CONTINUE;
    END IF;

    IF _name IS NULL THEN
      RAISE EXCEPTION 'Cada acompanhante precisa de um nome';
    END IF;

    _inserted := _inserted + 1;

    INSERT INTO public.waitlist_companions (
      waitlist_id,
      company_id,
      position,
      name,
      phone,
      email,
      birthdate
    )
    VALUES (
      _waitlist_id,
      _entry.company_id,
      _inserted,
      _name,
      _phone,
      _email,
      CASE
        WHEN _birthdate_text IS NULL THEN NULL
        ELSE _birthdate_text::date
      END
    );
  END LOOP;

  IF _inserted > GREATEST(_seated_party_size - 1, 0) THEN
    RAISE EXCEPTION 'A quantidade de acompanhantes excede o total presente informado';
  END IF;

  UPDATE public.waitlist
  SET
    status = 'seated',
    seated_at = COALESCE(seated_at, now()),
    seated_party_size = _seated_party_size,
    guest_email = _normalized_guest_email,
    guest_birthdate = CASE
      WHEN _normalized_guest_birthdate IS NULL THEN NULL
      ELSE _normalized_guest_birthdate::date
    END,
    updated_at = now()
  WHERE id = _waitlist_id
  RETURNING *
  INTO _updated;

  SELECT *
  INTO _reservation
  FROM public.reservations
  WHERE origin_waitlist_id = _waitlist_id
  FOR UPDATE;

  -- Resolucao do modo/duracao/mesa. So acontece aqui (ao sentar).
  SELECT COALESCE(availability_mode, 'tables')
  INTO _availability_mode
  FROM public.get_public_reservation_schedule(_updated.company_id, _reservation_date_value)
  LIMIT 1;
  _availability_mode := COALESCE(_availability_mode, 'tables');

  _duration_minutes := GREATEST(
    COALESCE(public.resolve_reservation_slot_duration(_updated.company_id, _reservation_date_value, _reservation_time_value), 30),
    1
  );

  _resolved_table_id := NULL;
  _assignment_note_value := NULL;

  IF _availability_mode = 'tables' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(format('reservation-slot|%s|%s|%s', _updated.company_id::text, _reservation_date_value::text, _reservation_time_value::text), 0)
    );

    SELECT active_map.id
    INTO _active_table_map_id
    FROM public.get_active_table_map(_updated.company_id, (_reservation_date_value + _reservation_time_value)::timestamptz) active_map
    LIMIT 1;

    -- Re-sentar: mantem a mesa atual se ainda for valida.
    IF _reservation.table_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM public.restaurant_tables rt
         WHERE rt.id = _reservation.table_id
           AND rt.company_id = _updated.company_id
           AND rt.status = 'available'
           AND rt.capacity >= _seated_party_size
           AND (_active_table_map_id IS NULL OR rt.table_map_id = _active_table_map_id)
       )
       AND public.reservation_table_conflict_id(
         _updated.company_id, _reservation_date_value, _reservation_time_value, _duration_minutes, _reservation.table_id, _reservation.id
       ) IS NULL THEN
      _resolved_table_id := _reservation.table_id;
    ELSE
      _resolved_table_id := public.pick_best_fit_reservation_table(
        _updated.company_id, _reservation_date_value, _reservation_time_value, _duration_minutes, _seated_party_size, _active_table_map_id, _reservation.id
      );
    END IF;

    IF _resolved_table_id IS NULL THEN
      _assignment_note_value := 'Alocar mesa depois (fila de espera)';
    ELSE
      PERFORM pg_advisory_xact_lock(
        hashtextextended(format('reservation-table|%s|%s', _resolved_table_id::text, _reservation_date_value::text), 0)
      );

      -- Revalida apos o lock para evitar corrida.
      IF public.reservation_table_conflict_id(
        _updated.company_id, _reservation_date_value, _reservation_time_value, _duration_minutes, _resolved_table_id, _reservation.id
      ) IS NOT NULL THEN
        _resolved_table_id := public.pick_best_fit_reservation_table(
          _updated.company_id, _reservation_date_value, _reservation_time_value, _duration_minutes, _seated_party_size, _active_table_map_id, _reservation.id
        );
        IF _resolved_table_id IS NULL THEN
          _assignment_note_value := 'Alocar mesa depois (fila de espera)';
        END IF;
      END IF;
    END IF;
  END IF;

  IF _reservation.id IS NULL THEN
    INSERT INTO public.reservations (
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
      checked_in_at,
      checked_in_party_size,
      source,
      origin_waitlist_id,
      created_in_mode,
      table_assignment_note
    )
    VALUES (
      _updated.company_id,
      CASE WHEN _availability_mode = 'capacity' THEN NULL ELSE _resolved_table_id END,
      _updated.guest_name,
      _updated.guest_phone,
      _updated.guest_email,
      _updated.guest_birthdate,
      _reservation_date_value,
      _reservation_time_value,
      _seated_party_size,
      _duration_minutes,
      'checked_in',
      'Fila de espera',
      _updated.notes,
      NULL,
      COALESCE(_updated.seated_at, now()),
      _seated_party_size,
      'waitlist',
      _waitlist_id,
      _availability_mode,
      CASE WHEN _availability_mode = 'tables' THEN _assignment_note_value ELSE NULL END
    )
    RETURNING *
    INTO _reservation;
  ELSE
    UPDATE public.reservations
    SET
      guest_name = _updated.guest_name,
      guest_phone = _updated.guest_phone,
      guest_email = _updated.guest_email,
      guest_birthdate = _updated.guest_birthdate,
      date = _reservation_date_value,
      time = _reservation_time_value,
      party_size = _seated_party_size,
      duration_minutes = _duration_minutes,
      status = 'checked_in',
      occasion = COALESCE(occasion, 'Fila de espera'),
      notes = _updated.notes,
      checked_in_at = COALESCE(_reservation.checked_in_at, _updated.seated_at, now()),
      checked_in_party_size = _seated_party_size,
      source = 'waitlist',
      table_id = CASE WHEN _availability_mode = 'capacity' THEN NULL ELSE _resolved_table_id END,
      created_in_mode = _availability_mode,
      table_assignment_note = CASE WHEN _availability_mode = 'tables' THEN _assignment_note_value ELSE NULL END,
      updated_at = now()
    WHERE id = _reservation.id
    RETURNING *
    INTO _reservation;
  END IF;

  _reservation_id := _reservation.id;

  DELETE FROM public.reservation_companions
  WHERE reservation_id = _reservation_id;

  _inserted := 0;

  FOR _companion IN
    SELECT value
    FROM jsonb_array_elements(_companions_payload)
  LOOP
    _name := NULLIF(btrim(COALESCE(_companion->>'name', '')), '');
    _phone := NULLIF(btrim(COALESCE(_companion->>'phone', '')), '');
    _email := NULLIF(lower(btrim(COALESCE(_companion->>'email', ''))), '');
    _birthdate_text := NULLIF(btrim(COALESCE(_companion->>'birthdate', '')), '');

    IF _name IS NULL AND _phone IS NULL AND _email IS NULL AND _birthdate_text IS NULL THEN
      CONTINUE;
    END IF;

    IF _name IS NULL THEN
      RAISE EXCEPTION 'Cada acompanhante precisa de um nome';
    END IF;

    _inserted := _inserted + 1;

    INSERT INTO public.reservation_companions (
      reservation_id,
      company_id,
      position,
      name,
      phone,
      email,
      birthdate
    )
    VALUES (
      _reservation_id,
      _updated.company_id,
      _inserted,
      _name,
      _phone,
      _email,
      CASE
        WHEN _birthdate_text IS NULL THEN NULL
        ELSE _birthdate_text::date
      END
    );
  END LOOP;

  RETURN _updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seat_waitlist_entry(uuid, integer, jsonb, text, text, text, text) TO authenticated;
