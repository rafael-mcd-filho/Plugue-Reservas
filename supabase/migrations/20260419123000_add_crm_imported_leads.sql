CREATE TABLE IF NOT EXISTS public.crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text,
  phone_normalized text,
  email text,
  email_normalized text,
  birthdate date,
  notes text,
  source text NOT NULL DEFAULT 'import_csv',
  import_filename text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_leads_contact_required CHECK (
    COALESCE(NULLIF(phone_normalized, ''), NULLIF(email_normalized, '')) IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_crm_leads_company_created_at
  ON public.crm_leads(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_leads_company_phone
  ON public.crm_leads(company_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL AND phone_normalized <> '';

CREATE INDEX IF NOT EXISTS idx_crm_leads_company_email
  ON public.crm_leads(company_id, email_normalized)
  WHERE email_normalized IS NOT NULL AND email_normalized <> '';

CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_company_phone_unique
  ON public.crm_leads(company_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL AND phone_normalized <> '';

CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_company_email_unique
  ON public.crm_leads(company_id, email_normalized)
  WHERE email_normalized IS NOT NULL AND email_normalized <> '';

ALTER TABLE public.crm_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmins can manage all crm leads" ON public.crm_leads;
CREATE POLICY "Superadmins can manage all crm leads"
ON public.crm_leads
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'superadmin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'superadmin'::public.app_role));

DROP POLICY IF EXISTS "Company users can view crm leads" ON public.crm_leads;
CREATE POLICY "Company users can view crm leads"
ON public.crm_leads
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company users can insert crm leads" ON public.crm_leads;
CREATE POLICY "Company users can insert crm leads"
ON public.crm_leads
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company users can update crm leads" ON public.crm_leads;
CREATE POLICY "Company users can update crm leads"
ON public.crm_leads
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can delete crm leads" ON public.crm_leads;
CREATE POLICY "Company admins can delete crm leads"
ON public.crm_leads
FOR DELETE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

CREATE OR REPLACE FUNCTION public.touch_crm_lead_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_crm_lead_updated_at ON public.crm_leads;
CREATE TRIGGER trg_touch_crm_lead_updated_at
BEFORE UPDATE
ON public.crm_leads
FOR EACH ROW
EXECUTE FUNCTION public.touch_crm_lead_updated_at();
