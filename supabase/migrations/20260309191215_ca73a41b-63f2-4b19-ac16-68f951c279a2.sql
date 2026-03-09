
-- Funnel analytics: tracks unique visitors per step per day per company
CREATE TABLE public.reservation_funnel_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
  visitor_id text NOT NULL,
  step text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  date date NOT NULL DEFAULT CURRENT_DATE
);

-- Index for fast aggregation queries
CREATE INDEX idx_funnel_logs_company_date ON public.reservation_funnel_logs(company_id, date, step);
CREATE INDEX idx_funnel_logs_visitor ON public.reservation_funnel_logs(company_id, visitor_id, step, date);

-- Unique constraint to ensure one log per visitor per step per day per company
CREATE UNIQUE INDEX idx_funnel_logs_unique ON public.reservation_funnel_logs(company_id, visitor_id, step, date);

-- Enable RLS
ALTER TABLE public.reservation_funnel_logs ENABLE ROW LEVEL SECURITY;

-- Anon users can insert (for tracking from public page)
CREATE POLICY "Anyone can insert funnel logs"
ON public.reservation_funnel_logs
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Superadmins can view all
CREATE POLICY "Superadmins can view all funnel logs"
ON public.reservation_funnel_logs
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'superadmin'));

-- Company users can view their own
CREATE POLICY "Users can view their company funnel logs"
ON public.reservation_funnel_logs
FOR SELECT
TO authenticated
USING (
  company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid())
);
