-- PGlite regression harness.
-- The runner executes the bootstrap below, applies
-- 20260814140000_add_crm_leads_canonical_export.sql at the marker,
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
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
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
  SELECT
    _user_id IS NOT NULL
    AND _company_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
    AND _permission = 'leads_view'
    AND COALESCE(current_setting('test.crm_permission', true), 'false') = 'true';
$$;

CREATE TABLE public.test_crm_lead_profiles (
  company_id uuid NOT NULL,
  customer_key text NOT NULL,
  identity_kind text NOT NULL,
  identity_value text NOT NULL,
  phone_normalized text,
  email_normalized text,
  display_phone text,
  latest_name text NOT NULL,
  latest_email text,
  latest_birthdate date,
  first_seen_at timestamptz NOT NULL,
  last_visit_date date,
  last_visit_time time,
  last_visit_at timestamptz,
  state_code text,
  state_name text,
  source text NOT NULL,
  canonical_visit_count integer NOT NULL,
  crm_lead_id uuid,
  crm_notes text,
  crm_imported_at timestamptz,
  crm_imported_by_user_id uuid,
  crm_import_filename text,
  is_import_only boolean NOT NULL
);

CREATE OR REPLACE FUNCTION public._get_crm_lead_profiles(_company_id uuid)
RETURNS TABLE (
  company_id uuid,
  customer_key text,
  identity_kind text,
  identity_value text,
  phone_normalized text,
  email_normalized text,
  display_phone text,
  latest_name text,
  latest_email text,
  latest_birthdate date,
  first_seen_at timestamptz,
  last_visit_date date,
  last_visit_time time,
  last_visit_at timestamptz,
  state_code text,
  state_name text,
  source text,
  canonical_visit_count integer,
  crm_lead_id uuid,
  crm_notes text,
  crm_imported_at timestamptz,
  crm_imported_by_user_id uuid,
  crm_import_filename text,
  is_import_only boolean
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT profiles.*
  FROM public.test_crm_lead_profiles AS profiles
  WHERE profiles.company_id = _company_id;
$$;

CREATE TABLE public.test_customer_canonical_visit_events (
  company_id uuid NOT NULL,
  customer_key text NOT NULL,
  identity_kind text NOT NULL,
  identity_value text NOT NULL,
  canonical_event_key text NOT NULL,
  contact_record_key text NOT NULL,
  visit_id uuid NOT NULL,
  contact_id uuid,
  visit_origin text NOT NULL,
  lead_source text NOT NULL,
  role_kind text NOT NULL,
  record_date date NOT NULL,
  record_time time NOT NULL,
  record_at timestamptz NOT NULL,
  presence_date date NOT NULL,
  presence_time time NOT NULL,
  presence_at timestamptz NOT NULL,
  contact_created_at timestamptz NOT NULL,
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_birthdate date,
  phone_normalized text,
  email_normalized text,
  party_size integer NOT NULL,
  status text NOT NULL,
  normalized_status text NOT NULL,
  occasion text,
  origin_waitlist_id uuid,
  came_from_waitlist boolean NOT NULL,
  reservation_holder_name text
);

CREATE OR REPLACE FUNCTION public._get_customer_canonical_visit_events(
  _company_id uuid,
  _through_date date DEFAULT NULL,
  _include_companions boolean DEFAULT true
)
RETURNS TABLE (
  company_id uuid,
  customer_key text,
  identity_kind text,
  identity_value text,
  canonical_event_key text,
  contact_record_key text,
  visit_id uuid,
  contact_id uuid,
  visit_origin text,
  lead_source text,
  role_kind text,
  record_date date,
  record_time time,
  record_at timestamptz,
  presence_date date,
  presence_time time,
  presence_at timestamptz,
  contact_created_at timestamptz,
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_birthdate date,
  phone_normalized text,
  email_normalized text,
  party_size integer,
  status text,
  normalized_status text,
  occasion text,
  origin_waitlist_id uuid,
  came_from_waitlist boolean,
  reservation_holder_name text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT events.*
  FROM public.test_customer_canonical_visit_events AS events
  WHERE events.company_id = _company_id
    AND (_through_date IS NULL OR events.presence_date <= _through_date)
    AND (_include_companions OR events.role_kind = 'holder');
$$;

-- @apply-migration

INSERT INTO public.test_crm_lead_profiles (
  company_id,
  customer_key,
  identity_kind,
  identity_value,
  phone_normalized,
  email_normalized,
  display_phone,
  latest_name,
  latest_email,
  latest_birthdate,
  first_seen_at,
  last_visit_date,
  last_visit_time,
  last_visit_at,
  state_code,
  state_name,
  source,
  canonical_visit_count,
  crm_lead_id,
  crm_notes,
  crm_imported_at,
  crm_imported_by_user_id,
  crm_import_filename,
  is_import_only
)
VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'phone:5583999991001',
    'phone',
    '5583999991001',
    '5583999991001',
    'holder@example.com',
    '(83) 99999-1001',
    'Canonical Holder',
    'holder@example.com',
    '1990-01-10',
    '2026-01-01 18:00:00-03',
    '2026-04-11',
    '20:00:00',
    '2026-04-11 20:00:00-03',
    'PB',
    'Paraiba',
    'reservation_holder',
    101,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    false
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'email:import@example.com',
    'email',
    'import@example.com',
    NULL,
    'import@example.com',
    NULL,
    'Imported Only',
    'import@example.com',
    '1994-05-18',
    '2026-08-02 02:30:00+00',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    'imported',
    0,
    '50000000-0000-0000-0000-000000000001',
    'Legacy base',
    '2026-08-02 02:30:00+00',
    NULL,
    'leads.csv',
    true
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'phone:5583999991003',
    'phone',
    '5583999991003',
    '5583999991003',
    NULL,
    '(83) 99999-1003',
    'Lead Without Presence',
    NULL,
    '1992-06-20',
    '2026-08-03 12:00:00-03',
    NULL,
    NULL,
    NULL,
    'PB',
    'Paraiba',
    'reservation_holder',
    0,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    false
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'phone:5585999999999',
    'phone',
    '5585999999999',
    '5585999999999',
    NULL,
    '(85) 99999-9999',
    'Other Company',
    NULL,
    NULL,
    '2026-01-01 12:00:00-03',
    '2026-01-01',
    '20:00:00',
    '2026-01-01 20:00:00-03',
    'CE',
    'Ceara',
    'reservation_holder',
    1,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    false
  );

INSERT INTO public.test_customer_canonical_visit_events (
  company_id,
  customer_key,
  identity_kind,
  identity_value,
  canonical_event_key,
  contact_record_key,
  visit_id,
  contact_id,
  visit_origin,
  lead_source,
  role_kind,
  record_date,
  record_time,
  record_at,
  presence_date,
  presence_time,
  presence_at,
  contact_created_at,
  guest_name,
  guest_phone,
  guest_email,
  guest_birthdate,
  phone_normalized,
  email_normalized,
  party_size,
  status,
  normalized_status,
  occasion,
  origin_waitlist_id,
  came_from_waitlist,
  reservation_holder_name
)
SELECT
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'phone:5583999991001',
  'phone',
  '5583999991001',
  'reservation:' || lpad(series.value::text, 12, '0'),
  'reservation-holder:' || lpad(series.value::text, 12, '0'),
  ('20000000-0000-0000-0000-' || lpad(series.value::text, 12, '0'))::uuid,
  NULL::uuid,
  'reservation',
  'reservation_holder',
  'holder',
  DATE '2026-01-01' + (series.value - 1),
  TIME '20:00:00',
  ((DATE '2026-01-01' + (series.value - 1) + TIME '20:00:00') AT TIME ZONE 'America/Fortaleza'),
  DATE '2026-01-01' + (series.value - 1),
  TIME '20:00:00',
  ((DATE '2026-01-01' + (series.value - 1) + TIME '20:00:00') AT TIME ZONE 'America/Fortaleza'),
  ((DATE '2025-12-01' + (series.value - 1) + TIME '12:00:00') AT TIME ZONE 'America/Fortaleza'),
  'Canonical Holder',
  '(83) 99999-1001',
  'holder@example.com',
  DATE '1990-01-10',
  '5583999991001',
  'holder@example.com',
  2,
  CASE WHEN series.value = 101 THEN 'completed' ELSE 'checked_in' END,
  'checked_in',
  NULL,
  NULL,
  false,
  'Canonical Holder'
FROM generate_series(1, 101) AS series(value);

INSERT INTO public.test_customer_canonical_visit_events (
  company_id,
  customer_key,
  identity_kind,
  identity_value,
  canonical_event_key,
  contact_record_key,
  visit_id,
  visit_origin,
  lead_source,
  role_kind,
  record_date,
  record_time,
  record_at,
  presence_date,
  presence_time,
  presence_at,
  contact_created_at,
  guest_name,
  guest_phone,
  phone_normalized,
  party_size,
  status,
  normalized_status,
  came_from_waitlist,
  reservation_holder_name
)
VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'phone:5585999999999',
  'phone',
  '5585999999999',
  'reservation:other-company',
  'reservation-holder:other-company',
  '60000000-0000-0000-0000-000000000001',
  'reservation',
  'reservation_holder',
  'holder',
  '2026-01-01',
  '20:00:00',
  '2026-01-01 20:00:00-03',
  '2026-01-01',
  '20:00:00',
  '2026-01-01 20:00:00-03',
  '2025-12-01 12:00:00-03',
  'Other Company',
  '(85) 99999-9999',
  '5585999999999',
  1,
  'checked_in',
  'checked_in',
  false,
  'Other Company'
);

