-- PGlite/PostgreSQL integration harness for Occupancy & Capacity.
--
-- A runner must execute the bootstrap below, then apply migrations
--   20260820130000_add_advanced_report_foundation.sql
--   20260820133000_add_occupancy_capacity_foundation.sql
-- at their markers, and finally execute the fixtures/assertions. Concurrent
-- index and pg_cron migrations are intentionally verified separately.

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
  status text NOT NULL DEFAULT 'active',
  reservation_duration integer NOT NULL DEFAULT 60,
  reservation_slot_interval_minutes integer NOT NULL DEFAULT 60,
  max_guests_per_slot integer,
  opening_hours jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE public.blocked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  date date NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  start_time time,
  end_time time
);
CREATE TABLE public.reservation_schedule_rule_slots (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL,
  block_id uuid,
  time time NOT NULL,
  duration_minutes integer,
  max_guests_per_slot integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.restaurant_tables (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  table_map_id uuid,
  number integer NOT NULL,
  section text NOT NULL,
  capacity integer NOT NULL,
  status text NOT NULL DEFAULT 'available'
);
CREATE TABLE public.table_sections (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY(company_id, code)
);
CREATE TABLE public.reservations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  guest_email text,
  date date NOT NULL,
  time time NOT NULL,
  party_size integer NOT NULL,
  status text NOT NULL,
  table_id uuid REFERENCES public.restaurant_tables(id) ON DELETE SET NULL,
  checked_in_at timestamptz,
  checked_in_party_size integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_in_mode text,
  public_tracking_code text
);
CREATE TABLE public.waitlist (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  party_size integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  seated_at timestamptz,
  expired_at timestamptz,
  removed_at timestamptz
);
CREATE TABLE public.reservation_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL,
  status text NOT NULL,
  expires_at timestamptz
);

CREATE FUNCTION public.is_reservation_occupying_capacity(
  _reservation_id uuid,
  _status text,
  _created_at timestamptz
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT
    lower(_status) NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
    AND (
      lower(_status) <> 'pending_payment'
      OR EXISTS (
        SELECT 1 FROM public.reservation_payments
        WHERE reservation_id = _reservation_id
          AND status IN ('awaiting_method', 'pending')
          AND expires_at > now()
      )
      OR (
        _created_at > now() - interval '2 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM public.reservation_payments WHERE reservation_id = _reservation_id
        )
      )
    );
$$;

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
    AND _company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
