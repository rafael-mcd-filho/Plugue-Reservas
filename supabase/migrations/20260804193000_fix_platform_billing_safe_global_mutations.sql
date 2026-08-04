-- Supabase enables pg-safeupdate in production. Global cache invalidations are
-- intentional here, but they still need explicit predicates so the extension
-- does not reject the token/environment rotation transaction.

CREATE OR REPLACE FUNCTION public.reset_company_billing_rollout_on_source_rotation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source_revision IS DISTINCT FROM OLD.source_revision THEN
    UPDATE public.company_billing_links AS link
    SET
      billing_enabled = false,
      billing_revision = gen_random_uuid(),
      billing_enabled_at = NULL,
      billing_enabled_by = NULL,
      link_revision = gen_random_uuid(),
      sync_attempt_revision = NULL,
      updated_at = now()
    WHERE link.company_id IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_company_billing_rollout_on_source_rotation()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_company_billing_rollout_on_source_rotation()
TO service_role;

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

  DELETE FROM public.company_billing_invoices AS invoice
  WHERE invoice.id IS NOT NULL;
  GET DIAGNOSTICS _purged_invoice_count = ROW_COUNT;

  UPDATE public.company_billing_links AS link
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
    updated_by = _updated_by
  WHERE link.company_id IS NOT NULL;
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
