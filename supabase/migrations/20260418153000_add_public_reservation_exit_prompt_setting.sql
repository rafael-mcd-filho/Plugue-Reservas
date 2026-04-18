ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS show_public_reservation_exit_prompt boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW public.companies_public
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
  status,
  show_public_whatsapp_button,
  public_waitlist_enabled,
  show_public_sticky_reserve_button,
  show_public_reservation_exit_prompt
FROM public.companies
WHERE status = 'active';

GRANT SELECT ON public.companies_public TO anon;
GRANT SELECT ON public.companies_public TO authenticated;

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
  show_public_sticky_reserve_button boolean,
  public_waitlist_enabled boolean,
  instagram text,
  opening_hours jsonb,
  payment_methods jsonb,
  reservation_duration integer,
  max_guests_per_slot integer,
  status text,
  custom_public_page_enabled boolean,
  show_public_reservation_exit_prompt boolean
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
    c.show_public_sticky_reserve_button,
    c.public_waitlist_enabled,
    c.instagram,
    c.opening_hours,
    c.payment_methods,
    c.reservation_duration,
    c.max_guests_per_slot,
    c.status,
    public.company_feature_enabled(c.id, 'custom_public_page') AS custom_public_page_enabled,
    c.show_public_reservation_exit_prompt
  FROM public.companies c
  WHERE c.slug = _slug
    AND c.status = 'active'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO authenticated;