$$;
CREATE FUNCTION public.company_feature_enabled(_company_id uuid, _feature_key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _feature_key = 'advanced_reports'
    AND _company_id IS NOT NULL
    AND _company_id <> 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    AND COALESCE(current_setting('test.feature', true), 'on') <> 'off';
$$;
CREATE FUNCTION public.get_active_table_map(_company_id uuid, _at timestamptz)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE AS $$
  SELECT NULL::uuid, NULL::text WHERE false;
$$;
CREATE FUNCTION public.get_public_reservation_schedule(_company_id uuid, _date date)
RETURNS TABLE (
  source text,
  rule_id uuid,
  rule_name text,
  block_id uuid,
  block_name text,
  slots jsonb,
  max_party_size_per_reservation integer,
  availability_mode text,
  publish_at timestamptz,
  default_duration_minutes integer
)
LANGUAGE sql STABLE AS $$
  SELECT
    'weekly'::text,
    CASE WHEN EXTRACT(DAY FROM _date)::integer % 2 = 1
      THEN '11111111-1111-4111-8111-111111111111'::uuid
      ELSE '22222222-2222-4222-8222-222222222222'::uuid
    END,
    'Agenda',
    NULL::uuid,
    NULL::text,
    CASE WHEN _date = '2099-01-03'::date
      THEN '[]'::jsonb
      ELSE '["00:00", "19:00"]'::jsonb
    END,
    NULL::integer,
    CASE WHEN EXTRACT(DAY FROM _date)::integer % 2 = 1 THEN 'capacity' ELSE 'tables' END,
    NULL::timestamptz,
    60;
$$;
CREATE FUNCTION public.test_assert(_ok boolean, _message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(_ok, false) THEN RAISE EXCEPTION '%', _message; END IF;
END;
$$;

-- __APPLY_ADVANCED_REPORT_FOUNDATION__
-- __APPLY_OCCUPANCY_CAPACITY_FOUNDATION__

INSERT INTO public.companies(id, name, max_guests_per_slot) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A', 20),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'B', 20),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'C', 20);
INSERT INTO public.table_sections VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'salao', 'Salao');
INSERT INTO public.restaurant_tables VALUES
  ('30000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, 1, 'salao', 4, 'available'),
  ('30000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, 2, 'salao', 6, 'available'),
  ('30000000-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NULL, 99, 'privado', 8, 'available');
INSERT INTO public.reservation_schedule_rule_slots(
  id, rule_id, time, duration_minutes, max_guests_per_slot, sort_order
) VALUES
  ('40000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '00:00', 60, 30, 1),
  ('40000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '19:00', 60, 30, 2),
  ('40000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', '00:00', 60, NULL, 1),
  ('40000000-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', '19:00', 60, NULL, 2);

SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT public._capture_occupancy_capacity_snapshots(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02'
);
SELECT public.test_assert(
  (SELECT count(*) = 4 FROM public.occupancy_capacity_slot_snapshots
   WHERE company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'first capture did not freeze all future slots'
);
SELECT public._capture_occupancy_capacity_snapshots(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02'
);
SELECT public.test_assert(
  (SELECT count(*) = 4 FROM public.occupancy_capacity_slot_snapshots
   WHERE company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'idempotent capture appended unchanged versions'
);
UPDATE public.reservation_schedule_rule_slots
SET max_guests_per_slot = 35
WHERE id = '40000000-0000-4000-8000-000000000002';
SELECT public._capture_occupancy_capacity_snapshots(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01'
);
SELECT public.test_assert(
  (SELECT max(version) = 2 FROM public.occupancy_capacity_slot_snapshots
   WHERE company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     AND service_date = '2099-01-01' AND time_slot = '19:00'),
  'changed capacity did not append a version'
);

-- A slot that already started today must remain absent/frozen, never be
-- reconstructed from a midday configuration change.
DO $$
DECLARE local_today date := (clock_timestamp() AT TIME ZONE 'America/Fortaleza')::date;
BEGIN
  PERFORM public._capture_occupancy_capacity_snapshots(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', local_today, local_today
  );
  PERFORM public.test_assert(NOT EXISTS(
    SELECT 1 FROM public.occupancy_capacity_slot_snapshots
    WHERE company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND service_date = local_today AND time_slot = '00:00'
  ), 'started local slot was backfilled');
END;
$$;

INSERT INTO public.reservations(
  id, company_id, guest_name, guest_phone, date, time, party_size, status,
  table_id, checked_in_at, checked_in_party_size, created_at, created_in_mode, public_tracking_code
) VALUES
  ('50000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Capacidade', '5511', '2099-01-01', '19:00', 4, 'confirmed', NULL, NULL, NULL, '2026-01-01 12:00+00', 'capacity', 'a'),
  ('50000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Mesa', '5522', '2099-01-02', '19:00', 3, 'checked_in', '30000000-0000-4000-8000-000000000001', '2099-01-02 22:00+00', 3, '2026-01-01 12:00+00', 'tables', 'b'),
  ('50000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Sem mesa', '5533', '2099-01-02', '19:00', 2, 'no-show', '30000000-0000-4000-8000-000000000003', NULL, NULL, '2026-01-01 12:00+00', NULL, 'c'),
  ('50000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Sem slot', '5544', '2099-01-01', '18:00', 5, 'confirmed', NULL, NULL, NULL, '2026-01-01 12:00+00', 'capacity', 'd'),
  ('50000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Pagamento expirado', '5555', '2099-01-01', '19:00', 6, 'pending_payment', NULL, NULL, NULL, '2026-01-01 12:00+00', 'capacity', 'e');
INSERT INTO public.waitlist VALUES
  ('60000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 'seated', '2099-01-01 22:00+00', '2099-01-01 22:20+00', NULL, NULL),
  ('60000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3, 'removed', '2099-01-01 22:10+00', NULL, NULL, '2099-01-01 22:30+00');

SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'all'
  ) #>> '{meta,capacity_history}') = 'snapshot',
  'frozen report did not identify snapshot history'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'all'
  ) #>> '{summary,checked_in_people}')::integer = 3,
  'checked-in people metric is wrong'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'capacity', 'all'
  ) #>> '{summary,slot_count}')::integer = 2
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'capacity', 'all'
  ) #>> '{summary,capacity_slots}')::integer = 2
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'capacity', 'all'
  ) #>> '{summary,table_slots}')::integer = 0
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'capacity', 'all'
  ) #>> '{summary,reserved_people}')::integer = 4,
  'capacity mode did not filter the aggregate capacity and reservation facts'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'tables', 'all'
  ) #>> '{summary,slot_count}')::integer = 2
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'tables', 'all'
  ) #>> '{summary,capacity_slots}')::integer = 0
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'tables', 'all'
  ) #>> '{summary,table_slots}')::integer = 2
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'tables', 'all'
  ) #>> '{summary,checked_in_people}')::integer = 3,
  'tables mode did not filter the aggregate capacity and reservation facts'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'checked_in'
  ) #>> '{summary,reservations}')::integer = 3
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'checked_in'
  ) #>> '{meta,details_total}')::integer = 1,
  'list outcome filter leaked into aggregate metrics or did not filter details'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'all'
  ) #>> '{table_assignment,unassigned_reservations}')::integer = 1,
  'table assignment coverage did not preserve no-table bucket'
);
SELECT public.test_assert(
  jsonb_array_length(public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'all'
  ) -> 'table_breakdown') = 1,
  'table breakdown included rows without table_id or omitted assigned table'
);
SELECT public.test_assert(
  (SELECT detail -> 'table_id' = 'null'::jsonb
   FROM jsonb_array_elements(public.get_occupancy_capacity_report(
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
     'day', 1, 20, 'all', 'all'
   ) -> 'details') AS detail
   WHERE detail ->> 'id' = '50000000-0000-4000-8000-000000000003'),
  'a table belonging to another tenant leaked through the reservation join'
);
SELECT public.test_assert(
  (SELECT (hour_row ->> 'eligible_reservations')::integer = 2
      AND (hour_row ->> 'rate')::numeric = 50.0
   FROM jsonb_array_elements(public.get_occupancy_capacity_report(
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
     'day', 1, 20, 'all', 'all'
   ) -> 'no_show_by_hour') AS hour_row
   WHERE hour_row ->> 'hour' = '19:00:00'),
  'no-show rate denominator must include only checked-in and no-show outcomes'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'all'
  ) #>> '{summary,unmatched_reservations}')::integer = 1
  AND (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-02',
    'day', 1, 20, 'all', 'all'
  ) #>> '{summary,unmatched_people}')::integer = 5,
  'reservations without a published slot were not disclosed separately'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2098-12-30', '2098-12-30',
    'day', 1, 20, 'all', 'all'
  ) #>> '{meta,capacity_history}') = 'estimated_current_configuration',
  'pre-snapshot range was not marked estimated'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-03', '2099-01-03',
    'day', 1, 20, 'all', 'all'
  ) #>> '{meta,capacity_history}') = 'unavailable',
  'empty capacity base was mislabeled as a snapshot'
);

