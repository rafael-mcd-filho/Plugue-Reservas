-- Company deletion detaches profiles and removes company roles while keeping
-- Auth accounts. A returning customer can reuse that account without changing
-- credentials or taking over an account that still has access elsewhere.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.reuse_unassigned_company_admin(
  _company_id uuid,
  _email text,
  _full_name text,
  _phone text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  _account_ids uuid[];
  _account auth.users%ROWTYPE;
  _profile public.profiles%ROWTYPE;
  _normalized_email text := lower(btrim(_email));
BEGIN
  IF _company_id IS NULL OR COALESCE(_normalized_email, '') = '' THEN
    RAISE EXCEPTION 'Empresa e email sao obrigatorios.' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(id) INTO _account_ids FROM auth.users
  WHERE lower(btrim(email)) = _normalized_email;
  IF COALESCE(cardinality(_account_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'Nao foi possivel identificar uma unica conta para este email.'
      USING ERRCODE = '23505';
  END IF;

  -- Share the role-assignment trigger's lock before taking Auth row locks;
  -- this also serializes competing registrations for the same account.
  PERFORM pg_advisory_xact_lock(hashtextextended(_account_ids[1]::text, 1));

  PERFORM 1 FROM public.companies
  WHERE id = _company_id AND deletion_requested_at IS NULL AND status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa indisponivel para vincular o responsavel.' USING ERRCODE = '22023';
  END IF;

  -- Locking Auth blocks concurrent deletion, bans and FK-backed permission
  -- inserts. Recheck the email after waiting for the shared account lock.
  SELECT * INTO _account FROM auth.users
  WHERE id = _account_ids[1] AND lower(btrim(email)) = _normalized_email
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conta existente nao encontrada.' USING ERRCODE = '23505';
  END IF;
  IF _account.deleted_at IS NOT NULL OR _account.banned_until > now() THEN
    RAISE EXCEPTION 'Esta conta esta desativada ou bloqueada. Revise o usuario antes de continuar.'
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO _profile FROM public.profiles
  WHERE id = _account.id
  FOR UPDATE;

  IF NOT FOUND OR _profile.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Esta conta esta desativada ou sem perfil. Revise o usuario antes de continuar.'
      USING ERRCODE = '23505';
  END IF;
  IF _profile.company_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _account.id)
    OR EXISTS (SELECT 1 FROM public.support_company_access WHERE user_id = _account.id)
  THEN
    RAISE EXCEPTION 'Este email ja esta vinculado a uma empresa ou possui permissoes no sistema.'
      USING ERRCODE = '23505';
  END IF;

  -- Both writes commit together. A rejected role insert cannot leave a
  -- half-linked profile, and the original Auth credentials are untouched.
  UPDATE public.profiles
  SET company_id = _company_id,
      email = _normalized_email,
      full_name = COALESCE(NULLIF(btrim(_full_name), ''), full_name),
      phone = NULLIF(btrim(_phone), ''),
      updated_at = now()
  WHERE id = _account.id;

  INSERT INTO public.user_roles (user_id, role, company_id)
  VALUES (_account.id, 'admin', _company_id);

  RETURN _account.id;
END;
$$;

REVOKE ALL ON FUNCTION public.reuse_unassigned_company_admin(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reuse_unassigned_company_admin(uuid, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.reuse_unassigned_company_admin(uuid, text, text, text) IS
  'Service-only company provisioning: atomically reuse an active Auth account without company, roles or support grants.';
