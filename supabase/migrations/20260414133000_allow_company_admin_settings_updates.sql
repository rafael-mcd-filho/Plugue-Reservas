DROP POLICY IF EXISTS "Company admins can update their own company" ON public.companies;
CREATE POLICY "Company admins can update their own company"
ON public.companies
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, id)
);

DROP POLICY IF EXISTS "Company admins can upload company logo assets" ON storage.objects;
CREATE POLICY "Company admins can upload company logo assets"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'system-assets'
  AND (storage.foldername(name))[1] = 'company-logos'
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
