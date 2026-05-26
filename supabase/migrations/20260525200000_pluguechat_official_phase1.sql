-- Fase 1 PlugueChat Oficial
-- 1. Canal ativo por empresa
-- 2. Tabelas PlugueChat
-- 3. Feature flag pluguechat_official nas RPCs

-- ============================================================
-- Canal ativo por empresa
-- ============================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS whatsapp_automation_channel text NOT NULL DEFAULT 'evolution'
    CONSTRAINT companies_whatsapp_automation_channel_check
    CHECK (whatsapp_automation_channel IN ('evolution', 'pluguechat_official'));

-- ============================================================
-- Configuração da API oficial (token salvo aqui, nunca exposto ao frontend)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pluguechat_official_configs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT true,
  from_number         text NOT NULL DEFAULT '',
  api_token_encrypted text,
  status              text NOT NULL DEFAULT 'not_configured',
  last_success_at     timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pluguechat_official_configs ENABLE ROW LEVEL SECURITY;

-- Leitura: membros da empresa ou superadmin (nunca retorna o token; o frontend deve consultar apenas colunas seguras)
CREATE POLICY "pluguechat_configs_select"
  ON public.pluguechat_official_configs
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_official_configs.company_id
    )
  );

-- Escrita somente via service role (Edge Functions com SECURITY DEFINER ou service_role key)

-- ============================================================
-- Templates de automação por empresa (somente templateId, sem parameter_map)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pluguechat_automation_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT false,
  template_id   text NOT NULL DEFAULT '',
  template_name text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, type)
);

ALTER TABLE public.pluguechat_automation_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pluguechat_templates_select"
  ON public.pluguechat_automation_templates
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_automation_templates.company_id
    )
  );

CREATE POLICY "pluguechat_templates_insert"
  ON public.pluguechat_automation_templates
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_automation_templates.company_id
        AND ur.role IN ('admin', 'operator')
    )
  );

CREATE POLICY "pluguechat_templates_update"
  ON public.pluguechat_automation_templates
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_automation_templates.company_id
        AND ur.role IN ('admin', 'operator')
    )
  );

-- ============================================================
-- Fila de mensagens PlugueChat
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pluguechat_message_queue (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id      uuid,
  waitlist_id         uuid,
  phone               text NOT NULL,
  type                text NOT NULL,
  template_id         text NOT NULL,
  template_name       text,
  parameters          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending',
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,
  scheduled_for       timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '2 hours',
  last_attempt_at     timestamptz,
  provider_message_id text,
  error_details       text,
  cancel_reason       text,
  cancelled_at        timestamptz,
  idempotency_key     text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pluguechat_message_queue_status_idx
  ON public.pluguechat_message_queue (status, scheduled_for)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pluguechat_message_queue_company_idx
  ON public.pluguechat_message_queue (company_id, status);

ALTER TABLE public.pluguechat_message_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pluguechat_queue_select"
  ON public.pluguechat_message_queue
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_message_queue.company_id
    )
  );

-- ============================================================
-- Log de mensagens enviadas PlugueChat
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pluguechat_message_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id      uuid,
  waitlist_id         uuid,
  phone               text NOT NULL,
  type                text NOT NULL,
  template_id         text NOT NULL,
  template_name       text,
  parameters          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL,
  provider_message_id text,
  provider_status     text,
  error_details       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pluguechat_message_logs_company_idx
  ON public.pluguechat_message_logs (company_id, created_at DESC);

ALTER TABLE public.pluguechat_message_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pluguechat_logs_select"
  ON public.pluguechat_message_logs
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_message_logs.company_id
    )
  );

-- ============================================================
-- Disparos PlugueChat (broadcasts)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pluguechat_broadcasts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  template_id      text NOT NULL,
  template_name    text,
  audience_filter  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'draft',
  scheduled_for    timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  cancel_reason    text,
  cancelled_at     timestamptz,
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pluguechat_broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pluguechat_broadcasts_select"
  ON public.pluguechat_broadcasts
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_broadcasts.company_id
    )
  );

-- ============================================================
-- Destinatários de disparos PlugueChat
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pluguechat_broadcast_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id        uuid NOT NULL REFERENCES public.pluguechat_broadcasts(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  customer_id         uuid,
  phone               text NOT NULL,
  parameters          jsonb NOT NULL DEFAULT '{}'::jsonb,
  queue_id            uuid,
  status              text NOT NULL DEFAULT 'pending',
  provider_message_id text,
  error_details       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcast_id, phone)
);

ALTER TABLE public.pluguechat_broadcast_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pluguechat_broadcast_recipients_select"
  ON public.pluguechat_broadcast_recipients
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.company_id = pluguechat_broadcast_recipients.company_id
    )
  );

-- ============================================================
-- RPC: ler canal ativo da empresa
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_company_whatsapp_channel(_company_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.whatsapp_automation_channel
  FROM public.companies c
  WHERE c.id = _company_id
    AND (
      public.has_role(auth.uid(), 'superadmin')
      OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.company_id = _company_id
      )
    )
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_company_whatsapp_channel(uuid) TO authenticated;

-- ============================================================
-- Restaurar get_company_feature_flags com mesma lista de features
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_company_feature_flags(_company_id uuid)
RETURNS TABLE (
  feature_key text,
  enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE public.has_role(auth.uid(), 'superadmin')
      OR EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.company_id = _company_id
      )
  )
  SELECT feature_key, public.company_feature_enabled(_company_id, feature_key) AS enabled
  FROM unnest(ARRAY[
    'whatsapp_integration',
    'custom_public_page',
    'advanced_reports',
    'active_communication',
    'flow_protection'
  ]) AS feature_key
  WHERE EXISTS (SELECT 1 FROM has_access);
$$;

-- ============================================================
-- Restaurar company_feature_enabled (sem alteração de comportamento)
-- ============================================================

CREATE OR REPLACE FUNCTION public.company_feature_enabled(
  _company_id uuid,
  _feature_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company_plan AS (
    SELECT COALESCE(c.plan_tier, 'enterprise') AS plan_tier
    FROM public.companies c
    WHERE c.id = _company_id
  ),
  override_value AS (
    SELECT cfo.enabled
    FROM public.company_feature_overrides cfo
    WHERE cfo.company_id = _company_id
      AND cfo.feature_key = _feature_key
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT enabled FROM override_value),
    CASE
      WHEN (SELECT plan_tier FROM company_plan) = 'starter' THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'pro' THEN
        _feature_key IN ('whatsapp_integration', 'custom_public_page', 'active_communication', 'flow_protection')
      WHEN (SELECT plan_tier FROM company_plan) = 'enterprise' THEN true
      ELSE true
    END
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_company_feature_flags(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_feature_enabled(uuid, text) TO authenticated;
