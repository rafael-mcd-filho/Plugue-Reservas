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
  _recent_visitor_count integer := 0;
BEGIN
  IF _normalized_tracking_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    SELECT count(*)
    INTO _recent_visitor_count
    FROM public.public_rate_limits prl
    WHERE prl.scope = 'public_waitlist_leave_visitor'
      AND prl.identifier = _normalized_visitor_id
      AND prl.created_at >= now() - interval '15 minutes';

    IF _recent_visitor_count >= 10 THEN
      RAISE EXCEPTION 'Muitas tentativas deste dispositivo. Aguarde alguns minutos e tente novamente.';
    END IF;
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

  IF _normalized_visitor_id IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_waitlist_leave_visitor', _entry.company_id, _normalized_visitor_id);
  END IF;

  UPDATE public.waitlist w
  SET
    status = 'removed',
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
