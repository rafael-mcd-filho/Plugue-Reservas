-- Per-company rollout for the PlugueGuest platform billing read model.
--
-- billing_enabled deliberately controls only customer exposure and automatic
-- synchronization. A superadmin can still preview and manually synchronize a
-- disabled company before enabling it.

ALTER TABLE public.company_billing_links
  ADD COLUMN IF NOT EXISTS billing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS billing_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_enabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_company_billing_links_automatic_sync
ON public.company_billing_links(last_sync_attempt_at NULLS FIRST, company_id)
WHERE billing_enabled = true AND status IN ('active', 'error');

COMMENT ON COLUMN public.company_billing_links.billing_enabled IS
  'Explicit superadmin rollout switch. Enables company-admin visibility and automatic sync; defaults to false.';

COMMENT ON COLUMN public.company_billing_links.billing_revision IS
  'CAS revision for the per-company rollout switch. Link revision is bumped too so toggles fence in-flight syncs.';

-- A token/environment rotation changes the provider source. Every company must
-- be explicitly released again, and any in-flight sync must become stale.
CREATE OR REPLACE FUNCTION public.reset_company_billing_rollout_on_source_rotation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source_revision IS DISTINCT FROM OLD.source_revision THEN
    UPDATE public.company_billing_links
    SET
      billing_enabled = false,
      billing_revision = gen_random_uuid(),
      billing_enabled_at = NULL,
      billing_enabled_by = NULL,
      link_revision = gen_random_uuid(),
      sync_attempt_revision = NULL,
      updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_company_billing_rollout_on_source_rotation()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_company_billing_rollout_on_source_rotation()
TO service_role;

DROP TRIGGER IF EXISTS reset_company_billing_rollout_on_source_rotation
ON public.platform_billing_config;

CREATE TRIGGER reset_company_billing_rollout_on_source_rotation
AFTER UPDATE OF source_revision ON public.platform_billing_config
FOR EACH ROW
WHEN (OLD.source_revision IS DISTINCT FROM NEW.source_revision)
EXECUTE FUNCTION public.reset_company_billing_rollout_on_source_rotation();

-- Changing the Asaas identity is also a new rollout. Revalidation of the same
-- customer preserves the current switch, but a different customer never becomes
-- visible or eligible for cron implicitly.
CREATE OR REPLACE FUNCTION public.reset_company_billing_rollout_on_customer_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.asaas_customer_id IS DISTINCT FROM OLD.asaas_customer_id THEN
    NEW.billing_enabled := false;
    NEW.billing_revision := gen_random_uuid();
    NEW.billing_enabled_at := NULL;
    NEW.billing_enabled_by := NULL;
    -- save_company_billing_link already generates and returns a new link
    -- revision. Preserve that exact value so its immediate fenced sync uses the
    -- same revision that was persisted. Only generate one for other writers.
    IF NEW.link_revision IS NOT DISTINCT FROM OLD.link_revision THEN
      NEW.link_revision := gen_random_uuid();
    END IF;
    NEW.sync_attempt_revision := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_company_billing_rollout_on_customer_change()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_company_billing_rollout_on_customer_change()
TO service_role;

DROP TRIGGER IF EXISTS reset_company_billing_rollout_on_customer_change
ON public.company_billing_links;

CREATE TRIGGER reset_company_billing_rollout_on_customer_change
BEFORE UPDATE OF asaas_customer_id ON public.company_billing_links
FOR EACH ROW
WHEN (OLD.asaas_customer_id IS DISTINCT FROM NEW.asaas_customer_id)
EXECUTE FUNCTION public.reset_company_billing_rollout_on_customer_change();

