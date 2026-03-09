
CREATE TABLE public.whatsapp_message_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id UUID REFERENCES public.reservations(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'confirmation',
  status TEXT NOT NULL DEFAULT 'sent',
  error_details TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_message_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can view message logs"
  ON public.whatsapp_message_logs
  FOR SELECT
  TO authenticated
  USING (
    has_role_in_company(auth.uid(), 'admin'::app_role, company_id)
    OR has_role(auth.uid(), 'superadmin'::app_role)
  );

CREATE POLICY "Operators can view message logs"
  ON public.whatsapp_message_logs
  FOR SELECT
  TO authenticated
  USING (
    company_id IN (SELECT profiles.company_id FROM profiles WHERE profiles.id = auth.uid())
  );

CREATE INDEX idx_whatsapp_message_logs_company ON public.whatsapp_message_logs(company_id, created_at DESC);
