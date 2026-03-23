-- Remove the anon SELECT policy on companies table (use companies_public view instead)
DROP POLICY IF EXISTS "Public can view active companies" ON public.companies;

-- Restrict system_settings SELECT to superadmins only (edge functions use service role)
DROP POLICY IF EXISTS "Authenticated users can read system settings" ON public.system_settings;