-- The Edge Function invokes this service-role-only RPC. Enabling is guarded by
-- CAS and requires a valid source plus an active, validated link. Disabling is
-- intentionally fail-safe: it is accepted even from a stale UI revision.
CREATE OR REPLACE FUNCTION public.set_company_billing_enabled(
  _company_id uuid,
  _enabled boolean,
  _expected_billing_revision uuid,
  _actor_id uuid,
  _changed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _source_is_valid boolean := false;
  _current_enabled boolean;
  _current_billing_revision uuid;
  _current_status text;
  _last_validated_at timestamptz;
  _new_billing_revision uuid;
BEGIN
  IF _enabled IS NULL THEN
    RAISE EXCEPTION 'Company billing enabled state is required';
  END IF;

  IF _changed_at IS NULL THEN
    _changed_at := now();
  END IF;

  -- Keep the same config -> link lock order used by the synchronization RPCs.
  SELECT
    config.api_token_encrypted IS NOT NULL
      AND config.token_validated_at IS NOT NULL
      AND config.token_last_error IS NULL
  INTO _source_is_valid
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR SHARE;

  SELECT
    link.billing_enabled,
    link.billing_revision,
    link.status,
    link.last_validated_at
  INTO
    _current_enabled,
    _current_billing_revision,
    _current_status,
    _last_validated_at
  FROM public.company_billing_links link
  WHERE link.company_id = _company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company billing link not found';
  END IF;

  IF _enabled THEN
    IF _expected_billing_revision IS NULL
      OR _expected_billing_revision IS DISTINCT FROM _current_billing_revision
    THEN
      RAISE EXCEPTION 'Company billing revision changed';
    END IF;
    IF NOT COALESCE(_source_is_valid, false) THEN
      RAISE EXCEPTION 'Platform billing source is not configured or valid';
    END IF;
    IF _current_status <> 'active' OR _last_validated_at IS NULL THEN
      RAISE EXCEPTION 'Company billing link must be active and validated before enabling';
    END IF;
  END IF;

  IF _current_enabled IS NOT DISTINCT FROM _enabled THEN
    RETURN jsonb_build_object(
      'changed', false,
      'previous_enabled', _current_enabled,
      'billing_enabled', _current_enabled,
      'billing_revision', _current_billing_revision
    );
  END IF;

  _new_billing_revision := gen_random_uuid();

  UPDATE public.company_billing_links
  SET
    billing_enabled = _enabled,
    billing_revision = _new_billing_revision,
    billing_enabled_at = CASE WHEN _enabled THEN _changed_at ELSE NULL END,
    billing_enabled_by = _actor_id,
    link_revision = gen_random_uuid(),
    sync_attempt_revision = NULL,
    updated_by = _actor_id,
    updated_at = _changed_at
  WHERE company_id = _company_id;

  RETURN jsonb_build_object(
    'changed', true,
    'previous_enabled', _current_enabled,
    'billing_enabled', _enabled,
    'billing_revision', _new_billing_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_company_billing_enabled(
  uuid, boolean, uuid, uuid, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_company_billing_enabled(
  uuid, boolean, uuid, uuid, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.company_platform_billing_is_enabled(_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.platform_billing_is_enabled()
    AND COALESCE((
      SELECT link.billing_enabled
      FROM public.company_billing_links link
      WHERE link.company_id = _company_id
      LIMIT 1
    ), false);
$$;

REVOKE ALL ON FUNCTION public.company_platform_billing_is_enabled(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.company_platform_billing_is_enabled(uuid) TO authenticated;

DROP POLICY IF EXISTS "Superadmins and company admins can view billing links"
ON public.company_billing_links;

CREATE POLICY "Superadmins and enabled company admins can view billing links"
ON public.company_billing_links
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR (
    public.company_platform_billing_is_enabled(company_id)
    AND public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  )
);

DROP POLICY IF EXISTS "Superadmins and company admins can view billing invoices"
ON public.company_billing_invoices;

CREATE POLICY "Superadmins and enabled company admins can view billing invoices"
ON public.company_billing_invoices
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR (
    public.company_platform_billing_is_enabled(company_id)
    AND public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  )
);

-- Company admins always receive one small access-state row so the UI can hide
-- the navigation when rollout is off. Invoice aggregates and sync metadata stay
-- masked unless both switches are effective. Superadmins retain preview access.
DROP FUNCTION IF EXISTS public.get_company_billing_summary(uuid);

CREATE FUNCTION public.get_company_billing_summary(_company_id uuid)
RETURNS TABLE (
  module_enabled boolean,
  company_billing_enabled boolean,
  link_status text,
  has_link boolean,
  last_synced_at timestamptz,
  last_sync_error text,
  open_count bigint,
  open_amount numeric,
  overdue_count bigint,
  overdue_amount numeric,
  oldest_overdue_due_date date,
  oldest_overdue_days integer,
  next_due_date date,
  next_due_amount numeric,
  show_overdue_popup boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH viewer AS (
    SELECT
      public.has_role(auth.uid(), 'superadmin'::public.app_role) AS is_superadmin,
      public.has_role_in_company(
        auth.uid(),
        'admin'::public.app_role,
        _company_id
      ) AS is_company_admin
    WHERE auth.uid() IS NOT NULL
  ),
  local_clock AS (
    SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS today
  ),
  billing_state AS (
    SELECT
      public.platform_billing_is_enabled() AS global_enabled,
      COALESCE(link.billing_enabled, false) AS company_enabled,
      link.status,
      link.last_synced_at,
      link.last_sync_error
    FROM (SELECT 1) singleton
    LEFT JOIN public.company_billing_links link ON link.company_id = _company_id
  ),
  access_state AS (
    SELECT
      viewer.is_superadmin,
      viewer.is_company_admin,
      (
        viewer.is_superadmin
        OR (billing_state.global_enabled AND billing_state.company_enabled)
      ) AS can_read_billing,
      billing_state.*
    FROM viewer
    CROSS JOIN billing_state
    WHERE viewer.is_superadmin OR viewer.is_company_admin
  ),
  open_invoices AS (
    SELECT invoice.*
    FROM public.company_billing_invoices invoice
    CROSS JOIN access_state
    WHERE access_state.can_read_billing
      AND invoice.company_id = _company_id
      AND upper(invoice.status) IN (
        'PENDING',
        'OVERDUE',
        'DUNNING_REQUESTED',
        'AWAITING_RISK_ANALYSIS'
      )
  ),
  rollup AS (
    SELECT
      count(*)::bigint AS open_count,
      COALESCE(sum(invoice.value), 0)::numeric AS open_amount,
      count(*) FILTER (
        WHERE invoice.due_date < local_clock.today
      )::bigint AS overdue_count,
      COALESCE(sum(invoice.value) FILTER (
        WHERE invoice.due_date < local_clock.today
      ), 0)::numeric AS overdue_amount,
      min(invoice.due_date) FILTER (
        WHERE invoice.due_date < local_clock.today
      ) AS oldest_overdue_due_date
    FROM open_invoices invoice
    CROSS JOIN local_clock
  ),
  next_due AS (
    SELECT
      invoice.due_date AS next_due_date,
      sum(invoice.value)::numeric AS next_due_amount
    FROM open_invoices invoice
    CROSS JOIN local_clock
    WHERE invoice.due_date >= local_clock.today
    GROUP BY invoice.due_date
    ORDER BY invoice.due_date
    LIMIT 1
  )
  SELECT
    (
      access_state.global_enabled
      AND access_state.company_enabled
    ) AS module_enabled,
    access_state.company_enabled AS company_billing_enabled,
    CASE
      WHEN access_state.can_read_billing
        THEN COALESCE(access_state.status, 'not_configured')
      ELSE 'not_configured'
    END AS link_status,
    (
      access_state.can_read_billing
      AND access_state.status IS NOT NULL
    ) AS has_link,
    CASE WHEN access_state.can_read_billing THEN access_state.last_synced_at END,
    CASE WHEN access_state.can_read_billing THEN access_state.last_sync_error END,
    COALESCE(rollup.open_count, 0)::bigint AS open_count,
    COALESCE(rollup.open_amount, 0)::numeric AS open_amount,
    COALESCE(rollup.overdue_count, 0)::bigint AS overdue_count,
    COALESCE(rollup.overdue_amount, 0)::numeric AS overdue_amount,
    rollup.oldest_overdue_due_date,
    CASE
      WHEN rollup.oldest_overdue_due_date IS NULL THEN NULL
      ELSE local_clock.today - rollup.oldest_overdue_due_date
    END::integer AS oldest_overdue_days,
    next_due.next_due_date,
    COALESCE(next_due.next_due_amount, 0)::numeric AS next_due_amount,
    COALESCE(
      local_clock.today - rollup.oldest_overdue_due_date >= 6,
      false
    ) AS show_overdue_popup
  FROM access_state
  CROSS JOIN local_clock
  LEFT JOIN rollup ON true
  LEFT JOIN next_due ON true;
$$;

REVOKE ALL ON FUNCTION public.get_company_billing_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_billing_summary(uuid) TO authenticated;
