ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS show_public_hero_reserve_button boolean NOT NULL DEFAULT true;

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
  show_public_reservation_exit_prompt,
  public_reservation_exit_prompt_primary_text,
  public_reservation_exit_prompt_primary_text_size,
  public_reservation_exit_prompt_secondary_text,
  public_reservation_exit_prompt_secondary_text_size,
  large_party_whatsapp_threshold,
  reservation_late_tolerance_minutes,
  hero_media_url,
  hero_media_type,
  public_header_style,
  hero_media_urls,
  show_public_hero_reserve_button
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
  hero_media_url text,
  hero_media_type text,
  public_header_style text,
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
  show_public_reservation_exit_prompt boolean,
  public_reservation_exit_prompt_primary_text text,
  public_reservation_exit_prompt_primary_text_size text,
  public_reservation_exit_prompt_secondary_text text,
  public_reservation_exit_prompt_secondary_text_size text,
  large_party_whatsapp_threshold integer,
  reservation_late_tolerance_minutes integer,
  hero_media_urls text[],
  show_public_hero_reserve_button boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    companies.id,
    companies.name,
    companies.slug,
    companies.logo_url,
    companies.hero_media_url,
    companies.hero_media_type,
    companies.public_header_style,
    companies.description,
    companies.phone,
    companies.address,
    companies.google_maps_url,
    companies.whatsapp,
    companies.show_public_whatsapp_button,
    companies.show_public_sticky_reserve_button,
    companies.public_waitlist_enabled,
    companies.instagram,
    companies.opening_hours,
    companies.payment_methods,
    companies.reservation_duration,
    companies.max_guests_per_slot,
    companies.status,
    public.company_feature_enabled(companies.id, 'custom_public_page') AS custom_public_page_enabled,
    companies.show_public_reservation_exit_prompt,
    companies.public_reservation_exit_prompt_primary_text,
    companies.public_reservation_exit_prompt_primary_text_size,
    companies.public_reservation_exit_prompt_secondary_text,
    companies.public_reservation_exit_prompt_secondary_text_size,
    companies.large_party_whatsapp_threshold,
    companies.reservation_late_tolerance_minutes,
    companies.hero_media_urls,
    companies.show_public_hero_reserve_button
  FROM public.companies AS companies
  WHERE companies.slug = _slug
    AND companies.status = 'active'
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_company_by_slug(text) TO authenticated;
