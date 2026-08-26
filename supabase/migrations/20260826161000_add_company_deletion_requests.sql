-- Async, resumable, batched company deletion pipeline -- schema.
--
-- Replaces the synchronous DELETE FROM companies (still done straight from
-- the browser today, see src/hooks/useCompanies.ts) which cascades through
-- ~60 tables in one statement and blows the authenticated role's 8s
-- statement_timeout for any company with real history. See
-- docs/problema-exclusao-empresas.md for the full history of this problem.
--
-- company_deletion_requests is the pipeline's source of truth and its
-- primary audit record. It deliberately has NO foreign key to companies:
-- it must survive after the company row is gone.

CREATE TABLE public.company_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  company_name_snapshot text NOT NULL,
  company_slug_snapshot text NOT NULL,

  requested_by uuid NOT NULL REFERENCES auth.users(id),
  requested_reason text NOT NULL,
  confirmation_text text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),

  status text NOT NULL DEFAULT 'grace_period' CHECK (status IN (
    'grace_period', 'running', 'needs_attention', 'completed', 'failed', 'canceled'
  )),
  grace_period_ends_at timestamptz NOT NULL,
  canceled_by uuid REFERENCES auth.users(id),
  canceled_at timestamptz,

  -- 1-based to match company_deletion_phase_order.phase_index (starts at 1).
  phase_index integer NOT NULL DEFAULT 1,
  phase text,

  deleted_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_teardown_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_teardown_requested_at timestamptz,
  impact_preview jsonb NOT NULL DEFAULT '{}'::jsonb,

  attempts integer NOT NULL DEFAULT 0,
  consecutive_errors integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  started_processing_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One active (non-terminal) request per company at a time.
CREATE UNIQUE INDEX idx_company_deletion_requests_active_company
  ON public.company_deletion_requests(company_id)
  WHERE status IN ('grace_period', 'running', 'needs_attention');

CREATE INDEX idx_company_deletion_requests_pending_attempt
  ON public.company_deletion_requests(next_attempt_at)
  WHERE status IN ('grace_period', 'running');

ALTER TABLE public.company_deletion_requests ENABLE ROW LEVEL SECURITY;
-- No RLS policies: the table is never queried directly by PostgREST. All
-- access goes through SECURITY DEFINER RPCs (superadmin-gated) or the
-- service_role worker, matching tracking_funnel_projection_state.
REVOKE ALL ON public.company_deletion_requests FROM PUBLIC, anon, authenticated;

-- Ordered, data-driven list of company-scoped tables the worker walks
-- through. All 58 rows below were read live from production's
-- pg_constraint (confrelid = companies) and are every table with a direct
-- ON DELETE CASCADE company_id foreign key to companies. Tables with
-- ON DELETE SET NULL (access_audit_logs, asaas_webhook_events, profiles)
-- are intentionally excluded -- the schema already says "disconnect, don't
-- delete" for those, and the final cascade honors that automatically.
--
-- Order does not affect correctness (no ON DELETE RESTRICT exists anywhere
-- in this graph -- confirmed live), only observability/throughput. Any
-- table accidentally left out of this list is still cleaned up by the
-- worker's final `DELETE FROM companies`, just without per-table batching.
CREATE TABLE public.company_deletion_phase_order (
  phase_index integer PRIMARY KEY,
  table_name text NOT NULL UNIQUE,
  company_id_column text NOT NULL DEFAULT 'company_id'
);

REVOKE ALL ON public.company_deletion_phase_order FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_deletion_phase_order TO service_role;

