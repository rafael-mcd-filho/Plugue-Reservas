CREATE POLICY "Public can view active companies"
ON public.companies
FOR SELECT
TO anon
USING (status = 'active');