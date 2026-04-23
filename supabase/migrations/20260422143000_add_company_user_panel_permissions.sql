CREATE TABLE IF NOT EXISTS public.company_user_panel_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  permission_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id),
  CONSTRAINT company_user_panel_permissions_overrides_is_object
    CHECK (jsonb_typeof(permission_overrides) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_company_user_panel_permissions_company_user
  ON public.company_user_panel_permissions(company_id, user_id);

ALTER TABLE public.company_user_panel_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can manage all company user panel permissions"
  ON public.company_user_panel_permissions;
CREATE POLICY "Superadmins can manage all company user panel permissions"
  ON public.company_user_panel_permissions
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'superadmin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'superadmin'::public.app_role));

DROP POLICY IF EXISTS "Admins can manage company user panel permissions in their company"
  ON public.company_user_panel_permissions;
CREATE POLICY "Admins can manage company user panel permissions in their company"
  ON public.company_user_panel_permissions
  FOR ALL
  TO authenticated
  USING (public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id))
  WITH CHECK (public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id));

DROP POLICY IF EXISTS "Users can view own company panel permissions"
  ON public.company_user_panel_permissions;
CREATE POLICY "Users can view own company panel permissions"
  ON public.company_user_panel_permissions
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND (
      public.has_role(auth.uid(), 'superadmin'::public.app_role)
      OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
      OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
    )
  );
