-- PGlite integration harness.
-- Runner order:
--   1. execute bootstrap before @apply-old-recurrence
--   2. apply 20260814120000_fix_customer_recurrence_waitlist_fallback.sql
--   3. execute fixtures before @apply-core-migration
--   4. apply 20260814130000_add_server_side_crm_leads_read_model.sql
--   5. apply 20260814140000_add_crm_leads_canonical_export.sql at
--      @apply-export-migration
--   6. apply 20260817120000_add_recurrence_minimum_visits_filter.sql at
--      @apply-recurrence-pagination-filter-migration
--   7. apply 20260817130000_remove_crm_report_pagination_ceiling.sql at
--      @apply-unbounded-pagination-migration
--   8. execute assertions, including recurrence compatibility checks

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
    _user_id = '00000000-0000-4000-8000-000000000001'::uuid
    AND _company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
    AND _permission = 'leads_view'
    AND COALESCE(current_setting('test.permission', true), 'on') <> 'off';
$$;

CREATE OR REPLACE FUNCTION public.company_feature_enabled(uuid, text)
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
  guest_email text,
  guest_birthdate date,
  checked_in_at timestamptz,
  date date NOT NULL,
  time time NOT NULL,
  party_size integer NOT NULL,
  checked_in_party_size integer,
  occasion text,
  origin_waitlist_id uuid,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.reservation_companions (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id),
  position integer NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  birthdate date,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.waitlist (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  status text NOT NULL,
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_birthdate date,
  seated_at timestamptz,
  created_at timestamptz NOT NULL,
  party_size integer NOT NULL,
  seated_party_size integer
);

CREATE TABLE public.waitlist_companions (
  id uuid PRIMARY KEY,
  waitlist_id uuid NOT NULL REFERENCES public.waitlist(id),
  position integer NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  birthdate date,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.crm_leads (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  full_name text NOT NULL,
  phone text,
  phone_normalized text,
  email text,
  email_normalized text,
  birthdate date,
  notes text,
  source text NOT NULL,
  import_filename text,
  imported_at timestamptz NOT NULL,
  imported_by_user_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('test.permission', 'on', false);

-- @apply-old-recurrence

INSERT INTO public.reservations (
  id, company_id, status, guest_name, guest_phone, guest_email,
  guest_birthdate, checked_in_at, date, time, party_size,
  checked_in_party_size, occasion, origin_waitlist_id, created_at
)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'checked_in',
    'Old Operational Name',
    '(83) 99999-1020',
    'old@example.com',
    '1990-08-10',
    '2026-08-02 02:30:00+00',
    '2026-08-01',
    '19:00',
    4,
    4,
    'Aniversario',
    NULL,
    '2026-07-01 12:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'completed',
    'New Operational Name',
    '+55 83 99999-1020',
    'new@example.com',
    '1990-08-10',
    NULL,
    '2026-08-01',
    '22:00',
    2,
    NULL,
    NULL,
    NULL,
    '2026-07-02 12:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'confirmed',
    'Confirmed Zero',
    '83999992003',
    NULL,
    NULL,
    NULL,
    '2026-08-10',
    '19:00',
    2,
    NULL,
    NULL,
    NULL,
    '2026-08-01 12:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cancelled',
    'Cancelled Zero',
    '83999992004',
    NULL,
    NULL,
    NULL,
    '2026-08-11',
    '19:00',
    2,
    NULL,
    NULL,
    NULL,
    '2026-08-01 12:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'no-show',
    'No Show Zero',
    '83999992005',
    NULL,
    NULL,
    NULL,
    '2026-08-12',
    '19:00',
    2,
    NULL,
    NULL,
    NULL,
    '2026-08-01 12:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'payment_expired',
    'Payment Zero',
    '83999992006',
    NULL,
    NULL,
    NULL,
    '2026-08-13',
    '19:00',
    2,
    NULL,
    NULL,
    NULL,
    '2026-08-01 12:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000007',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'checked_in',
    'Linked Checked',
    '83999993002',
    NULL,
    NULL,
    '2026-08-05 22:00:00-03',
    '2026-08-05',
    '21:00',
    3,
    3,
    NULL,
    '10000000-0000-4000-8000-000000000002',
    '2026-08-05 18:00:00-03'
  ),
  (
    '20000000-0000-4000-8000-000000000008',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cancelled',
    'Linked Cancelled',
    '83999993003',
    NULL,
    NULL,
    NULL,
    '2026-08-06',
    '21:00',
    2,
    NULL,
    NULL,
    '10000000-0000-4000-8000-000000000003',
    '2026-08-06 18:00:00-03'
  ),
  (
    '20000000-0000-4000-8000-000000000009',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'no-show',
    'Linked No Show',
    '83999993004',
    NULL,
    NULL,
    NULL,
    '2026-08-07',
    '21:00',
    2,
    NULL,
    NULL,
    '10000000-0000-4000-8000-000000000004',
    '2026-08-07 18:00:00-03'
  ),
  (
    '20000000-0000-4000-8000-000000000010',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'confirmed',
    'Operational Before Import',
    '83999992010',
    NULL,
    NULL,
    NULL,
    '2026-08-14',
    '19:00',
    2,
    NULL,
    NULL,
    NULL,
    '2026-08-01 12:00:00+00'
  );

INSERT INTO public.reservation_companions (
  id, reservation_id, position, name, phone, email, birthdate, created_at
)
VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    1,
    'Duplicate Same Phone',
    '+55 83 99999-1020',
    NULL,
    NULL,
    '2026-08-01 20:00:00-03'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    2,
    'Email Only Companion',
    NULL,
    'emailcomp@example.com',
    NULL,
    '2026-08-01 20:01:00-03'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000001',
    3,
    'Name Only Companion',
    NULL,
    NULL,
    NULL,
    '2026-08-01 20:02:00-03'
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000007',
    1,
    'Converted Companion',
    '83999994001',
    NULL,
    NULL,
    '2026-08-05 22:00:00-03'
  );

