-- PGlite regression harness for the async company-deletion pipeline.
--
-- Run with `node supabase/tests/run_company_deletion_regression.mjs`.
-- The runner applies the original migrations at the first marker, reproduces
-- the tracking FK/index failure, then applies the repair at the second marker.
-- All database state and external-service stubs are ephemeral. No production
-- data or network services are used.
--
-- This replaces the old harness for the retired synchronous
-- delete_company_permanently (see docs/problema-exclusao-empresas.md for why
-- that approach was superseded).

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

CREATE TABLE auth.users (id uuid PRIMARY KEY);

-- pg_net and pg_cron are real Supabase-hosted extensions, not available in
-- this ephemeral harness. Both are stubbed with the minimal surface the
-- migrations under test actually call, so the real migration files can be
-- pasted in verbatim at the marker.
CREATE SCHEMA net;
CREATE TABLE net.http_post_calls (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb,
  body jsonb,
  called_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO net.http_post_calls (url, headers, body) VALUES (url, headers, body)
  RETURNING id;
$$;

CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
CREATE OR REPLACE FUNCTION cron.schedule(jobname text, schedule text, command text)
RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (jobname, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$$;
CREATE OR REPLACE FUNCTION cron.unschedule(jobid bigint)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM cron.job WHERE cron.job.jobid = unschedule.jobid;
$$;

CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');

CREATE TABLE public.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL
);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles role_row
    WHERE role_row.user_id = _user_id AND role_row.role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.has_role_in_company(_user_id uuid, _role public.app_role, _company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles role_row
    WHERE role_row.user_id = _user_id AND role_row.role = _role AND role_row.company_id = _company_id
  );
$$;

CREATE TABLE public.system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.system_settings (key, value) VALUES ('internal_job_secret', 'test-secret');

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  details jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Representative subset of the real 58-table phase list -- enough to prove
-- batching/resumability/backoff/teardown-ordering. company_whatsapp_instances
-- and waitlist are deliberately NOT added to company_deletion_phase_order
-- below: the former proves the teardown lookup handles "no instance"
-- gracefully, the latter proves the final cascade still cleans up a table
-- the manual list forgot (the pipeline's documented safety property).
CREATE TABLE public.reservations (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE);
CREATE TABLE public.tracking_sessions (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE);
CREATE TABLE public.tracking_journeys (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE, session_id uuid REFERENCES public.tracking_sessions(id) ON DELETE SET NULL);
CREATE TABLE public.tracking_events (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE, session_id uuid REFERENCES public.tracking_sessions(id) ON DELETE SET NULL, journey_id uuid REFERENCES public.tracking_journeys(id) ON DELETE SET NULL);
CREATE TABLE public.meta_event_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  journey_id uuid REFERENCES public.tracking_journeys(id) ON DELETE SET NULL,
  tracking_event_id uuid REFERENCES public.tracking_events(id) ON DELETE SET NULL,
  event_name text NOT NULL,
  meta_event_name text NOT NULL
);
CREATE UNIQUE INDEX idx_meta_event_queue_reservation_event_unique
ON public.meta_event_queue(reservation_id, event_name);
CREATE UNIQUE INDEX idx_meta_event_queue_tracking_event_unique
ON public.meta_event_queue(tracking_event_id, event_name);
CREATE TABLE public.meta_event_attempts (
  id uuid PRIMARY KEY,
  queue_id uuid NOT NULL REFERENCES public.meta_event_queue(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL
);
CREATE TABLE public.waitlist (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE);
CREATE TABLE public.company_whatsapp_instances (company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE, instance_name text, status text);

-- @apply-migration

-- Keep the real dependency order for this representative schema while
-- avoiding unrelated empty table definitions in a focused regression.
DELETE FROM public.company_deletion_phase_order WHERE phase_index > 3;
INSERT INTO public.company_deletion_phase_order (phase_index, table_name) VALUES
  (4, 'tracking_journeys'), (5, 'tracking_sessions'), (6, 'reservations');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc function_meta
    WHERE function_meta.oid = 'public._process_company_deletion_batch(uuid, integer)'::regprocedure
      AND function_meta.prosecdef
  ) THEN
    RAISE EXCEPTION '_process_company_deletion_batch must exist and be SECURITY DEFINER';
  END IF;

  IF has_function_privilege('authenticated', 'public._process_company_deletion_batch(uuid, integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.request_company_deletion(uuid, text, text)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.request_company_deletion(uuid, text, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Unexpected deletion pipeline ACL';
  END IF;
END;
$$;

UPDATE public.system_settings SET value = 'true' WHERE key = 'company_deletion_pipeline_enabled';

INSERT INTO public.companies (id, name, slug) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Empresa alvo', 'empresa-alvo'),
  ('20000000-0000-4000-8000-000000000002', 'Empresa preservada', 'empresa-preservada'),
  ('20000000-0000-4000-8000-000000000003', 'Empresa travada', 'empresa-travada');

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002');

INSERT INTO public.user_roles (user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', 'superadmin'),
  ('10000000-0000-4000-8000-000000000002', 'admin');

INSERT INTO public.reservations (id, company_id) VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');

INSERT INTO public.tracking_sessions (id, company_id) VALUES
  ('31000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');

-- 5 tracking_events rows, batched 2-at-a-time below, to exercise multi-tick
-- draining of a single phase before it advances.
INSERT INTO public.tracking_events (id, company_id, session_id)
SELECT ('33000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
       '20000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001'
FROM generate_series(1, 5) AS series;

INSERT INTO public.meta_event_queue (id, company_id, event_name, meta_event_name) VALUES
  ('34000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'page_view', 'PageView');
INSERT INTO public.meta_event_attempts (id, queue_id, company_id) VALUES
  ('35000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');
INSERT INTO public.waitlist (id, company_id) VALUES
  ('38000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');

-- Repeated tracking PageViews linked to a reservation are valid after the
-- September Meta queue migration. Deleting their source events first changes
-- tracking_event_id to NULL, bringing both queue rows into the partial unique
-- index and reproducing the production 23505 failure.
INSERT INTO public.reservations (id, company_id) VALUES
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003');
INSERT INTO public.tracking_events (id, company_id) VALUES
  ('33000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000003'),
  ('33000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000003'),
  ('33000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000003'),
  ('33000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000002');
INSERT INTO public.meta_event_queue (id, company_id, reservation_id, tracking_event_id, event_name, meta_event_name) VALUES
  ('34000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000011', 'page_view', 'PageView'),
  ('34000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000012', 'page_view', 'PageView'),
  ('34000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000020', 'page_view', 'PageView');
INSERT INTO public.meta_event_attempts (id, queue_id, company_id) VALUES
  ('35000000-0000-4000-8000-000000000011', '34000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000003');

SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
DO $$
DECLARE
  _request_id uuid;
  _tick jsonb;
  _iteration integer;
BEGIN
  _request_id := (public.request_company_deletion(
    '20000000-0000-4000-8000-000000000003', 'Empresa travada', 'reproduzir falha de exclusao'
  ) ->> 'request_id')::uuid;
  UPDATE public.company_deletion_requests
  SET grace_period_ends_at = now() - interval '1 minute'
  WHERE id = _request_id;

  -- A first successful batch gives this request real progress to preserve.
  _tick := public._process_company_deletion_batch(_request_id, 1);
  IF (_tick ->> 'deleted_this_tick')::integer <> 1 THEN
    RAISE EXCEPTION 'Initial tracking batch did not establish partial progress: %', _tick;
  END IF;

  FOR _iteration IN 1..10 LOOP
    _tick := public._process_company_deletion_batch(_request_id, 2);
    IF _tick ->> 'sqlstate' <> '23505'
      OR strpos(_tick ->> 'error', 'idx_meta_event_queue_reservation_event_unique') = 0 THEN
      RAISE EXCEPTION 'Original pipeline did not reproduce the queue index failure: %', _tick;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_deletion_requests
    WHERE id = _request_id AND status = 'needs_attention' AND phase_index = 1
      AND phase = 'tracking_events' AND consecutive_errors = 10
      AND (deleted_counts ->> 'tracking_events')::integer = 1
  ) THEN
    RAISE EXCEPTION 'Original pipeline did not retain the failed request and partial counters';
  END IF;
  IF (SELECT count(*) FROM public.tracking_events WHERE company_id = '20000000-0000-4000-8000-000000000003') <> 2 THEN
    RAISE EXCEPTION 'Failed tracking batch was not rolled back';
  END IF;
END;
$$;

-- Requests already past individual first-three phases must safely revisit
-- the queue, while later phases and unrelated failures retain their state.
INSERT INTO public.companies (id, name, slug)
SELECT ('22000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'Empresa matriz ' || series, 'empresa-matriz-' || series
FROM generate_series(1, 6) AS series;
INSERT INTO public.company_deletion_requests (
  company_id, company_name_snapshot, company_slug_snapshot, requested_by,
  requested_reason, confirmation_text, grace_period_ends_at, status,
  phase_index, phase, deleted_counts, consecutive_errors, last_error, external_teardown_result
) VALUES
  ('22000000-0000-4000-8000-000000000001', 'Matriz 1', 'matriz-1', '10000000-0000-4000-8000-000000000001', 'regressao', 'Matriz 1', now(), 'running', 2, 'meta_event_attempts', '{"tracking_events":7,"meta_event_attempts":2}', 0, NULL, '{}'),
  ('22000000-0000-4000-8000-000000000002', 'Matriz 2', 'matriz-2', '10000000-0000-4000-8000-000000000001', 'regressao', 'Matriz 2', now(), 'running', 3, 'meta_event_queue', '{"tracking_events":9}', 0, NULL, '{}'),
  ('22000000-0000-4000-8000-000000000003', 'Matriz 3', 'matriz-3', '10000000-0000-4000-8000-000000000001', 'regressao', 'Matriz 3', now(), 'running', 4, 'tracking_journeys', '{}', 0, NULL, '{}'),
  ('22000000-0000-4000-8000-000000000004', 'Matriz 4', 'matriz-4', '10000000-0000-4000-8000-000000000001', 'regressao', 'Matriz 4', now(), 'needs_attention', 1, 'tracking_events', '{"tracking_events":11}', 10, '23503: unrelated foreign key failure', '{"status":"ok","skipped_manually":true}'),
  ('22000000-0000-4000-8000-000000000005', 'Matriz 5', 'matriz-5', '10000000-0000-4000-8000-000000000001', 'regressao', 'Matriz 5', now(), 'needs_attention', 4, 'tracking_journeys', '{}', 10, '23505: idx_meta_event_queue_reservation_event_unique', '{}'),
  ('22000000-0000-4000-8000-000000000006', 'Matriz 6', 'matriz-6', '10000000-0000-4000-8000-000000000001', 'regressao', 'Matriz 6', now(), 'needs_attention', 7, 'external_teardown', '{}', 10, 'external service failure', '{"status":"error","whatsapp":{"status":"error"}}');

-- @apply-tracking-queue-fix

-- The production FK workload needs indexes led by the actual FK column:
-- company-first and reservation-only partial indexes cannot cover those
-- cross-company referential integrity lookups. This checks schema coverage,
-- without treating the ephemeral database's timings as production evidence.
DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM (VALUES
      ('idx_meta_event_queue_journey', 'meta_event_queue', 'journey_id'),
      ('idx_tracking_events_session', 'tracking_events', 'session_id'),
      ('idx_meta_event_queue_reservation', 'meta_event_queue', 'reservation_id'),
      ('idx_meta_event_attempts_reservation', 'meta_event_attempts', 'reservation_id')
    ) AS expected(index_name, table_name, column_name)
    JOIN pg_index index_meta
      ON index_meta.indexrelid = to_regclass('public.' || expected.index_name)
      AND index_meta.indrelid = to_regclass('public.' || expected.table_name)
    JOIN pg_attribute attribute
      ON attribute.attrelid = index_meta.indrelid
      AND attribute.attname = expected.column_name
      AND attribute.attnum = index_meta.indkey[0]
    WHERE index_meta.indisvalid AND index_meta.indisready
      AND index_meta.indpred IS NULL AND index_meta.indnkeyatts = 1
  ) <> 4 THEN
    RAISE EXCEPTION 'Missing unconditional indexes led by the company deletion FK columns';
  END IF;
END;
$$;

DO $$
DECLARE
  _request_id uuid;
  _tick jsonb;
  _guard integer := 0;
BEGIN
  IF ARRAY(SELECT table_name FROM public.company_deletion_phase_order ORDER BY phase_index LIMIT 3)
    <> ARRAY['meta_event_attempts', 'meta_event_queue', 'tracking_events'] THEN
    RAISE EXCEPTION 'Queue dependencies must precede tracking event deletion';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_deletion_requests
    WHERE company_id = '20000000-0000-4000-8000-000000000003'
      AND status = 'running' AND phase_index = 1 AND consecutive_errors = 0
      AND last_error IS NULL AND next_attempt_at <= clock_timestamp()
      AND (deleted_counts ->> 'tracking_events')::integer = 1
  ) THEN
    RAISE EXCEPTION 'Known failed request was not resumed with its counters intact';
  END IF;
  IF (SELECT count(*) FROM public.company_deletion_requests
      WHERE company_id IN ('22000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002')
        AND status = 'running' AND phase_index = 1) <> 2
    OR NOT EXISTS (SELECT 1 FROM public.company_deletion_requests WHERE company_id = '22000000-0000-4000-8000-000000000001' AND deleted_counts = '{"tracking_events":7,"meta_event_attempts":2}')
    OR NOT EXISTS (SELECT 1 FROM public.company_deletion_requests WHERE company_id = '22000000-0000-4000-8000-000000000003' AND phase_index = 4)
    OR NOT EXISTS (SELECT 1 FROM public.company_deletion_requests WHERE company_id = '22000000-0000-4000-8000-000000000004' AND status = 'needs_attention' AND last_error = '23503: unrelated foreign key failure')
    OR NOT EXISTS (SELECT 1 FROM public.company_deletion_requests WHERE company_id = '22000000-0000-4000-8000-000000000005' AND status = 'needs_attention' AND phase_index = 4)
  THEN
    RAISE EXCEPTION 'Migration changed unrelated requests or lost existing progress';
  END IF;

  SELECT id INTO _request_id FROM public.company_deletion_requests
  WHERE company_id = '20000000-0000-4000-8000-000000000003';
  _tick := public._process_company_deletion_batch(_request_id, 1);
  IF _tick ->> 'phase' <> 'meta_event_attempts' OR (_tick ->> 'deleted_this_tick')::integer <> 1 THEN
    RAISE EXCEPTION 'Recovered pipeline did not start with queue attempts: %', _tick;
  END IF;
  IF (SELECT count(*) FROM public.tracking_events WHERE company_id = '20000000-0000-4000-8000-000000000003') <> 2 THEN
    RAISE EXCEPTION 'Tracking events were changed before the queue was drained';
  END IF;
  LOOP
    _guard := _guard + 1;
    IF _guard > 30 THEN RAISE EXCEPTION 'Recovered pipeline failed to reach teardown'; END IF;
    _tick := public._process_company_deletion_batch(_request_id, 1);
    IF _tick ->> 'status' = 'error' THEN RAISE EXCEPTION 'Recovered pipeline still fails: %', _tick; END IF;
    EXIT WHEN _tick ->> 'phase' = 'external_teardown';
  END LOOP;
  UPDATE public.company_deletion_requests SET external_teardown_result = '{"status":"ok"}' WHERE id = _request_id;
  _tick := public._process_company_deletion_batch(_request_id, 1);
  IF _tick ->> 'status' <> 'completed'
    OR EXISTS (SELECT 1 FROM public.companies WHERE id = '20000000-0000-4000-8000-000000000003')
    OR EXISTS (SELECT 1 FROM public.tracking_events WHERE company_id = '20000000-0000-4000-8000-000000000003')
    OR EXISTS (SELECT 1 FROM public.meta_event_queue WHERE company_id = '20000000-0000-4000-8000-000000000003')
    OR NOT EXISTS (SELECT 1 FROM public.meta_event_queue WHERE id = '34000000-0000-4000-8000-000000000020' AND tracking_event_id = '33000000-0000-4000-8000-000000000020')
    OR NOT EXISTS (SELECT 1 FROM public.company_deletion_requests WHERE id = _request_id AND (deleted_counts ->> 'tracking_events')::integer = 3)
  THEN
    RAISE EXCEPTION 'Recovered deletion did not finish with other company data and counters intact: %', _tick;
  END IF;
END;
$$;

-- Retry requires a superadmin and a stalled request. Skipping external
-- resources must not disguise a failed internal database phase.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.retry_company_deletion(uuid)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.retry_company_deletion(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected retry RPC ACL';
  END IF;
  BEGIN
    PERFORM public.force_skip_company_deletion_teardown('22000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'Internal database failure must not permit external teardown skipping';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.retry_company_deletion('22000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'Non-superadmin retry should have failed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
DO $$
BEGIN
  PERFORM public.retry_company_deletion('22000000-0000-4000-8000-000000000004');
  IF NOT EXISTS (
    SELECT 1 FROM public.company_deletion_requests
    WHERE company_id = '22000000-0000-4000-8000-000000000004'
      AND status = 'running' AND phase_index = 1 AND consecutive_errors = 0 AND last_error IS NULL
      AND external_teardown_result = '{"status":"ok","skipped_manually":true}'
      AND deleted_counts = '{"tracking_events":11}'
  ) THEN
    RAISE EXCEPTION 'Retry lost progress or modified external teardown approval';
  END IF;
  BEGIN
    PERFORM public.retry_company_deletion('22000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'Retrying a running request should have failed';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  PERFORM public.force_skip_company_deletion_teardown('22000000-0000-4000-8000-000000000006');
  IF NOT EXISTS (
    SELECT 1 FROM public.company_deletion_requests
    WHERE company_id = '22000000-0000-4000-8000-000000000006'
      AND status = 'running' AND external_teardown_result ->> 'status' = 'ok'
      AND (external_teardown_result ->> 'skipped_manually')::boolean
  ) THEN
    RAISE EXCEPTION 'A genuine external teardown failure could not be skipped';
  END IF;
END;
$$;

-- Unauthorized request is rejected and leaves no trace.
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.request_company_deletion(
      '20000000-0000-4000-8000-000000000001', 'Empresa alvo', 'teste'
    );
    RAISE EXCEPTION 'Admin (non-superadmin) request should have failed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  IF EXISTS (SELECT 1 FROM public.company_deletion_requests WHERE company_id = '20000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Unauthorized call created a request';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);

-- With the pipeline flag off, the request itself fails fast -- it must not
-- quarantine the company (that would strand it forever with no cron to
-- pick it up).
UPDATE public.system_settings SET value = 'false' WHERE key = 'company_deletion_pipeline_enabled';
DO $$
BEGIN
  BEGIN
    PERFORM public.request_company_deletion('20000000-0000-4000-8000-000000000001', 'Empresa alvo', 'teste');
    RAISE EXCEPTION 'Request should have failed while pipeline flag is off';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '55000' THEN RAISE; END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.companies
    WHERE id = '20000000-0000-4000-8000-000000000001' AND deletion_requested_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Company was quarantined despite the pipeline flag being off';
  END IF;
END;
$$;
UPDATE public.system_settings SET value = 'true' WHERE key = 'company_deletion_pipeline_enabled';

-- Wrong confirmation text is rejected.
DO $$
BEGIN
  BEGIN
    PERFORM public.request_company_deletion(
      '20000000-0000-4000-8000-000000000001', 'nome errado', 'teste'
    );
    RAISE EXCEPTION 'Wrong confirmation text should have failed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN RAISE; END IF;
  END;
END;
$$;

-- Real request: grace period starts, company is quarantined.
DO $$
DECLARE
  _result jsonb;
  _request_id uuid;
BEGIN
  _result := public.request_company_deletion(
    '20000000-0000-4000-8000-000000000001', 'Empresa alvo', 'encerramento de teste'
  );
  _request_id := (_result ->> 'request_id')::uuid;

  IF NOT EXISTS (
    SELECT 1 FROM public.companies
    WHERE id = '20000000-0000-4000-8000-000000000001' AND deletion_requested_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Company was not quarantined';
  END IF;

  -- A second request for the same company is rejected while one is active.
  BEGIN
    PERFORM public.request_company_deletion('20000000-0000-4000-8000-000000000001', 'Empresa alvo', 'duplicada');
    RAISE EXCEPTION 'Duplicate active request should have failed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '55006' THEN RAISE; END IF;
  END;

  -- Before the grace period elapses, a batch tick is a no-op.
  IF (public._process_company_deletion_batch(_request_id, 2) ->> 'status') <> 'grace_period' THEN
    RAISE EXCEPTION 'Batch should no-op during grace period';
  END IF;

  -- Cancel works during grace period and un-quarantines the company.
  PERFORM public.cancel_company_deletion('20000000-0000-4000-8000-000000000001');
  IF EXISTS (
    SELECT 1 FROM public.companies
    WHERE id = '20000000-0000-4000-8000-000000000001' AND deletion_requested_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cancel did not clear quarantine';
  END IF;
  IF (SELECT status FROM public.company_deletion_requests WHERE id = _request_id) <> 'canceled' THEN
    RAISE EXCEPTION 'Cancel did not mark request canceled';
  END IF;
END;
$$;

-- Second, real run: force the grace period into the past so batching can
-- proceed immediately, then drive it tick by tick.
DO $$
DECLARE
  _result jsonb;
  _request_id uuid;
  _tick jsonb;
  _guard integer := 0;
BEGIN
  _result := public.request_company_deletion(
    '20000000-0000-4000-8000-000000000001', 'empresa-alvo', 'exclusão real de teste'
  );
  _request_id := (_result ->> 'request_id')::uuid;

  UPDATE public.company_deletion_requests
  SET grace_period_ends_at = now() - interval '1 minute'
  WHERE id = _request_id;

  -- Drain tracking_events (5 rows) two at a time: expect 3 ticks to empty
  -- that phase (2 + 2 + 0-that-advances), then continue until external
  -- teardown is requested.
  LOOP
    _guard := _guard + 1;
    IF _guard > 50 THEN RAISE EXCEPTION 'Too many ticks without reaching external_teardown'; END IF;

    _tick := public._process_company_deletion_batch(_request_id, 2);
    EXIT WHEN (_tick ->> 'phase') = 'external_teardown';
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.tracking_events WHERE company_id = '20000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'tracking_events was not fully drained before reaching teardown';
  END IF;
  IF EXISTS (SELECT 1 FROM public.meta_event_queue WHERE company_id = '20000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'meta_event_queue was not drained';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM net.http_post_calls WHERE (body ->> 'request_id')::uuid = _request_id) THEN
    RAISE EXCEPTION 'External teardown was not requested via net.http_post';
  END IF;

  -- Still 'ok'-less: another tick must not advance past teardown yet.
  _tick := public._process_company_deletion_batch(_request_id, 2);
  IF (_tick ->> 'phase') <> 'external_teardown' OR (_tick ->> 'status') <> 'running' THEN
    RAISE EXCEPTION 'Pipeline advanced past teardown without a result';
  END IF;

  -- Simulate the teardown edge function's own write-back (out of process in
  -- production; done directly here since pg_net has no real HTTP transport
  -- in this harness).
  UPDATE public.company_deletion_requests
  SET external_teardown_result = jsonb_build_object('status', 'ok', 'whatsapp', jsonb_build_object('status','ok','note','no_instance'), 'storage', jsonb_build_object('status','ok'))
  WHERE id = _request_id;

  -- Final tick: deletes the company, survives via company_deletion_requests
  -- + audit_logs, and the omitted "waitlist" table is still gone (final
  -- cascade safety net).
  _tick := public._process_company_deletion_batch(_request_id, 2);
  IF (_tick ->> 'status') <> 'completed' THEN
    RAISE EXCEPTION 'Final tick did not complete: %', _tick;
  END IF;

  IF EXISTS (SELECT 1 FROM public.companies WHERE id = '20000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Company row was not deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = '20000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'Unrelated company was deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.waitlist WHERE company_id = '20000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Table omitted from phase_order was not cleaned up by the final cascade';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_deletion_requests
    WHERE id = _request_id AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'company_deletion_requests row did not survive company deletion';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE action = 'company_deleted_permanently'
      AND entity_id = '20000000-0000-4000-8000-000000000001'
      AND (details ->> 'deletion_request_id')::uuid = _request_id
  ) THEN
    RAISE EXCEPTION 'audit_logs row for the deletion is missing';
  END IF;
END;
$$;

-- The runner no-ops entirely while the feature flag is off.
UPDATE public.system_settings SET value = 'false' WHERE key = 'company_deletion_pipeline_enabled';
DO $$
BEGIN
  IF (public._run_company_deletion_pipeline(10, 100) ->> 'status') <> 'disabled' THEN
    RAISE EXCEPTION 'Runner did not respect the disabled feature flag';
  END IF;
END;
$$;

SELECT jsonb_build_object(
  'regression', 'ok',
  'unauthorized_blocked', true,
  'confirmation_mismatch_blocked', true,
  'grace_period_respected', true,
  'cancel_during_grace_period', true,
  'multi_tick_batching', true,
  'external_teardown_gated_on_edge_function_result', true,
  'orphan_table_caught_by_final_cascade', true,
  'audit_survives_company_deletion', true,
  'feature_flag_gates_runner', true,
  'tracking_queue_unique_failure_reproduced', true,
  'stalled_tracking_deletion_automatically_resumed', true,
  'phase_rewind_preserves_existing_counters', true,
  'retry_preserves_external_teardown_decision', true,
  'external_skip_rejects_internal_failures', true,
  'other_company_tracking_queue_preserved', true,
  'cross_company_fk_indexes_cover_deletion_lookups', true
) AS company_deletion_regression;
