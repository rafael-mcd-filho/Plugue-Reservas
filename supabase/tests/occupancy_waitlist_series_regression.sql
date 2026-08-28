-- PGlite/PostgreSQL integration harness for the event-time waitlist series.
--
-- A runner must execute the bootstrap below, then apply migrations
--   20260820130000_add_advanced_report_foundation.sql
--   20260827110000_expand_occupancy_temporal_analysis.sql
-- at their markers before executing the fixtures/assertions. Concurrent index
-- migrations are loaded as regular indexes by the PGlite runner, which also
-- verifies that every timestamp branch can select its intended index.

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
CREATE TABLE public.waitlist (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  party_size integer NOT NULL,
  seated_party_size integer,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  seated_at timestamptz,
  expired_at timestamptz,
  removed_at timestamptz
);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT false;
$$;
CREATE FUNCTION public.has_role_in_company(
  _user_id uuid,
  _role public.app_role,
  _company_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT false;
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
-- __APPLY_OCCUPANCY_WAITLIST_SERIES__

INSERT INTO public.companies(id, name, advanced_reports, time_zone) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Empresa Manaus', true, 'America/Manaus'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Outro tenant', true, 'America/Fortaleza');

-- The two timestamps on rows 2 and 3 intentionally fall on different local
-- days. Their current status chooses exactly one canonical dropped event.
-- Rows 4 and 5 preserve the fallback behavior for historical incomplete data.
INSERT INTO public.waitlist(
  id, company_id, party_size, seated_party_size, status, created_at,
  seated_at, expired_at, removed_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 3, 'seated',
   '2026-08-01 04:10+00', '2026-08-01 04:40+00', NULL, NULL),
  ('10000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4, NULL, 'expired',
   '2026-08-01 04:15+00', NULL, '2026-08-01 05:00+00', '2026-08-02 05:00+00'),
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 6, NULL, 'removed',
   '2026-08-01 04:20+00', NULL, '2026-08-01 06:00+00', '2026-08-02 06:00+00'),
  ('10000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, NULL, 'expired',
   '2026-08-01 04:25+00', NULL, NULL, '2026-08-01 07:00+00'),
  ('10000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 7, NULL, 'removed',
   '2026-08-01 04:30+00', NULL, '2026-08-02 07:00+00', NULL),
  ('10000000-0000-4000-8000-000000000006', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 8, NULL, 'removed',
   '2026-08-01 04:35+00', NULL, NULL, NULL),
  ('20000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 99, NULL, 'expired',
   '2026-08-01 12:00+00', NULL, '2026-08-01 13:00+00', NULL);

DO $$
DECLARE
  report jsonb;
  day_one jsonb;
  day_two jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  SELECT public.get_occupancy_waitlist_series(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2026-08-01',
    '2026-08-02',
    'day'
  ) INTO report;

  SELECT item INTO day_one
  FROM jsonb_array_elements(report -> 'series') AS item
  WHERE item ->> 'period' = '2026-08-01';

  SELECT item INTO day_two
  FROM jsonb_array_elements(report -> 'series') AS item
  WHERE item ->> 'period' = '2026-08-02';

  PERFORM public.test_assert(
    (day_one ->> 'dropped')::integer = 2
      AND (day_one ->> 'dropped_people')::integer = 9,
    'expired primary/fallback events were duplicated or assigned to the wrong day'
  );
  PERFORM public.test_assert(
    (day_two ->> 'dropped')::integer = 2
      AND (day_two ->> 'dropped_people')::integer = 13,
    'removed primary/fallback events were duplicated or assigned to the wrong day'
  );
  PERFORM public.test_assert(
    (day_one ->> 'seated')::integer = 1
      AND (day_one ->> 'seated_people')::integer = 3
      AND (day_one ->> 'average_wait_minutes')::numeric = 30.0,
    'seated event timestamp, people fallback, or wait time is wrong'
  );
  PERFORM public.test_assert(
    (SELECT sum((item ->> 'dropped')::integer)
     FROM jsonb_array_elements(report -> 'series') AS item) = 4,
    'a waitlist row generated more than one dropped event'
  );
  PERFORM public.test_assert(
    report #>> '{meta,time_zone}' = 'America/Manaus'
      AND report #>> '{meta,event_semantics}' = 'event_timestamp',
    'company timezone or event-time contract was not preserved'
  );
END;
$$;

SELECT public.test_assert(
  NOT has_function_privilege(
    'anon',
    'public.get_occupancy_waitlist_series(uuid,date,date,text)',
    'EXECUTE'
  ),
  'anonymous role can execute the occupancy waitlist series'
);
