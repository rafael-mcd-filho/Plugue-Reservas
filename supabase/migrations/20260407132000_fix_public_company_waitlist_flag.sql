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
  show_public_whatsapp_button boolean,
  public_waitlist_enabled boolean,
  instagram text,
  opening_hours jsonb,
  payment_methods jsonb,
  reservation_duration integer,
  max_guests_per_slot integer,
  status text,
  custom_public_page_enabled boolean
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
    c.show_public_whatsapp_button,
    c.public_waitlist_enabled,
    c.instagram,
    c.opening_hours,
    c.payment_methods,
    c.reservation_duration,
    c.max_guests_per_slot,
    c.status,
    public.company_feature_enabled(c.id, 'custom_public_page') AS custom_public_page_enabled
  FROM public.companies c
  WHERE c.slug = _slug
    AND c.status = 'active'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO authenticated;
