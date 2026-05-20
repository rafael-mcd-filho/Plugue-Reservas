-- Pagamentos antecipados de reservas via Asaas.
-- Esta migration prepara o contrato de dados, mas nao ativa o fluxo publico por si so.

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
      WHEN _feature_key = 'reservation_prepayment' THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'starter' THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'pro' THEN
        _feature_key IN ('whatsapp_integration', 'custom_public_page', 'active_communication', 'flow_protection')
      WHEN (SELECT plan_tier FROM company_plan) = 'enterprise' THEN
        _feature_key IN ('whatsapp_integration', 'custom_public_page', 'advanced_reports', 'active_communication', 'flow_protection')
      ELSE false
    END
  );
$$;

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
    'flow_protection',
    'reservation_prepayment'
  ]) AS feature_key
  WHERE EXISTS (SELECT 1 FROM has_access);
$$;

GRANT EXECUTE ON FUNCTION public.get_company_feature_flags(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_feature_enabled(uuid, text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.company_asaas_configs (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'asaas',
  api_token text NOT NULL,
  webhook_auth_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  status text NOT NULL DEFAULT 'configured',
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_asaas_configs_provider_check
    CHECK (provider = 'asaas'),
  CONSTRAINT company_asaas_configs_status_check
    CHECK (status IN ('configured', 'error'))
);

CREATE TABLE IF NOT EXISTS public.reservation_payment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  date_start date NOT NULL,
  date_end date NOT NULL,
  amount_type text NOT NULL,
  base_amount numeric(10,2) NOT NULL,
  pix_enabled boolean NOT NULL DEFAULT true,
  pix_amount numeric(10,2),
  credit_card_enabled boolean NOT NULL DEFAULT false,
  credit_card_amount numeric(10,2),
  max_credit_card_installments integer,
  payment_deadline_minutes integer NOT NULL DEFAULT 10,
  customer_notice text,
  cancellation_policy text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  activated_at timestamptz,
  archived_at timestamptz,
  archived_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  archived_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_payment_rules_name_check
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT reservation_payment_rules_date_range_check
    CHECK (date_end >= date_start),
  CONSTRAINT reservation_payment_rules_amount_type_check
    CHECK (amount_type IN ('fixed_per_reservation', 'per_person')),
  CONSTRAINT reservation_payment_rules_base_amount_check
    CHECK (base_amount > 0),
  CONSTRAINT reservation_payment_rules_method_check
    CHECK (pix_enabled OR credit_card_enabled),
  CONSTRAINT reservation_payment_rules_pix_amount_check
    CHECK ((pix_enabled AND pix_amount IS NOT NULL AND pix_amount > 0) OR (NOT pix_enabled)),
  CONSTRAINT reservation_payment_rules_card_amount_check
    CHECK ((credit_card_enabled AND credit_card_amount IS NOT NULL AND credit_card_amount > 0) OR (NOT credit_card_enabled)),
  CONSTRAINT reservation_payment_rules_card_installments_check
    CHECK (
      (credit_card_enabled AND max_credit_card_installments BETWEEN 1 AND 21)
      OR (NOT credit_card_enabled AND max_credit_card_installments IS NULL)
    ),
  CONSTRAINT reservation_payment_rules_deadline_check
    CHECK (payment_deadline_minutes BETWEEN 1 AND 120)
);

CREATE TABLE IF NOT EXISTS public.reservation_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.reservation_payment_rules(id) ON DELETE SET NULL,
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL DEFAULT 'asaas',
  asaas_payment_link_id text,
  asaas_payment_id text,
  payment_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  billing_type text,
  base_amount numeric(10,2) NOT NULL,
  charged_amount numeric(10,2),
  max_installments integer,
  status text NOT NULL DEFAULT 'awaiting_method',
  asaas_status text,
  payment_link_url text,
  payment_link_external_reference text,
  payment_link_deleted_at timestamptz,
  selected_at timestamptz,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  cancelled_at timestamptz,
  last_checked_at timestamptz,
  error_details text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_payments_provider_check
    CHECK (provider = 'asaas'),
  CONSTRAINT reservation_payments_billing_type_check
    CHECK (billing_type IS NULL OR billing_type IN ('PIX', 'CREDIT_CARD')),
  CONSTRAINT reservation_payments_amount_check
    CHECK (base_amount > 0 AND (charged_amount IS NULL OR charged_amount > 0)),
  CONSTRAINT reservation_payments_installments_check
    CHECK (max_installments IS NULL OR max_installments BETWEEN 1 AND 21),
  CONSTRAINT reservation_payments_status_check
    CHECK (status IN (
      'awaiting_method',
      'pending',
      'paid',
      'expired',
      'cancelled',
      'failed',
      'late_paid',
      'refunded'
    )),
  CONSTRAINT reservation_payments_method_required_check
    CHECK (
      status IN ('awaiting_method', 'expired', 'cancelled', 'failed')
      OR (billing_type IS NOT NULL AND charged_amount IS NOT NULL)
    ),
  CONSTRAINT reservation_payments_link_required_check
    CHECK (
      status <> 'pending'
      OR (asaas_payment_link_id IS NOT NULL AND payment_link_url IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.reservation_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_payment_id uuid REFERENCES public.reservation_payments(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.asaas_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  asaas_payment_link_id text,
  asaas_payment_id text,
  reservation_payment_id uuid REFERENCES public.reservation_payments(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'received',
  error_details text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asaas_webhook_events_processing_status_check
    CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_reservation_payment_rules_company_enabled_dates
ON public.reservation_payment_rules(company_id, enabled, date_start, date_end)
WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reservation_payment_rules_company_archived
ON public.reservation_payment_rules(company_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_reservation_payments_company_status_expires
ON public.reservation_payments(company_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_reservation_payments_reservation
ON public.reservation_payments(reservation_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_payments_payment_token
ON public.reservation_payments(payment_token);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_payments_asaas_payment_id
ON public.reservation_payments(asaas_payment_id)
WHERE asaas_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_payments_asaas_payment_link_id
ON public.reservation_payments(asaas_payment_link_id)
WHERE asaas_payment_link_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_payments_one_active_per_reservation
ON public.reservation_payments(reservation_id)
WHERE status IN ('awaiting_method', 'pending');

CREATE INDEX IF NOT EXISTS idx_reservation_payment_events_payment_created_at
ON public.reservation_payment_events(reservation_payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_payment_events_company_created_at
ON public.reservation_payment_events(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_asaas_webhook_events_payment_created_at
ON public.asaas_webhook_events(asaas_payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_asaas_webhook_events_payment_link_created_at
ON public.asaas_webhook_events(asaas_payment_link_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_reservation_prepayment_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_company_asaas_configs_touch_updated_at ON public.company_asaas_configs;
CREATE TRIGGER trg_company_asaas_configs_touch_updated_at
BEFORE UPDATE ON public.company_asaas_configs
FOR EACH ROW
EXECUTE FUNCTION public.touch_reservation_prepayment_updated_at();

DROP TRIGGER IF EXISTS trg_reservation_payment_rules_touch_updated_at ON public.reservation_payment_rules;
CREATE TRIGGER trg_reservation_payment_rules_touch_updated_at
BEFORE UPDATE ON public.reservation_payment_rules
FOR EACH ROW
EXECUTE FUNCTION public.touch_reservation_prepayment_updated_at();

DROP TRIGGER IF EXISTS trg_reservation_payments_touch_updated_at ON public.reservation_payments;
CREATE TRIGGER trg_reservation_payments_touch_updated_at
BEFORE UPDATE ON public.reservation_payments
FOR EACH ROW
EXECUTE FUNCTION public.touch_reservation_prepayment_updated_at();

CREATE OR REPLACE FUNCTION public.validate_reservation_payment_rule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _conflicting_rule text;
  _rule_used boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.reservation_payments rp
      WHERE rp.rule_id = OLD.id
      LIMIT 1
    )
    INTO _rule_used;

    IF _rule_used THEN
      IF NEW.name IS DISTINCT FROM OLD.name
        OR NEW.date_start IS DISTINCT FROM OLD.date_start
        OR NEW.date_end IS DISTINCT FROM OLD.date_end
        OR NEW.amount_type IS DISTINCT FROM OLD.amount_type
        OR NEW.base_amount IS DISTINCT FROM OLD.base_amount
        OR NEW.pix_enabled IS DISTINCT FROM OLD.pix_enabled
        OR NEW.pix_amount IS DISTINCT FROM OLD.pix_amount
        OR NEW.credit_card_enabled IS DISTINCT FROM OLD.credit_card_enabled
        OR NEW.credit_card_amount IS DISTINCT FROM OLD.credit_card_amount
        OR NEW.max_credit_card_installments IS DISTINCT FROM OLD.max_credit_card_installments
        OR NEW.payment_deadline_minutes IS DISTINCT FROM OLD.payment_deadline_minutes
        OR NEW.customer_notice IS DISTINCT FROM OLD.customer_notice
        OR NEW.cancellation_policy IS DISTINCT FROM OLD.cancellation_policy
      THEN
        RAISE EXCEPTION 'Regra ja usada nao pode ser editada; desative ou arquive e crie uma nova regra';
      END IF;
    END IF;
  END IF;

  IF NEW.enabled AND NEW.archived_at IS NULL THEN
    SELECT r.name
    INTO _conflicting_rule
    FROM public.reservation_payment_rules r
    WHERE r.company_id = NEW.company_id
      AND r.id <> NEW.id
      AND r.enabled = true
      AND r.archived_at IS NULL
      AND daterange(r.date_start, r.date_end, '[]') && daterange(NEW.date_start, NEW.date_end, '[]')
    LIMIT 1;

    IF _conflicting_rule IS NOT NULL THEN
      RAISE EXCEPTION 'Ja existe regra ativa no periodo informado: %', _conflicting_rule;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_reservation_payment_rule ON public.reservation_payment_rules;
CREATE TRIGGER trg_validate_reservation_payment_rule
BEFORE INSERT OR UPDATE ON public.reservation_payment_rules
FOR EACH ROW
EXECUTE FUNCTION public.validate_reservation_payment_rule();

CREATE OR REPLACE FUNCTION public.prevent_used_reservation_payment_rule_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.reservation_payments rp
    WHERE rp.rule_id = OLD.id
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Regra ja usada deve ser arquivada, nao excluida';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_used_reservation_payment_rule_delete ON public.reservation_payment_rules;
CREATE TRIGGER trg_prevent_used_reservation_payment_rule_delete
BEFORE DELETE ON public.reservation_payment_rules
FOR EACH ROW
EXECUTE FUNCTION public.prevent_used_reservation_payment_rule_delete();

ALTER TABLE public.company_asaas_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_payment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asaas_webhook_events ENABLE ROW LEVEL SECURITY;

-- Tokens Asaas ficam service-role only. O painel deve acessar por Edge Function.
DROP POLICY IF EXISTS "No direct access to company Asaas configs" ON public.company_asaas_configs;

DROP POLICY IF EXISTS "Company staff can view reservation payment rules" ON public.reservation_payment_rules;
CREATE POLICY "Company staff can view reservation payment rules"
ON public.reservation_payment_rules
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can manage reservation payment rules" ON public.reservation_payment_rules;
CREATE POLICY "Company admins can manage reservation payment rules"
ON public.reservation_payment_rules
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company staff can view reservation payments" ON public.reservation_payments;
CREATE POLICY "Company staff can view reservation payments"
ON public.reservation_payments
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can update reservation payments" ON public.reservation_payments;
CREATE POLICY "Company admins can update reservation payments"
ON public.reservation_payments
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company staff can view reservation payment events" ON public.reservation_payment_events;
CREATE POLICY "Company staff can view reservation payment events"
ON public.reservation_payment_events
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company staff can view Asaas webhook events" ON public.asaas_webhook_events;
CREATE POLICY "Company staff can view Asaas webhook events"
ON public.asaas_webhook_events
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR (
    company_id IS NOT NULL
    AND (
      public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
      OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
    )
  )
);

CREATE OR REPLACE FUNCTION public.format_reservation_status_label(_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(btrim(COALESCE(_status, '')))
    WHEN 'pending_payment' THEN 'Aguardando pagamento'
    WHEN 'payment_expired' THEN 'Pagamento expirado'
    WHEN 'payment_cancelled' THEN 'Pagamento cancelado'
    WHEN 'paid_after_expiration' THEN 'Pago apos expirar'
    WHEN 'confirmed' THEN 'Confirmada'
    WHEN 'checked_in' THEN 'Check-in realizado'
    WHEN 'cancelled' THEN 'Cancelada'
    WHEN 'no-show' THEN 'No Show'
    WHEN 'no_show' THEN 'No Show'
    ELSE COALESCE(NULLIF(_status, ''), 'Sem status')
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_occupied_table_ids(
  _company_id uuid,
  _date date,
  _time time
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(r.table_id), '{}')
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.time = _time
    AND r.table_id IS NOT NULL
    AND r.status NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
    AND (
      r.status <> 'pending_payment'
      OR EXISTS (
        SELECT 1
        FROM public.reservation_payments rp
        WHERE rp.reservation_id = r.id
          AND rp.status IN ('awaiting_method', 'pending')
          AND rp.expires_at > now()
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.get_slot_occupancy(
  _company_id uuid,
  _date date
)
RETURNS TABLE(time_slot time, occupied_tables bigint, total_guests bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.time, COUNT(*), COALESCE(SUM(r.party_size), 0)
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.status NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
    AND (
      r.status <> 'pending_payment'
      OR EXISTS (
        SELECT 1
        FROM public.reservation_payments rp
        WHERE rp.reservation_id = r.id
          AND rp.status IN ('awaiting_method', 'pending')
          AND rp.expires_at > now()
      )
    )
  GROUP BY r.time;
$$;

GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO anon;
GRANT EXECUTE ON FUNCTION public.get_slot_occupancy(uuid, date) TO anon;
