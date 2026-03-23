-- Fix: Change view to security_invoker to respect RLS of querying user
DROP VIEW IF EXISTS public.companies_public;

CREATE VIEW public.companies_public
WITH (security_invoker = true) AS
SELECT
  id, name, slug, logo_url, description, phone, address,
  google_maps_url, whatsapp, instagram, opening_hours,
  payment_methods, reservation_duration, max_guests_per_slot, status
FROM public.companies
WHERE status = 'active';

GRANT SELECT ON public.companies_public TO anon;
GRANT SELECT ON public.companies_public TO authenticated;