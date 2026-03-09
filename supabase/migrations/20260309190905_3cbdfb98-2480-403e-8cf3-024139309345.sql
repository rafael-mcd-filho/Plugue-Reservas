
-- Add reservation_duration to companies (in minutes, default 30)
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS reservation_duration integer NOT NULL DEFAULT 30;

-- Create restaurant_tables table
CREATE TABLE public.restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
  number integer NOT NULL,
  capacity integer NOT NULL DEFAULT 2,
  section text NOT NULL DEFAULT 'salão',
  status text NOT NULL DEFAULT 'available',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

-- Enable RLS
ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;

-- Public can view tables of active companies
CREATE POLICY "Public can view tables of active companies"
ON public.restaurant_tables
FOR SELECT
TO anon
USING (company_id IN (SELECT id FROM public.companies WHERE status = 'active'));

-- Authenticated users can view tables of their company
CREATE POLICY "Users can view their company tables"
ON public.restaurant_tables
FOR SELECT
TO authenticated
USING (
  company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid())
  OR has_role(auth.uid(), 'superadmin')
);

-- Admins and superadmins can manage tables
CREATE POLICY "Admins can manage company tables"
ON public.restaurant_tables
FOR ALL
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role(auth.uid(), 'superadmin')
)
WITH CHECK (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role(auth.uid(), 'superadmin')
);
