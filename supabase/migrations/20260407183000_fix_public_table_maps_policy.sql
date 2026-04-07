DROP POLICY IF EXISTS "Public can view table maps of active companies" ON public.table_maps;

CREATE POLICY "Public can view table maps of active companies"
ON public.table_maps
FOR SELECT
TO anon
USING (
  EXISTS (
    SELECT 1
    FROM public.companies_public cp
    WHERE cp.id = table_maps.company_id
  )
);