INSERT INTO public.company_deletion_phase_order (phase_index, table_name) VALUES
  (1, 'tracking_events'),
  (2, 'meta_event_attempts'),
  (3, 'meta_event_queue'),
  (4, 'tracking_journeys'),
  (5, 'tracking_sessions'),
  (6, 'tracking_funnel_sessions'),
  (7, 'tracking_funnel_projection_state'),
  (8, 'tracking_funnel_company_rollout'),
  (9, 'whatsapp_message_logs'),
  (10, 'whatsapp_message_queue'),
  (11, 'whatsapp_dispatch_guards'),
  (12, 'whatsapp_broadcast_recipients'),
  (13, 'whatsapp_broadcasts'),
  (14, 'whatsapp_circuit_state'),
  (15, 'whatsapp_delivery_cadence_state'),
  (16, 'pluguechat_message_logs'),
  (17, 'pluguechat_message_queue'),
  (18, 'pluguechat_broadcast_recipients'),
  (19, 'pluguechat_broadcasts'),
  (20, 'pluguechat_automation_templates'),
  (21, 'pluguechat_official_configs'),
  (22, 'reservation_payment_events'),
  (23, 'reservation_payments'),
  (24, 'reservation_payment_rules'),
  (25, 'reservation_audit_logs'),
  (26, 'reservation_funnel_logs'),
  (27, 'reservation_companions'),
  (28, 'reservation_reviews'),
  (29, 'reservation_schedule_overrides'),
  (30, 'reservation_schedule_rules'),
  (31, 'reservations'),
  (32, 'waitlist_companions'),
  (33, 'waitlist'),
  (34, 'notification_recipients'),
  (35, 'notifications'),
  (36, 'crm_leads'),
  (37, 'lead_reactivation_dispatches'),
  (38, 'ads_journey_states'),
  (39, 'affiliate_link_visits'),
  (40, 'affiliate_links'),
  (41, 'occupancy_capacity_slot_snapshots'),
  (42, 'platform_billing_pix_rate_limits'),
  (43, 'company_billing_invoices'),
  (44, 'company_billing_links'),
  (45, 'company_asaas_configs'),
  (46, 'company_nps_configs'),
  (47, 'company_public_notices'),
  (48, 'company_tracking_settings'),
  (49, 'company_user_panel_permissions'),
  (50, 'company_whatsapp_instances'),
  (51, 'company_feature_overrides'),
  (52, 'automation_settings'),
  (53, 'blocked_dates'),
  (54, 'restaurant_tables'),
  (55, 'table_maps'),
  (56, 'table_sections'),
  (57, 'public_rate_limits'),
  (58, 'user_roles');

-- Fast, indexable quarantine marker. The request row above is the source of
-- truth; this column is a cheap predicate for RLS policies and for the many
-- existing cron jobs that iterate companies.
ALTER TABLE public.companies
  ADD COLUMN deletion_requested_at timestamptz;

CREATE INDEX idx_companies_deletion_requested_at
  ON public.companies(deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;

-- Quarantine must block writes even from a superadmin's or the tenant
-- admin's own session -- reusing companies.status='paused' was considered
-- and rejected: it already has two independent write paths (tenant admin
-- self-service update, superadmin pause/unpause toggle) that would race the
-- worker. Splitting the old "FOR ALL" superadmin policy is required because
-- permissive RLS policies OR together -- guarding only the replacement
-- policy while the old ALL policy still exists would leave the hole open.
DROP POLICY IF EXISTS "Superadmins can manage all companies" ON public.companies;

CREATE POLICY "Superadmins can view all companies"
  ON public.companies FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'superadmin'));

CREATE POLICY "Superadmins can insert companies"
  ON public.companies FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'superadmin'));

CREATE POLICY "Superadmins can update companies not pending deletion"
  ON public.companies FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'superadmin') AND deletion_requested_at IS NULL)
  WITH CHECK (public.has_role(auth.uid(), 'superadmin') AND deletion_requested_at IS NULL);

-- No DELETE policy is (re)created for companies: combined with the REVOKE
-- below, direct deletion is denied outright. Only the SECURITY DEFINER
-- worker function (running as its owner, which bypasses RLS) can remove a
-- companies row, and only after its own request/grace-period/teardown
-- checks pass.
REVOKE DELETE ON public.companies FROM authenticated;

DROP POLICY IF EXISTS "Company admins can update their own company" ON public.companies;
CREATE POLICY "Company admins can update their own company"
ON public.companies
FOR UPDATE
TO authenticated
USING (
  (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, id)
  )
  AND deletion_requested_at IS NULL
)
WITH CHECK (
  (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, id)
  )
  AND deletion_requested_at IS NULL
);
