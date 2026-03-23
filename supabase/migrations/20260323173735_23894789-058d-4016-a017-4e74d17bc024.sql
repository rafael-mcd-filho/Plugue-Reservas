-- Function to check company status by slug (returns name, status, phone for paused page)
CREATE OR REPLACE FUNCTION public.get_company_status_by_slug(_slug text)
RETURNS TABLE(name text, status text, phone text, whatsapp text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.name, c.status, c.phone, c.whatsapp
  FROM public.companies c
  WHERE c.slug = _slug
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_company_status_by_slug(text) TO anon;