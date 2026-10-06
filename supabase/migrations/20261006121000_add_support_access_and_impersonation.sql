-- A support account has no superadmin privileges. Delegation is bound to the
-- real Auth user AND Auth session, an explicit company grant, and a live target.
-- auth.uid() is deliberately left untouched; it remains the audit actor.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.support_company_access (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE public.support_impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  auth_session_id uuid NOT NULL,
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  ended_at timestamptz,
  CHECK (actor_user_id <> target_user_id),
  CHECK (expires_at > started_at)
);
CREATE INDEX support_impersonation_actor_session_idx
  ON public.support_impersonation_sessions(actor_user_id, auth_session_id)
  WHERE ended_at IS NULL;
ALTER TABLE public.support_company_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_impersonation_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_company_access, public.support_impersonation_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_company_access TO authenticated;
GRANT ALL ON public.support_company_access, public.support_impersonation_sessions TO service_role;

CREATE FUNCTION public.revoke_support_sessions_on_access_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'support_company_access' THEN
    UPDATE public.support_impersonation_sessions SET ended_at = now()
      WHERE actor_user_id = OLD.user_id AND company_id = OLD.company_id AND ended_at IS NULL;
  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    UPDATE public.support_impersonation_sessions SET ended_at = now()
      WHERE ended_at IS NULL AND ((actor_user_id = OLD.user_id AND OLD.role = 'support')
        OR (target_user_id = OLD.user_id AND company_id = OLD.company_id));
  ELSIF TG_TABLE_NAME = 'profiles' THEN
    IF NOT NEW.is_active THEN
      UPDATE public.support_impersonation_sessions SET ended_at = now()
        WHERE (actor_user_id = NEW.id OR target_user_id = NEW.id) AND ended_at IS NULL;
    END IF;
  ELSIF TG_TABLE_SCHEMA = 'auth' THEN
    IF NEW.banned_until > now() THEN
      UPDATE public.support_impersonation_sessions SET ended_at = now()
        WHERE (actor_user_id = NEW.id OR target_user_id = NEW.id) AND ended_at IS NULL;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER revoke_support_sessions_on_company_access AFTER DELETE ON public.support_company_access
FOR EACH ROW EXECUTE FUNCTION public.revoke_support_sessions_on_access_change();
CREATE TRIGGER revoke_support_sessions_on_profile_deactivation AFTER UPDATE OF is_active ON public.profiles
FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active AND NOT NEW.is_active)
EXECUTE FUNCTION public.revoke_support_sessions_on_access_change();
CREATE TRIGGER revoke_support_sessions_on_role_delete AFTER DELETE ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.revoke_support_sessions_on_access_change();
CREATE TRIGGER revoke_support_sessions_on_role_update AFTER UPDATE OF role, company_id, user_id ON public.user_roles
FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.company_id IS DISTINCT FROM NEW.company_id OR OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION public.revoke_support_sessions_on_access_change();
CREATE TRIGGER revoke_support_sessions_on_auth_ban AFTER UPDATE OF banned_until ON auth.users
FOR EACH ROW WHEN (OLD.banned_until IS DISTINCT FROM NEW.banned_until AND NEW.banned_until IS NOT NULL)
EXECUTE FUNCTION public.revoke_support_sessions_on_access_change();

-- Raw actor helpers must not call the effective-role helpers: doing so would
-- make session validation recursively depend on itself.
CREATE FUNCTION public.is_support_actor()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'support'); $$;

CREATE FUNCTION public.is_real_superadmin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.profiles p ON p.id = ur.user_id JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = auth.uid() AND ur.role = 'superadmin' AND p.is_active AND (u.banned_until IS NULL OR u.banned_until <= now()));
$$;

CREATE FUNCTION public.support_actor_is_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.is_support_actor() AND EXISTS (SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE p.id = auth.uid() AND p.is_active AND (u.banned_until IS NULL OR u.banned_until <= now())); $$;

