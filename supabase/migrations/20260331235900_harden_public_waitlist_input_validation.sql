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
  _normalized_slug text := btrim(COALESCE(_slug, ''));
  _normalized_name text := btrim(COALESCE(_guest_name, ''));
  _normalized_phone text := regexp_replace(COALESCE(_guest_phone, ''), '\D', '', 'g');
  _normalized_notes text := NULLIF(btrim(COALESCE(_notes, '')), '');
  _normalized_visitor_id text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _next_position integer := 1;
  _recent_phone_count integer := 0;
  _recent_visitor_count integer := 0;
BEGIN
  IF _normalized_slug = '' OR _normalized_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'Link da unidade invalido.';
  END IF;

  SELECT *
  INTO _company
  FROM public.companies c
  WHERE c.slug = _normalized_slug
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

  IF char_length(_normalized_name) > 120 THEN
    RAISE EXCEPTION 'O nome deve ter no maximo 120 caracteres.';
  END IF;

  IF _normalized_notes IS NOT NULL AND char_length(_normalized_notes) > 500 THEN
    RAISE EXCEPTION 'As observacoes devem ter no maximo 500 caracteres.';
  END IF;

  IF _normalized_phone !~ '^(55)?[1-9][0-9](?:9?[0-9]{8})$' THEN
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