INSERT INTO public.occupancy_capacity_slot_snapshots(
  company_id, service_date, time_slot, version, is_published,
  availability_mode, published_capacity, duration_minutes,
  published_table_count, configuration_hash
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-04', '19:00', 1, true,
  'capacity', 0, 60, 0, 'zero-capacity'
);
SELECT public.test_assert(
  (public.get_occupancy_capacity_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-04', '2099-01-04',
    'day', 1, 20, 'all', 'all'
  ) #>> '{meta,capacity_history}') = 'unavailable',
  'a zero-capacity snapshot was presented as usable capacity history'
);

SELECT public.test_assert(
  to_regprocedure('public.get_occupancy_capacity_export_batch(uuid,date,date,text,text,date,time,uuid,integer)') IS NULL,
  'bulk export RPC must not be exposed'
);
SELECT public.test_assert(
  NOT has_function_privilege(
    'authenticated',
    'public.refresh_occupancy_capacity_snapshots(uuid,integer)',
    'EXECUTE'
  ),
  'interactive users can execute the mutating snapshot refresh'
);
SELECT public.test_assert(
  NOT has_table_privilege(
    'service_role',
    'public.occupancy_capacity_slot_snapshots',
    'DELETE'
  ),
  'service role can delete immutable capacity snapshots directly'
);

