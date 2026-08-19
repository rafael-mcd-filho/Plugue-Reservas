-- PGlite regression harness.
-- Apply 20260819110000_add_company_billing_overdue_warning.sql at the marker,
-- then run the fixtures and assertions below it. No production data is used.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');

CREATE TABLE public.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  company_id uuid REFERENCES public.companies(id)
);

CREATE OR REPLACE FUNCTION public.has_role(
  _user_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS role_row
    WHERE role_row.user_id = _user_id
      AND role_row.role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.has_role_in_company(
  _user_id uuid,
  _role public.app_role,
  _company_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS role_row
    WHERE role_row.user_id = _user_id
      AND role_row.role = _role
      AND role_row.company_id = _company_id
  );
$$;

CREATE TABLE public.platform_billing_config (
  id boolean PRIMARY KEY,
  module_enabled boolean NOT NULL,
  api_token_encrypted text,
  token_validated_at timestamptz,
  token_last_error text
);

CREATE TABLE public.company_billing_links (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id),
  billing_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE public.company_billing_invoices (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  status text NOT NULL,
  due_date date
);

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
    FROM public.platform_billing_config AS config
    WHERE config.id = true
    LIMIT 1
  ), false);
$$;

-- @apply-migration

INSERT INTO public.companies (id, name) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Empresa A'),
  ('20000000-0000-4000-8000-000000000002', 'Empresa B'),
  ('20000000-0000-4000-8000-000000000003', 'Empresa C');

INSERT INTO public.user_roles (user_id, role, company_id) VALUES
  ('10000000-0000-4000-8000-000000000001', 'superadmin', NULL),
  ('10000000-0000-4000-8000-000000000002', 'admin', '20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000003', 'operator', '20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000004', 'admin', '20000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000005', 'operator', '20000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000006', 'operator', '20000000-0000-4000-8000-000000000003');

INSERT INTO public.platform_billing_config (
  id,
  module_enabled,
  api_token_encrypted,
  token_validated_at,
  token_last_error
) VALUES (
  true,
  true,
  'encrypted-token',
  now(),
  NULL
);

INSERT INTO public.company_billing_links (company_id, billing_enabled) VALUES
  ('20000000-0000-4000-8000-000000000001', true),
  ('20000000-0000-4000-8000-000000000002', true),
  ('20000000-0000-4000-8000-000000000003', false);

DO $$
DECLARE
  _proconfig text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc AS function_meta
    WHERE function_meta.oid =
      'public.get_company_billing_overdue_warning(uuid)'::regprocedure
      AND function_meta.prosecdef
      AND function_meta.provolatile = 's'
  ) THEN
    RAISE EXCEPTION 'Warning RPC must be STABLE and SECURITY DEFINER';
  END IF;

  SELECT function_meta.proconfig
  INTO _proconfig
  FROM pg_proc AS function_meta
  WHERE function_meta.oid =
    'public.get_company_billing_overdue_warning(uuid)'::regprocedure;

  IF NOT ('search_path=public, pg_temp' = ANY(_proconfig)) THEN
    RAISE EXCEPTION 'Warning RPC search_path is not hardened: %', _proconfig;
  END IF;

  IF has_function_privilege(
    'anon',
    'public.get_company_billing_overdue_warning(uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'service_role',
    'public.get_company_billing_overdue_warning(uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'authenticated',
    'public.get_company_billing_overdue_warning(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Unexpected warning RPC ACL';
  END IF;

  IF pg_get_function_result(
    'public.get_company_billing_overdue_warning(uuid)'::regprocedure
  ) <> 'TABLE(billing_enabled boolean, show_overdue_warning boolean)' THEN
    RAISE EXCEPTION 'Warning RPC exposes an unexpected result shape: %',
      pg_get_function_result(
        'public.get_company_billing_overdue_warning(uuid)'::regprocedure
      );
  END IF;
END;
$$;

-- No JWT and an authenticated outsider must both fail before receiving state.
SELECT set_config('request.jwt.claim.sub', '', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.get_company_billing_overdue_warning(
      '20000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Unauthenticated warning lookup should have failed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000004',
  false
);

DO $$
BEGIN
  BEGIN
    PERFORM public.get_company_billing_overdue_warning(
      '20000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Cross-company warning lookup should have failed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;

-- Five overdue days, paid/cancelled old invoices and a future open invoice do
-- not qualify. This also exercises admin access.
INSERT INTO public.company_billing_invoices (id, company_id, status, due_date)
SELECT
  '30000000-0000-4000-8000-000000000001'::uuid,
  '20000000-0000-4000-8000-000000000001'::uuid,
  'PENDING',
  (now() AT TIME ZONE 'America/Fortaleza')::date - 5
UNION ALL
SELECT
  '30000000-0000-4000-8000-000000000002'::uuid,
  '20000000-0000-4000-8000-000000000001'::uuid,
  'RECEIVED',
  (now() AT TIME ZONE 'America/Fortaleza')::date - 20
UNION ALL
SELECT
  '30000000-0000-4000-8000-000000000003'::uuid,
  '20000000-0000-4000-8000-000000000001'::uuid,
  'DELETED',
  (now() AT TIME ZONE 'America/Fortaleza')::date - 20
UNION ALL
SELECT
  '30000000-0000-4000-8000-000000000004'::uuid,
  '20000000-0000-4000-8000-000000000001'::uuid,
  'PENDING',
  (now() AT TIME ZONE 'America/Fortaleza')::date + 1;

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  false
);

DO $$
DECLARE
  _billing_enabled boolean;
  _show_warning boolean;
BEGIN
  SELECT warning.billing_enabled, warning.show_overdue_warning
  INTO _billing_enabled, _show_warning
  FROM public.get_company_billing_overdue_warning(
    '20000000-0000-4000-8000-000000000001'
  ) AS warning;

  IF _billing_enabled IS DISTINCT FROM true
    OR _show_warning IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'Five-day/paid/cancelled/future fixture was misclassified';
  END IF;
END;
$$;

-- The exact six-day boundary qualifies for every supported open status.
DO $$
DECLARE
  _status text;
  _show_warning boolean;
BEGIN
  FOREACH _status IN ARRAY ARRAY[
    'PENDING',
    'OVERDUE',
    'DUNNING_REQUESTED',
    'AWAITING_RISK_ANALYSIS'
  ] LOOP
    UPDATE public.company_billing_invoices
    SET
      status = _status,
      due_date = (now() AT TIME ZONE 'America/Fortaleza')::date - 6
    WHERE id = '30000000-0000-4000-8000-000000000001';

    SELECT warning.show_overdue_warning
    INTO _show_warning
    FROM public.get_company_billing_overdue_warning(
      '20000000-0000-4000-8000-000000000001'
    ) AS warning;

    IF _show_warning IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Open status % failed at the six-day boundary', _status;
    END IF;
  END LOOP;
END;
$$;

-- Seven days remains eligible and an operator in the same company can read
-- only the two booleans returned by this RPC.
UPDATE public.company_billing_invoices
SET
  status = 'PENDING',
  due_date = (now() AT TIME ZONE 'America/Fortaleza')::date - 7
WHERE id = '30000000-0000-4000-8000-000000000001';

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  false
);

DO $$
DECLARE
  _billing_enabled boolean;
  _show_warning boolean;
BEGIN
  SELECT warning.billing_enabled, warning.show_overdue_warning
  INTO _billing_enabled, _show_warning
  FROM public.get_company_billing_overdue_warning(
    '20000000-0000-4000-8000-000000000001'
  ) AS warning;

  IF _billing_enabled IS DISTINCT FROM true
    OR _show_warning IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'Same-company operator did not receive the seven-day warning';
  END IF;
END;
$$;

-- A warning in company B must not affect company A after A's qualifying invoice
-- is paid. Company B's own operator can still read its warning.
UPDATE public.company_billing_invoices
SET status = 'RECEIVED'
WHERE id = '30000000-0000-4000-8000-000000000001';

INSERT INTO public.company_billing_invoices (id, company_id, status, due_date)
VALUES (
  '30000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000002',
  'OVERDUE',
  (now() AT TIME ZONE 'America/Fortaleza')::date - 7
);

DO $$
DECLARE
  _show_warning boolean;
BEGIN
  SELECT warning.show_overdue_warning
  INTO _show_warning
  FROM public.get_company_billing_overdue_warning(
    '20000000-0000-4000-8000-000000000001'
  ) AS warning;

  IF _show_warning IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Another company invoice leaked into company A warning';
  END IF;
END;
$$;

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000005',
  false
);

