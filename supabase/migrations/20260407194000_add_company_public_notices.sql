CREATE TABLE IF NOT EXISTS public.company_public_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  text text,
  image_url text,
  is_active boolean NOT NULL DEFAULT false,
  active_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id),
  CONSTRAINT company_public_notices_active_until_required CHECK (
    is_active = false OR active_until IS NOT NULL
  ),
  CONSTRAINT company_public_notices_active_has_content CHECK (
    is_active = false
    OR NULLIF(BTRIM(COALESCE(text, '')), '') IS NOT NULL
    OR NULLIF(BTRIM(COALESCE(image_url, '')), '') IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_company_public_notices_company
ON public.company_public_notices(company_id);

CREATE INDEX IF NOT EXISTS idx_company_public_notices_active
ON public.company_public_notices(company_id, is_active, active_until);

ALTER TABLE public.company_public_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view active company public notices" ON public.company_public_notices;
CREATE POLICY "Public can view active company public notices"
ON public.company_public_notices
FOR SELECT
TO anon, authenticated
USING (
  is_active
  AND active_until > now()
  AND EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = company_public_notices.company_id
      AND c.status = 'active'
  )
);

DROP POLICY IF EXISTS "Company admins can view company public notices" ON public.company_public_notices;
CREATE POLICY "Company admins can view company public notices"
ON public.company_public_notices
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can manage company public notices" ON public.company_public_notices;
CREATE POLICY "Company admins can manage company public notices"
ON public.company_public_notices
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

CREATE OR REPLACE FUNCTION public.touch_company_public_notice_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_company_public_notice_updated_at ON public.company_public_notices;
CREATE TRIGGER trg_touch_company_public_notice_updated_at
BEFORE UPDATE
ON public.company_public_notices
FOR EACH ROW
EXECUTE FUNCTION public.touch_company_public_notice_updated_at();

DROP POLICY IF EXISTS "Company admins can upload public notice assets" ON storage.objects;
CREATE POLICY "Company admins can upload public notice assets"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'system-assets'
  AND (storage.foldername(name))[1] = 'company-notices'
  AND (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'::public.app_role
        AND ur.company_id::text = (storage.foldername(name))[2]
    )
  )
);
