-- PlugueGuest platform billing read model.
--
-- This module is intentionally isolated from company_asaas_configs and from
-- reservation payments. It only mirrors invoices that already exist in the
-- platform's own Asaas account; it never creates or mutates Asaas resources.

CREATE TABLE public.platform_billing_config (
  id boolean PRIMARY KEY DEFAULT true,
  api_token_encrypted text,
  api_environment text NOT NULL DEFAULT 'production',
  source_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  module_enabled boolean NOT NULL DEFAULT false,
  token_last_four text,
  token_validated_at timestamptz,
  token_last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT platform_billing_config_singleton CHECK (id = true),
  CONSTRAINT platform_billing_config_environment CHECK (
    api_environment IN ('sandbox', 'production')
  ),
  CONSTRAINT platform_billing_config_last_four CHECK (
    token_last_four IS NULL OR char_length(token_last_four) <= 8
  )
);

INSERT INTO public.platform_billing_config (id, module_enabled, api_environment)
VALUES (true, false, 'production')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_billing_config ENABLE ROW LEVEL SECURITY;

-- There are deliberately no anon/authenticated policies. The encrypted token
-- is only reachable through service-role Edge Functions.
REVOKE ALL ON TABLE public.platform_billing_config FROM anon, authenticated;
GRANT ALL ON TABLE public.platform_billing_config TO service_role;

CREATE TABLE public.company_billing_links (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  asaas_customer_id text NOT NULL UNIQUE,
  customer_name text,
  customer_cpf_cnpj text,
  description_marker text NOT NULL DEFAULT '[PLUGUEGUEST]',
  link_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending_validation',
  last_validated_at timestamptz,
  last_sync_attempt_at timestamptz,
  sync_attempt_revision uuid,
  last_synced_at timestamptz,
  last_sync_error text,
  last_fetched_count integer NOT NULL DEFAULT 0,
  last_matched_count integer NOT NULL DEFAULT 0,
  last_ignored_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_billing_links_customer_id_not_blank CHECK (
    btrim(asaas_customer_id) <> '' AND char_length(asaas_customer_id) <= 100
  ),
  CONSTRAINT company_billing_links_marker_not_blank CHECK (
    btrim(description_marker) <> '' AND char_length(description_marker) <= 100
  ),
  CONSTRAINT company_billing_links_marker_fixed CHECK (
    description_marker = '[PLUGUEGUEST]'
  ),
  CONSTRAINT company_billing_links_status_check CHECK (
    status IN ('pending_validation', 'active', 'error', 'disabled')
  ),
  CONSTRAINT company_billing_links_sync_counts_nonnegative CHECK (
    last_fetched_count >= 0
    AND last_matched_count >= 0
    AND last_ignored_count >= 0
  )
);

CREATE TABLE public.company_billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  asaas_payment_id text NOT NULL UNIQUE,
  asaas_customer_id text NOT NULL,
  asaas_subscription_id text,
  description text,
  status text NOT NULL,
  value numeric(12, 2) NOT NULL DEFAULT 0,
  due_date date,
  payment_date date,
  billing_type text,
  invoice_url text,
  bank_slip_url text,
  external_reference text,
  asaas_created_at date,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_billing_invoices_payment_id_not_blank CHECK (
    btrim(asaas_payment_id) <> '' AND char_length(asaas_payment_id) <= 100
  ),
  CONSTRAINT company_billing_invoices_value_nonnegative CHECK (value >= 0)
);

CREATE INDEX idx_company_billing_invoices_company_due
ON public.company_billing_invoices(company_id, due_date DESC);

CREATE INDEX idx_company_billing_invoices_company_status_due
ON public.company_billing_invoices(company_id, status, due_date);

ALTER TABLE public.company_billing_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_billing_invoices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.company_billing_links FROM anon, authenticated;
REVOKE ALL ON TABLE public.company_billing_invoices FROM anon, authenticated;

GRANT SELECT ON TABLE public.company_billing_links TO authenticated;
GRANT SELECT ON TABLE public.company_billing_invoices TO authenticated;
GRANT ALL ON TABLE public.company_billing_links TO service_role;
GRANT ALL ON TABLE public.company_billing_invoices TO service_role;

