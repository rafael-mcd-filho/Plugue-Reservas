
-- Waitlist table
CREATE TABLE public.waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  party_size integer NOT NULL DEFAULT 1,
  tracking_code text NOT NULL UNIQUE DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'called', 'seated', 'expired', 'removed')),
  position integer NOT NULL DEFAULT 0,
  notes text,
  called_at timestamptz,
  seated_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX idx_waitlist_company_status ON public.waitlist(company_id, status);
CREATE INDEX idx_waitlist_tracking_code ON public.waitlist(tracking_code);

-- Enable RLS
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Operators and admins can manage waitlist for their company
CREATE POLICY "Company staff can manage waitlist"
ON public.waitlist
FOR ALL
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin'::app_role, company_id)
  OR has_role_in_company(auth.uid(), 'operator'::app_role, company_id)
  OR has_role(auth.uid(), 'superadmin'::app_role)
)
WITH CHECK (
  has_role_in_company(auth.uid(), 'admin'::app_role, company_id)
  OR has_role_in_company(auth.uid(), 'operator'::app_role, company_id)
  OR has_role(auth.uid(), 'superadmin'::app_role)
);

-- Public can view their own waitlist entry by tracking_code (for the tracking page)
CREATE POLICY "Public can view by tracking code"
ON public.waitlist
FOR SELECT
TO anon
USING (true);
