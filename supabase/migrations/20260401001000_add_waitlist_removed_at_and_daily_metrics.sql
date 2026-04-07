ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;

UPDATE public.waitlist
SET seated_at = COALESCE(seated_at, updated_at)
WHERE status = 'seated'
  AND seated_at IS NULL;

UPDATE public.waitlist
SET expired_at = COALESCE(expired_at, updated_at)
WHERE status = 'expired'
  AND expired_at IS NULL;

UPDATE public.waitlist
SET removed_at = COALESCE(removed_at, updated_at)
WHERE status = 'removed'
  AND removed_at IS NULL;

DROP FUNCTION IF EXISTS public.leave_public_waitlist(text, text);

CREATE OR REPLACE FUNCTION public.leave_public_waitlist(
  _tracking_code text,
  _visitor_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tracking_code text,
  status text,
  left_waitlist boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry public.waitlist%ROWTYPE;
  _updated public.waitlist%ROWTYPE;
  _normalized_tracking_code text := lower(btrim(COALESCE(_tracking_code, '')));
  _normalized_visitor_id text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
BEGIN
  IF _normalized_tracking_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  IF _normalized_visitor_id IS NULL THEN
    RAISE EXCEPTION 'Identificador do visitante invalido.';
  END IF;

  SELECT *
  INTO _entry
  FROM public.waitlist w
  WHERE w.tracking_code = _normalized_tracking_code
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entrada nao encontrada.';
  END IF;

  IF _entry.status NOT IN ('waiting', 'called') THEN
    RETURN QUERY
    SELECT
      _entry.id,
      _entry.tracking_code,
      _entry.status,
      false;
    RETURN;
  END IF;

  INSERT INTO public.public_rate_limits (scope, company_id, identifier)
  VALUES ('public_waitlist_leave_visitor', _entry.company_id, _normalized_visitor_id);

  UPDATE public.waitlist w
  SET
    status = 'removed',
    removed_at = COALESCE(w.removed_at, now()),
    updated_at = now()
  WHERE w.id = _entry.id
  RETURNING *
  INTO _updated;

  RETURN QUERY
  SELECT
    _updated.id,
    _updated.tracking_code,
    _updated.status,
    true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.leave_public_waitlist(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.leave_public_waitlist(text, text) TO authenticated;
