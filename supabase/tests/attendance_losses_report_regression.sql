-- PGlite/PostgreSQL harness.
-- O runner executa o bootstrap abaixo, aplica
-- 20260820132000_add_attendance_losses_report.sql no marcador e então executa
-- fixtures/assertions. As três migrations CONCURRENTLY são verificadas à parte.

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
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
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

CREATE TABLE public.reservations(
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  guest_email text,
  source text NOT NULL DEFAULT 'reservation',
  origin_affiliate_code text,
  origin_affiliate_name text,
  origin_affiliate_link_id uuid,
  origin_waitlist_id uuid,
  origin_tracking_session_id uuid,
  origin_anonymous_id text,
  attribution_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  date date NOT NULL,
  time time NOT NULL,
  party_size integer NOT NULL,
  status text NOT NULL,
  occasion text,
  notes text,
  checked_in_at timestamptz,
  checked_in_party_size integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  public_tracking_code text NOT NULL
);
CREATE TABLE public.reservation_audit_logs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL,
  company_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE TABLE public.whatsapp_message_logs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  reservation_id uuid,
  status text NOT NULL,
  type text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE public.pluguechat_message_logs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  reservation_id uuid,
  status text NOT NULL,
  type text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE public.reservation_payments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  paid_at timestamptz,
  status text NOT NULL
);

CREATE FUNCTION public.test_assert(_condition boolean, _message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(_condition, false) THEN RAISE EXCEPTION '%', _message; END IF;
END;
$$;

-- APPLY 20260820132000_add_attendance_losses_report.sql HERE

INSERT INTO public.companies(id, name, time_zone, advanced_reports) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Restaurante A', 'America/Manaus', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Restaurante B', 'America/Fortaleza', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Sem relatórios', 'America/Fortaleza', false),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Outro tenant', 'America/Fortaleza', true);

INSERT INTO public.reservations(
  id, company_id, guest_name, guest_phone, guest_email, source,
  origin_affiliate_link_id, origin_waitlist_id, origin_tracking_session_id,
  date, time, party_size, status, checked_in_at, checked_in_party_size,
  created_at, updated_at, public_tracking_code
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ana', '5592999990001', 'ana@example.com', 'reservation', NULL, NULL, gen_random_uuid(), '2026-08-10', '19:00', 4, 'checked_in', '2026-08-10 23:05+00', 3, '2026-08-01 12:00+00', '2026-08-10 23:05+00', 'track-1'),
  ('10000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bia', '5592999990002', NULL, 'reservation', gen_random_uuid(), NULL, NULL, '2026-08-11', '20:00', 2, 'no-show', NULL, NULL, '2026-08-09 12:00+00', '2026-08-12 01:00+00', 'track-2'),
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Caio', '5592999990003', NULL, 'waitlist', NULL, gen_random_uuid(), NULL, '2026-08-12', '21:00', 5, 'cancelled', NULL, NULL, '2026-08-01 12:00+00', '2026-08-12 00:00+00', 'track-3'),
  ('10000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Dani', '5592999990004', NULL, 'reservation', NULL, NULL, NULL, '2026-08-13', '18:00', 1, 'confirmed', NULL, NULL, '2026-08-13 12:00+00', '2026-08-13 12:00+00', 'track-4'),
  ('10000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Eva', '5592999990005', NULL, 'reservation', NULL, NULL, NULL, '2026-08-14', '22:30', 3, 'cancelled', NULL, NULL, '2026-08-10 12:00+00', '2026-08-13 12:00+00', 'track-5');

INSERT INTO public.whatsapp_message_logs(company_id, reservation_id, status, type, created_at) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 'sent', 'reminder_24h', '2026-08-09 20:00+00'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000002', 'failed', 'reminder_1h', '2026-08-11 22:00+00');
INSERT INTO public.pluguechat_message_logs(company_id, reservation_id, status, type, created_at) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000002', 'sent', 'reminder_1h', '2026-08-11 22:00+00');
INSERT INTO public.reservation_payments(company_id, reservation_id, paid_at, status) VALUES
  -- Pago antes do horário: conta como pré-pagamento.
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', '2026-08-02 12:00+00', 'paid'),
  -- Pago depois do horário reservado: não conta como pré-pagamento.
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000002', '2026-08-12 02:00+00', 'paid'),
  -- Estornado antes do horário: não permanece no grupo de pré-pagamento.
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000005', '2026-08-12 12:00+00', 'refunded');
INSERT INTO public.reservation_audit_logs(reservation_id, company_id, details, created_at) VALUES
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"changes":{"status":{"old":"confirmed","new":"cancelled"}}}', '2026-08-10 00:00+00'),
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"changes":{"status":{"old":"cancelled","new":"confirmed"}}}', '2026-08-11 00:00+00'),
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"changes":{"status":{"old":"confirmed","new":"cancelled"}}}', '2026-08-12 00:00+00');