DO $regression$
DECLARE
  _page_one jsonb;
  _page_two jsonb;
  _page_beyond jsonb;
  _filtered jsonb;
  _authorized jsonb;
  _row jsonb;
  _row_count integer;
  _distinct_row_count integer;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', false);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  PERFORM set_config('test.crm_permission', 'false', false);

  _page_one := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    100,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );
  _page_two := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    2,
    100,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

  IF jsonb_array_length(_page_one -> 'rows') <> 100
    OR jsonb_array_length(_page_two -> 'rows') <> 3
    OR (_page_one #>> '{meta,total_rows}')::integer <> 103
    OR (_page_one #>> '{meta,filtered_leads}')::integer <> 3
    OR (_page_one #>> '{meta,matched_visits}')::integer <> 101
    OR (_page_one #>> '{meta,total_pages}')::integer <> 2
    OR (_page_one #>> '{meta,has_more}')::boolean IS DISTINCT FROM true
    OR (_page_two #>> '{meta,total_rows}')::integer <> (_page_one #>> '{meta,total_rows}')::integer
    OR (_page_two #>> '{meta,filtered_leads}')::integer <> (_page_one #>> '{meta,filtered_leads}')::integer
    OR (_page_two #>> '{meta,matched_visits}')::integer <> (_page_one #>> '{meta,matched_visits}')::integer
    OR (_page_two #>> '{meta,has_more}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'full export pagination mismatch: %, %', _page_one -> 'meta', _page_two -> 'meta';
  END IF;

  SELECT
    count(*),
    count(DISTINCT rows.value ->> 'row_key')
  INTO _row_count, _distinct_row_count
  FROM (
    SELECT value FROM jsonb_array_elements(_page_one -> 'rows')
    UNION ALL
    SELECT value FROM jsonb_array_elements(_page_two -> 'rows')
  ) AS rows;

  IF _row_count <> 103 OR _distinct_row_count <> 103 THEN
    RAISE EXCEPTION 'rows were lost or duplicated across pages: %/%', _row_count, _distinct_row_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT value FROM jsonb_array_elements(_page_one -> 'rows')
      UNION ALL
      SELECT value FROM jsonb_array_elements(_page_two -> 'rows')
    ) AS rows
    WHERE rows.value ->> 'row_key' <> CASE rows.value ->> 'row_kind'
      WHEN 'presence' THEN
        'presence:' || (rows.value ->> 'customer_key') || ':' || (rows.value #>> '{visit,id}')
      ELSE
        'lead_only:' || (rows.value ->> 'customer_key')
    END
  ) THEN
    RAISE EXCEPTION 'row_key does not include both customer and canonical event';
  END IF;

  SELECT value
  INTO _row
  FROM jsonb_array_elements(_page_two -> 'rows')
  WHERE value ->> 'customer_key' = 'email:import@example.com';

  IF _row IS NULL
    OR _row ->> 'row_kind' <> 'lead_only'
    OR (_row ->> 'is_import_only')::boolean IS DISTINCT FROM true
    OR _row -> 'visit' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'import-only lead missing without visit filter: %', _row;
  END IF;

  SELECT value
  INTO _row
  FROM jsonb_array_elements(_page_two -> 'rows')
  WHERE value ->> 'customer_key' = 'phone:5583999991003';

  IF _row IS NULL
    OR _row ->> 'row_kind' <> 'lead_only'
    OR (_row ->> 'canonical_visit_count')::integer <> 0
    OR _row -> 'visit' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'zero-presence lead missing or leaked an operational status: %', _row;
  END IF;

  _filtered := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    100,
    NULL,
    NULL,
    NULL,
    NULL,
    DATE '2026-02-01',
    DATE '2026-02-01'
  );

  IF jsonb_array_length(_filtered -> 'rows') <> 1
    OR (_filtered #>> '{meta,total_rows}')::integer <> 1
    OR (_filtered #>> '{meta,filtered_leads}')::integer <> 1
    OR (_filtered #>> '{meta,matched_visits}')::integer <> 1
    OR (_filtered #>> '{meta,visit_filter_applied}')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'canonical visit range mismatch: %', _filtered;
  END IF;

  _row := _filtered #> '{rows,0}';
  IF _row ->> 'row_kind' <> 'presence'
    OR _row #>> '{visit,date}' <> '2026-02-01'
    OR (_row ->> 'matched_visit_count')::integer <> 1
    OR (_row ->> 'canonical_visit_count')::integer <> 101 THEN
    RAISE EXCEPTION 'filtered row did not preserve lifetime and matched totals: %', _row;
  END IF;

  _filtered := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    100,
    NULL,
    NULL,
    NULL,
    NULL,
    DATE '2027-01-01',
    DATE '2027-01-31'
  );

  IF jsonb_array_length(_filtered -> 'rows') <> 0
    OR (_filtered #>> '{meta,total_rows}')::integer <> 0
    OR (_filtered #>> '{meta,filtered_leads}')::integer <> 0 THEN
    RAISE EXCEPTION 'visit filter exported leads without a canonical presence: %', _filtered;
  END IF;

  -- 02:30Z on Aug 2 is still Aug 1 in America/Fortaleza.
  _filtered := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    100,
    DATE '2026-08-01',
    DATE '2026-08-01',
    NULL,
    NULL,
    NULL,
    NULL
  );

  IF jsonb_array_length(_filtered -> 'rows') <> 1
    OR _filtered #>> '{rows,0,customer_key}' <> 'email:import@example.com' THEN
    RAISE EXCEPTION 'created date did not use America/Fortaleza: %', _filtered;
  END IF;

  _filtered := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    100,
    NULL,
    NULL,
    'unknown',
    5,
    NULL,
    NULL
  );

  IF jsonb_array_length(_filtered -> 'rows') <> 1
    OR _filtered #>> '{rows,0,customer_key}' <> 'email:import@example.com' THEN
    RAISE EXCEPTION 'state/birthday filters mismatch: %', _filtered;
  END IF;

  _page_beyond := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    3,
    100,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

  IF jsonb_array_length(_page_beyond -> 'rows') <> 0
    OR (_page_beyond #>> '{meta,total_rows}')::integer <> 103
    OR (_page_beyond #>> '{meta,has_more}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'out-of-range page metadata mismatch: %', _page_beyond;
  END IF;

  BEGIN
    PERFORM public.get_crm_leads_export_page(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      1,
      100,
      NULL,
      NULL,
      'ZZ',
      NULL,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'invalid state code was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_crm_leads_export_page(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      1,
      101,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'page_size > 100 was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_crm_leads_export_page(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      1,
      100,
      NULL,
      NULL,
      NULL,
      NULL,
      DATE '2026-08-02',
      DATE '2026-08-01'
    );
    RAISE EXCEPTION 'invalid visit interval was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.role', 'anon', false);
  BEGIN
    PERFORM public.get_crm_leads_export_page(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      1,
      100,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'anonymous caller was accepted';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
  PERFORM set_config('test.crm_permission', 'false', false);
  BEGIN
    PERFORM public.get_crm_leads_export_page(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      1,
      100,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'authenticated caller without leads_view was accepted';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('test.crm_permission', 'true', false);
  _authorized := public.get_crm_leads_export_page(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    1,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

  IF jsonb_array_length(_authorized -> 'rows') <> 1 THEN
    RAISE EXCEPTION 'authorized caller could not export: %', _authorized;
  END IF;

  BEGIN
    PERFORM public.get_crm_leads_export_page(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      1,
      100,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'cross-company caller was accepted';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;

  IF has_function_privilege(
      'anon',
      'public.get_crm_leads_export_page(uuid,integer,integer,date,date,text,integer,date,date)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.get_crm_leads_export_page(uuid,integer,integer,date,date,text,integer,date,date)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'service_role',
      'public.get_crm_leads_export_page(uuid,integer,integer,date,date,text,integer,date,date)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'function grants mismatch';
  END IF;
END;
$regression$;

SELECT
  'ok'::text AS regression,
  3::integer AS exported_leads,
  101::integer AS canonical_visits,
  103::integer AS export_rows,
  2::integer AS export_pages;