DO $$
DECLARE
  _show_warning boolean;
BEGIN
  SELECT warning.show_overdue_warning
  INTO _show_warning
  FROM public.get_company_billing_overdue_warning(
    '20000000-0000-4000-8000-000000000002'
  ) AS warning;

  IF _show_warning IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Company B operator should receive company B warning';
  END IF;
END;
$$;

-- Company-level and global rollout switches both fail closed, even with an old
-- open invoice present.
INSERT INTO public.company_billing_invoices (id, company_id, status, due_date)
VALUES (
  '30000000-0000-4000-8000-000000000006',
  '20000000-0000-4000-8000-000000000003',
  'PENDING',
  (now() AT TIME ZONE 'America/Fortaleza')::date - 7
);

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000006',
  false
);

DO $$
DECLARE
  _billing_enabled boolean;
  _show_warning boolean;
BEGIN
  SELECT warning.billing_enabled, warning.show_overdue_warning
  INTO _billing_enabled, _show_warning
  FROM public.get_company_billing_overdue_warning(
    '20000000-0000-4000-8000-000000000003'
  ) AS warning;

  IF _billing_enabled IS DISTINCT FROM false
    OR _show_warning IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'Company-disabled billing did not fail closed';
  END IF;
END;
$$;

UPDATE public.platform_billing_config
SET module_enabled = false
WHERE id = true;

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000005',
  false
);

DO $$
DECLARE
  _billing_enabled boolean;
  _show_warning boolean;
BEGIN
  SELECT warning.billing_enabled, warning.show_overdue_warning
  INTO _billing_enabled, _show_warning
  FROM public.get_company_billing_overdue_warning(
    '20000000-0000-4000-8000-000000000002'
  ) AS warning;

  IF _billing_enabled IS DISTINCT FROM false
    OR _show_warning IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'Globally disabled billing did not fail closed';
  END IF;
END;
$$;

-- Superadmins remain authorized, without bypassing the effective enablement
-- rule returned by the two booleans.
UPDATE public.platform_billing_config
SET module_enabled = true
WHERE id = true;

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  false
);

DO $$
DECLARE
  _billing_enabled boolean;
  _show_warning boolean;
BEGIN
  SELECT warning.billing_enabled, warning.show_overdue_warning
  INTO _billing_enabled, _show_warning
  FROM public.get_company_billing_overdue_warning(
    '20000000-0000-4000-8000-000000000002'
  ) AS warning;

  IF _billing_enabled IS DISTINCT FROM true
    OR _show_warning IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'Superadmin warning lookup returned an unexpected result';
  END IF;
END;
$$;

SELECT jsonb_build_object(
  'regression', 'ok',
  'result_columns', 2,
  'same_company_admin', true,
  'same_company_operator', true,
  'cross_company_denied', true,
  'six_day_boundary', true,
  'company_isolation', true,
  'rollout_gates', true
) AS company_billing_overdue_warning_regression;