CREATE FUNCTION public.support_request_session_id()
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public, pg_temp
AS $$
DECLARE _value text;
BEGIN
  _value := NULLIF(current_setting('request.headers', true), '')::jsonb ->> 'x-support-impersonation';
  RETURN _value::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$;

CREATE FUNCTION public.support_auth_session_id()
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id')::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$;

CREATE FUNCTION public.get_support_impersonation_context()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'actorUserId', s.actor_user_id,
    'companyId', c.id, 'companySlug', c.slug, 'companyName', c.name,
    'userId', p.id, 'userName', COALESCE(NULLIF(p.full_name, ''), p.email, p.id::text),
    'userEmail', COALESCE(p.email, ''), 'effectiveRole', target.role, 'expiresAt', s.expires_at)
  FROM public.support_impersonation_sessions s
  JOIN public.support_company_access grant_access ON grant_access.user_id = s.actor_user_id AND grant_access.company_id = s.company_id
  JOIN public.profiles actor ON actor.id = s.actor_user_id AND actor.is_active
  JOIN public.profiles p ON p.id = s.target_user_id AND p.is_active
  JOIN auth.users actor_auth ON actor_auth.id = actor.id AND (actor_auth.banned_until IS NULL OR actor_auth.banned_until <= now())
  JOIN auth.users target_auth ON target_auth.id = p.id AND (target_auth.banned_until IS NULL OR target_auth.banned_until <= now())
  JOIN public.companies c ON c.id = s.company_id
  JOIN LATERAL (
    SELECT ur.role FROM public.user_roles ur
    WHERE ur.user_id = s.target_user_id AND ur.company_id = s.company_id AND ur.role IN ('admin', 'operator')
    ORDER BY CASE ur.role WHEN 'admin' THEN 0 ELSE 1 END LIMIT 1
  ) target ON true
  WHERE s.id = public.support_request_session_id()
    AND s.actor_user_id = auth.uid()
    AND s.auth_session_id = public.support_auth_session_id()
    AND s.ended_at IS NULL AND s.expires_at > now()
    AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = s.actor_user_id AND ur.role = 'support' AND ur.company_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id IN (s.target_user_id, s.actor_user_id) AND ur.role = 'superadmin')
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = s.target_user_id AND ur.role = 'support');
$$;

CREATE FUNCTION public.support_company_scope_allows(_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT NOT public.is_support_actor() OR COALESCE((public.get_support_impersonation_context()->>'companyId')::uuid = _company_id, false); $$;

CREATE FUNCTION public.effective_auth_uid(_company_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.is_support_actor() THEN
    CASE WHEN _company_id IS NULL OR public.support_company_scope_allows(_company_id)
      THEN (public.get_support_impersonation_context()->>'userId')::uuid ELSE NULL END
    ELSE auth.uid() END;
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.is_support_actor() THEN
    _role IN ('admin', 'operator')
    AND _user_id IN (auth.uid(), public.effective_auth_uid())
    AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = public.effective_auth_uid()
      AND company_id = (public.get_support_impersonation_context()->>'companyId')::uuid AND role = _role)
    ELSE EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) END;
$$;

CREATE OR REPLACE FUNCTION public.has_role_in_company(_user_id uuid, _role public.app_role, _company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT public.support_company_scope_allows(_company_id) AND CASE WHEN public.is_support_actor() THEN
    _role IN ('admin', 'operator') AND _user_id IN (auth.uid(), public.effective_auth_uid())
    AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = public.effective_auth_uid() AND role = _role AND company_id = _company_id)
    ELSE EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role AND company_id = _company_id) END;
$$;

