-- Company plans
ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS plan_tier text NOT NULL DEFAULT 'enterprise';

ALTER TABLE public.companies
DROP CONSTRAINT IF EXISTS companies_plan_tier_check;

ALTER TABLE public.companies
ADD CONSTRAINT companies_plan_tier_check
CHECK (plan_tier IN ('starter', 'pro', 'enterprise'));

-- Keep company role creation timestamps for support history.
ALTER TABLE public.user_roles
ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE public.user_roles ur
SET created_at = COALESCE(ur.created_at, p.created_at, now())
FROM public.profiles p
WHERE p.id = ur.user_id
  AND ur.created_at IS NULL;

UPDATE public.user_roles
SET created_at = now()
WHERE created_at IS NULL;

ALTER TABLE public.user_roles
ALTER COLUMN created_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_user_roles_company_created_at
ON public.user_roles(company_id, created_at DESC);

-- Per-company feature overrides
CREATE TABLE IF NOT EXISTS public.company_feature_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, feature_key)
);

ALTER TABLE public.company_feature_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can manage all company feature overrides" ON public.company_feature_overrides;
CREATE POLICY "Superadmins can manage all company feature overrides"
ON public.company_feature_overrides
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'superadmin'))
WITH CHECK (public.has_role(auth.uid(), 'superadmin'));

DROP POLICY IF EXISTS "Company members can view their feature overrides" ON public.company_feature_overrides;
CREATE POLICY "Company members can view their feature overrides"
ON public.company_feature_overrides
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin')
  OR company_id IN (
    SELECT COALESCE(p.company_id, ur.company_id)
    FROM public.profiles p
    LEFT JOIN public.user_roles ur
      ON ur.user_id = p.id
    WHERE p.id = auth.uid()
  )
);

CREATE INDEX IF NOT EXISTS idx_company_feature_overrides_company
ON public.company_feature_overrides(company_id);

CREATE INDEX IF NOT EXISTS idx_company_feature_overrides_feature
ON public.company_feature_overrides(feature_key);

-- Access audit for every login and panel access.
CREATE TABLE IF NOT EXISTS public.access_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  path text,
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_audit_logs_event_type_check CHECK (event_type IN ('login', 'panel_access'))
);

ALTER TABLE public.access_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can view all access audit logs" ON public.access_audit_logs;
CREATE POLICY "Superadmins can view all access audit logs"
ON public.access_audit_logs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'superadmin'));

DROP POLICY IF EXISTS "Admins can view company access audit logs" ON public.access_audit_logs;
CREATE POLICY "Admins can view company access audit logs"
ON public.access_audit_logs
FOR SELECT
TO authenticated
USING (
  company_id IN (
    SELECT ur.company_id
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role = 'admin'
      AND ur.company_id IS NOT NULL
  )
);

DROP POLICY IF EXISTS "Users can view own access audit logs" ON public.access_audit_logs;
CREATE POLICY "Users can view own access audit logs"
ON public.access_audit_logs
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_access_audit_logs_company_created_at
ON public.access_audit_logs(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_access_audit_logs_user_created_at
ON public.access_audit_logs(user_id, created_at DESC);

-- Feature resolution helpers
CREATE OR REPLACE FUNCTION public.company_feature_enabled(_company_id uuid, _feature_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company_plan AS (
    SELECT COALESCE(c.plan_tier, 'enterprise') AS plan_tier
    FROM public.companies c
    WHERE c.id = _company_id
  ),
  override_value AS (
    SELECT cfo.enabled
    FROM public.company_feature_overrides cfo
    WHERE cfo.company_id = _company_id
      AND cfo.feature_key = _feature_key
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT enabled FROM override_value),
    CASE
      WHEN (SELECT plan_tier FROM company_plan) = 'starter' THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'pro' THEN _feature_key IN ('whatsapp_integration', 'custom_public_page')
      WHEN (SELECT plan_tier FROM company_plan) = 'enterprise' THEN true
      ELSE true
    END
  );
$$;

CREATE OR REPLACE FUNCTION public.get_company_feature_flags(_company_id uuid)
RETURNS TABLE (
  feature_key text,
  enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE public.has_role(auth.uid(), 'superadmin')
      OR EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.company_id = _company_id
      )
  )
  SELECT feature_key, public.company_feature_enabled(_company_id, feature_key) AS enabled
  FROM unnest(ARRAY[
    'whatsapp_integration',
    'custom_public_page',
    'advanced_reports'
  ]) AS feature_key
  WHERE EXISTS (SELECT 1 FROM has_access);