INSERT INTO public.waitlist (
  id, company_id, status, guest_name, guest_phone, guest_email,
  guest_birthdate, seated_at, created_at, party_size, seated_party_size
)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'seated',
    'Unlinked Queue',
    '83999993001',
    NULL,
    NULL,
    '2026-08-02 02:30:00+00',
    '2026-08-01 22:00:00+00',
    2,
    2
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'seated',
    'Ghost Suppressed Queue',
    '83999999998',
    NULL,
    NULL,
    '2026-08-05 21:30:00-03',
    '2026-08-05 18:00:00-03',
    3,
    3
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'seated',
    'Linked Cancelled Queue',
    '83999993003',
    NULL,
    NULL,
    '2026-08-06 20:00:00-03',
    '2026-08-06 18:00:00-03',
    2,
    2
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'seated',
    'Linked No Show Queue',
    '83999993004',
    NULL,
    NULL,
    NULL,
    '2026-08-07 20:00:00-03',
    2,
    2
  );

INSERT INTO public.waitlist_companions (
  id, waitlist_id, position, name, phone, email, birthdate, created_at
)
VALUES (
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  1,
  'Converted Companion Queue',
  '+55 83 99999-4001',
  NULL,
  NULL,
  '2026-08-05 21:30:00-03'
);

INSERT INTO public.crm_leads (
  id, company_id, full_name, phone, phone_normalized, email,
  email_normalized, birthdate, notes, source, import_filename,
  imported_at, imported_by_user_id, created_at, updated_at
)
VALUES
  (
    '60000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Imported Older Name',
    '83999991020',
    '83999991020',
    'imported-primary@example.com',
    'imported-primary@example.com',
    '1990-08-10',
    'Import matched by canonical phone',
    'import_csv',
    'primary.csv',
    '2026-06-01 12:00:00+00',
    '00000000-0000-4000-8000-000000000001',
    '2026-06-01 12:00:00+00',
    '2026-06-01 12:00:00+00'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Email Only Import',
    NULL,
    NULL,
    'only@example.com',
    'only@example.com',
    '1995-09-20',
    'No phone',
    'import_csv',
    'email-only.csv',
    '2026-06-02 12:00:00+00',
    '00000000-0000-4000-8000-000000000001',
    '2026-06-02 12:00:00+00',
    '2026-06-02 12:00:00+00'
  ),
  (
    '60000000-0000-4000-8000-000000000003',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Newest Imported Name',
    '+55 83 99999-2010',
    '5583999992010',
    'newest-import@example.com',
    'newest-import@example.com',
    NULL,
    'Newer than the operational profile',
    'import_csv',
    'newest.csv',
    '2026-09-01 12:00:00+00',
    '00000000-0000-4000-8000-000000000001',
    '2026-09-01 12:00:00+00',
    '2026-09-01 12:00:00+00'
  );

