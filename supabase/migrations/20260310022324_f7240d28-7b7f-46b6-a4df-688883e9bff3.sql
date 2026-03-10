
-- Message queue for failed WhatsApp messages
CREATE TABLE public.whatsapp_message_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  phone text NOT NULL,
  message text NOT NULL,
  type text NOT NULL DEFAULT 'general',
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  last_attempt_at timestamptz,
  error_details text
);

ALTER TABLE public.whatsapp_message_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company staff can view message queue"
  ON public.whatsapp_message_queue FOR SELECT
  TO authenticated
  USING (
    has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR
    has_role_in_company(auth.uid(), 'operator'::app_role, company_id) OR
    has_role(auth.uid(), 'superadmin'::app_role)
  );

CREATE INDEX idx_whatsapp_queue_pending ON public.whatsapp_message_queue(company_id, status) WHERE status = 'pending';
