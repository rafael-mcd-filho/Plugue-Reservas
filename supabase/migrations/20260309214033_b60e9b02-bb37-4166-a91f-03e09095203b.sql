
-- Automation settings per company (confirmation msg, 1h reminder, etc.)
CREATE TABLE public.automation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type text NOT NULL, -- 'confirmation_message', 'reminder_1h'
  enabled boolean NOT NULL DEFAULT false,
  message_template text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, type)
);

ALTER TABLE public.automation_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can manage automations"
ON public.automation_settings FOR ALL TO authenticated
USING (has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR has_role(auth.uid(), 'superadmin'::app_role))
WITH CHECK (has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR has_role(auth.uid(), 'superadmin'::app_role));

CREATE POLICY "Operators can view automations"
ON public.automation_settings FOR SELECT TO authenticated
USING (company_id IN (SELECT profiles.company_id FROM profiles WHERE profiles.id = auth.uid()));

-- Webhook configurations per company
CREATE TABLE public.webhook_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  url text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb, -- ['reservation_created','reservation_cancelled','status_changed']
  enabled boolean NOT NULL DEFAULT true,
  secret text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.webhook_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can manage webhooks"
ON public.webhook_configs FOR ALL TO authenticated
USING (has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR has_role(auth.uid(), 'superadmin'::app_role))
WITH CHECK (has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR has_role(auth.uid(), 'superadmin'::app_role));

-- WhatsApp instance per company
CREATE TABLE public.company_whatsapp_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE UNIQUE,
  instance_name text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected', -- 'connected', 'disconnected', 'connecting'
  phone_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_whatsapp_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company admins can manage whatsapp instances"
ON public.company_whatsapp_instances FOR ALL TO authenticated
USING (has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR has_role(auth.uid(), 'superadmin'::app_role))
WITH CHECK (has_role_in_company(auth.uid(), 'admin'::app_role, company_id) OR has_role(auth.uid(), 'superadmin'::app_role));

CREATE POLICY "Operators can view whatsapp instances"
ON public.company_whatsapp_instances FOR SELECT TO authenticated
USING (company_id IN (SELECT profiles.company_id FROM profiles WHERE profiles.id = auth.uid()));
