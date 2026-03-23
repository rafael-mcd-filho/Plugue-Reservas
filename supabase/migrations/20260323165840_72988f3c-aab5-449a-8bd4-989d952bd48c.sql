-- =============================================
-- FIX 1: Reservations anon policy is a tautology (visitor_id = visitor_id)
-- This exposes ALL reservations to anonymous users including PII
-- =============================================
DROP POLICY IF EXISTS "Anon can view own reservations" ON public.reservations;

-- =============================================
-- FIX 2: Waitlist "Public can view by tracking code" has USING(true)
-- This exposes ALL waitlist entries with PII to anonymous users
-- =============================================
DROP POLICY IF EXISTS "Public can view by tracking code" ON public.waitlist;

-- Security definer function to safely lookup waitlist by tracking code
CREATE OR REPLACE FUNCTION public.get_waitlist_by_tracking_code(_tracking_code text)
RETURNS SETOF public.waitlist
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.waitlist WHERE tracking_code = _tracking_code LIMIT 1;
$$;

-- =============================================
-- FIX 3: Companies "Public can view active companies" exposes PII
-- Create a public view that only exposes safe columns
-- =============================================
CREATE OR REPLACE VIEW public.companies_public
WITH (security_invoker = false) AS
SELECT
  id, name, slug, logo_url, description, phone, address,
  google_maps_url, whatsapp, instagram, opening_hours,
  payment_methods, reservation_duration, max_guests_per_slot, status
FROM public.companies
WHERE status = 'active';

GRANT SELECT ON public.companies_public TO anon;

-- =============================================
-- FIX 4: Blocked dates - restrict anon to active companies only
-- =============================================
DROP POLICY IF EXISTS "Public can view blocked dates" ON public.blocked_dates;

CREATE POLICY "Public can view blocked dates for active companies"
ON public.blocked_dates
FOR SELECT
TO anon
USING (
  company_id IN (SELECT id FROM public.companies WHERE status = 'active')
);

-- =============================================
-- FIX 5: Availability count function for anon (no row data exposed)
-- =============================================
CREATE OR REPLACE FUNCTION public.get_reservation_count_by_slot(
  _company_id uuid,
  _date date,
  _time time
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(party_size), 0)::integer
  FROM public.reservations
  WHERE company_id = _company_id
    AND date = _date
    AND time = _time
    AND status NOT IN ('cancelled', 'no_show');
$$;

GRANT EXECUTE ON FUNCTION public.get_waitlist_by_tracking_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_reservation_count_by_slot(uuid, date, time) TO anon;

-- =============================================
-- FIX 6: Tighten admin role assignment - only to users in same company
-- =============================================
DROP POLICY IF EXISTS "Admins can manage roles in their company" ON public.user_roles;

CREATE POLICY "Admins can manage roles in their company"
ON public.user_roles
FOR ALL
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin'::app_role, company_id)
)
WITH CHECK (
  has_role_in_company(auth.uid(), 'admin'::app_role, company_id)
  AND role <> 'superadmin'::app_role
  AND user_id IN (
    SELECT id FROM public.profiles WHERE profiles.company_id = user_roles.company_id
  )
);