INSERT INTO public.reservations (
  id, company_id, status, guest_name, guest_phone, guest_email,
  guest_birthdate, checked_in_at, date, time, party_size,
  checked_in_party_size, occasion, origin_waitlist_id, created_at
)
SELECT
  (
    '50000000-0000-4000-8000-' || lpad(series.value::text, 12, '0')
  )::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'confirmed',
  'BulkTie ' || lpad(series.value::text, 3, '0'),
  '83' || lpad((900000000 + series.value)::text, 9, '0'),
  NULL,
  NULL,
  NULL,
  '2026-09-01',
  '19:00',
  2,
  NULL,
  NULL,
  NULL,
  '2026-08-05 02:30:00+00'
FROM generate_series(1, 101) AS series(value);

-- A dedicated company with more than 1,000 identified customers proves that
-- recurrence pagination can address rows beyond 1,000 inside the single JSON
-- value returned by the RPC. PostgREST's max_rows limit applies to top-level
-- result rows, not to this nested page. The first 1,005 customers have two
-- visits; the final seven have one.
INSERT INTO public.reservations (
  id, company_id, status, guest_name, guest_phone, guest_email,
  guest_birthdate, checked_in_at, date, time, party_size,
  checked_in_party_size, occasion, origin_waitlist_id, created_at
)
SELECT
  (
    '70000000-0000-4000-8000-' || lpad(series.value::text, 12, '0')
  )::uuid,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  'completed',
  'Scale Customer ' || lpad(series.value::text, 4, '0'),
  '84' || lpad((910000000 + series.value)::text, 9, '0'),
  NULL,
  NULL,
  NULL,
  '2026-08-10',
  '19:00',
  2,
  NULL,
  NULL,
  NULL,
  '2026-08-01 12:00:00+00'
FROM generate_series(1, 1012) AS series(value);

INSERT INTO public.reservations (
  id, company_id, status, guest_name, guest_phone, guest_email,
  guest_birthdate, checked_in_at, date, time, party_size,
  checked_in_party_size, occasion, origin_waitlist_id, created_at
)
SELECT
  (
    '71000000-0000-4000-8000-' || lpad(series.value::text, 12, '0')
  )::uuid,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  'completed',
  'Scale Customer ' || lpad(series.value::text, 4, '0'),
  '84' || lpad((910000000 + series.value)::text, 9, '0'),
  NULL,
  NULL,
  NULL,
  '2026-07-10',
  '19:00',
  2,
  NULL,
  NULL,
  NULL,
  '2026-07-01 12:00:00+00'
FROM generate_series(1, 1005) AS series(value);

-- @apply-core-migration

-- @apply-export-migration

-- @apply-recurrence-pagination-filter-migration

-- @apply-unbounded-pagination-migration

