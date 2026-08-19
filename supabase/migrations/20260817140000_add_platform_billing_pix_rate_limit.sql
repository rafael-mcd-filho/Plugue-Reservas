-- Atomic Pix-generation throttle and final snapshot fence for on-demand
-- platform billing Pix QR codes. Browser roles cannot inspect or claim these
-- internal buckets directly.

CREATE TABLE public.platform_billing_pix_rate_limits (
  bucket_key text PRIMARY KEY,
  scope text NOT NULL,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  last_claimed_at timestamptz,
  window_started_at timestamptz,
  window_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_billing_pix_rate_limits_scope_check CHECK (
    (scope = 'global' AND company_id IS NULL AND user_id IS NULL)
    OR (scope = 'company' AND company_id IS NOT NULL AND user_id IS NULL)
    OR (scope = 'user' AND company_id IS NULL AND user_id IS NOT NULL)
  ),
  CONSTRAINT platform_billing_pix_rate_limits_count_nonnegative CHECK (
    window_count >= 0
  )
);

ALTER TABLE public.platform_billing_pix_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.platform_billing_pix_rate_limits
FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.platform_billing_pix_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.claim_platform_billing_pix_request(
  _company_id uuid,
  _user_id uuid,
  _claimed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _global_key constant text := 'global';
  _company_key text := 'company:' || _company_id::text;
  _user_key text := 'user:' || _user_id::text;
  _global_bucket public.platform_billing_pix_rate_limits%ROWTYPE;
  _company_bucket public.platform_billing_pix_rate_limits%ROWTYPE;
  _user_bucket public.platform_billing_pix_rate_limits%ROWTYPE;
  _retry_after_seconds integer := 0;
BEGIN
  IF _company_id IS NULL OR _user_id IS NULL OR _claimed_at IS NULL THEN
    RAISE EXCEPTION 'Pix rate limit claim requires company, user and timestamp';
  END IF;

  -- Every caller creates/locks in this exact order. The global row serializes
  -- claims across the shared Asaas token; company and user rows then add their
  -- narrower limits without a deadlock-prone lock-order inversion.
  INSERT INTO public.platform_billing_pix_rate_limits (
    bucket_key, scope, window_count
  ) VALUES (
    _global_key, 'global', 0
  ) ON CONFLICT (bucket_key) DO NOTHING;

  INSERT INTO public.platform_billing_pix_rate_limits (
    bucket_key, scope, company_id, window_count
  ) VALUES (
    _company_key, 'company', _company_id, 0
  ) ON CONFLICT (bucket_key) DO NOTHING;

  INSERT INTO public.platform_billing_pix_rate_limits (
    bucket_key, scope, user_id, window_count
  ) VALUES (
    _user_key, 'user', _user_id, 0
  ) ON CONFLICT (bucket_key) DO NOTHING;

  SELECT * INTO STRICT _global_bucket
  FROM public.platform_billing_pix_rate_limits
  WHERE bucket_key = _global_key
  FOR UPDATE;

  SELECT * INTO STRICT _company_bucket
  FROM public.platform_billing_pix_rate_limits
  WHERE bucket_key = _company_key
  FOR UPDATE;

  SELECT * INTO STRICT _user_bucket
  FROM public.platform_billing_pix_rate_limits
  WHERE bucket_key = _user_key
  FOR UPDATE;

  -- Global shared-token bucket: at most one generation/second and 30/minute.
  -- Each generation performs at most two Asaas GETs, capping this flow at 60
  -- provider reads/minute while retaining the requested one-QR/second pace.
  _retry_after_seconds := GREATEST(
    _retry_after_seconds,
    CASE
      WHEN _global_bucket.last_claimed_at IS NOT NULL
        AND _global_bucket.last_claimed_at + interval '1 second' > _claimed_at
      THEN CEIL(EXTRACT(EPOCH FROM (
        _global_bucket.last_claimed_at + interval '1 second' - _claimed_at
      )))::integer
      ELSE 0
    END,
    CASE
      WHEN _global_bucket.window_started_at IS NOT NULL
        AND _global_bucket.window_started_at + interval '60 seconds' > _claimed_at
        AND _global_bucket.window_count >= 30
      THEN CEIL(EXTRACT(EPOCH FROM (
        _global_bucket.window_started_at + interval '60 seconds' - _claimed_at
      )))::integer
      ELSE 0
    END
  );

  -- Company bucket: at most one request/two seconds and 30/minute.
  _retry_after_seconds := GREATEST(
    _retry_after_seconds,
    CASE
      WHEN _company_bucket.last_claimed_at IS NOT NULL
        AND _company_bucket.last_claimed_at + interval '2 seconds' > _claimed_at
      THEN CEIL(EXTRACT(EPOCH FROM (
        _company_bucket.last_claimed_at + interval '2 seconds' - _claimed_at
      )))::integer
      ELSE 0
    END,
    CASE
      WHEN _company_bucket.window_started_at IS NOT NULL
        AND _company_bucket.window_started_at + interval '60 seconds' > _claimed_at
        AND _company_bucket.window_count >= 30
      THEN CEIL(EXTRACT(EPOCH FROM (
        _company_bucket.window_started_at + interval '60 seconds' - _claimed_at
      )))::integer
      ELSE 0
    END
  );

  -- User bucket: at most one request/ten seconds and six/minute, even when a
  -- superadmin switches between companies.
  _retry_after_seconds := GREATEST(
    _retry_after_seconds,
    CASE
      WHEN _user_bucket.last_claimed_at IS NOT NULL
        AND _user_bucket.last_claimed_at + interval '10 seconds' > _claimed_at
      THEN CEIL(EXTRACT(EPOCH FROM (
        _user_bucket.last_claimed_at + interval '10 seconds' - _claimed_at
      )))::integer
      ELSE 0
    END,
    CASE
      WHEN _user_bucket.window_started_at IS NOT NULL
        AND _user_bucket.window_started_at + interval '60 seconds' > _claimed_at
        AND _user_bucket.window_count >= 6
      THEN CEIL(EXTRACT(EPOCH FROM (
        _user_bucket.window_started_at + interval '60 seconds' - _claimed_at
      )))::integer
      ELSE 0
    END
  );

  IF _retry_after_seconds > 0 THEN
    -- No bucket timestamp/count is changed on rejection. Inserts above may
    -- leave empty bucket rows, which carry no consumed quota.
    RETURN jsonb_build_object(
      'claimed', false,
      'retry_after_seconds', LEAST(60, GREATEST(1, _retry_after_seconds))
    );
  END IF;

  UPDATE public.platform_billing_pix_rate_limits
  SET
    last_claimed_at = _claimed_at,
    window_started_at = CASE
      WHEN window_started_at IS NULL
        OR window_started_at + interval '60 seconds' <= _claimed_at
      THEN _claimed_at
      ELSE window_started_at
    END,
    window_count = CASE
      WHEN window_started_at IS NULL
        OR window_started_at + interval '60 seconds' <= _claimed_at
      THEN 1
      ELSE window_count + 1
    END,
    updated_at = _claimed_at
  WHERE bucket_key IN (_global_key, _company_key, _user_key);

  RETURN jsonb_build_object(
    'claimed', true,
    'retry_after_seconds', 0,
    'claimed_at', _claimed_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_platform_billing_pix_request(
  uuid, uuid, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_platform_billing_pix_request(
  uuid, uuid, timestamptz
) TO service_role;

COMMENT ON TABLE public.platform_billing_pix_rate_limits IS
  'Atomic global, company and user throttles for Asaas Pix QR Code generation actions.';
COMMENT ON FUNCTION public.claim_platform_billing_pix_request(
  uuid, uuid, timestamptz
) IS
  'Claims global, company and user Pix generation buckets atomically; rejection consumes none.';

-- One statement checks the source, link and cached invoice under a single
-- database snapshot. The Edge Function calls it after fetching the QR and once
-- more as its final await before returning sensitive payment material.
CREATE OR REPLACE FUNCTION public.assert_platform_billing_pix_snapshot(
  _company_id uuid,
  _invoice_id uuid,
  _expected_source_revision uuid,
  _expected_link_revision uuid,
  _expected_payment_id text,
  _expected_customer_id text,
  _require_billing_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _snapshot jsonb;
BEGIN
  SELECT jsonb_build_object(
    'invoice_id', invoice.id,
    'asaas_payment_id', invoice.asaas_payment_id,
    'asaas_customer_id', invoice.asaas_customer_id,
    'description', invoice.description,
    'status', invoice.status,
    'value', invoice.value,
    'due_date', invoice.due_date,
    'billing_type', invoice.billing_type,
    'description_marker', link.description_marker
  )
  INTO _snapshot
  FROM public.platform_billing_config AS config
  JOIN public.company_billing_links AS link
    ON link.company_id = _company_id
  JOIN public.company_billing_invoices AS invoice
    ON invoice.company_id = link.company_id
   AND invoice.id = _invoice_id
  WHERE config.id = true
    AND config.source_revision = _expected_source_revision
    AND link.link_revision = _expected_link_revision
    AND link.status = 'active'
    AND link.asaas_customer_id = _expected_customer_id
    AND invoice.asaas_payment_id = _expected_payment_id
    AND invoice.asaas_customer_id = _expected_customer_id
    AND (
      NOT COALESCE(_require_billing_enabled, true)
      OR (
        config.module_enabled = true
        AND config.api_token_encrypted IS NOT NULL
        AND config.token_validated_at IS NOT NULL
        AND config.token_last_error IS NULL
        AND link.billing_enabled = true
      )
    );

  IF _snapshot IS NULL THEN
    RAISE EXCEPTION 'Platform billing Pix snapshot changed';
  END IF;

  RETURN _snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_platform_billing_pix_snapshot(
  uuid, uuid, uuid, uuid, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_platform_billing_pix_snapshot(
  uuid, uuid, uuid, uuid, text, text, boolean
) TO service_role;

COMMENT ON FUNCTION public.assert_platform_billing_pix_snapshot(
  uuid, uuid, uuid, uuid, text, text, boolean
) IS
  'Atomically fences an on-demand Pix response against source, link, rollout and invoice changes.';
