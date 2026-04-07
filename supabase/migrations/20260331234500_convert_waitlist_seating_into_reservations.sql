ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS source text;

UPDATE public.reservations
SET source = 'reservation'
WHERE source IS NULL;

ALTER TABLE public.reservations
  ALTER COLUMN source SET DEFAULT 'reservation';

ALTER TABLE public.reservations
  ALTER COLUMN source SET NOT NULL;

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_source_check;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_source_check
  CHECK (source IN ('reservation', 'waitlist'));

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS origin_waitlist_id uuid REFERENCES public.waitlist(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_origin_waitlist_id
ON public.reservations(origin_waitlist_id)
WHERE origin_waitlist_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_source_date
ON public.reservations(company_id, source, date DESC);

DROP FUNCTION IF EXISTS public.seat_waitlist_entry(uuid, integer, jsonb, text, text);
DROP FUNCTION IF EXISTS public.seat_waitlist_entry(uuid, integer, jsonb, text, text, text, text);
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

  IF NOT FOUND THEN
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
      origin_waitlist_id
    )
    VALUES (
      _updated.company_id,
      NULL,
      _updated.guest_name,
      _updated.guest_phone,
      _updated.guest_email,
      _updated.guest_birthdate,
      _reservation_date_value,
      _reservation_time_value,
      _seated_party_size,
      30,
      'checked_in',
      'Fila de espera',
      _updated.notes,
      NULL,
      COALESCE(_updated.seated_at, now()),
      _seated_party_size,
      'waitlist',
      _waitlist_id
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
      status = 'checked_in',
      occasion = COALESCE(occasion, 'Fila de espera'),
      notes = _updated.notes,
      checked_in_at = COALESCE(_reservation.checked_in_at, _updated.seated_at, now()),
      checked_in_party_size = _seated_party_size,
      source = 'waitlist',
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
