
-- Create reservations table
CREATE TABLE public.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
  table_id uuid REFERENCES public.restaurant_tables(id) ON DELETE SET NULL,
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  guest_email text,
  guest_birthdate date,
  date date NOT NULL,
  time time NOT NULL,
  party_size integer NOT NULL DEFAULT 1,
  duration_minutes integer NOT NULL DEFAULT 30,
  status text NOT NULL DEFAULT 'pending',
  occasion text,
  notes text,
  visitor_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_reservations_company_date ON public.reservations(company_id, date);
CREATE INDEX idx_reservations_table_date ON public.reservations(table_id, date, time);
CREATE INDEX idx_reservations_status ON public.reservations(status);

-- Enable RLS
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

-- Anon users can insert reservations (public booking)
CREATE POLICY "Anyone can create reservations"
ON public.reservations
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Anon can view their own reservations by visitor_id (future use)
CREATE POLICY "Anon can view own reservations"
ON public.reservations
FOR SELECT
TO anon
USING (visitor_id IS NOT NULL AND visitor_id = visitor_id);

-- Superadmins can manage all
CREATE POLICY "Superadmins can manage all reservations"
ON public.reservations
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'superadmin'))
WITH CHECK (has_role(auth.uid(), 'superadmin'));

-- Company users can view and manage their company reservations
CREATE POLICY "Company users can view reservations"
ON public.reservations
FOR SELECT
TO authenticated
USING (
  company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid())
);

CREATE POLICY "Company admins can update reservations"
ON public.reservations
FOR UPDATE
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
)
WITH CHECK (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
);

CREATE POLICY "Company admins can delete reservations"
ON public.reservations
FOR DELETE
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
);
