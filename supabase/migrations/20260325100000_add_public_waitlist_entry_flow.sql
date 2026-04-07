ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS public_waitlist_enabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW public.companies_public
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  slug,
  logo_url,
  description,
  phone,
  address,
  google_maps_url,
  whatsapp,
  instagram,
  opening_hours,
  payment_methods,
  reservation_duration,
  max_guests_per_slot,
  status,
  show_public_whatsapp_button,
  public_waitlist_enabled
FROM public.companies
WHERE status = 'active';

GRANT SELECT ON public.companies_public TO anon;
GRANT SELECT ON public.companies_public TO authenticated;

DROP FUNCTION IF EXISTS public.get_public_company_by_slug(text);

CREATE OR REPLACE FUNCTION public.get_public_company_by_slug(_slug text)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  logo_url text,
  description text,
  phone text,
  address text,
  google_maps_url text,
  whatsapp text,
  show_public_whatsapp_button boolean,
  public_waitlist_enabled boolean,
  instagram text,
  opening_hours jsonb,
  payment_methods jsonb,
  reservation_duration integer,
  max_guests_per_slot integer,
  status text,
  custom_public_page_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.name,
    c.slug,
    c.logo_url,
    c.description,
    c.phone,
    c.address,
    c.google_maps_url,
    c.whatsapp,
    c.show_public_whatsapp_button,
    c.public_waitlist_enabled,
    c.instagram,
    c.opening_hours,
    c.payment_methods,
    c.reservation_duration,
    c.max_guests_per_slot,
    c.status,
    public.company_feature_enabled(c.id, 'custom_public_page') AS custom_public_page_enabled
  FROM public.companies c
  WHERE c.slug = _slug
    AND c.status = 'active'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO authenticated;

DROP FUNCTION IF EXISTS public.join_public_waitlist(text, text, text, integer, text, text);

CREATE OR REPLACE FUNCTION public.join_public_waitlist(
  _slug text,
  _guest_name text,
  _guest_phone text,
  _party_size integer DEFAULT 1,
  _notes text DEFAULT NULL,
  _visitor_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tracking_code text,
  status text,
  "position" integer,
  already_exists boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company public.companies%ROWTYPE;
  _existing public.waitlist%ROWTYPE;
  _created public.waitlist%ROWTYPE;
  _normalized_name text := btrim(COALESCE(_guest_name, ''));
  _normalized_phone text := regexp_replace(COALESCE(_guest_phone, ''), '\D', '', 'g');
  _normalized_notes text := NULLIF(btrim(COALESCE(_notes, '')), '');
  _normalized_visitor_id text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _next_position integer := 1;
  _recent_phone_count integer := 0;
  _recent_visitor_count integer := 0;
BEGIN
  SELECT *
  INTO _company
  FROM public.companies c
  WHERE c.slug = _slug
    AND c.status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa nao encontrada ou indisponivel.';
  END IF;

  IF NOT COALESCE(_company.public_waitlist_enabled, false) THEN
    RAISE EXCEPTION 'A entrada online na fila esta desabilitada. Dirija-se a unidade para entrar na fila de espera.';
  END IF;

  IF _normalized_name = '' THEN
    RAISE EXCEPTION 'Informe seu nome.';
  END IF;

  IF length(_normalized_phone) < 10 THEN
    RAISE EXCEPTION 'Informe um WhatsApp valido com DDD.';
  END IF;

  IF _party_size < 1 OR _party_size > 20 THEN
    RAISE EXCEPTION 'Quantidade de pessoas invalida.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(_company.id::text));

  SELECT *
  INTO _existing
  FROM public.waitlist w
  WHERE w.company_id = _company.id
    AND w.guest_phone = _normalized_phone
    AND w.status IN ('waiting', 'called')
  ORDER BY w.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY
    SELECT
      _existing.id,
      _existing.tracking_code,
      _existing.status,
      _existing.position,
      true;
    RETURN;
  END IF;

  SELECT count(*)
  INTO _recent_phone_count
  FROM public.public_rate_limits
  WHERE scope = 'public_waitlist_phone'
    AND company_id = _company.id
    AND identifier = _normalized_phone
    AND created_at >= now() - interval '15 minutes';

  IF _recent_phone_count >= 3 THEN
    RAISE EXCEPTION 'Muitas tentativas para este telefone. Aguarde alguns minutos e tente novamente.';
  END IF;

  IF _normalized_visitor_id IS NOT NULL THEN
    SELECT count(*)
    INTO _recent_visitor_count
    FROM public.public_rate_limits
    WHERE scope = 'public_waitlist_visitor'
      AND company_id = _company.id
      AND identifier = _normalized_visitor_id
      AND created_at >= now() - interval '15 minutes';

    IF _recent_visitor_count >= 5 THEN
      RAISE EXCEPTION 'Muitas tentativas deste dispositivo. Aguarde alguns minutos e tente novamente.';
    END IF;
  END IF;

  INSERT INTO public.public_rate_limits (scope, company_id, identifier)
  VALUES ('public_waitlist_phone', _company.id, _normalized_phone);

  IF _normalized_visitor_id IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_waitlist_visitor', _company.id, _normalized_visitor_id);
  END IF;

  SELECT COALESCE(MAX(w.position), 0) + 1
  INTO _next_position
  FROM public.waitlist w
  WHERE w.company_id = _company.id
    AND w.status IN ('waiting', 'called');

  INSERT INTO public.waitlist (
    company_id,
    guest_name,
    guest_phone,
    party_size,
    notes,
    position,
    status
  )
  VALUES (
    _company.id,
    _normalized_name,
    _normalized_phone,
    _party_size,
    _normalized_notes,
    _next_position,
    'waiting'
  )
  RETURNING *
  INTO _created;

  RETURN QUERY
  SELECT
    _created.id,
    _created.tracking_code,
    _created.status,
    _created.position,
    false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_public_waitlist(text, text, text, integer, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.join_public_waitlist(text, text, text, integer, text, text) TO authenticated;