CREATE OR REPLACE FUNCTION public.is_company_member(_user_id uuid, _company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.has_role_in_company(_user_id, 'admin', _company_id) OR public.has_role_in_company(_user_id, 'operator', _company_id); $$;

CREATE OR REPLACE FUNCTION public.get_user_company_id(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT CASE WHEN public.is_support_actor() THEN
    CASE WHEN _user_id IN (auth.uid(), public.effective_auth_uid()) THEN (public.get_support_impersonation_context()->>'companyId')::uuid END
    ELSE (SELECT company_id FROM public.profiles WHERE id = _user_id) END; $$;

CREATE OR REPLACE FUNCTION public.has_company_panel_permission(_user_id uuid, _company_id uuid, _permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE _overrides jsonb := '{}'::jsonb; _target uuid := _user_id;
BEGIN
  IF _user_id IS NULL OR _company_id IS NULL OR COALESCE(btrim(_permission), '') = '' OR NOT public.support_company_scope_allows(_company_id) THEN RETURN false; END IF;
  IF public.is_support_actor() THEN
    IF _user_id NOT IN (auth.uid(), public.effective_auth_uid()) OR public.effective_auth_uid() IS NULL THEN RETURN false; END IF;
    _target := public.effective_auth_uid();
  END IF;
  IF public.has_role(_target, 'superadmin') OR public.has_role_in_company(_target, 'admin', _company_id) THEN RETURN true; END IF;
  IF NOT public.has_role_in_company(_target, 'operator', _company_id) THEN RETURN false; END IF;
  SELECT permission_overrides INTO _overrides FROM public.company_user_panel_permissions WHERE user_id = _target AND company_id = _company_id;
  _overrides := COALESCE(_overrides, '{}'::jsonb);
  CASE _permission
    WHEN 'dashboard_view', 'checkins_view', 'reservations_view', 'calendar_view', 'waitlist_view' THEN RETURN COALESCE((_overrides ->> _permission)::boolean, true);
    WHEN 'reservations_delete', 'tables_view' THEN RETURN COALESCE((_overrides ->> _permission)::boolean, false);
    ELSE RETURN false;
  END CASE;
END;
$$;

CREATE POLICY "Support and superadmin can view support grants" ON public.support_company_access
FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_real_superadmin());

CREATE FUNCTION public.set_support_company_access(_user_id uuid, _company_ids uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_real_superadmin() OR public.is_support_actor() THEN RAISE EXCEPTION 'Somente superadministradores podem gerenciar acessos de suporte' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'support' AND company_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role <> 'support') THEN
    RAISE EXCEPTION 'Usuario de suporte global invalido' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(COALESCE(_company_ids, '{}'::uuid[])) wanted(id)
    WHERE wanted.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = wanted.id)) THEN
    RAISE EXCEPTION 'Empresa invalida' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.support_company_access WHERE user_id = _user_id AND NOT (company_id = ANY(COALESCE(_company_ids, '{}'::uuid[])));
  INSERT INTO public.support_company_access(user_id, company_id, granted_by)
    SELECT _user_id, id, auth.uid() FROM (SELECT DISTINCT unnest(COALESCE(_company_ids, '{}'::uuid[])) AS id) desired
    ON CONFLICT (user_id, company_id) DO NOTHING;
  UPDATE public.support_impersonation_sessions SET ended_at = now()
    WHERE actor_user_id = _user_id AND ended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.support_company_access a WHERE a.user_id = _user_id AND a.company_id = support_impersonation_sessions.company_id);
  INSERT INTO public.audit_logs(user_id, action, entity_type, entity_id, details)
    VALUES (auth.uid(), 'set_support_company_access', 'user', _user_id, jsonb_build_object('company_ids', COALESCE(_company_ids, '{}'::uuid[])));
  RETURN true;
END;
$$;