DO $$
DECLARE
  report jsonb;
BEGIN
  report := public.get_attendance_losses_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-10', '2026-08-14',
    'all', 'all', 1, 2, NULL
  );

  PERFORM public.test_assert((report #>> '{summary,reservations}')::integer = 5, 'summary reservations');
  PERFORM public.test_assert((report #>> '{summary,attended}')::integer = 1, 'summary attended');
  PERFORM public.test_assert((report #>> '{summary,no_show}')::integer = 1, 'summary no-show');
  PERFORM public.test_assert((report #>> '{summary,cancelled}')::integer = 2, 'summary cancelled');
  PERFORM public.test_assert((report #>> '{summary,scheduled}')::integer = 1, 'summary scheduled');
  PERFORM public.test_assert((report #>> '{summary,attended_people}')::integer = 3, 'attended people uses checked-in count');
  PERFORM public.test_assert((report #>> '{summary,lost_people}')::integer = 10, 'lost people counts no-show and cancellations');
  PERFORM public.test_assert((report #>> '{summary,attendance_rate}')::numeric = 50.0, 'attendance rate denominator');
  PERFORM public.test_assert((report #>> '{meta,time_zone}') = 'America/Manaus', 'company timezone');
  PERFORM public.test_assert(jsonb_array_length(report -> 'reservations') = 2, 'server page size');
  PERFORM public.test_assert(jsonb_array_length(report #> '{segments,weekday}') = 7, 'weekday definitions');
  PERFORM public.test_assert(jsonb_array_length(report #> '{segments,entry_method}') = 4, 'entry method definitions');
  PERFORM public.test_assert((report #>> '{cancellation_curve,cancelled_with_audit}')::integer = 1, 'audit coverage');
  PERFORM public.test_assert((report #>> '{cancellation_curve,cancelled_total}')::integer = 2, 'all cancellations in curve');
  PERFORM public.test_assert((
    SELECT (bucket ->> 'reservations')::integer
    FROM jsonb_array_elements(report #> '{cancellation_curve,buckets}') bucket
    WHERE bucket ->> 'key' = '1_3d'
  ) = 1, 'curve uses the final cancellation transition');
  PERFORM public.test_assert((
    SELECT (bucket ->> 'reservations')::integer
    FROM jsonb_array_elements(report #> '{cancellation_curve,buckets}') bucket
    WHERE bucket ->> 'key' = '3d_plus'
  ) = 0, 'curve does not use an older cancelled state');
  PERFORM public.test_assert((report #>> '{associations,whatsapp,0,reservations}')::integer = 2, 'both WhatsApp providers combined');
  PERFORM public.test_assert((report #>> '{associations,prepayment,0,reservations}')::integer = 1, 'prepayment excludes payment after service and refunded payment');

  report := public.get_attendance_losses_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-10', '2026-08-14',
    'all', 'all', 1, 2, NULL, false
  );
  PERFORM public.test_assert(report -> 'comparison' = 'null'::jsonb, 'disabled comparison is not calculated or returned');
  PERFORM public.test_assert((report #>> '{meta,comparison_enabled}')::boolean = false, 'comparison flag is echoed');

  BEGIN
    PERFORM public.get_attendance_losses_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-01-01', '2026-01-02'
    );
    RAISE EXCEPTION 'Expected oversized range to fail';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;

SELECT public.test_assert(
  to_regprocedure('public.get_attendance_losses_export_batch(uuid,date,date,text,text,text,timestamptz,timestamptz,uuid,integer)') IS NULL,
  'bulk export RPC must not be exposed'
);

-- ACL: operador e empresa sem a feature falham fechados.
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.get_attendance_losses_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-10', '2026-08-14'
    );
    RAISE EXCEPTION 'Expected operator to fail';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.get_attendance_losses_report(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-08-10', '2026-08-14'
    );
    RAISE EXCEPTION 'Expected disabled feature to fail';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_attendance_losses_report(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2026-08-10', '2026-08-14'
    );
    RAISE EXCEPTION 'Expected cross-tenant access to fail';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

-- Superadmin autenticado pode consultar empresa com a feature ativa.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false);
SELECT public.get_attendance_losses_report(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-10', '2026-08-14'
);

-- Anônimo falha tanto no gate interno quanto na ACL de EXECUTE.
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claim.sub', '', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.get_attendance_losses_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-10', '2026-08-14'
    );
    RAISE EXCEPTION 'Expected anonymous access to fail';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

SELECT public.test_assert(
  NOT has_function_privilege(
    'anon',
    'public.get_attendance_losses_report(uuid,date,date,text,text,integer,integer,text,boolean)',
    'EXECUTE'
  ),
  'anon must not execute attendance report RPC'
);
