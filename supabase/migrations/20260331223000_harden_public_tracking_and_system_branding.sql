CREATE OR REPLACE FUNCTION public.get_public_system_branding()
RETURNS TABLE (
  system_name text,
  system_logo_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(MAX(value) FILTER (WHERE key = 'system_name'), 'ReservaFacil') AS system_name,
    COALESCE(MAX(value) FILTER (WHERE key = 'system_logo_url'), '') AS system_logo_url
  FROM public.system_settings
  WHERE key IN ('system_name', 'system_logo_url');
$$;

GRANT EXECUTE ON FUNCTION public.get_public_system_branding() TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_system_branding() TO authenticated;

ALTER TABLE public.waitlist
  ALTER COLUMN tracking_code SET DEFAULT replace(gen_random_uuid()::text, '-', '');

DROP FUNCTION IF EXISTS public.get_waitlist_by_tracking_code(text);

CREATE OR REPLACE FUNCTION public.get_waitlist_by_tracking_code(
  _tracking_code text,
  _visitor_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  guest_name text,
  party_size integer,
  tracking_code text,
  status text,
  "position" integer,
  created_at timestamptz,
  called_at timestamptz,
  ahead_count integer,
  avg_wait_minutes integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry public.waitlist%ROWTYPE;
  _normalized_tracking_code text := lower(btrim(COALESCE(_tracking_code, '')));
  _normalized_visitor_id text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _recent_lookup_count integer := 0;
BEGIN
  IF _normalized_tracking_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    SELECT count(*)
    INTO _recent_lookup_count
    FROM public.public_rate_limits prl
    WHERE prl.scope = 'public_waitlist_lookup_visitor'
      AND prl.identifier = _normalized_visitor_id
      AND prl.created_at >= now() - interval '15 minutes';

    IF _recent_lookup_count >= 60 THEN
      RAISE EXCEPTION 'Muitas consultas deste dispositivo. Aguarde alguns minutos e tente novamente.';
    END IF;
  END IF;

  SELECT *
  INTO _entry
  FROM public.waitlist w
  WHERE w.tracking_code = _normalized_tracking_code
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_waitlist_lookup_visitor', _entry.company_id, _normalized_visitor_id);
  END IF;

  RETURN QUERY
  SELECT
    _entry.id,
    _entry.guest_name,
    _entry.party_size,
    _entry.tracking_code,
    _entry.status,
    _entry.position,
    _entry.created_at,
    _entry.called_at,
    COALESCE((
      SELECT count(*)::integer
      FROM public.waitlist w
      WHERE w.company_id = _entry.company_id
        AND w.status = 'waiting'
        AND w.position < _entry.position
    ), 0),
    GREATEST(5, COALESCE((
      SELECT round(avg(EXTRACT(EPOCH FROM (w.seated_at - w.created_at)) / 60.0))::integer
      FROM public.waitlist w
      WHERE w.company_id = _entry.company_id
        AND w.status = 'seated'
        AND w.seated_at IS NOT NULL
        AND w.created_at >= now() - interval '30 days'
    ), 10));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_waitlist_by_tracking_code(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_waitlist_by_tracking_code(text, text) TO authenticated;

DROP FUNCTION IF EXISTS public.get_public_reservation_by_tracking_code(text);

CREATE OR REPLACE FUNCTION public.get_public_reservation_by_tracking_code(
  _tracking_code text,
  _visitor_id text DEFAULT NULL
)
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
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry public.reservations%ROWTYPE;
  _normalized_tracking_code text := lower(btrim(COALESCE(_tracking_code, '')));
  _normalized_visitor_id text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _recent_lookup_count integer := 0;
BEGIN
  IF _normalized_tracking_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    SELECT count(*)
    INTO _recent_lookup_count
    FROM public.public_rate_limits prl
    WHERE prl.scope = 'public_reservation_lookup_visitor'
      AND prl.identifier = _normalized_visitor_id
      AND prl.created_at >= now() - interval '15 minutes';

    IF _recent_lookup_count >= 60 THEN
      RAISE EXCEPTION 'Muitas consultas deste dispositivo. Aguarde alguns minutos e tente novamente.';
    END IF;
  END IF;

  SELECT *
  INTO _entry
  FROM public.reservations r
  WHERE r.public_tracking_code = _normalized_tracking_code
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_reservation_lookup_visitor', _entry.company_id, _normalized_visitor_id);
  END IF;

  RETURN QUERY
  SELECT
    _entry.id,
    _entry.company_id,
    _entry.guest_name,
    _entry.date,
    _entry.time::text,
    _entry.party_size,
    _entry.status,
    _entry.occasion,
    _entry.notes,
    _entry.created_at,
    _entry.updated_at,
    _entry.public_tracking_code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_reservation_by_tracking_code(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_by_tracking_code(text, text) TO authenticated;

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

  IF _normalized_visitor_id IS NULL THEN
    RAISE EXCEPTION 'Identificacao do dispositivo obrigatoria.';
  END IF;

  SELECT count(*)
  INTO _recent_visitor_count
  FROM public.public_rate_limits prl
  WHERE prl.scope = 'public_waitlist_leave_visitor'
    AND prl.identifier = _normalized_visitor_id
    AND prl.created_at >= now() - interval '15 minutes';

  IF _recent_visitor_count >= 10 THEN
    RAISE EXCEPTION 'Muitas tentativas deste dispositivo. Aguarde alguns minutos e tente novamente.';
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

  IF _normalized_visitor_id IS NULL THEN
    RAISE EXCEPTION 'Identificacao do dispositivo obrigatoria.';
  END IF;

  SELECT count(*)
  INTO _recent_visitor_count
  FROM public.public_rate_limits prl
  WHERE prl.scope = 'public_reservation_cancel_visitor'
    AND prl.identifier = _normalized_visitor_id
    AND prl.created_at >= now() - interval '15 minutes';

  IF _recent_visitor_count >= 10 THEN
    RAISE EXCEPTION 'Muitas tentativas deste dispositivo. Aguarde alguns minutos e tente novamente.';
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

  INSERT INTO public.public_rate_limits (scope, company_id, identifier)
  VALUES ('public_reservation_cancel_visitor', _entry.company_id, _normalized_visitor_id);

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
