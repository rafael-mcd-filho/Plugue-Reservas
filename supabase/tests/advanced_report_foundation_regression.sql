-- PGlite/PostgreSQL integration harness for the shared advanced-report foundation.
-- A runner executes this bootstrap, applies
-- 20260820130000_add_advanced_report_foundation.sql at the marker, then runs
-- the fixtures/assertions below it.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;

CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');
CREATE TABLE public.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  advanced_reports boolean NOT NULL DEFAULT true
);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _role = 'superadmin'
    AND _user_id = '00000000-0000-4000-8000-000000000001';
$$;
CREATE FUNCTION public.has_role_in_company(
  _user_id uuid,
  _role public.app_role,
  _company_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _role = 'admin'
    AND _user_id = '00000000-0000-4000-8000-000000000002'
    AND _company_id IN (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    );
$$;
CREATE FUNCTION public.company_feature_enabled(_company_id uuid, _feature text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _feature = 'advanced_reports' AND companies.advanced_reports
  FROM public.companies
  WHERE companies.id = _company_id;
$$;
CREATE FUNCTION public.test_assert(_condition boolean, _message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(_condition, false) THEN
    RAISE EXCEPTION '%', _message;
  END IF;
END;
$$;

-- __APPLY_ADVANCED_REPORT_FOUNDATION__

INSERT INTO public.companies(id, name, advanced_reports, time_zone) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Empresa A', true, 'America/Manaus'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Empresa B', true, 'America/Fortaleza'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Empresa C', false, 'America/Sao_Paulo');

SELECT public.test_assert(
  public._company_report_time_zone('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 'America/Manaus',
  'company timezone was not preserved'
);
SELECT public._validate_advanced_report_range('2026-01-01', '2026-12-31', 366);
DO $$
BEGIN
  BEGIN
    PERFORM public._validate_advanced_report_range('2025-01-01', '2026-01-02', 366);
    RAISE EXCEPTION 'oversized range unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    UPDATE public.companies
    SET time_zone = 'Fuso/Inexistente'
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'invalid timezone unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Service-role access is reserved for internal report functions/workers.
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT public._assert_company_advanced_report_access('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

-- Administrator of A succeeds for A.
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false);
SELECT public._assert_company_advanced_report_access('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

DO $$
BEGIN
  -- B has the feature, but this administrator has no B membership.
  BEGIN
    PERFORM public._assert_company_advanced_report_access(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    );
    RAISE EXCEPTION 'cross-tenant administrator unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- This administrator belongs to C, so the feature gate must deny it.
  BEGIN
    PERFORM public._assert_company_advanced_report_access(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    );
    RAISE EXCEPTION 'feature-disabled company unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

-- Operator is not an advanced-report administrator.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', false);
DO $$
BEGIN
  BEGIN
    PERFORM public._assert_company_advanced_report_access(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'operator unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

-- Superadmin succeeds for a company with the feature enabled.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false);
SELECT public._assert_company_advanced_report_access('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

-- Anonymous requests fail closed.
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claim.sub', '', false);
DO $$
BEGIN
  BEGIN
    PERFORM public._assert_company_advanced_report_access(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'anonymous access unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

SELECT public.test_assert(
  NOT has_function_privilege(
    'anon', 'public._assert_company_advanced_report_access(uuid)', 'EXECUTE'
  ),
  'anon can execute the private access gate'
);
SELECT public.test_assert(
  NOT has_function_privilege(
    'authenticated', 'public._assert_company_advanced_report_access(uuid)', 'EXECUTE'
  ),
  'authenticated can execute the private access gate directly'
);
SELECT public.test_assert(
  has_function_privilege(
    'service_role', 'public._assert_company_advanced_report_access(uuid)', 'EXECUTE'
  ),
  'service role cannot execute the private access gate'
);
SELECT public.test_assert(
  has_function_privilege(
    'authenticated', 'public._is_valid_iana_time_zone(text)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon', 'public._is_valid_iana_time_zone(text)', 'EXECUTE'
  ),
  'timezone validator grants are incorrect'
);