DO $regression$
DECLARE
  _page jsonb;
  _page_two jsonb;
  _history jsonb;
  _lead jsonb;
  _key text;
  _recurrence_page jsonb;
  _recurrence_next_page jsonb;
  _recurrence_filtered jsonb;
  _recurrence_compat jsonb;
  _recurrence_base jsonb;
  _export_page jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', false);
  PERFORM set_config('request.jwt.claim.sub', '', false);

  IF (
    SELECT count(*)
    FROM public.reservations
    WHERE company_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid
  ) <> 2017 THEN
    RAISE EXCEPTION 'scale fixture must stay above 1,000 source rows';
  END IF;

  -- Eight positional arguments exercise compatibility with clients deployed
  -- before min_total_visits existed. Only the nine-argument public signature
  -- must remain, so PostgREST has no overload ambiguity.
  _recurrence_compat := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    84, 12, NULL, 'previous_period'
  );
  _recurrence_page := _recurrence_compat;
  _recurrence_base := public._get_customer_recurrence_report_without_min_filter(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    84, 12, NULL, 'previous_period'
  );

  IF _recurrence_compat IS DISTINCT FROM jsonb_set(
      _recurrence_base,
      '{meta,min_total_visits}',
      'null'::jsonb,
      true
    ) THEN
    RAISE EXCEPTION 'null minimum changed the legacy report payload';
  END IF;

  IF (_recurrence_page #>> '{meta,customers_total}')::integer <> 1012
    OR (_recurrence_page #>> '{meta,filtered_customers_total}')::integer <> 1012
    OR (_recurrence_page #>> '{summary,identified_customers}')::integer <> 1012
    OR (_recurrence_page #>> '{meta,page}')::integer <> 84
    OR (_recurrence_page #>> '{meta,page_size}')::integer <> 12
    OR (_recurrence_page #> '{meta,min_total_visits}') IS DISTINCT FROM 'null'::jsonb
    OR jsonb_array_length(_recurrence_page -> 'customers') <> 12
    OR _recurrence_page #>> '{customers,0,customer_key}' <> 'customer:997'
    OR _recurrence_page #>> '{customers,11,customer_key}' <> 'customer:1008' THEN
    RAISE EXCEPTION 'recurrence page crossing row 1,000 mismatch: %',
      _recurrence_page -> 'meta';
  END IF;

  _recurrence_next_page := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    85, 12, NULL, 'previous_period', NULL
  );

  IF (_recurrence_next_page #>> '{meta,page}')::integer <> 85
    OR jsonb_array_length(_recurrence_next_page -> 'customers') <> 4
    OR _recurrence_next_page #>> '{customers,0,customer_key}' <> 'customer:1009'
    OR _recurrence_next_page #>> '{customers,3,customer_key}' <> 'customer:1012'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_recurrence_page -> 'customers') AS page_84
      JOIN jsonb_array_elements(_recurrence_next_page -> 'customers') AS page_85
        ON page_84 ->> 'customer_key' = page_85 ->> 'customer_key'
    ) THEN
    RAISE EXCEPTION 'recurrence pages after row 1,000 overlap or truncate: %, %',
      _recurrence_page -> 'meta', _recurrence_next_page -> 'meta';
  END IF;

  -- These are the same middle/last-page numbers visible in the production UI
  -- report that originally exposed the client-side pagination problem.
  _recurrence_filtered := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    28, 12, NULL, 'previous_period', 2
  );
  IF (_recurrence_filtered #>> '{meta,page}')::integer <> 28
    OR (_recurrence_filtered #>> '{meta,filtered_customers_total}')::integer <> 1005
    OR jsonb_array_length(_recurrence_filtered -> 'customers') <> 12
    OR _recurrence_filtered #>> '{customers,0,customer_key}' <> 'customer:325'
    OR _recurrence_filtered #>> '{customers,11,customer_key}' <> 'customer:336' THEN
    RAISE EXCEPTION 'recurrence filtered page 28 mismatch: %',
      _recurrence_filtered -> 'meta';
  END IF;

  _recurrence_next_page := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    31, 12, NULL, 'previous_period', NULL
  );
  IF (_recurrence_next_page #>> '{meta,page}')::integer <> 31
    OR jsonb_array_length(_recurrence_next_page -> 'customers') <> 12
    OR _recurrence_next_page #>> '{customers,0,customer_key}' <> 'customer:361'
    OR _recurrence_next_page #>> '{customers,11,customer_key}' <> 'customer:372' THEN
    RAISE EXCEPTION 'recurrence page 31 mismatch: %',
      _recurrence_next_page -> 'meta';
  END IF;

  _recurrence_filtered := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    84, 12, NULL, 'previous_period', 2
  );

  IF (_recurrence_filtered #>> '{meta,customers_total}')::integer <> 1012
    OR (_recurrence_filtered #>> '{meta,filtered_customers_total}')::integer <> 1005
    OR (_recurrence_filtered #>> '{meta,min_total_visits}')::integer <> 2
    OR (_recurrence_filtered #>> '{meta,page}')::integer <> 84
    OR jsonb_array_length(_recurrence_filtered -> 'customers') <> 9
    OR _recurrence_filtered #>> '{customers,0,customer_key}' <> 'customer:997'
    OR _recurrence_filtered #>> '{customers,8,customer_key}' <> 'customer:1005'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_recurrence_filtered -> 'customers') AS customer
      WHERE (customer ->> 'total_visits')::integer < 2
    ) THEN
    RAISE EXCEPTION 'minimum total visits filter/pagination mismatch: %',
      _recurrence_filtered;
  END IF;

  IF _recurrence_filtered -> 'summary' IS DISTINCT FROM _recurrence_page -> 'summary'
    OR _recurrence_filtered -> 'comparison' IS DISTINCT FROM _recurrence_page -> 'comparison'
    OR _recurrence_filtered -> 'frequency_bands' IS DISTINCT FROM _recurrence_page -> 'frequency_bands'
    OR _recurrence_filtered -> 'monthly_composition' IS DISTINCT FROM _recurrence_page -> 'monthly_composition' THEN
    RAISE EXCEPTION 'minimum visits filter unexpectedly changed aggregate sections';
  END IF;

  _recurrence_filtered := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    1, 12, 'Scale Customer 1010', 'previous_period', 2
  );
  IF (_recurrence_filtered #>> '{meta,filtered_customers_total}')::integer <> 0
    OR jsonb_array_length(_recurrence_filtered -> 'customers') <> 0 THEN
    RAISE EXCEPTION 'search and minimum visits must be combined with AND: %',
      _recurrence_filtered -> 'meta';
  END IF;

  FOREACH _key IN ARRAY ARRAY['0', '-1', '1000001']
  LOOP
    BEGIN
      PERFORM public.get_customer_recurrence_report(
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        DATE '2026-08-01', DATE '2026-08-13', false,
        1, 12, NULL, 'previous_period', _key::integer
      );
      RAISE EXCEPTION 'min_total_visits=% unexpectedly accepted', _key;
    EXCEPTION
      WHEN SQLSTATE '22023' THEN NULL;
    END;
  END LOOP;

  IF to_regprocedure(
      'public.get_customer_recurrence_report(uuid,date,date,boolean,integer,integer,text,text)'
    ) IS NOT NULL
    OR to_regprocedure(
      'public.get_customer_recurrence_report(uuid,date,date,boolean,integer,integer,text,text,integer)'
    ) IS NULL THEN
    RAISE EXCEPTION 'recurrence report overload rollout is ambiguous';
  END IF;

  -- The server-side Leads page also crosses PostgREST's usual 1,000-row
  -- boundary. Page 11 must expose positions 1,001-1,012 from the complete
  -- 1,012-profile dataset instead of truncating the source query.
  _page_two := public.get_crm_leads_page(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    10, 100, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  _page := public.get_crm_leads_page(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    11, 100, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );

  IF (_page #>> '{meta,total_leads}')::integer <> 1012
    OR (_page #>> '{meta,filtered_leads}')::integer <> 1012
    OR (_page #>> '{meta,total_canonical_visits}')::integer <> 2017
    OR (_page #>> '{meta,page}')::integer <> 11
    OR jsonb_array_length(_page -> 'leads') <> 12
    OR (
      SELECT count(*)
      FROM jsonb_array_elements(_page -> 'leads') AS lead
      WHERE (lead ->> 'canonical_visit_count')::integer = 2
    ) <> 5
    OR (
      SELECT count(*)
      FROM jsonb_array_elements(_page -> 'leads') AS lead
      WHERE (lead ->> 'canonical_visit_count')::integer = 1
    ) <> 7
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_page_two -> 'leads') AS page_10
      JOIN jsonb_array_elements(_page -> 'leads') AS page_11
        ON page_10 ->> 'customer_key' = page_11 ->> 'customer_key'
    ) THEN
    RAISE EXCEPTION 'leads page crossing row 1,000 mismatch: %', _page -> 'meta';
  END IF;

  -- Export pagination is independently server-side. Its page 11 crosses the
  -- same boundary while preserving all 2,017 canonical presence rows.
  _export_page := public.get_crm_leads_export_page(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    11, 100, NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF (_export_page #>> '{meta,page}')::integer <> 11
    OR (_export_page #>> '{meta,total_rows}')::integer <> 2017
    OR (_export_page #>> '{meta,total_pages}')::integer <> 21
    OR (_export_page #>> '{meta,filtered_leads}')::integer <> 1012
    OR (_export_page #>> '{meta,matched_visits}')::integer <> 2017
    OR (_export_page #>> '{meta,has_more}')::boolean IS DISTINCT FROM true
    OR jsonb_array_length(_export_page -> 'rows') <> 100
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_export_page -> 'rows') AS export_row
      WHERE export_row ->> 'row_kind' <> 'presence'
    ) THEN
    RAISE EXCEPTION 'export page crossing row 1,000 mismatch: %',
      _export_page -> 'meta';
  END IF;

  -- Page 10,001 used to be rejected even though it is a valid empty page.
  -- A much larger page also verifies that offset multiplication uses bigint.
  _page := public.get_crm_leads_page(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    30000000, 100, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF _page #>> '{meta,page}' <> '30000000'
    OR (_page #>> '{meta,total_leads}')::integer <> 1012
    OR jsonb_array_length(_page -> 'leads') <> 0 THEN
    RAISE EXCEPTION 'large Leads page was truncated or rejected: %', _page -> 'meta';
  END IF;

  _key := _page_two #>> '{leads,0,customer_key}';
  _history := public.get_crm_lead_presence_history(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', _key, 30000000, 100
  );
  IF _history #>> '{meta,page}' <> '30000000'
    OR (_history #>> '{meta,total_visits}')::integer <> 2
    OR jsonb_array_length(_history -> 'visits') <> 0 THEN
    RAISE EXCEPTION 'large presence-history page was truncated or rejected: %', _history -> 'meta';
  END IF;

  _recurrence_page := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    30000000, 12, NULL, 'previous_period', NULL
  );
  IF _recurrence_page #>> '{meta,page}' <> '30000000'
    OR (_recurrence_page #>> '{meta,customers_total}')::integer <> 1012
    OR jsonb_array_length(_recurrence_page -> 'customers') <> 0 THEN
    RAISE EXCEPTION 'large recurrence page was truncated or rejected: %',
      _recurrence_page -> 'meta';
  END IF;

  _recurrence_filtered := public.get_customer_recurrence_report(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    DATE '2026-08-01', DATE '2026-08-13', false,
    30000000, 12, NULL, 'previous_period', 2
  );
  IF _recurrence_filtered #>> '{meta,page}' <> '30000000'
    OR (_recurrence_filtered #>> '{meta,filtered_customers_total}')::integer <> 1005
    OR jsonb_array_length(_recurrence_filtered -> 'customers') <> 0 THEN
    RAISE EXCEPTION 'large filtered recurrence page was truncated or rejected: %',
      _recurrence_filtered -> 'meta';
  END IF;

  IF public._crm_state_name('PB') <> 'Paraíba'
    OR public._crm_state_name('SP') <> 'São Paulo' THEN
    RAISE EXCEPTION 'Brazilian state labels lost accents';
  END IF;

  _page := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 100, '999991020', NULL, NULL, NULL, NULL, NULL, NULL
  );

  IF (_page #>> '{meta,filtered_leads}')::integer <> 1 THEN
    RAISE EXCEPTION 'phone aliases/import did not collapse: %', _page -> 'meta';
  END IF;

  _lead := (_page -> 'leads') -> 0;
  _key := _lead ->> 'customer_key';

  IF _key <> 'phone:5583999991020'
    OR (_lead ->> 'canonical_visit_count')::integer <> 2
    OR _lead ->> 'latest_name' <> 'New Operational Name'
    OR _lead #>> '{crm_lead,id}' <> '60000000-0000-4000-8000-000000000001'
    OR _lead ->> 'state_name' <> 'Paraíba' THEN
    RAISE EXCEPTION 'primary profile mismatch: %', _lead;
  END IF;

  _history := public.get_crm_lead_presence_history(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', _key, 1, 100
  );

  IF (_history #>> '{meta,total_visits}')::integer <> 2
    OR jsonb_array_length(_history -> 'visits') <> 2
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_history -> 'visits') AS visit
      WHERE visit ->> 'date' = '2026-08-01'
        AND visit ->> 'time' LIKE '23:30:%'
    ) THEN
    RAISE EXCEPTION 'same-day/timezone history mismatch: %', _history;
  END IF;

  _page := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 25, 'only@example.com', NULL, NULL, NULL, NULL, NULL, NULL
  );
  _lead := (_page -> 'leads') -> 0;

  IF _lead ->> 'customer_key' <> 'email:only@example.com'
    OR (_lead ->> 'canonical_visit_count')::integer <> 0
    OR (_lead ->> 'is_import_only')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'email-only import mismatch: %', _lead;
  END IF;

  _history := public.get_crm_lead_presence_history(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'email:only@example.com',
    1,
    50
  );

  IF (_history #>> '{meta,total_visits}')::integer <> 0
    OR jsonb_array_length(_history -> 'visits') <> 0 THEN
    RAISE EXCEPTION 'import-only history should be empty: %', _history;
  END IF;

  _page := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 25, 'Newest Imported Name', NULL, NULL, NULL, NULL, NULL, NULL
  );
  _lead := (_page -> 'leads') -> 0;

  IF (_page #>> '{meta,filtered_leads}')::integer <> 1
    OR _lead ->> 'customer_key' <> 'phone:5583999992010'
    OR _lead ->> 'latest_name' <> 'Newest Imported Name'
    OR _lead ->> 'latest_email' <> 'newest-import@example.com'
    OR (_lead ->> 'is_import_only')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'newer imported profile did not win latest fields: %', _lead;
  END IF;

  _page := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 25, 'emailcomp@example.com', NULL, NULL, NULL, NULL, NULL, NULL
  );
  _lead := (_page -> 'leads') -> 0;

  IF _lead ->> 'customer_key' <> 'email:emailcomp@example.com'
    OR (_lead ->> 'canonical_visit_count')::integer <> 1
    OR _lead ->> 'source' <> 'reservation_companion' THEN
    RAISE EXCEPTION 'email-only companion mismatch: %', _lead;
  END IF;

  _history := public.get_crm_lead_presence_history(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'email:emailcomp@example.com',
    1,
    50
  );
  IF (_history #>> '{meta,total_visits}')::integer <> 1
    OR _history #>> '{visits,0,lead_source}' <> 'reservation_companion'
    OR _history #>> '{visits,0,visit_origin}' <> 'reservation' THEN
    RAISE EXCEPTION 'reservation companion history contract mismatch: %', _history;
  END IF;

  _page := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 25, 'Name Only Companion', NULL, NULL, NULL, NULL, NULL, NULL
  );
  _lead := (_page -> 'leads') -> 0;
  _key := _lead ->> 'customer_key';

  IF _key <> 'contact:reservation_companion:30000000-0000-4000-8000-000000000003'
    OR (_lead ->> 'canonical_visit_count')::integer <> 1 THEN
    RAISE EXCEPTION 'name-only companion mismatch: %', _lead;
  END IF;

  _history := public.get_crm_lead_presence_history(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', _key, 1, 50
  );
  IF (_history #>> '{meta,total_visits}')::integer <> 1 THEN
    RAISE EXCEPTION 'name-only history mismatch: %', _history;
  END IF;

  FOREACH _key IN ARRAY ARRAY[
    'Confirmed Zero',
    'Cancelled Zero',
    'No Show Zero',
    'Payment Zero'
  ]
  LOOP
    _page := public.get_crm_leads_page(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1, 25, _key, NULL, NULL, NULL, NULL, NULL, NULL
    );
    _lead := (_page -> 'leads') -> 0;

    IF (_page #>> '{meta,filtered_leads}')::integer <> 1
      OR (_lead ->> 'canonical_visit_count')::integer <> 0 THEN
      RAISE EXCEPTION 'non-presence lead missing/counting: %, %', _key, _page;
    END IF;
  END LOOP;

  FOREACH _key IN ARRAY ARRAY[
    'phone:5583999993001',
    'phone:5583999993002',
    'phone:5583999993003',
    'phone:5583999993004',
    'phone:5583999994001'
  ]
  LOOP
    _history := public.get_crm_lead_presence_history(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', _key, 1, 50
    );

    IF (_history #>> '{meta,total_visits}')::integer <> 1 THEN
      RAISE EXCEPTION 'waitlist linkage mismatch for %: %', _key, _history;
    END IF;
  END LOOP;

  _history := public.get_crm_lead_presence_history(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'phone:5583999993001',
    1,
    50
  );
  IF (_history #>> '{visits,0,date}') <> '2026-08-01' THEN
    RAISE EXCEPTION 'Fortaleza waitlist date mismatch: %', _history;
  END IF;

  _page := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 25, 'Ghost Suppressed Queue', NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF (_page #>> '{meta,filtered_leads}')::integer <> 0
    OR jsonb_array_length(_page -> 'leads') <> 0 THEN
    RAISE EXCEPTION 'suppressed linked-waitlist identity leaked as empty lead: %', _page;
  END IF;

  _page := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 100, 'BulkTie', DATE '2026-08-04', DATE '2026-08-04',
    'PB', NULL, 0, 0
  );
  _page_two := public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    2, 100, 'BulkTie', DATE '2026-08-04', DATE '2026-08-04',
    'PB', NULL, 0, 0
  );

  IF (_page #>> '{meta,filtered_leads}')::integer <> 101
    OR jsonb_array_length(_page -> 'leads') <> 100
    OR jsonb_array_length(_page_two -> 'leads') <> 1
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_page -> 'leads') AS first_page
      JOIN jsonb_array_elements(_page_two -> 'leads') AS second_page
        ON first_page ->> 'customer_key' = second_page ->> 'customer_key'
    ) THEN
    RAISE EXCEPTION 'stable pagination/filter mismatch: %, %',
      _page -> 'meta', _page_two -> 'meta';
  END IF;

  BEGIN
    PERFORM public.get_crm_leads_page(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1, 101, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'page_size=101 unexpectedly accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  IF has_function_privilege(
      'authenticated',
      'public._get_crm_contact_records(uuid)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public._get_crm_contact_records(uuid)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'service_role',
      'public._get_crm_contact_records(uuid)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'authenticated',
      'public._get_customer_canonical_visit_events(uuid,date,boolean)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public._get_customer_canonical_visit_events(uuid,date,boolean)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'service_role',
      'public._get_customer_canonical_visit_events(uuid,date,boolean)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'authenticated',
      'public._get_crm_lead_profiles(uuid)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public._get_crm_lead_profiles(uuid)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'service_role',
      'public._get_crm_lead_profiles(uuid)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'authenticated',
      'public._get_customer_recurrence_report_without_min_filter(uuid,date,date,boolean,integer,integer,text,text)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public._get_customer_recurrence_report_without_min_filter(uuid,date,date,boolean,integer,integer,text,text)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'service_role',
      'public._get_customer_recurrence_report_without_min_filter(uuid,date,date,boolean,integer,integer,text,text)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'internal helper leaked EXECUTE privilege';
  END IF;

  IF has_function_privilege(
      'anon',
      'public.get_crm_leads_page(uuid,integer,integer,text,date,date,text,integer,integer,integer)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public.get_crm_lead_presence_history(uuid,text,integer,integer)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public.get_customer_recurrence_report(uuid,date,date,boolean,integer,integer,text,text,integer)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.get_crm_leads_page(uuid,integer,integer,text,date,date,text,integer,integer,integer)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.get_crm_lead_presence_history(uuid,text,integer,integer)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.get_customer_recurrence_report(uuid,date,date,boolean,integer,integer,text,text,integer)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'service_role',
      'public.get_crm_leads_page(uuid,integer,integer,text,date,date,text,integer,integer,integer)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'service_role',
      'public.get_crm_lead_presence_history(uuid,text,integer,integer)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'service_role',
      'public.get_customer_recurrence_report(uuid,date,date,boolean,integer,integer,text,text,integer)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'public RPC grant matrix mismatch';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'anon', false);
  PERFORM set_config('request.jwt.claim.sub', '', false);
  BEGIN
    PERFORM public.get_crm_leads_page(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1, 25, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'anon unexpectedly authorized';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_customer_recurrence_report(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      DATE '2026-08-01', DATE '2026-08-13', false,
      1, 12, NULL, 'previous_period', 0
    );
    RAISE EXCEPTION 'anon unexpectedly reached minimum visits validation';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
  PERFORM set_config(
    'request.jwt.claim.sub',
    '00000000-0000-4000-8000-000000000001',
    false
  );
  PERFORM set_config('test.permission', 'off', false);
  BEGIN
    PERFORM public.get_crm_leads_page(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1, 25, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'authenticated without leads_view unexpectedly authorized';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('test.permission', 'on', false);
  PERFORM public.get_crm_leads_page(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1, 25, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );

  BEGIN
    PERFORM public.get_crm_leads_page(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1, 25, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'cross-company access unexpectedly authorized';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.role', 'service_role', false);
  PERFORM set_config('request.jwt.claim.sub', '', false);
END;
$regression$;

SELECT
  'ok'::text AS regression,
  101::integer AS paginated_tie_leads,
  2::integer AS same_day_visits,
  true AS identity_fallbacks_covered,
  true AS permission_matrix_covered;
