CREATE POLICY "Authenticated users can read system settings"
ON public.system_settings
FOR SELECT
TO authenticated
USING (true);