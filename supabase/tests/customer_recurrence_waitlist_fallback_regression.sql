-- PGlite regression harness.
-- The runner executes the bootstrap below, applies
-- 20260814120000_fix_customer_recurrence_waitlist_fallback.sql at the marker,
-- and then executes the fixtures and assertions after the marker.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT 'service_role'::text;
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT '00000000-0000-0000-0000-000000000001'::uuid;
$$;

CREATE OR REPLACE FUNCTION public.has_company_panel_permission(
  _user_id uuid,
  _company_id uuid,
  _permission text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT true;
$$;

CREATE OR REPLACE FUNCTION public.company_feature_enabled(
  _company_id uuid,
  _feature text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT true;
$$;

CREATE OR REPLACE FUNCTION public.normalize_whatsapp_phone(_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH digits AS (
    SELECT regexp_replace(COALESCE(_phone, ''), '\D', '', 'g') AS value
  )
  SELECT CASE
    WHEN value = '' THEN NULL
    WHEN value !~ '^55' AND length(value) <= 11 THEN '55' || value
    ELSE value
  END
  FROM digits;
$$;

CREATE TABLE public.reservations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  status text NOT NULL,
  guest_name text,
  guest_phone text,
  checked_in_at timestamptz,
  date date NOT NULL,
  time time NOT NULL DEFAULT '19:00',
  origin_waitlist_id uuid
);

CREATE TABLE public.reservation_companions (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id),
  name text,
  phone text,
  position integer NOT NULL DEFAULT 1
);

CREATE TABLE public.waitlist (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  status text NOT NULL,
  guest_name text,
  guest_phone text,
  created_at timestamptz NOT NULL,
  seated_at timestamptz
);

CREATE TABLE public.waitlist_companions (
  id uuid PRIMARY KEY,
  waitlist_id uuid NOT NULL REFERENCES public.waitlist(id),
  name text,
  phone text,
  position integer NOT NULL DEFAULT 1
);

-- @apply-migration

INSERT INTO public.waitlist (
  id, company_id, status, guest_name, guest_phone, created_at, seated_at
)
VALUES
  (
    '10000000-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'seated',
    'Queue Holder Checked',
    '(83) 99999-1001',
    '2026-08-01 19:00:00-03',
    '2026-08-01 20:00:00-03'
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'seated',
    'Queue Holder Cancelled',
    '(83) 99999-1002',
    '2026-08-02 19:00:00-03',
    '2026-08-02 20:00:00-03'
  ),
  (
    '10000000-0000-0000-0000-000000000003',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'seated',
    'Queue Holder No Show',
    '(83) 99999-1003',
    '2026-08-03 19:00:00-03',
    '2026-08-03 20:00:00-03'
  );

INSERT INTO public.reservations (
  id, company_id, status, guest_name, guest_phone, checked_in_at, date, time,
  origin_waitlist_id
)
VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'checked_in',
    'Reservation Holder Checked',
    '+55 83 99999-1001',
    '2026-08-01 21:00:00-03',
    '2026-08-01',
    '21:00',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'cancelled',
    'Reservation Holder Cancelled',
    '+55 83 99999-1002',
    NULL,
    '2026-08-02',
    '21:00',
    '10000000-0000-0000-0000-000000000002'
  ),
  (
    '20000000-0000-0000-0000-000000000003',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'no-show',
    'Reservation Holder No Show',
    '+55 83 99999-1003',
    NULL,
    '2026-08-03',
    '21:00',
    '10000000-0000-0000-0000-000000000003'
  );

INSERT INTO public.waitlist_companions (
  id, waitlist_id, name, phone, position
)
VALUES
  (
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Queue Companion Checked',
    '(83) 99999-2001',
    1
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    'Queue Companion Cancelled',
    '(83) 99999-2002',
    1
  ),
  (
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000003',
    'Queue Companion No Show',
    '(83) 99999-2003',
    1
  );

