-- PGlite regression harness for the async company-deletion pipeline.
--
-- Apply, in order, at the marker below:
--   1. 20260826161000_add_company_deletion_requests.sql
--   2. 20260826162000_add_company_deletion_engine.sql
--   3. 20260826163000_add_company_deletion_request_rpc.sql
-- then run the fixtures and assertions below it. No production data is used.
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
  value text
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
CREATE TABLE public.meta_event_queue (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE, journey_id uuid REFERENCES public.tracking_journeys(id) ON DELETE SET NULL);
CREATE TABLE public.meta_event_attempts (id uuid PRIMARY KEY, queue_id uuid NOT NULL REFERENCES public.meta_event_queue(id) ON DELETE CASCADE, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE);
CREATE TABLE public.waitlist (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE);
CREATE TABLE public.company_whatsapp_instances (company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE, instance_name text, status text);

-- @apply-migration

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
  ('20000000-0000-4000-8000-000000000002', 'Empresa preservada', 'empresa-preservada');

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

INSERT INTO public.meta_event_queue (id, company_id) VALUES
  ('34000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');
INSERT INTO public.meta_event_attempts (id, queue_id, company_id) VALUES
  ('35000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');
INSERT INTO public.waitlist (id, company_id) VALUES
  ('38000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');

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

  IF EXISTS (SELECT 1 FROM public.company_deletion_requests) THEN
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
  'feature_flag_gates_runner', true
) AS company_deletion_regression;
