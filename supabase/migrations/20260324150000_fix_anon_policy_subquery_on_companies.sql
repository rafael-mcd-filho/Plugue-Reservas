-- Fix anon visibility on restaurant_tables and blocked_dates.
--
-- The anon SELECT policy on companies was removed in migration
-- 20260323171051 (security hardening). However, the RLS policies
-- on restaurant_tables and blocked_dates still use a subquery against
-- the companies table directly:
--   company_id IN (SELECT id FROM public.companies WHERE status = 'active')
--
-- Since anon can no longer read companies, that subquery returns an empty
-- set and no rows are ever visible to unauthenticated users — which breaks
-- the public reservation flow (no available time slots shown).
--
-- Fix: recreate both policies using the companies_public view, which the
-- anon role already has SELECT granted on.

-- restaurant_tables
DROP POLICY IF EXISTS "Public can view tables of active companies" ON public.restaurant_tables;

CREATE POLICY "Public can view tables of active companies"
ON public.restaurant_tables
FOR SELECT
TO anon
USING (company_id IN (SELECT id FROM public.companies_public));

-- blocked_dates
DROP POLICY IF EXISTS "Public can view blocked dates for active companies" ON public.blocked_dates;

CREATE POLICY "Public can view blocked dates for active companies"
ON public.blocked_dates
FOR SELECT
TO anon
USING (company_id IN (SELECT id FROM public.companies_public));
