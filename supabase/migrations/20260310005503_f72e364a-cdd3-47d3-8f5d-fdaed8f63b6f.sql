-- Create storage bucket for system assets (logos, etc.)
INSERT INTO storage.buckets (id, name, public)
VALUES ('system-assets', 'system-assets', true);

-- Allow authenticated users to upload to system-assets
CREATE POLICY "Superadmins can upload system assets"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'system-assets'
  AND public.has_role(auth.uid(), 'superadmin'::public.app_role)
);

-- Allow public read access
CREATE POLICY "Public can view system assets"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'system-assets');

-- Allow superadmins to delete
CREATE POLICY "Superadmins can delete system assets"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'system-assets'
  AND public.has_role(auth.uid(), 'superadmin'::public.app_role)
);

-- Allow superadmins to update
CREATE POLICY "Superadmins can update system assets"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'system-assets'
  AND public.has_role(auth.uid(), 'superadmin'::public.app_role)
)
WITH CHECK (
  bucket_id = 'system-assets'
  AND public.has_role(auth.uid(), 'superadmin'::public.app_role)
);