-- PGlite regression harness.
-- Apply 20260817140000_add_platform_billing_pix_rate_limit.sql at the marker,
-- then execute the fixtures and assertions below it.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.companies (id uuid PRIMARY KEY);
CREATE TABLE public.platform_billing_config (
  id boolean PRIMARY KEY,
  source_revision uuid NOT NULL,
  module_enabled boolean NOT NULL,
  api_token_encrypted text,
  token_validated_at timestamptz,
  token_last_error text
);
CREATE TABLE public.company_billing_links (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id),
  asaas_customer_id text NOT NULL,
  description_marker text NOT NULL,
  billing_enabled boolean NOT NULL,
  link_revision uuid NOT NULL,
  status text NOT NULL
);
CREATE TABLE public.company_billing_invoices (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  asaas_payment_id text NOT NULL,
  asaas_customer_id text NOT NULL,
  description text,
  status text NOT NULL,
  value numeric(12, 2) NOT NULL,
  due_date date,
  billing_type text
);

-- @apply-migration

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000006'),
  ('10000000-0000-4000-8000-000000000007');

INSERT INTO public.companies (id) VALUES
  ('20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000003'),
  ('20000000-0000-4000-8000-000000000004');

DO $$
DECLARE
  _result jsonb;
  _first_time timestamptz := '2026-08-17T12:00:00Z'::timestamptz;
BEGIN
  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    _first_time
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'The first Pix request should claim all buckets: %', _result;
  END IF;

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    _first_time + interval '4 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM false
    OR (_result ->> 'retry_after_seconds')::integer <> 6
  THEN
    RAISE EXCEPTION 'The user bucket should throttle for six seconds: %', _result;
  END IF;

  -- The rejected user claim above must not consume the company/global buckets.
  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    _first_time + interval '4 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'A rejected user bucket consumed broader quota: %', _result;
  END IF;

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    _first_time + interval '5 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM false
    OR (_result ->> 'retry_after_seconds')::integer <> 5
  THEN
    RAISE EXCEPTION 'The user throttle must span companies: %', _result;
  END IF;

  -- The failed cross-company user claim must leave its new company bucket free.
  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    _first_time + interval '5 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'A rejected user claim consumed company/global quota: %', _result;
  END IF;

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    _first_time + interval '10 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'The exact user cooldown boundary should be claimable: %', _result;
  END IF;

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000004',
    _first_time + interval '11 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'A fresh company/user should pass the global boundary: %', _result;
  END IF;

  -- Company 3 is still inside its two-second cooldown. Rejection must not
  -- consume user 2 or the global bucket.
  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000006',
    _first_time + interval '12 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM false
    OR (_result ->> 'retry_after_seconds')::integer <> 1
  THEN
    RAISE EXCEPTION 'The company bucket should throttle for one second: %', _result;
  END IF;

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    _first_time + interval '12 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'A rejected company bucket consumed user/global quota: %', _result;
  END IF;

  -- At 12.5s only the shared global bucket is blocked.
  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000007',
    _first_time + interval '12.5 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM false
    OR (_result ->> 'retry_after_seconds')::integer <> 1
  THEN
    RAISE EXCEPTION 'The global bucket should throttle the shared token: %', _result;
  END IF;

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000007',
    _first_time + interval '13 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'A rejected global bucket consumed company/user quota: %', _result;
  END IF;
END;
$$;

DO $$
DECLARE
  _result jsonb;
  _window_start timestamptz := '2026-08-17T13:00:00Z'::timestamptz;
BEGIN
  UPDATE public.platform_billing_pix_rate_limits
  SET
    last_claimed_at = _window_start - interval '1 second',
    window_started_at = _window_start,
    window_count = 30
  WHERE bucket_key = 'global';

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000005',
    _window_start + interval '30 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM false
    OR (_result ->> 'retry_after_seconds')::integer <> 30
  THEN
    RAISE EXCEPTION 'The global 30-generation/minute window should throttle: %', _result;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.platform_billing_pix_rate_limits
    WHERE bucket_key IN (
      'company:20000000-0000-4000-8000-000000000004',
      'user:10000000-0000-4000-8000-000000000005'
    )
      AND (last_claimed_at IS NOT NULL OR window_count <> 0)
  ) THEN
    RAISE EXCEPTION 'A rejected global minute window consumed narrower quota';
  END IF;

  _result := public.claim_platform_billing_pix_request(
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000005',
    _window_start + interval '60 seconds'
  );
  IF (_result ->> 'claimed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'The exact minute-window boundary should reset all buckets: %', _result;
  END IF;
END;
$$;

INSERT INTO public.platform_billing_config VALUES (
  true,
  '30000000-0000-4000-8000-000000000001',
  true,
  'encrypted-token',
  '2026-08-17T12:00:00Z',
  NULL
);
INSERT INTO public.company_billing_links VALUES (
  '20000000-0000-4000-8000-000000000001',
  'cus_000000000001',
  '[PLUGUEGUEST]',
  true,
  '40000000-0000-4000-8000-000000000001',
  'active'
);
INSERT INTO public.company_billing_invoices VALUES (
  '50000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'pay_000000000001',
  'cus_000000000001',
  'Mensalidade [PLUGUEGUEST]',
  'PENDING',
  149.90,
  '2026-08-20',
  'PIX'
);

DO $$
DECLARE
  _snapshot jsonb;
  _rejected boolean := false;
BEGIN
  _snapshot := public.assert_platform_billing_pix_snapshot(
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'pay_000000000001',
    'cus_000000000001',
    true
  );
  IF (_snapshot ->> 'due_date') <> '2026-08-20'
    OR (_snapshot ->> 'value')::numeric <> 149.90
  THEN
    RAISE EXCEPTION 'The snapshot fence returned unexpected invoice data: %', _snapshot;
  END IF;

  UPDATE public.company_billing_links
  SET link_revision = '40000000-0000-4000-8000-000000000002';

  BEGIN
    PERFORM public.assert_platform_billing_pix_snapshot(
      '20000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'pay_000000000001',
      'cus_000000000001',
      true
    );
  EXCEPTION WHEN OTHERS THEN
    _rejected := position('Pix snapshot changed' in SQLERRM) > 0;
  END;
  IF NOT _rejected THEN
    RAISE EXCEPTION 'The fence should reject a changed link revision';
  END IF;
END;
$$;

DO $$
BEGIN
  IF has_table_privilege(
    'authenticated',
    'public.platform_billing_pix_rate_limits',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Authenticated users must not read Pix rate-limit buckets';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.claim_platform_billing_pix_request(uuid,uuid,timestamptz)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.assert_platform_billing_pix_snapshot(uuid,uuid,uuid,uuid,text,text,boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Authenticated users must not call internal Pix RPCs';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.claim_platform_billing_pix_request(uuid,uuid,timestamptz)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.assert_platform_billing_pix_snapshot(uuid,uuid,uuid,uuid,text,text,boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'The Edge service role must be able to call internal Pix RPCs';
  END IF;
END;
$$;