DO $$
BEGIN
  PERFORM set_config('test.feature', 'off', true);
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01'
    );
    RAISE EXCEPTION 'feature-disabled access unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
SELECT set_config('test.feature', 'on', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2099-01-01', '2099-01-01'
    );
    RAISE EXCEPTION 'cross-tenant access unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

-- Operador não pode abrir relatórios avançados.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01'
    );
    RAISE EXCEPTION 'operator access unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

-- Superadmin autenticado mantém acesso quando a feature da empresa está ativa.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false);
SELECT public.get_occupancy_capacity_report(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01'
);

-- Anônimo falha no gate interno e não recebe EXECUTE na RPC pública.
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claim.sub', '', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01'
    );
    RAISE EXCEPTION 'anonymous access unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
SELECT public.test_assert(
  NOT has_function_privilege(
    'anon',
    'public.get_occupancy_capacity_report(uuid,date,date,text,integer,integer,text,text)',
    'EXECUTE'
  ),
  'anon must not execute occupancy report RPC'
);

-- Retorna à identidade administrativa para validar parâmetros.
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2100-01-02'
    );
    RAISE EXCEPTION 'range longer than 366 days unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01',
      NULL, 1, 20, 'all', 'all'
    );
    RAISE EXCEPTION 'null granularity unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01',
      'day', 1, 20, NULL, 'all'
    );
    RAISE EXCEPTION 'null availability mode unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.get_occupancy_capacity_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2099-01-01', '2099-01-01',
      'day', 1, 20, 'all', NULL
    );
    RAISE EXCEPTION 'null outcome unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;

SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT public._run_occupancy_capacity_snapshot_pipeline(0, 1);
SELECT public._run_occupancy_capacity_snapshot_pipeline(0, 1);
SELECT public.test_assert(
  (SELECT last_company_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
   FROM public.occupancy_capacity_snapshot_pipeline_state WHERE singleton),
  'round-robin cursor starved companies after the first limit window'
);

DO $$
DECLARE
  pipeline_result jsonb;
BEGIN
  pipeline_result := public._run_occupancy_capacity_snapshot_pipeline(0, 100);
  PERFORM public.test_assert(
    NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(pipeline_result -> 'results') AS item
      WHERE item ->> 'company_id' = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ),
    'snapshot pipeline processed a company without advanced reports'
  );
  PERFORM public.test_assert(
    NOT EXISTS (
      SELECT 1
      FROM public.occupancy_capacity_slot_snapshots
      WHERE company_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ),
    'snapshot pipeline persisted capacity for a company without advanced reports'
  );
END;
$$;

SELECT public.test_assert(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('reservations', 'occupancy_capacity_slot_snapshots')
      AND column_name IN ('released_at', 'dwell_minutes', 'turnover_minutes')
  ),
  'report introduced forbidden dwell/turnover fields'
);