CREATE FUNCTION public.support_list_companies()
RETURNS TABLE(id uuid, name text, slug text, status text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.name, c.slug, c.status::text FROM public.companies c
  JOIN public.support_company_access a ON a.company_id = c.id AND a.user_id = auth.uid()
  JOIN public.profiles p ON p.id = auth.uid() AND p.is_active
  WHERE public.support_actor_is_active() ORDER BY c.name, c.id;
$$;

CREATE FUNCTION public.support_list_impersonation_candidates(_company_id uuid)
RETURNS TABLE(user_id uuid, full_name text, email text, effective_role text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.full_name, p.email, CASE WHEN bool_or(ur.role = 'admin') THEN 'admin' ELSE 'operator' END
  FROM public.profiles p JOIN public.user_roles ur ON ur.user_id = p.id AND ur.company_id = _company_id AND ur.role IN ('admin', 'operator')
  JOIN auth.users target_auth ON target_auth.id = p.id AND (target_auth.banned_until IS NULL OR target_auth.banned_until <= now())
  WHERE p.is_active AND public.support_actor_is_active()
    AND EXISTS (SELECT 1 FROM public.support_company_access a WHERE a.user_id = auth.uid() AND a.company_id = _company_id)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles platform_role WHERE platform_role.user_id = p.id AND platform_role.role IN ('support', 'superadmin'))
  GROUP BY p.id, p.full_name, p.email ORDER BY p.full_name, p.id;
$$;

CREATE FUNCTION public.start_support_impersonation(_company_id uuid, _target_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE _id uuid; _context jsonb; _headers jsonb;
BEGIN
  IF public.support_auth_session_id() IS NULL OR NOT public.is_support_actor()
    OR NOT EXISTS (SELECT 1 FROM public.support_list_impersonation_candidates(_company_id) WHERE user_id = _target_user_id) THEN
    RAISE EXCEPTION 'Impersonacao de suporte nao autorizada' USING ERRCODE = '42501';
  END IF;
  -- Serializes two starts within the same login, so only one stays active.
  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text || public.support_auth_session_id()::text, 0));
  UPDATE public.support_impersonation_sessions SET ended_at = now()
    WHERE actor_user_id = auth.uid() AND auth_session_id = public.support_auth_session_id() AND ended_at IS NULL;
  INSERT INTO public.support_impersonation_sessions(actor_user_id, auth_session_id, target_user_id, company_id)
    VALUES (auth.uid(), public.support_auth_session_id(), _target_user_id, _company_id) RETURNING id INTO _id;
  _headers := COALESCE(NULLIF(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  PERFORM set_config('request.headers', jsonb_set(_headers, '{x-support-impersonation}', to_jsonb(_id::text))::text, true);
  _context := public.get_support_impersonation_context();
  PERFORM set_config('request.headers', _headers::text, true);
  INSERT INTO public.audit_logs(user_id, action, entity_type, entity_id, details)
    VALUES (auth.uid(), 'start_support_impersonation', 'user', _target_user_id,
      jsonb_build_object('session_id', _id, 'company_id', _company_id, 'target_user_id', _target_user_id));
  RETURN _context;
END;
$$;

CREATE FUNCTION public.stop_support_impersonation(_session_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE _session public.support_impersonation_sessions; 
BEGIN
  UPDATE public.support_impersonation_sessions SET ended_at = now()
    WHERE id = _session_id AND actor_user_id = auth.uid() AND auth_session_id = public.support_auth_session_id() AND ended_at IS NULL
    RETURNING * INTO _session;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.audit_logs(user_id, action, entity_type, entity_id, details)
    VALUES (auth.uid(), 'stop_support_impersonation', 'user', _session.target_user_id,
      jsonb_build_object('session_id', _session.id, 'company_id', _session.company_id, 'target_user_id', _session.target_user_id));
  RETURN true;
END;
$$;

CREATE FUNCTION public.support_dashboard(_company_id uuid DEFAULT NULL, _start_date date DEFAULT CURRENT_DATE, _end_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE _result jsonb;
BEGIN
  IF NOT public.support_actor_is_active() THEN
    RAISE EXCEPTION 'Acesso de suporte nao autorizado' USING ERRCODE = '42501';
  END IF;
  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date OR _end_date - _start_date > 366 THEN
    RAISE EXCEPTION 'Periodo invalido (maximo 367 dias)' USING ERRCODE = '22023';
  END IF;
  IF _company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.support_company_access WHERE user_id = auth.uid() AND company_id = _company_id) THEN
    RAISE EXCEPTION 'Empresa nao autorizada' USING ERRCODE = '42501';
  END IF;
  WITH allowed AS (SELECT company_id FROM public.support_company_access WHERE user_id = auth.uid() AND (_company_id IS NULL OR company_id = _company_id)),
  rows AS (SELECT r.* FROM public.reservations r JOIN allowed a ON a.company_id = r.company_id WHERE r.date BETWEEN _start_date AND _end_date)
  SELECT jsonb_build_object(
    'companyCount', (SELECT count(*) FROM allowed), 'reservationCount', count(*),
    'confirmedCount', count(*) FILTER (WHERE status = 'confirmed'), 'checkedInCount', count(*) FILTER (WHERE status = 'checked_in'),
    'cancelledCount', count(*) FILTER (WHERE status = 'cancelled'), 'noShowCount', count(*) FILTER (WHERE status IN ('no_show', 'no-show')),
    'totalGuests', COALESCE(sum(party_size), 0)) INTO _result FROM rows;
  RETURN _result;
END;
$$;

-- A support role is global and exclusive. A company administrator may only
-- assign the two company roles; adding an enum value must not widen that power.
ALTER TABLE public.user_roles ADD CONSTRAINT support_role_is_global CHECK (role <> 'support' OR company_id IS NULL);
CREATE FUNCTION public.enforce_support_role_exclusivity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 1));
  IF EXISTS (SELECT 1 FROM public.user_roles existing WHERE existing.user_id = NEW.user_id
    AND existing.id IS DISTINCT FROM NEW.id AND ((NEW.role = 'support') <> (existing.role = 'support'))) THEN
    RAISE EXCEPTION 'O papel de suporte nao pode ser combinado com outros papeis' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enforce_support_role_exclusivity BEFORE INSERT OR UPDATE ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.enforce_support_role_exclusivity();
DROP POLICY IF EXISTS "Admins can manage roles in their company" ON public.user_roles;
CREATE POLICY "Admins can manage roles in their company" ON public.user_roles FOR ALL TO authenticated
USING (role IN ('admin', 'operator') AND public.has_role_in_company(public.effective_auth_uid(), 'admin', company_id))
WITH CHECK (role IN ('admin', 'operator') AND public.has_role_in_company(public.effective_auth_uid(), 'admin', company_id)
  AND user_id IN (SELECT id FROM public.profiles WHERE profiles.company_id = user_roles.company_id));

-- Introspection preserves the deployed function signatures, ACLs, comments,
-- volatility, and tenant-specific expressions. Only public SQL/PLpgSQL RPCs
-- and public/storage policies are adapted; Auth internals are never changed.
-- Trigger/audit mutations keep the real actor and use the scoped role helpers.
DO $$
DECLARE f record; _definition text; _replacement text;
BEGIN
  FOR f IN SELECT p.oid, p.proname, p.prosrc, p.proargnames, p.prorettype
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND l.lanname IN ('sql', 'plpgsql') AND p.prokind = 'f'
      AND p.prorettype <> 'trigger'::regtype AND p.prosrc ~ 'auth[.]uid\s*\('
      AND p.proname NOT IN ('get_my_memberships', 'is_support_actor', 'is_real_superadmin', 'effective_auth_uid', 'has_role', 'has_role_in_company', 'get_user_company_id', 'has_company_panel_permission')
      AND p.proname NOT LIKE '%support%'
  LOOP
    -- These functions mix authorization and audit inserts. Their role helpers
    -- now delegate securely while their actor values must remain auth.uid().
    IF f.prosrc ~ '(reservation_audit_logs|audit_logs)' THEN CONTINUE; END IF;
    _replacement := CASE WHEN '_company_id' = ANY(COALESCE(f.proargnames, '{}'::text[])) THEN 'public.effective_auth_uid(_company_id)' ELSE 'public.effective_auth_uid()' END;
    _definition := pg_get_functiondef(f.oid);
    _definition := regexp_replace(_definition, 'auth[.]uid\s*\(\s*\)', _replacement, 'g');
    -- This UUID-array RPC has no company argument/role check. Matching only the
    -- effective user would otherwise mark that user's other-company receipts.
    IF f.proname = 'mark_notifications_read' THEN
      _definition := replace(_definition, 'AND nr.user_id = public.effective_auth_uid()',
        'AND nr.user_id = public.effective_auth_uid() AND public.support_company_scope_allows(nr.company_id)');
    END IF;
    EXECUTE _definition;
  END LOOP;
END;
$$;

DO $$
DECLARE p record; _using text; _check text; _sql text;
BEGIN
  FOR p IN SELECT pol.*, n.nspname, c.relname FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'storage') AND c.relname NOT LIKE 'support_%'
  LOOP
    _using := pg_get_expr(p.polqual, p.polrelid); _check := pg_get_expr(p.polwithcheck, p.polrelid);
    -- Keep bootstrap SELECT of the real actor's own profile/roles available.
    IF p.relname IN ('profiles', 'user_roles') AND p.polcmd = 'r' AND p.polname IN ('Users can view own profile', 'Users can view own roles') THEN CONTINUE; END IF;
    -- Scalar subqueries become statement initplans; identity/session joins must
    -- not run again for every reservation in a large tenant result.
    _using := regexp_replace(_using, 'auth[.]uid\s*\(\s*\)', '(SELECT public.effective_auth_uid())', 'g');
    _check := regexp_replace(_check, 'auth[.]uid\s*\(\s*\)', '(SELECT public.effective_auth_uid())', 'g');
    _sql := format('ALTER POLICY %I ON %I.%I', p.polname, p.nspname, p.relname);
    IF _using IS NOT NULL THEN _sql := _sql || ' USING (' || _using || ')'; END IF;
    IF _check IS NOT NULL THEN _sql := _sql || ' WITH CHECK (' || _check || ')'; END IF;
    EXECUTE _sql;
  END LOOP;
