ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS guest_email text,
  ADD COLUMN IF NOT EXISTS guest_birthdate date,
  ADD COLUMN IF NOT EXISTS seated_party_size integer;

ALTER TABLE public.waitlist
  DROP CONSTRAINT IF EXISTS waitlist_seated_party_size_check;

ALTER TABLE public.waitlist
  ADD CONSTRAINT waitlist_seated_party_size_check
  CHECK (seated_party_size IS NULL OR seated_party_size BETWEEN 1 AND 50);

CREATE TABLE IF NOT EXISTS public.waitlist_companions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_id uuid NOT NULL REFERENCES public.waitlist(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  phone text,
  email text,
  birthdate date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_companions_position_check CHECK (position >= 1)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_companions_waitlist_id
  ON public.waitlist_companions(waitlist_id);

CREATE INDEX IF NOT EXISTS idx_waitlist_companions_company_id
  ON public.waitlist_companions(company_id);

CREATE INDEX IF NOT EXISTS idx_waitlist_companions_phone
  ON public.waitlist_companions(company_id, phone)
  WHERE phone IS NOT NULL;

ALTER TABLE public.waitlist_companions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can manage all waitlist companions" ON public.waitlist_companions;
CREATE POLICY "Superadmins can manage all waitlist companions"
ON public.waitlist_companions
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'superadmin'))
WITH CHECK (has_role(auth.uid(), 'superadmin'));

DROP POLICY IF EXISTS "Company users can view waitlist companions" ON public.waitlist_companions;
CREATE POLICY "Company users can view waitlist companions"
ON public.waitlist_companions
FOR SELECT
TO authenticated
USING (
  company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Company staff can manage waitlist companions" ON public.waitlist_companions;
CREATE POLICY "Company staff can manage waitlist companions"
ON public.waitlist_companions
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

CREATE OR REPLACE FUNCTION public.sync_waitlist_companion_company_id()
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
  FROM public.waitlist
  WHERE id = NEW.waitlist_id;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Entrada da fila nao encontrada para acompanhante';
  END IF;

  NEW.company_id := _company_id;
  NEW.updated_at := now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_waitlist_companion_company_id ON public.waitlist_companions;
CREATE TRIGGER trg_sync_waitlist_companion_company_id
BEFORE INSERT OR UPDATE OF waitlist_id
ON public.waitlist_companions
FOR EACH ROW
EXECUTE FUNCTION public.sync_waitlist_companion_company_id();

DROP FUNCTION IF EXISTS public.seat_waitlist_entry(uuid, integer, jsonb, text, text);
CREATE OR REPLACE FUNCTION public.seat_waitlist_entry(
  _waitlist_id uuid,
  _seated_party_size integer,
  _companions jsonb DEFAULT '[]'::jsonb,
  _guest_email text DEFAULT NULL,
  _guest_birthdate text DEFAULT NULL
)
RETURNS public.waitlist
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry public.waitlist%ROWTYPE;
  _updated public.waitlist%ROWTYPE;
  _companion jsonb;
  _companions_payload jsonb := COALESCE(_companions, '[]'::jsonb);
  _name text;
  _phone text;
  _email text;
  _birthdate_text text;
  _inserted integer := 0;
  _normalized_guest_email text := NULLIF(lower(btrim(COALESCE(_guest_email, ''))), '');
  _normalized_guest_birthdate text := NULLIF(btrim(COALESCE(_guest_birthdate, '')), '');
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

  RETURN _updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seat_waitlist_entry(uuid, integer, jsonb, text, text) TO authenticated;
