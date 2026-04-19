CREATE TABLE IF NOT EXISTS public.whatsapp_circuit_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  consecutive_failures integer NOT NULL DEFAULT 0,
  paused_until timestamptz,
  last_error_code text,
  last_error_message text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_circuit_state_paused_until
ON public.whatsapp_circuit_state(paused_until);

ALTER TABLE public.whatsapp_circuit_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view whatsapp circuit state"
ON public.whatsapp_circuit_state;
CREATE POLICY "Company staff can view whatsapp circuit state"
ON public.whatsapp_circuit_state
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin')
  OR public.has_role_in_company(auth.uid(), 'admin', company_id)
  OR public.has_role_in_company(auth.uid(), 'operator', company_id)
);