END;
$$;

-- Restrictive policies close permissive public-access policies as well as
-- multi-company target memberships. Identity rows are special-cased for Auth
-- bootstrap, but writes may only use the delegated company's normal policies.
DO $$
DECLARE t record; fk record; _scope text;
BEGIN
  FOR t IN SELECT c.oid, c.relname, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relname NOT LIKE 'support_%'
  LOOP
    _scope := NULL;
    IF t.relname = 'companies' THEN _scope := 'id = (SELECT (public.get_support_impersonation_context()->>''companyId'')::uuid)';
    ELSIF t.relname IN ('profiles', 'user_roles') THEN
      _scope := 'NOT (SELECT public.is_support_actor()) OR company_id = (SELECT (public.get_support_impersonation_context()->>''companyId'')::uuid)';
      EXECUTE format('CREATE POLICY support_identity_read_scope ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT (SELECT public.is_support_actor()) OR %I = (SELECT auth.uid()) OR company_id = (SELECT (public.get_support_impersonation_context()->>''companyId'')::uuid))', t.relname, CASE t.relname WHEN 'profiles' THEN 'id' ELSE 'user_id' END);
      EXECUTE format('CREATE POLICY support_identity_write_scope ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (%s)', t.relname, _scope);
      EXECUTE format('CREATE POLICY support_identity_update_scope ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', t.relname, _scope, _scope);
      EXECUTE format('CREATE POLICY support_identity_delete_scope ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (%s)', t.relname, _scope);
      CONTINUE;
    ELSIF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = t.oid AND attname = 'company_id' AND NOT attisdropped) THEN
      _scope := 'company_id = (SELECT (public.get_support_impersonation_context()->>''companyId'')::uuid)';
    ELSE
      -- Child relations without company_id inherit the parent's company.
      FOR fk IN SELECT child.attname child_column, parent.relname parent_table, parent_column.attname parent_column
        FROM pg_constraint con JOIN pg_class parent ON parent.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = parent.relnamespace
        JOIN pg_attribute child ON child.attrelid = con.conrelid AND child.attnum = con.conkey[1]
        JOIN pg_attribute parent_column ON parent_column.attrelid = con.confrelid AND parent_column.attnum = con.confkey[1]
        WHERE con.conrelid = t.oid AND con.contype = 'f' AND array_length(con.conkey, 1) = 1 AND pn.nspname = 'public'
          AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = parent.oid AND attname = 'company_id' AND NOT attisdropped)
      LOOP
        _scope := concat_ws(' AND ', _scope, format('EXISTS (SELECT 1 FROM public.%I scope_parent WHERE scope_parent.%I = %I.%I AND scope_parent.company_id = (SELECT (public.get_support_impersonation_context()->>''companyId'')::uuid))', fk.parent_table, fk.parent_column, t.relname, fk.child_column));
      END LOOP;
    END IF;
    IF _scope IS NOT NULL THEN EXECUTE format('CREATE POLICY support_tenant_scope ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (SELECT public.is_support_actor()) OR (%s)) WITH CHECK (NOT (SELECT public.is_support_actor()) OR (%s))', t.relname, _scope, _scope); END IF;
  END LOOP;
