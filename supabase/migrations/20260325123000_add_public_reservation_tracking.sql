ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS public_tracking_code text;

UPDATE public.reservations
SET public_tracking_code = replace(gen_random_uuid()::text, '-', '')
WHERE public_tracking_code IS NULL;

ALTER TABLE public.reservations
  ALTER COLUMN public_tracking_code SET DEFAULT replace(gen_random_uuid()::text, '-', '');

ALTER TABLE public.reservations
  ALTER COLUMN public_tracking_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_public_tracking_code
ON public.reservations(public_tracking_code);

DROP FUNCTION IF EXISTS public.get_public_reservation_by_tracking_code(text);

CREATE OR REPLACE FUNCTION public.get_public_reservation_by_tracking_code(_tracking_code text)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  guest_name text,
  date date,
  "time" text,
  party_size integer,
  status text,
  occasion text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  public_tracking_code text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id,
    r.company_id,
    r.guest_name,
    r.date,
    r.time::text AS "time",
    r.party_size,
    r.status,
    r.occasion,
    r.notes,
    r.created_at,
    r.updated_at,
    r.public_tracking_code
  FROM public.reservations r
  WHERE r.public_tracking_code = lower(btrim(_tracking_code))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_reservation_by_tracking_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_by_tracking_code(text) TO authenticated;

DROP FUNCTION IF EXISTS public.cancel_public_reservation(text, text);

CREATE OR REPLACE FUNCTION public.cancel_public_reservation(
  _tracking_code text,
  _visitor_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  public_tracking_code text,
  status text,
  cancelled boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry public.reservations%ROWTYPE;
  _updated public.reservations%ROWTYPE;
  _normalized_tracking_code text := lower(btrim(COALESCE(_tracking_code, '')));
  _normalized_visitor_id text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _recent_visitor_count integer := 0;
BEGIN
  IF _normalized_tracking_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    SELECT count(*)
    INTO _recent_visitor_count
    FROM public.public_rate_limits prl
    WHERE prl.scope = 'public_reservation_cancel_visitor'
      AND prl.identifier = _normalized_visitor_id
      AND prl.created_at >= now() - interval '15 minutes';

    IF _recent_visitor_count >= 10 THEN
      RAISE EXCEPTION 'Muitas tentativas deste dispositivo. Aguarde alguns minutos e tente novamente.';
    END IF;
  END IF;

  SELECT *
  INTO _entry
  FROM public.reservations r
  WHERE r.public_tracking_code = _normalized_tracking_code
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reserva nao encontrada.';
  END IF;

  IF _entry.status <> 'confirmed' THEN
    RETURN QUERY
    SELECT
      _entry.id,
      _entry.public_tracking_code,
      _entry.status,
      false;
    RETURN;
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_reservation_cancel_visitor', _entry.company_id, _normalized_visitor_id);
  END IF;

  UPDATE public.reservations r
  SET
    status = 'cancelled',
    updated_at = now()
  WHERE r.id = _entry.id
  RETURNING *
  INTO _updated;

  RETURN QUERY
  SELECT
    _updated.id,
    _updated.public_tracking_code,
    _updated.status,
    true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_public_reservation(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.cancel_public_reservation(text, text) TO authenticated;