$$;

GRANT EXECUTE ON FUNCTION public.get_company_feature_flags(uuid) TO authenticated;

-- Recreate the public lookup to expose whether custom public page is enabled.
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

-- Timeline RPC for support view.
CREATE OR REPLACE FUNCTION public.get_company_activity_timeline(_company_id uuid)
RETURNS TABLE (
  event_key text,
  occurred_at timestamptz,
  title text,
  description text,
  actor_name text,
  metadata jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE public.has_role(auth.uid(), 'superadmin')
      OR public.has_role_in_company(auth.uid(), 'admin', _company_id)
  ),
  company_created AS (
    SELECT
      'company_created'::text AS event_key,
      c.created_at AS occurred_at,
      'Conta criada'::text AS title,
      'Empresa cadastrada na plataforma'::text AS description,
      c.responsible_name AS actor_name,
      jsonb_build_object('company_name', c.name, 'slug', c.slug) AS metadata
    FROM public.companies c
    WHERE c.id = _company_id
  ),
  first_reservation AS (
    SELECT
      'first_reservation'::text AS event_key,
      r.created_at AS occurred_at,
      'Primeira reserva'::text AS title,
      'Primeira reserva registrada na empresa'::text AS description,
      r.guest_name AS actor_name,
      jsonb_build_object(
        'reservation_id', r.id,
        'guest_name', r.guest_name,
        'date', r.date,
        'time', r.time,
        'party_size', r.party_size
      ) AS metadata
    FROM public.reservations r
    WHERE r.company_id = _company_id
    ORDER BY r.created_at ASC
    LIMIT 1
  ),
  user_added AS (
    SELECT DISTINCT ON (ur.user_id)
      'user_added'::text AS event_key,
      ur.created_at AS occurred_at,
      'Usuário adicionado'::text AS title,
      'Novo usuário vinculado à empresa'::text AS description,
      COALESCE(NULLIF(p.full_name, ''), p.email, ur.user_id::text) AS actor_name,
      jsonb_build_object(
        'user_id', ur.user_id,
        'role', ur.role,
        'email', p.email
      ) AS metadata
    FROM public.user_roles ur
    LEFT JOIN public.profiles p
      ON p.id = ur.user_id
    WHERE ur.company_id = _company_id
      AND ur.role IN ('admin', 'operator')
    ORDER BY ur.user_id, ur.created_at ASC
  ),
  last_panel_access AS (
    SELECT
      'last_panel_access'::text AS event_key,
      aal.created_at AS occurred_at,
      'Último acesso ao painel'::text AS title,
      COALESCE('Acesso em ' || COALESCE(aal.path, 'painel'), 'Acesso ao painel') AS description,
      COALESCE(NULLIF(p.full_name, ''), p.email, aal.user_id::text) AS actor_name,
      jsonb_build_object(
        'user_id', aal.user_id,
        'path', aal.path,
        'ip_address', aal.ip_address,
        'event_type', aal.event_type
      ) AS metadata
    FROM public.access_audit_logs aal
    LEFT JOIN public.profiles p
      ON p.id = aal.user_id
    WHERE aal.company_id = _company_id
      AND aal.event_type IN ('login', 'panel_access')
    ORDER BY aal.created_at DESC
    LIMIT 1
  )
  SELECT *
  FROM (
    SELECT * FROM company_created
    UNION ALL
    SELECT * FROM first_reservation
    UNION ALL
    SELECT * FROM user_added
    UNION ALL
    SELECT * FROM last_panel_access
  ) timeline
  WHERE EXISTS (SELECT 1 FROM has_access)
  ORDER BY occurred_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_company_activity_timeline(uuid) TO authenticated;