END;
$$;

-- Tenant rows must not point at another company's business objects. In
-- particular, a payment in company A cannot be relinked to a reservation in B
-- and later acted on by a trusted service-role payment endpoint.
DO $$
DECLARE t record; fk record; _references text;
BEGIN
  FOR t IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relname NOT LIKE 'support_%'
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attname='company_id' AND NOT attisdropped)
  LOOP
    _references := NULL;
    FOR fk IN SELECT child.attname child_column,parent.relname parent_table,parent_column.attname parent_column
      FROM pg_constraint con JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      JOIN pg_attribute child ON child.attrelid=con.conrelid AND child.attnum=con.conkey[1]
      JOIN pg_attribute parent_column ON parent_column.attrelid=con.confrelid AND parent_column.attnum=con.confkey[1]
      WHERE con.conrelid=t.oid AND con.contype='f' AND array_length(con.conkey,1)=1 AND pn.nspname='public'
        AND parent.relname NOT IN ('profiles','user_roles') AND parent.relname NOT LIKE 'support_%'
        AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=parent.oid AND attname='company_id' AND NOT attisdropped)
    LOOP
      _references := concat_ws(' AND ',_references,format('(%I IS NULL OR EXISTS(SELECT 1 FROM public.%I scope_reference WHERE scope_reference.%I=%I.%I AND scope_reference.company_id=(SELECT (public.get_support_impersonation_context()->>''companyId'')::uuid)))',fk.child_column,fk.parent_table,fk.parent_column,t.relname,fk.child_column));
    END LOOP;
    IF _references IS NOT NULL THEN
      EXECUTE format('CREATE POLICY support_reference_insert_scope ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT (SELECT public.is_support_actor()) OR (%s))',t.relname,_references);
      EXECUTE format('CREATE POLICY support_reference_update_scope ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated WITH CHECK (NOT (SELECT public.is_support_actor()) OR (%s))',t.relname,_references);
    END IF;
  END LOOP;
