
-- Blocked dates table for restaurants to block specific dates/time slots
CREATE TABLE public.blocked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  date date NOT NULL,
  all_day boolean NOT NULL DEFAULT true,
  start_time time WITHOUT TIME ZONE,
  end_time time WITHOUT TIME ZONE,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX idx_blocked_dates_company_date ON public.blocked_dates(company_id, date);

-- RLS
ALTER TABLE public.blocked_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can manage blocked dates"
  ON public.blocked_dates FOR ALL
  TO authenticated
  USING (
    has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR
    has_role(auth.uid(), 'superadmin'::app_role)
  )
  WITH CHECK (
    has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR
    has_role(auth.uid(), 'superadmin'::app_role)
  );

CREATE POLICY "Public can view blocked dates"
  ON public.blocked_dates FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Operators can view blocked dates"
  ON public.blocked_dates FOR SELECT
  TO authenticated
  USING (
    company_id IN (SELECT profiles.company_id FROM profiles WHERE profiles.id = auth.uid())
  );

-- Add max capacity per time slot to companies
ALTER TABLE public.companies ADD COLUMN max_guests_per_slot integer DEFAULT 0;
