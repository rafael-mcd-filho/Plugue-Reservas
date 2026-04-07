-- Restore public company reads for anonymous users.
DROP VIEW IF EXISTS public.companies_public;

CREATE VIEW public.companies_public
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  slug,
  logo_url,
  description,
  phone,
  address,
  google_maps_url,
  whatsapp,
  instagram,
  opening_hours,
  payment_methods,
  reservation_duration,
  max_guests_per_slot,
  status
FROM public.companies
WHERE status = 'active';

GRANT SELECT ON public.companies_public TO anon;
GRANT SELECT ON public.companies_public TO authenticated;

-- Safe public lookup by slug for public pages.
DROP FUNCTION IF EXISTS public.get_public_company_by_slug(text);

CREATE OR REPLACE FUNCTION public.get_public_company_by_slug(_slug text)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  logo_url text,
  description text,
  phone text,
  address text,
  google_maps_url text,
  whatsapp text,
  instagram text,
  opening_hours jsonb,
  payment_methods jsonb,
  reservation_duration integer,
  max_guests_per_slot integer,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.name,
    c.slug,
    c.logo_url,
    c.description,
    c.phone,
    c.address,
    c.google_maps_url,
    c.whatsapp,
    c.instagram,
    c.opening_hours,
    c.payment_methods,
    c.reservation_duration,
    c.max_guests_per_slot,
    c.status
  FROM public.companies c
  WHERE c.slug = _slug
    AND c.status = 'active'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO authenticated;

-- Reliable authenticated membership lookup for the current user.
CREATE OR REPLACE FUNCTION public.get_my_memberships()
RETURNS TABLE (
  role public.app_role,
  company_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ur.role, ur.company_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.get_my_memberships() TO authenticated;