END;
$$;

-- The staff-facing payment UI reads these provider identities. They are set
-- by trusted service endpoints; a delegated client must not substitute an
-- arbitrary external payment ID (companies can share an Asaas account).
CREATE FUNCTION public.protect_support_payment_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$
DECLARE _field text;
BEGIN
  IF public.is_support_actor() THEN
    FOREACH _field IN ARRAY ARRAY['reservation_id','company_id','rule_id','payment_token','asaas_payment_id','asaas_payment_link_id','payment_link_external_reference'] LOOP
      IF to_jsonb(NEW)->_field IS DISTINCT FROM to_jsonb(OLD)->_field THEN
        RAISE EXCEPTION 'Identificadores de pagamentos sao gerenciados pelo servico de pagamentos' USING ERRCODE='42501';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
DO $$
BEGIN
  IF to_regclass('public.reservation_payments') IS NOT NULL THEN
    CREATE TRIGGER protect_support_payment_identity BEFORE UPDATE ON public.reservation_payments
      FOR EACH ROW EXECUTE FUNCTION public.protect_support_payment_identity();
  END IF;
END;
$$;

-- Storage policies use company UUIDs in the second path component. The target
-- can have memberships elsewhere; delegated uploads/deletes stay in one folder.
CREATE POLICY support_storage_insert_scope ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (NOT (SELECT public.is_support_actor()) OR COALESCE((storage.foldername(name))[2] = (SELECT public.get_support_impersonation_context()->>'companyId'), false));
CREATE POLICY support_storage_update_scope ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
USING (NOT (SELECT public.is_support_actor()) OR COALESCE((storage.foldername(name))[2] = (SELECT public.get_support_impersonation_context()->>'companyId'), false))
WITH CHECK (NOT (SELECT public.is_support_actor()) OR COALESCE((storage.foldername(name))[2] = (SELECT public.get_support_impersonation_context()->>'companyId'), false));
CREATE POLICY support_storage_delete_scope ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
USING (NOT (SELECT public.is_support_actor()) OR COALESCE((storage.foldername(name))[2] = (SELECT public.get_support_impersonation_context()->>'companyId'), false));