CREATE OR REPLACE FUNCTION public.platform_billing_is_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT
      config.module_enabled
      AND config.api_token_encrypted IS NOT NULL
      AND config.token_validated_at IS NOT NULL
      AND config.token_last_error IS NULL
    FROM public.platform_billing_config config
    WHERE config.id = true
    LIMIT 1
  ), false);
$$;

REVOKE ALL ON FUNCTION public.platform_billing_is_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_billing_is_enabled() TO authenticated;

CREATE POLICY "Superadmins and company admins can view billing links"
ON public.company_billing_links
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR (
    public.platform_billing_is_enabled()
    AND public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  )
);

CREATE POLICY "Superadmins and company admins can view billing invoices"
ON public.company_billing_invoices
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR (
    public.platform_billing_is_enabled()
    AND public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  )
);

-- Rotate the global provider source and invalidate every dependent cache/link
-- in one transaction. The expected revision prevents a stale browser tab from
-- overwriting a newer source configuration.
CREATE OR REPLACE FUNCTION public.rotate_platform_billing_source(
  _expected_source_revision uuid,
  _api_token_encrypted text,
  _api_environment text,
  _token_last_four text,
  _token_validated_at timestamptz,
  _updated_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _current_source_revision uuid;
  _previous_environment text;
  _token_replaced boolean;
  _next_source_revision uuid := gen_random_uuid();
  _purged_invoice_count integer := 0;
  _invalidated_link_count integer := 0;
BEGIN
  IF _api_token_encrypted IS NULL OR btrim(_api_token_encrypted) = '' THEN
    RAISE EXCEPTION 'Encrypted Asaas token is required';
  END IF;

  IF _api_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'Invalid platform billing environment';
  END IF;

  SELECT
    config.source_revision,
    config.api_environment,
    config.api_token_encrypted IS NOT NULL
  INTO
    _current_source_revision,
    _previous_environment,
    _token_replaced
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR UPDATE;

  IF _current_source_revision IS NULL THEN
    RAISE EXCEPTION 'Platform billing config not found';
  END IF;

  IF _expected_source_revision IS DISTINCT FROM _current_source_revision THEN
    RAISE EXCEPTION 'Platform billing source revision changed';
  END IF;

  UPDATE public.platform_billing_config
  SET
    api_token_encrypted = _api_token_encrypted,
    api_environment = _api_environment,
    source_revision = _next_source_revision,
    module_enabled = false,
    token_last_four = _token_last_four,
    token_validated_at = _token_validated_at,
    token_last_error = NULL,
    updated_at = _token_validated_at,
    updated_by = _updated_by
  WHERE id = true;

  DELETE FROM public.company_billing_invoices;
  GET DIAGNOSTICS _purged_invoice_count = ROW_COUNT;

  UPDATE public.company_billing_links
  SET
    link_revision = gen_random_uuid(),
    status = 'pending_validation',
    last_validated_at = NULL,
    last_sync_attempt_at = NULL,
    sync_attempt_revision = NULL,
    last_synced_at = NULL,
    last_sync_error = 'Revalide o Customer ID apos trocar a fonte Asaas.',
    last_fetched_count = 0,
    last_matched_count = 0,
    last_ignored_count = 0,
    updated_at = _token_validated_at,
    updated_by = _updated_by;
  GET DIAGNOSTICS _invalidated_link_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'source_revision', _next_source_revision,
    'token_replaced', COALESCE(_token_replaced, false),
    'environment_changed', _previous_environment IS DISTINCT FROM _api_environment,
    'purged_invoice_count', _purged_invoice_count,
    'invalidated_link_count', _invalidated_link_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_platform_billing_source(
  uuid, text, text, text, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_platform_billing_source(
  uuid, text, text, text, timestamptz, uuid
) TO service_role;

-- Save/revalidate a company link and purge incompatible cache rows atomically.
-- It locks config before link, matching the cache replacement lock order.
CREATE OR REPLACE FUNCTION public.save_company_billing_link(
  _company_id uuid,
  _asaas_customer_id text,
  _customer_name text,
  _customer_cpf_cnpj text,
  _description_marker text,
  _expected_source_revision uuid,
  _actor_id uuid,
  _validated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _current_source_revision uuid;
  _previous_customer_id text;
  _previous_marker text;
  _link_exists boolean := false;
  _relationship_changed boolean := false;
  _next_link_revision uuid := gen_random_uuid();
  _purged_invoice_count integer := 0;
BEGIN
  IF _description_marker <> '[PLUGUEGUEST]' THEN
    RAISE EXCEPTION 'Platform billing marker must be [PLUGUEGUEST]';
  END IF;

  SELECT config.source_revision
  INTO _current_source_revision
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR SHARE;

  IF _expected_source_revision IS DISTINCT FROM _current_source_revision THEN
    RAISE EXCEPTION 'Platform billing source revision changed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.companies company WHERE company.id = _company_id) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.company_billing_links other_link
    WHERE other_link.asaas_customer_id = _asaas_customer_id
      AND other_link.company_id <> _company_id
  ) THEN
    RAISE EXCEPTION 'Asaas customer is already linked to another company'
      USING ERRCODE = '23505';
  END IF;

  SELECT link.asaas_customer_id, link.description_marker
  INTO _previous_customer_id, _previous_marker
  FROM public.company_billing_links link
  WHERE link.company_id = _company_id
  FOR UPDATE;
  _link_exists := FOUND;

  _relationship_changed := NOT _link_exists
    OR _previous_customer_id IS DISTINCT FROM _asaas_customer_id
    OR _previous_marker IS DISTINCT FROM _description_marker;

  IF _relationship_changed THEN
    DELETE FROM public.company_billing_invoices invoice
    WHERE invoice.company_id = _company_id;
    GET DIAGNOSTICS _purged_invoice_count = ROW_COUNT;
  END IF;

  IF _link_exists THEN
    UPDATE public.company_billing_links
    SET
      asaas_customer_id = _asaas_customer_id,
      customer_name = _customer_name,
      customer_cpf_cnpj = _customer_cpf_cnpj,
      description_marker = _description_marker,
      link_revision = _next_link_revision,
      status = 'active',
      last_validated_at = _validated_at,
      sync_attempt_revision = NULL,
      last_sync_attempt_at = CASE WHEN _relationship_changed THEN NULL ELSE last_sync_attempt_at END,
      last_synced_at = CASE WHEN _relationship_changed THEN NULL ELSE last_synced_at END,
      last_sync_error = NULL,
      last_fetched_count = CASE WHEN _relationship_changed THEN 0 ELSE last_fetched_count END,
      last_matched_count = CASE WHEN _relationship_changed THEN 0 ELSE last_matched_count END,
      last_ignored_count = CASE WHEN _relationship_changed THEN 0 ELSE last_ignored_count END,
      updated_by = _actor_id,
      updated_at = _validated_at
    WHERE company_id = _company_id;
  ELSE
    INSERT INTO public.company_billing_links (
      company_id,
      asaas_customer_id,
      customer_name,
      customer_cpf_cnpj,
      description_marker,
      link_revision,
      status,
      last_validated_at,
      created_by,
      updated_by,
      created_at,
      updated_at
    ) VALUES (
      _company_id,
      _asaas_customer_id,
      _customer_name,
      _customer_cpf_cnpj,
      _description_marker,
      _next_link_revision,
      'active',
      _validated_at,
      _actor_id,
      _actor_id,
      _validated_at,
      _validated_at
    );
  END IF;

  RETURN jsonb_build_object(
    'source_revision', _current_source_revision,
    'link_revision', _next_link_revision,
    'previous_customer_id', _previous_customer_id,
    'previous_marker', _previous_marker,
    'relationship_changed', _relationship_changed,
    'purged_invoice_count', _purged_invoice_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_company_billing_link(
  uuid, text, text, text, text, uuid, uuid, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_company_billing_link(
  uuid, text, text, text, text, uuid, uuid, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.remove_company_billing_link_cache(
  _company_id uuid,
  _expected_source_revision uuid,
  _expected_asaas_customer_id text,
  _expected_link_revision uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _current_source_revision uuid;
  _asaas_customer_id text;
  _description_marker text;
  _link_revision uuid;
  _purged_invoice_count integer := 0;
BEGIN
  -- Keep the global lock order config -> link for all billing mutations.
  SELECT config.source_revision
  INTO _current_source_revision
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR SHARE;

  IF _expected_source_revision IS DISTINCT FROM _current_source_revision THEN
    RAISE EXCEPTION 'Platform billing source revision changed before link removal';
  END IF;

  SELECT link.asaas_customer_id, link.description_marker, link.link_revision
  INTO _asaas_customer_id, _description_marker, _link_revision
  FROM public.company_billing_links link
  WHERE link.company_id = _company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('removed', false, 'purged_invoice_count', 0);
  END IF;

  IF _expected_asaas_customer_id IS DISTINCT FROM _asaas_customer_id
    OR _expected_link_revision IS DISTINCT FROM _link_revision
  THEN
    RAISE EXCEPTION 'Company billing link revision changed before removal';
  END IF;

  DELETE FROM public.company_billing_invoices invoice
  WHERE invoice.company_id = _company_id;
  GET DIAGNOSTICS _purged_invoice_count = ROW_COUNT;

  DELETE FROM public.company_billing_links link
  WHERE link.company_id = _company_id;

  RETURN jsonb_build_object(
    'removed', true,
    'asaas_customer_id', _asaas_customer_id,
    'description_marker', _description_marker,
    'purged_invoice_count', _purged_invoice_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.remove_company_billing_link_cache(uuid, uuid, text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_company_billing_link_cache(uuid, uuid, text, uuid)
TO service_role;

-- Claim one synchronization attempt under the same config -> link lock order
-- used by cache replacement. A newer claim changes sync_attempt_revision and
-- makes every older provider response harmless.
CREATE OR REPLACE FUNCTION public.claim_company_billing_sync_attempt(
  _company_id uuid,
  _asaas_customer_id text,
  _source_revision uuid,
  _link_revision uuid,
  _sync_attempt_revision uuid,
  _attempted_at timestamptz,
  _bypass_cooldown boolean,
  _allow_pending_validation boolean,
  _cooldown_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _current_source_revision uuid;
  _current_customer_id text;
  _current_link_revision uuid;
  _current_status text;
  _last_sync_attempt_at timestamptz;
  _effective_cooldown_seconds integer := GREATEST(0, LEAST(COALESCE(_cooldown_seconds, 300), 3600));
  _retry_after_seconds integer;
BEGIN
  IF _sync_attempt_revision IS NULL THEN
    RAISE EXCEPTION 'Synchronization attempt revision is required';
  END IF;

  SELECT config.source_revision
  INTO _current_source_revision
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR SHARE;

  IF _source_revision IS DISTINCT FROM _current_source_revision THEN
    RAISE EXCEPTION 'Platform billing source revision changed before synchronization';
  END IF;

  SELECT
    link.asaas_customer_id,
    link.link_revision,
    link.status,
    link.last_sync_attempt_at
  INTO
    _current_customer_id,
    _current_link_revision,
    _current_status,
    _last_sync_attempt_at
  FROM public.company_billing_links link
  WHERE link.company_id = _company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company billing link not found';
  END IF;

  IF _current_customer_id IS DISTINCT FROM _asaas_customer_id
    OR _current_link_revision IS DISTINCT FROM _link_revision
  THEN
    RAISE EXCEPTION 'Company billing link revision changed before synchronization';
  END IF;

  IF _current_status = 'disabled' THEN
    RAISE EXCEPTION 'Company billing link is disabled';
  END IF;

  IF _current_status = 'pending_validation' AND NOT COALESCE(_allow_pending_validation, false) THEN
    RAISE EXCEPTION 'Company billing link requires superadmin revalidation';
  END IF;

  IF NOT COALESCE(_bypass_cooldown, false)
    AND _last_sync_attempt_at IS NOT NULL
    AND _last_sync_attempt_at > _attempted_at - make_interval(secs => _effective_cooldown_seconds)
  THEN
    _retry_after_seconds := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        _last_sync_attempt_at
        + make_interval(secs => _effective_cooldown_seconds)
        - _attempted_at
      )))::integer
    );
    RETURN jsonb_build_object(
      'claimed', false,
      'retry_after_seconds', _retry_after_seconds
    );
  END IF;

  UPDATE public.company_billing_links
  SET
    sync_attempt_revision = _sync_attempt_revision,
    last_sync_attempt_at = _attempted_at,
    updated_at = _attempted_at
  WHERE company_id = _company_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'sync_attempt_revision', _sync_attempt_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_company_billing_sync_attempt(
  uuid, text, uuid, uuid, uuid, timestamptz, boolean, boolean, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_company_billing_sync_attempt(
  uuid, text, uuid, uuid, uuid, timestamptz, boolean, boolean, integer
) TO service_role;

-- Atomically replace the rebuildable cache after a complete, successful Asaas
-- pagination pass. A failed provider call therefore leaves the last good cache
-- available, while a successful pass removes stale/non-matching invoices.
CREATE OR REPLACE FUNCTION public.replace_company_billing_invoice_cache(
  _company_id uuid,
  _asaas_customer_id text,
  _source_revision uuid,
  _link_revision uuid,
  _sync_attempt_revision uuid,
  _customer_name text,
  _customer_cpf_cnpj text,
  _synced_at timestamptz,
  _fetched_count integer,
  _rows jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _current_source_revision uuid;
  _current_customer_id text;
  _current_link_revision uuid;
  _current_sync_attempt_revision uuid;
  _matched_count integer;
BEGIN
  IF jsonb_typeof(COALESCE(_rows, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Invoice cache payload must be a JSON array';
  END IF;

  SELECT config.source_revision
  INTO _current_source_revision
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR SHARE;

  IF _source_revision IS DISTINCT FROM _current_source_revision THEN
    RAISE EXCEPTION 'Platform billing source revision changed during synchronization';
  END IF;

  SELECT link.asaas_customer_id, link.link_revision, link.sync_attempt_revision
  INTO _current_customer_id, _current_link_revision, _current_sync_attempt_revision
  FROM public.company_billing_links link
  WHERE link.company_id = _company_id
  FOR UPDATE;

  IF _current_customer_id IS NULL THEN
    RAISE EXCEPTION 'Company billing link not found';
  END IF;

  IF _current_customer_id <> _asaas_customer_id THEN
    RAISE EXCEPTION 'Company billing customer changed during synchronization';
  END IF;

  IF _current_link_revision IS DISTINCT FROM _link_revision THEN
    RAISE EXCEPTION 'Company billing link revision changed during synchronization';
  END IF;

  IF _current_sync_attempt_revision IS DISTINCT FROM _sync_attempt_revision THEN
    RAISE EXCEPTION 'Company billing synchronization attempt was superseded';
  END IF;

  _matched_count := jsonb_array_length(COALESCE(_rows, '[]'::jsonb));

  IF EXISTS (
    SELECT 1
    FROM public.company_billing_invoices invoice
    JOIN jsonb_to_recordset(COALESCE(_rows, '[]'::jsonb)) AS incoming(
      asaas_payment_id text
    ) ON incoming.asaas_payment_id = invoice.asaas_payment_id
    WHERE invoice.company_id <> _company_id
  ) THEN
    RAISE EXCEPTION 'Asaas payment is already linked to another company';
  END IF;

  INSERT INTO public.company_billing_invoices (
    company_id,
    asaas_payment_id,
    asaas_customer_id,
    asaas_subscription_id,
    description,
    status,
    value,
    due_date,
    payment_date,
    billing_type,
    invoice_url,
    bank_slip_url,
    external_reference,
    asaas_created_at,
    last_synced_at,
    updated_at
  )
  SELECT
    _company_id,
    incoming.asaas_payment_id,
    _asaas_customer_id,
    incoming.asaas_subscription_id,
    incoming.description,
    incoming.status,
    incoming.value,
    incoming.due_date,
    incoming.payment_date,
    incoming.billing_type,
    incoming.invoice_url,
    incoming.bank_slip_url,
    incoming.external_reference,
    incoming.asaas_created_at,
    _synced_at,
    _synced_at
  FROM jsonb_to_recordset(COALESCE(_rows, '[]'::jsonb)) AS incoming(
    asaas_payment_id text,
    asaas_subscription_id text,
    description text,
    status text,
    value numeric,
    due_date date,
    payment_date date,
    billing_type text,
    invoice_url text,
    bank_slip_url text,
    external_reference text,
    asaas_created_at date
  )
  ON CONFLICT (asaas_payment_id) DO UPDATE
  SET
    asaas_customer_id = EXCLUDED.asaas_customer_id,
    asaas_subscription_id = EXCLUDED.asaas_subscription_id,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    value = EXCLUDED.value,
    due_date = EXCLUDED.due_date,
    payment_date = EXCLUDED.payment_date,
    billing_type = EXCLUDED.billing_type,
    invoice_url = EXCLUDED.invoice_url,
    bank_slip_url = EXCLUDED.bank_slip_url,
    external_reference = EXCLUDED.external_reference,
    asaas_created_at = EXCLUDED.asaas_created_at,
    last_synced_at = EXCLUDED.last_synced_at,
    updated_at = EXCLUDED.updated_at
  WHERE company_billing_invoices.company_id = EXCLUDED.company_id;

  -- The pre-check above gives a clear error in the usual case; this second
  -- check also closes the race where another company inserts the same provider
  -- payment between that check and this upsert.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(_rows, '[]'::jsonb)) AS incoming(
      asaas_payment_id text
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.company_billing_invoices invoice
      WHERE invoice.asaas_payment_id = incoming.asaas_payment_id
        AND invoice.company_id = _company_id
    )
  ) THEN
    RAISE EXCEPTION 'Asaas payment is already linked to another company';
  END IF;

  DELETE FROM public.company_billing_invoices invoice
  WHERE invoice.company_id = _company_id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(COALESCE(_rows, '[]'::jsonb)) AS incoming(
        asaas_payment_id text
      )
      WHERE incoming.asaas_payment_id = invoice.asaas_payment_id
    );

  UPDATE public.company_billing_links
  SET
    customer_name = _customer_name,
    customer_cpf_cnpj = _customer_cpf_cnpj,
    status = 'active',
    last_validated_at = _synced_at,
    last_sync_attempt_at = _synced_at,
    last_synced_at = _synced_at,
    last_sync_error = NULL,
    last_fetched_count = GREATEST(COALESCE(_fetched_count, 0), 0),
    last_matched_count = _matched_count,
    last_ignored_count = GREATEST(COALESCE(_fetched_count, 0) - _matched_count, 0),
    updated_at = _synced_at
  WHERE company_id = _company_id;

  RETURN _matched_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_company_billing_invoice_cache(
  uuid, text, uuid, uuid, uuid, text, text, timestamptz, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_company_billing_invoice_cache(
  uuid, text, uuid, uuid, uuid, text, text, timestamptz, integer, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_company_billing_sync_failure(
  _company_id uuid,
  _asaas_customer_id text,
  _source_revision uuid,
  _link_revision uuid,
  _sync_attempt_revision uuid,
  _attempted_at timestamptz,
  _error_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _current_source_revision uuid;
  _current_customer_id text;
  _current_link_revision uuid;
  _current_sync_attempt_revision uuid;
  _current_status text;
BEGIN
  SELECT config.source_revision
  INTO _current_source_revision
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR SHARE;

  IF _source_revision IS DISTINCT FROM _current_source_revision THEN
    RETURN false;
  END IF;

  SELECT link.asaas_customer_id, link.link_revision, link.sync_attempt_revision, link.status
  INTO _current_customer_id, _current_link_revision, _current_sync_attempt_revision, _current_status
  FROM public.company_billing_links link
  WHERE link.company_id = _company_id
  FOR UPDATE;

  IF NOT FOUND
    OR _current_customer_id IS DISTINCT FROM _asaas_customer_id
    OR _current_link_revision IS DISTINCT FROM _link_revision
    OR _current_sync_attempt_revision IS DISTINCT FROM _sync_attempt_revision
    OR _current_status IN ('pending_validation', 'disabled')
  THEN
    RETURN false;
  END IF;

  UPDATE public.company_billing_links
  SET
    status = 'error',
    last_sync_attempt_at = _attempted_at,
    last_sync_error = left(COALESCE(_error_message, 'Erro de sincronizacao'), 1000),
    updated_at = _attempted_at
  WHERE company_id = _company_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_company_billing_sync_failure(
  uuid, text, uuid, uuid, uuid, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_company_billing_sync_failure(
  uuid, text, uuid, uuid, uuid, timestamptz, text
) TO service_role;

-- Disable the module when the current provider token is rejected. Both the
-- source and the specific sync attempt are fenced so an old 401/403 response
-- cannot disable a newly saved token or override a newer successful sync.
CREATE OR REPLACE FUNCTION public.record_platform_billing_auth_failure(
  _company_id uuid,
  _source_revision uuid,
  _link_revision uuid,
  _sync_attempt_revision uuid,
  _failed_at timestamptz,
  _error_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _current_source_revision uuid;
  _current_link_revision uuid;
  _current_sync_attempt_revision uuid;
BEGIN
  SELECT config.source_revision
  INTO _current_source_revision
  FROM public.platform_billing_config config
  WHERE config.id = true
  FOR UPDATE;

  IF _source_revision IS DISTINCT FROM _current_source_revision THEN
    RETURN false;
  END IF;

  SELECT link.link_revision, link.sync_attempt_revision
  INTO _current_link_revision, _current_sync_attempt_revision
  FROM public.company_billing_links link
  WHERE link.company_id = _company_id
  FOR SHARE;

  IF NOT FOUND
    OR _link_revision IS DISTINCT FROM _current_link_revision
    OR _sync_attempt_revision IS DISTINCT FROM _current_sync_attempt_revision
  THEN
    RETURN false;
  END IF;

  UPDATE public.platform_billing_config
  SET
    module_enabled = false,
    token_last_error = left(COALESCE(_error_message, 'Asaas rejected the configured token'), 1000),
    updated_at = _failed_at
  WHERE id = true;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_platform_billing_auth_failure(
  uuid, uuid, uuid, uuid, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_platform_billing_auth_failure(
  uuid, uuid, uuid, uuid, timestamptz, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.get_platform_billing_module_status()
RETURNS TABLE (
  module_enabled boolean,
  configured boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE auth.uid() IS NOT NULL
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR EXISTS (
          SELECT 1
          FROM public.user_roles ur
          WHERE ur.user_id = auth.uid()
            AND ur.role = 'admin'::public.app_role
            AND ur.company_id IS NOT NULL
        )
      )
  )
  SELECT
    public.platform_billing_is_enabled() AS module_enabled,
    (
      config.api_token_encrypted IS NOT NULL
      AND config.token_validated_at IS NOT NULL
      AND config.token_last_error IS NULL
    ) AS configured
  FROM has_access
  LEFT JOIN public.platform_billing_config config ON config.id = true;
$$;

REVOKE ALL ON FUNCTION public.get_platform_billing_module_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_billing_module_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_company_billing_summary(_company_id uuid)
RETURNS TABLE (
  module_enabled boolean,
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
  WITH has_access AS (
    SELECT 1
    WHERE auth.uid() IS NOT NULL
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR (
          public.platform_billing_is_enabled()
          AND public.has_role_in_company(
            auth.uid(),
            'admin'::public.app_role,
            _company_id
          )
        )
      )
  ),
  local_clock AS (
    SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS today
  ),
  config AS (
    SELECT public.platform_billing_is_enabled() AS module_enabled
  ),
  link AS (
    SELECT cbl.status, cbl.last_synced_at, cbl.last_sync_error
    FROM public.company_billing_links cbl
    WHERE cbl.company_id = _company_id
  ),
  open_invoices AS (
    SELECT invoice.*
    FROM public.company_billing_invoices invoice
    WHERE invoice.company_id = _company_id
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
    COALESCE(config.module_enabled, false) AS module_enabled,
    COALESCE(link.status, 'not_configured') AS link_status,
    (link.status IS NOT NULL) AS has_link,
    link.last_synced_at,
    link.last_sync_error,
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
  FROM has_access
  CROSS JOIN local_clock
  LEFT JOIN config ON true
  LEFT JOIN link ON true
  LEFT JOIN rollup ON true
  LEFT JOIN next_due ON true;
$$;

REVOKE ALL ON FUNCTION public.get_company_billing_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_billing_summary(uuid) TO authenticated;

COMMENT ON TABLE public.platform_billing_config IS
  'Service-role-only global Asaas configuration for PlugueGuest SaaS invoices.';

COMMENT ON TABLE public.company_billing_links IS
  'Manual company-to-Asaas-customer links for the read-only SaaS billing mirror.';

COMMENT ON TABLE public.company_billing_invoices IS
  'Rebuildable local cache of Asaas invoices whose description contains the configured marker.';