INSERT INTO public.reservation_companions (
  id, reservation_id, name, phone, position
)
VALUES
  (
    '40000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Reservation Companion Checked',
    '+55 83 99999-2001',
    1
  ),
  (
    '40000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    'Reservation Companion Cancelled',
    '+55 83 99999-2002',
    1
  ),
  (
    '40000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000003',
    'Reservation Companion No Show',
    '+55 83 99999-2003',
    1
  );

DO $regression$
DECLARE
  _holders jsonb;
  _with_companions jsonb;
  _customer jsonb;
BEGIN
  _holders := public.get_customer_recurrence_report(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    DATE '2026-08-01',
    DATE '2026-08-31',
    false,
    1,
    100,
    NULL,
    'previous_period'
  );

  IF (_holders #>> '{summary,identified_customers}')::integer <> 3
    OR (_holders #>> '{summary,period_visits}')::integer <> 3
    OR (_holders #>> '{summary,additional_visits}')::integer <> 0 THEN
    RAISE EXCEPTION 'holder summary mismatch: %', _holders -> 'summary';
  END IF;

  SELECT value
  INTO _customer
  FROM jsonb_array_elements(_holders -> 'customers')
  WHERE value ->> 'phone_normalized' = '1001';

  IF _customer ->> 'guest_name' <> 'Reservation Holder Checked' THEN
    RAISE EXCEPTION 'linked checked_in was not represented by reservation: %', _customer;
  END IF;

  SELECT value
  INTO _customer
  FROM jsonb_array_elements(_holders -> 'customers')
  WHERE value ->> 'phone_normalized' = '1002';

  IF _customer ->> 'guest_name' <> 'Queue Holder Cancelled' THEN
    RAISE EXCEPTION 'linked cancelled did not preserve waitlist visit: %', _customer;
  END IF;

  SELECT value
  INTO _customer
  FROM jsonb_array_elements(_holders -> 'customers')
  WHERE value ->> 'phone_normalized' = '1003';

  IF _customer ->> 'guest_name' <> 'Queue Holder No Show' THEN
    RAISE EXCEPTION 'linked no-show did not preserve waitlist visit: %', _customer;
  END IF;

  _with_companions := public.get_customer_recurrence_report(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    DATE '2026-08-01',
    DATE '2026-08-31',
    true,
    1,
    100,
    NULL,
    'previous_period'
  );

  IF (_with_companions #>> '{summary,identified_customers}')::integer <> 6
    OR (_with_companions #>> '{summary,period_visits}')::integer <> 6
    OR (_with_companions #>> '{summary,additional_visits}')::integer <> 0 THEN
    RAISE EXCEPTION 'companion summary mismatch: %', _with_companions -> 'summary';
  END IF;

  SELECT value
  INTO _customer
  FROM jsonb_array_elements(_with_companions -> 'customers')
  WHERE value ->> 'phone_normalized' = '2001';

  IF _customer ->> 'guest_name' <> 'Reservation Companion Checked' THEN
    RAISE EXCEPTION 'linked checked_in companion was not represented by reservation: %', _customer;
  END IF;

  SELECT value
  INTO _customer
  FROM jsonb_array_elements(_with_companions -> 'customers')
  WHERE value ->> 'phone_normalized' = '2002';

  IF _customer ->> 'guest_name' <> 'Queue Companion Cancelled' THEN
    RAISE EXCEPTION 'linked cancelled companion did not preserve waitlist visit: %', _customer;
  END IF;

  SELECT value
  INTO _customer
  FROM jsonb_array_elements(_with_companions -> 'customers')
  WHERE value ->> 'phone_normalized' = '2003';

  IF _customer ->> 'guest_name' <> 'Queue Companion No Show' THEN
    RAISE EXCEPTION 'linked no-show companion did not preserve waitlist visit: %', _customer;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(_with_companions -> 'customers')
    WHERE value -> 'guest_phone' <> 'null'::jsonb
      OR value ->> 'phone_normalized' !~ '^\d{4}$'
  ) THEN
    RAISE EXCEPTION 'privacy regression in customer rows';
  END IF;
END;
$regression$;

SELECT
  'ok'::text AS regression,
  3::integer AS holder_customers,
  3::integer AS holder_visits,
  6::integer AS customers_with_companions,
  6::integer AS visits_with_companions;