-- Existing reservation history keeps its actor ID/name; give support its own
-- role label instead of describing the actor as the delegated administrator.
DO $$
DECLARE _definition text;
BEGIN
  IF to_regprocedure('public.get_reservation_audit_actor_role(uuid,uuid,boolean)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.get_reservation_audit_actor_role(uuid,uuid,boolean)'::regprocedure) INTO _definition;
    _definition := regexp_replace(_definition, 'BEGIN', E'BEGIN\n  IF public.is_support_actor() AND _user_id = auth.uid() THEN RETURN ''support''; END IF;', 'i');
    EXECUTE _definition;
    ALTER TABLE public.reservation_audit_logs DROP CONSTRAINT reservation_audit_logs_actor_role_check;
    ALTER TABLE public.reservation_audit_logs ADD CONSTRAINT reservation_audit_logs_actor_role_check
      CHECK (actor_role IN ('superadmin', 'support', 'admin', 'operator', 'user', 'system'));
  END IF;
END;
$$;

-- Record tenant mutations made through the database with both identities.
-- Only identifiers and changed field names are kept; row values can include
-- credentials/customer data and must not be copied into platform audit logs.
CREATE FUNCTION public.audit_support_tenant_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE _context jsonb; _row jsonb; _changed text[];
BEGIN
  _context := public.get_support_impersonation_context();
  IF _context IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  _row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(key ORDER BY key) INTO _changed FROM jsonb_each(to_jsonb(NEW)) item
      WHERE item.value IS DISTINCT FROM to_jsonb(OLD)->item.key;
  END IF;
  INSERT INTO public.audit_logs(user_id, action, entity_type, entity_id, details)
    VALUES(auth.uid(), 'support_' || lower(TG_OP), TG_TABLE_NAME,
      CASE WHEN _row->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (_row->>'id')::uuid END,
      jsonb_build_object('session_id', _context->>'id', 'company_id', _context->>'companyId',
        'target_user_id', _context->>'userId', 'effective_role', _context->>'effectiveRole', 'changed_fields', _changed, 'row_id', _row->>'id'));
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname NOT IN ('audit_logs', 'access_audit_logs', 'reservation_audit_logs') AND c.relname NOT LIKE 'support_%'
      AND (c.relname = 'companies' OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid AND attname = 'company_id' AND NOT attisdropped))
  LOOP
    EXECUTE format('CREATE TRIGGER audit_support_tenant_mutation AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_support_tenant_mutation()', t.relname);
  END LOOP;
END;
$$;

-- No direct session table access or direct RPC execution through anonymous
-- callers. Helpers are read-only and expose only the current caller's context.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE '%support%' OR p.proname IN ('effective_auth_uid', 'is_real_superadmin'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.signature);
  END LOOP;
END;
$$;

-- Public policies/RPCs adapted above may evaluate this read-only helper even
-- for an anonymous request. Anonymous callers have no actor or delegation;
-- keeping its execution privilege preserves the existing public flows.
GRANT EXECUTE ON FUNCTION public.effective_auth_uid(uuid) TO anon;

NOTIFY pgrst, 'reload schema';
