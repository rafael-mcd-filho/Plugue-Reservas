ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS checked_in_party_size integer;

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_checked_in_party_size_check;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_checked_in_party_size_check
  CHECK (checked_in_party_size IS NULL OR checked_in_party_size BETWEEN 1 AND 50);

CREATE TABLE IF NOT EXISTS public.reservation_companions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  phone text,
  email text,
  birthdate date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_companions_position_check CHECK (position >= 1)
);

CREATE INDEX IF NOT EXISTS idx_reservation_companions_reservation_id
  ON public.reservation_companions(reservation_id);

CREATE INDEX IF NOT EXISTS idx_reservation_companions_company_id
  ON public.reservation_companions(company_id);

CREATE INDEX IF NOT EXISTS idx_reservation_companions_phone
  ON public.reservation_companions(company_id, phone)
  WHERE phone IS NOT NULL;

ALTER TABLE public.reservation_companions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can manage all reservation companions" ON public.reservation_companions;
CREATE POLICY "Superadmins can manage all reservation companions"
ON public.reservation_companions
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'superadmin'))
WITH CHECK (has_role(auth.uid(), 'superadmin'));

DROP POLICY IF EXISTS "Company users can view reservation companions" ON public.reservation_companions;
CREATE POLICY "Company users can view reservation companions"
ON public.reservation_companions
FOR SELECT
TO authenticated
USING (
  company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Company staff can manage reservation companions" ON public.reservation_companions;
CREATE POLICY "Company staff can manage reservation companions"
ON public.reservation_companions
FOR ALL
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
)
WITH CHECK (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
);

CREATE OR REPLACE FUNCTION public.sync_reservation_companion_company_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company_id uuid;
BEGIN
  SELECT company_id
  INTO _company_id
  FROM public.reservations
  WHERE id = NEW.reservation_id;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Reserva nao encontrada para acompanhante';
  END IF;

  NEW.company_id := _company_id;
  NEW.updated_at := now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_reservation_companion_company_id ON public.reservation_companions;
CREATE TRIGGER trg_sync_reservation_companion_company_id
BEFORE INSERT OR UPDATE OF reservation_id
ON public.reservation_companions
FOR EACH ROW
EXECUTE FUNCTION public.sync_reservation_companion_company_id();

DROP FUNCTION IF EXISTS public.check_in_reservation(uuid, integer, jsonb);
CREATE OR REPLACE FUNCTION public.check_in_reservation(
  _reservation_id uuid,
  _checked_in_party_size integer,
  _companions jsonb DEFAULT '[]'::jsonb
)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _reservation public.reservations%ROWTYPE;
  _updated public.reservations%ROWTYPE;
  _companion jsonb;
  _companions_payload jsonb := COALESCE(_companions, '[]'::jsonb);
  _name text;
  _phone text;
  _email text;
  _birthdate_text text;
  _inserted integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  IF _checked_in_party_size IS NULL OR _checked_in_party_size < 1 OR _checked_in_party_size > 50 THEN
    RAISE EXCEPTION 'Quantidade presente invalida';
  END IF;

  IF jsonb_typeof(_companions_payload) <> 'array' THEN
    RAISE EXCEPTION 'Lista de acompanhantes invalida';
  END IF;

  SELECT *
  INTO _reservation
  FROM public.reservations
  WHERE id = _reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reserva nao encontrada';
  END IF;

  IF NOT (
    has_role(auth.uid(), 'superadmin')
    OR has_role_in_company(auth.uid(), 'admin', _reservation.company_id)
    OR has_role_in_company(auth.uid(), 'operator', _reservation.company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  DELETE FROM public.reservation_companions
  WHERE reservation_id = _reservation_id;

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
      _reservation.company_id,
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

  IF _inserted > GREATEST(_checked_in_party_size - 1, 0) THEN
    RAISE EXCEPTION 'A quantidade de acompanhantes excede o total presente informado';
  END IF;

  UPDATE public.reservations
  SET
    status = 'checked_in',
    checked_in_at = COALESCE(checked_in_at, now()),
    checked_in_party_size = _checked_in_party_size,
    updated_at = now()
  WHERE id = _reservation_id
  RETURNING *
  INTO _updated;

  RETURN _updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_reservation(uuid, integer, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.update_reservation_status(uuid, text);
CREATE OR REPLACE FUNCTION public.update_reservation_status(
  _reservation_id uuid,
  _status text
)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _reservation public.reservations%ROWTYPE;
  _updated public.reservations%ROWTYPE;
  _normalized_status text := lower(btrim(COALESCE(_status, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  IF _normalized_status = 'no_show' THEN
    _normalized_status := 'no-show';
  END IF;

  IF _normalized_status NOT IN ('confirmed', 'cancelled', 'checked_in', 'no-show') THEN
    RAISE EXCEPTION 'Status invalido';
  END IF;

  IF _normalized_status = 'checked_in' THEN
    RAISE EXCEPTION 'Use a funcao de check-in para registrar acompanhantes';
  END IF;

  SELECT *
  INTO _reservation
  FROM public.reservations
  WHERE id = _reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reserva nao encontrada';
  END IF;

  IF NOT (
    has_role(auth.uid(), 'superadmin')
    OR has_role_in_company(auth.uid(), 'admin', _reservation.company_id)
    OR has_role_in_company(auth.uid(), 'operator', _reservation.company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  UPDATE public.reservations
  SET
    status = _normalized_status,
    checked_in_at = CASE
      WHEN _normalized_status IN ('confirmed', 'cancelled', 'no-show') THEN NULL
      ELSE checked_in_at
    END,
    checked_in_party_size = CASE
      WHEN _normalized_status IN ('confirmed', 'cancelled', 'no-show') THEN NULL
      ELSE checked_in_party_size
    END,
    updated_at = now()
  WHERE id = _reservation_id
  RETURNING *
  INTO _updated;

  IF _normalized_status IN ('confirmed', 'cancelled', 'no-show') THEN
    DELETE FROM public.reservation_companions
    WHERE reservation_id = _reservation_id;
  END IF;

  RETURN _updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_reservation_status(uuid, text) TO authenticated;
