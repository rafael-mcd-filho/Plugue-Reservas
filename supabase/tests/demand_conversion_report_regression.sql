-- PGlite/PostgreSQL integration harness for Demanda & Conversão.
-- The runner applies 20260820131000_add_demand_conversion_report.sql at the
-- marker below. The CONCURRENTLY index migration is checked separately.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;

CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'service_role');
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');
CREATE TABLE public.companies(
  id uuid PRIMARY KEY,
  name text NOT NULL,
  time_zone text NOT NULL DEFAULT 'America/Fortaleza',
  advanced_reports boolean NOT NULL DEFAULT true
);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _role = 'superadmin'
    AND _user_id = '00000000-0000-4000-8000-000000000001';
$$;
CREATE FUNCTION public.has_role_in_company(_user_id uuid, _role public.app_role, _company_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _role = 'admin'
    AND _user_id = '00000000-0000-4000-8000-000000000002'
    AND _company_id IN (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    );
$$;
CREATE FUNCTION public.company_feature_enabled(_company_id uuid, _feature text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _feature = 'advanced_reports' AND companies.advanced_reports
  FROM public.companies WHERE companies.id = _company_id;
$$;
CREATE FUNCTION public._assert_company_advanced_report_access(_company_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN; END IF;
  IF auth.role() <> 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autorizado.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_role(auth.uid(), 'superadmin')
    AND NOT public.has_role_in_company(auth.uid(), 'admin', _company_id) THEN
    RAISE EXCEPTION 'Apenas administradores.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.company_feature_enabled(_company_id, 'advanced_reports') THEN
    RAISE EXCEPTION 'Feature desativada.' USING ERRCODE = '42501';
  END IF;
END;
$$;
CREATE FUNCTION public._validate_advanced_report_range(_start date, _end date, _maximum integer DEFAULT 366)
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF _start IS NULL OR _end IS NULL OR _end < _start OR ((_end - _start) + 1) > _maximum THEN
    RAISE EXCEPTION 'Intervalo inválido.' USING ERRCODE = '22023';
  END IF;
END;
$$;
CREATE FUNCTION public._company_report_time_zone(_company_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT companies.time_zone FROM public.companies WHERE companies.id = _company_id;
$$;

CREATE TABLE public.tracking_events(
  company_id uuid NOT NULL,
  tracking_source text NOT NULL,
  event_name text NOT NULL
);
CREATE TABLE public.tracking_funnel_sessions(
  company_id uuid NOT NULL,
  session_id uuid NOT NULL,
  anonymous_id text,
  first_page_view_at timestamptz NOT NULL,
  date_selected_at timestamptz,
  time_selected_at timestamptz,
  form_filled_at timestamptz,
  completed_at timestamptz
);
CREATE TABLE public.tracking_funnel_projection_state(
  company_id uuid PRIMARY KEY,
  last_projected_at timestamptz,
  last_error text
);
CREATE FUNCTION public._tracking_funnel_company_read_model_ready(
  _company_id uuid,
  _required_until timestamptz
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT state.last_error IS NULL AND state.last_projected_at >= _required_until
    FROM public.tracking_funnel_projection_state state
    WHERE state.company_id = _company_id
  ), false);
$$;

CREATE TABLE public.reservations(
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  table_id uuid,
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  guest_email text,
  date date NOT NULL,
  time time NOT NULL,
  party_size integer NOT NULL,
  status text NOT NULL,
  source text,
  origin_affiliate_code text,
  origin_affiliate_name text,
  origin_waitlist_id uuid,
  origin_affiliate_link_id uuid,
  origin_tracking_session_id uuid,
  origin_anonymous_id text,
  attribution_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_in_at timestamptz,
  checked_in_party_size integer,
  occasion text,
  notes text,
  created_in_mode text,
  public_tracking_code text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE public.meta_event_queue(id integer PRIMARY KEY, marker text NOT NULL);
INSERT INTO public.meta_event_queue VALUES (1, 'intacto');

CREATE FUNCTION public.test_assert(_condition boolean, _message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(_condition, false) THEN RAISE EXCEPTION '%', _message; END IF;
END;
$$;

-- APPLY 20260820131000_add_demand_conversion_report.sql HERE

INSERT INTO public.companies(id, name, time_zone, advanced_reports) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Empresa Manaus', 'America/Manaus', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Sem recurso', 'America/Fortaleza', false),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Outro tenant', 'America/Fortaleza', true);

INSERT INTO public.tracking_funnel_projection_state VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-02 00:00+00', NULL);
INSERT INTO public.tracking_events VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'public', 'page_view');
INSERT INTO public.tracking_funnel_sessions VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '01000000-0000-4000-8000-000000000001', 'visitor-a', '2026-08-03 12:00+00', '2026-08-03 12:01+00', '2026-08-03 12:02+00', '2026-08-03 12:03+00', '2026-08-03 12:04+00'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '01000000-0000-4000-8000-000000000002', NULL, '2026-08-04 12:00+00', '2026-08-04 12:01+00', NULL, NULL, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '01000000-0000-4000-8000-000000000003', 'visitor-old', '2026-07-20 12:00+00', '2026-07-20 12:01+00', '2026-07-20 12:02+00', NULL, NULL);

-- Four explicit rows cover operational origin precedence and every group band.
INSERT INTO public.reservations(
  id, company_id, guest_name, guest_phone, date, time, party_size, status, source,
  origin_waitlist_id, origin_affiliate_link_id, origin_tracking_session_id,
  origin_anonymous_id, attribution_snapshot, public_tracking_code, created_at, updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Online', '55920001', '2026-08-10', '19:00', 2, 'confirmed', 'reservation', NULL, NULL, gen_random_uuid(), NULL, '{}', 'track-1', '2026-08-02 12:00+00', '2026-08-02 12:00+00'),
  ('10000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Afiliado', '55920002', '2026-08-10', '19:00', 4, 'confirmed', 'reservation', NULL, gen_random_uuid(), gen_random_uuid(), NULL, '{}', 'track-2', '2026-08-03 12:00+00', '2026-08-03 12:00+00'),
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Manual', '55920003', '2026-08-10', '19:00', 6, 'confirmed', 'panel', NULL, NULL, NULL, NULL, '{}', 'track-3', '2026-08-04 12:00+00', '2026-08-04 12:00+00'),
  ('10000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Fila', '55920004', '2026-08-10', '19:00', 8, 'confirmed', 'waitlist', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, '{}', 'track-4', '2026-08-05 12:00+00', '2026-08-05 12:00+00'),
  -- Manaus: 03:30Z ainda é 31/07 e precisa ficar fora de agosto.
  ('10000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Fora pelo fuso', '55920005', '2026-08-10', '19:00', 2, 'confirmed', 'panel', NULL, NULL, NULL, NULL, '{}', 'track-5', '2026-08-01 03:30+00', '2026-08-01 03:30+00');

-- More than 1,000 rows prove that server pagination is not truncated by the
-- default Supabase response ceiling.
INSERT INTO public.reservations(
  id, company_id, guest_name, guest_phone, date, time, party_size, status, source,
  attribution_snapshot, public_tracking_code, created_at, updated_at
)
SELECT
  ('30000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Cliente ' || series,
  '5592' || lpad(series::text, 8, '0'),
  '2026-08-20', '20:00', ((series - 1) % 8) + 1, 'confirmed', 'panel', '{}',
  'bulk-' || series,
  '2026-08-06 12:00+00'::timestamptz + series * interval '1 second',
  '2026-08-06 12:00+00'::timestamptz + series * interval '1 second'
FROM generate_series(1, 1001) AS series;

-- Same-duration comparison period (12/07–31/07).
INSERT INTO public.reservations(
  id, company_id, guest_name, guest_phone, date, time, party_size, status, source,
  attribution_snapshot, public_tracking_code, created_at, updated_at
) VALUES
  ('20000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Anterior', '55921001', '2026-07-25', '19:00', 3, 'confirmed', 'panel', '{}', 'old-1', '2026-07-20 12:00+00', '2026-07-20 12:00+00');

DO $$
DECLARE
  report jsonb;
  manual_report jsonb;
  caught_message text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SELECT public.get_demand_conversion_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20',
    false, true, 'day', 1, 15, NULL, 'all'
  ) INTO report;

  PERFORM public.test_assert((report #>> '{summary,sessions}')::integer = 2, 'funnel session total');
  PERFORM public.test_assert((report #>> '{summary,completed}')::integer = 1, 'funnel completed total');
  PERFORM public.test_assert(jsonb_array_length(report -> 'funnel') = 5, 'five funnel stages');
  PERFORM public.test_assert((report #>> '{meta,details_total}')::integer = 1005, 'timezone/current total');
  PERFORM public.test_assert(report #>> '{comparison,period_start}' = '2026-07-12', 'comparison start');
  PERFORM public.test_assert(report #>> '{comparison,period_end}' = '2026-07-31', 'comparison end');
  PERFORM public.test_assert((report #>> '{comparison,summary,created_reservations}')::integer = 2, 'comparison/timezone total');
  PERFORM public.test_assert(
    (SELECT sum((item ->> 'reservations')::integer) FROM jsonb_array_elements(report -> 'party_size_bands') item) = 1005,
    'party-size bands reconcile'
  );

  SELECT public.get_demand_conversion_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20',
    false, true, 'day', 1, 15, NULL, 'manual'
  ) INTO manual_report;
  PERFORM public.test_assert((manual_report #>> '{summary,created_reservations}')::integer = 1002, 'entry filter summary');
  PERFORM public.test_assert(
    (SELECT sum((item ->> 'created_reservations')::integer) FROM jsonb_array_elements(manual_report -> 'trend') item) = 1002,
    'entry filter trend'
  );
  PERFORM public.test_assert(
    (SELECT sum((item ->> 'reservations')::integer) FROM jsonb_array_elements(manual_report -> 'party_size_bands') item) = 1002,
    'entry filter group profile'
  );
  PERFORM public.test_assert((manual_report #>> '{summary,sessions}')::integer = 2, 'web funnel remains total');

  PERFORM public.test_assert(
    to_regprocedure('public.get_demand_conversion_export_page(uuid,date,date,integer,text,text,timestamptz,timestamptz,uuid)') IS NULL,
    'bulk export RPC must not be exposed'
  );

  INSERT INTO public.tracking_funnel_sessions VALUES (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '01000000-0000-4000-8000-000000000004',
    'visitor-a',
    '2026-08-05 12:00+00',
    '2026-08-05 12:10+00',
    '2026-08-05 12:20+00',
    '2026-08-05 12:30+00',
    '2026-08-05 12:40+00'
  );
  SELECT public.get_demand_conversion_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20',
    true, false, 'day', 1, 15, NULL, 'all'
  ) INTO report;
  PERFORM public.test_assert(
    (report #>> '{summary,sessions}')::integer = 2,
    'unique funnel counts must collapse repeated visitor sessions'
  );
  PERFORM public.test_assert(
    (SELECT (transition ->> 'sample_size')::integer = 3
      AND (transition ->> 'median_seconds')::integer = 60
     FROM jsonb_array_elements(report -> 'transition_times') AS transition
     WHERE transition ->> 'key' = 'page_to_date'),
    'unique visitor counts must not collapse timing samples from separate journeys'
  );

  UPDATE public.tracking_funnel_projection_state
  SET last_error = 'segredo interno do worker'
  WHERE company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  BEGIN
    PERFORM public.get_demand_conversion_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20'
    );
    RAISE EXCEPTION 'expected read-model readiness failure';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS caught_message = MESSAGE_TEXT;
    PERFORM public.test_assert(caught_message NOT LIKE '%segredo interno%', 'sanitized readiness error');
  END;
  UPDATE public.tracking_funnel_projection_state SET last_error = NULL
  WHERE company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  BEGIN
    PERFORM public.get_demand_conversion_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20',
      false, true, 'inválida'
    );
    RAISE EXCEPTION 'expected invalid granularity';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS caught_message = MESSAGE_TEXT;
    PERFORM public.test_assert(caught_message = 'Granularidade inválida.', 'UTF-8 error message');
  END;

  PERFORM public._validate_advanced_report_range('2025-08-20', '2026-08-20', 366);
  BEGIN
    PERFORM public._validate_advanced_report_range('2025-08-19', '2026-08-20', 366);
    RAISE EXCEPTION 'expected 367-day failure';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  PERFORM public.test_assert(
    (SELECT marker FROM public.meta_event_queue WHERE id = 1) = 'intacto',
    'Meta queue sentinel unchanged'
  );
  PERFORM public.test_assert(
    position('meta_event_queue' IN pg_get_functiondef(
      'public.get_demand_conversion_report(uuid,date,date,boolean,boolean,text,integer,integer,text,text)'::regprocedure
    )) = 0,
    'report is disconnected from Meta mapping'
  );
END;
$$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
  PERFORM public.get_demand_conversion_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20'
  );

  BEGIN
    PERFORM public.get_demand_conversion_report(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-08-01', '2026-08-20'
    );
    RAISE EXCEPTION 'expected feature denial';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_demand_conversion_report(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-08-01', '2026-08-20'
    );
    RAISE EXCEPTION 'expected cross-tenant denial with feature enabled';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
  BEGIN
    PERFORM public.get_demand_conversion_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20'
    );
    RAISE EXCEPTION 'expected operator denial';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
  PERFORM public.get_demand_conversion_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20'
  );

  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.get_demand_conversion_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', '2026-08-20'
    );
    RAISE EXCEPTION 'expected anonymous denial';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM public.test_assert(
    NOT has_function_privilege('anon',
      'public.get_demand_conversion_report(uuid,date,date,boolean,boolean,text,integer,integer,text,text)',
      'EXECUTE'),
    'anon must not execute report RPC'
  );
  PERFORM public.test_assert(
    NOT has_function_privilege('authenticated',
      'public._demand_conversion_entry_mode(text,uuid,uuid,uuid,text,jsonb)',
      'EXECUTE'),
    'authenticated must not execute private classifier'
  );
END;
$$;
