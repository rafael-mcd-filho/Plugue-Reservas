ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS hero_media_url text,
  ADD COLUMN IF NOT EXISTS hero_media_type text;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_hero_media_type_check;

ALTER TABLE public.companies
  ADD CONSTRAINT companies_hero_media_type_check
  CHECK (hero_media_type IS NULL OR hero_media_type IN ('image', 'video'));

DROP POLICY IF EXISTS "Company admins can upload company hero media assets" ON storage.objects;
CREATE POLICY "Company admins can upload company hero media assets"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'system-assets'
  AND (storage.foldername(name))[1] = 'company-hero-media'
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
