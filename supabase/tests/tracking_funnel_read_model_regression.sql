-- PGlite/PostgreSQL harness.
-- Run bootstrap/fixtures, apply the three transactional migrations at the
-- markers, then run
-- assertions.  CONCURRENTLY and pg_cron migrations are intentionally excluded.

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
CREATE TABLE public.companies(id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.tracking_sessions(
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE
);
CREATE TABLE public.tracking_journeys(
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE
);
CREATE TABLE public.tracking_events(
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  session_id uuid,
  journey_id uuid,
  reservation_id uuid,
  anonymous_id text NOT NULL,
  event_id text NOT NULL UNIQUE,
  event_name text NOT NULL,
  tracking_source text NOT NULL DEFAULT 'public',
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE public.meta_event_queue(
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  tracking_event_id uuid REFERENCES public.tracking_events(id) ON DELETE SET NULL
);
CREATE TABLE public.meta_event_attempts(
  id uuid PRIMARY KEY,
  queue_id uuid NOT NULL REFERENCES public.meta_event_queue(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE
);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _role = 'superadmin' AND _user_id = '00000000-0000-4000-8000-000000000001';
$$;
CREATE FUNCTION public.has_role_in_company(
  _user_id uuid, _role public.app_role, _company_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    AND ((_role = 'admin' AND _user_id = '00000000-0000-4000-8000-000000000004')
      OR (_role = 'operator' AND _user_id IN (
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003'
      )));
$$;
CREATE FUNCTION public.has_company_panel_permission(
  _user_id uuid, _company_id uuid, _permission text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT public.has_role(_user_id, 'superadmin')
    OR public.has_role_in_company(_user_id, 'admin', _company_id)
    OR (_permission = 'dashboard_view'
      AND _company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND _user_id = '00000000-0000-4000-8000-000000000002'
      AND COALESCE(current_setting('test.permission', true), 'on') <> 'off');
$$;
CREATE FUNCTION public.company_feature_enabled(_company_id uuid, _feature_key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _company_id IS NOT NULL AND _feature_key = 'advanced_reports'
    AND COALESCE(current_setting('test.feature', true), 'on') <> 'off';
$$;
CREATE FUNCTION public.test_assert(_ok boolean, _message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(_ok, false) THEN RAISE EXCEPTION '%', _message; END IF;
END;
$$;

CREATE FUNCTION public.test_existing_meta_queue_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER trg_existing_meta_queue_sentinel
AFTER INSERT ON public.tracking_events FOR EACH ROW
EXECUTE FUNCTION public.test_existing_meta_queue_trigger();

INSERT INTO public.companies VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'B');
INSERT INTO public.tracking_sessions VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('10000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('10000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('10000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('10000000-0000-4000-8000-000000000008', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('10000000-0000-4000-8000-000000000009', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('20000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

-- A/s1 full; occurred_at is intentionally wrong to prove created_at authority.
INSERT INTO public.tracking_events(
 id,company_id,session_id,reservation_id,anonymous_id,event_id,event_name,
 tracking_source,occurred_at,created_at
) VALUES
 ('30000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',NULL,'shared','a1p','page_view','public','2025-01-01','2026-08-01 03:00+00'),
 ('30000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',NULL,'shared','a1d','date_select','public','2025-01-01','2026-08-01 03:10+00'),
 ('30000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',NULL,'shared','a1t','time_select','public','2025-01-01','2026-08-01 03:20+00'),
 ('30000000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',NULL,'shared','a1f','form_fill','public','2025-01-01','2026-08-01 03:30+00'),
 ('30000000-0000-4000-8000-000000000005','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','shared','a1c','reservation_created','public','2025-01-01','2026-08-01 03:40+00');

-- A/s2 changes identity around its first page.  The pre-page milestone and
-- anonymous id must not poison the read model; the post-page time must win.
INSERT INTO public.tracking_events(
 id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at
) VALUES
 ('30000000-0000-4000-8000-000000000010','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000002','poison-before','a2-old','time_select','public','2020-01-01','2026-08-02 11:50+00'),
 ('30000000-0000-4000-8000-000000000011','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000002','shared','a2p','page_view','public','2020-01-01','2026-08-02 12:00+00'),
 ('30000000-0000-4000-8000-000000000012','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000002','changed-after','a2d','date_select','public','2020-01-01','2026-08-02 12:10+00'),
 ('30000000-0000-4000-8000-000000000013','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000002','changed-after','a2t','time_select','public','2020-01-01','2026-08-02 12:20+00');

-- A/s3 jumps to completed; implied stages keep the funnel monotonic.
INSERT INTO public.tracking_events(
 id,company_id,session_id,reservation_id,anonymous_id,event_id,event_name,
 tracking_source,occurred_at,created_at
) VALUES
 ('30000000-0000-4000-8000-000000000021','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000003',NULL,'v3','a3p','page_view','public','2026-08-02 14:00+00','2026-08-02 14:00+00'),
 ('30000000-0000-4000-8000-000000000022','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000003','v3','a3c','reservation_created','public','2026-08-02 14:05+00','2026-08-02 14:05+00');

-- Fortaleza end boundary: page is Aug 3 23:59:59; next event is Aug 4.
INSERT INTO public.tracking_events(
 id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at
) VALUES
 ('30000000-0000-4000-8000-000000000031','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000004','v4','a4p','page_view','public','2026-08-04 02:59:59+00','2026-08-04 02:59:59+00'),
 ('30000000-0000-4000-8000-000000000033','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000004','v4','a4-after','date_select','public','2026-08-04 03:00+00','2026-08-04 03:00:01+00');

-- Empty anonymous ids are valid legacy data.  Fast and read-model unique mode
-- must preserve the same company-scoped empty identity instead of failing.
INSERT INTO public.tracking_events(
 id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at
) VALUES
 ('30000000-0000-4000-8000-000000000041','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000005','','a5p','page_view','public','2026-08-03 16:00+00','2026-08-03 16:00+00'),
 ('30000000-0000-4000-8000-000000000042','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000005','','a5d','date_select','public','2026-08-03 16:05+00','2026-08-03 16:05+00');

-- A retry delayed by 23 hours keeps its original effective day.  An absurd
-- client clock is outside the trust envelope and falls back to server time.
INSERT INTO public.tracking_events(
 id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at
) VALUES
 ('30000000-0000-4000-8000-000000000081','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000008','delayed','delayed-page','page_view','public','2026-08-10 10:00+00','2026-08-11 09:00+00'),
 ('30000000-0000-4000-8000-000000000082','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000008','delayed','delayed-date','date_select','public','2026-08-10 10:05+00','2026-08-11 09:01+00'),
 ('30000000-0000-4000-8000-000000000091','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000009','absurd','absurd-page','page_view','public','2020-01-01 00:00+00','2026-08-12 10:00+00');

-- B reuses A's anonymous id; global unique must key company+anonymous.
INSERT INTO public.tracking_events(
 id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at
) VALUES
 ('40000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','20000000-0000-4000-8000-000000000001','shared','b1p','page_view','public','2026-08-02 15:00+00','2026-08-02 15:00+00'),
 ('40000000-0000-4000-8000-000000000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','20000000-0000-4000-8000-000000000001','shared','b1d','date_select','public','2026-08-02 15:05+00','2026-08-02 15:05+00'),
 ('50000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL,'manual','manual','page_view','manual','2026-08-02','2026-08-02'),
 ('50000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL,'no-session','nosession','page_view','public','2026-08-02','2026-08-02');

-- @apply-fast-migration

-- @apply-read-model-migration

-- @apply-hardening-migration

SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SELECT set_config('test.permission','on',false);
SELECT set_config('test.feature','on',false);

DO $$
DECLARE c bigint[]; s text[]; src text[];
BEGIN
 SELECT array_agg(event_count ORDER BY array_position(ARRAY['page_view','date_select','time_select','form_fill','completed'],step)),
        array_agg(step ORDER BY array_position(ARRAY['page_view','date_select','time_select','form_fill','completed'],step)),
        array_agg(data_source ORDER BY step)
 INTO c,s,src FROM public.get_tracking_funnel_report(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false);
 PERFORM public.test_assert(s=ARRAY['page_view','date_select','time_select','form_fill','completed'], 'not exactly 5 ordered steps');
 PERFORM public.test_assert(c=ARRAY[5,4,3,2,2]::bigint[], 'wrong fast/server-time/boundary counts: '||c::text);
 PERFORM public.test_assert((SELECT count(DISTINCT x) FROM unnest(src)x)=1 AND src[1]='fast','wrong default source');
 PERFORM public.test_assert(c[1]>=c[2] AND c[2]>=c[3] AND c[3]>=c[4] AND c[4]>=c[5], 'non-monotonic fast funnel');

 SELECT array_agg(event_count ORDER BY array_position(ARRAY['page_view','date_select','time_select','form_fill','completed'],step))
 INTO c FROM public.get_tracking_funnel_report(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',true);
 PERFORM public.test_assert(c=ARRAY[4,3,2,2,2]::bigint[],'company+anonymous unique failed: '||c::text);
END; $$;

-- Fail-closed auth including operator override and feature; superadmin bypasses
-- a tenant feature for the platform Dashboard; global remains superadmin-only.
DO $$ BEGIN
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
 BEGIN PERFORM * FROM public.get_tracking_funnel_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false); RAISE EXCEPTION 'denied operator passed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
 PERFORM set_config('test.feature','off',true);
 BEGIN PERFORM * FROM public.get_tracking_funnel_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false); RAISE EXCEPTION 'feature bypass'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('test.feature','on',true);
 BEGIN PERFORM * FROM public.get_tracking_funnel_report('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-08-01','2026-08-03',false); RAISE EXCEPTION 'tenant leak'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM * FROM public.get_global_tracking_funnel_report('2026-08-01','2026-08-03',false); RAISE EXCEPTION 'operator global'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
 PERFORM set_config('test.feature','off',true);
 PERFORM * FROM public.get_tracking_funnel_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false);
 PERFORM * FROM public.get_global_tracking_funnel_report('2026-08-01','2026-08-03',false);
 PERFORM set_config('request.jwt.claim.role','service_role',true); PERFORM set_config('request.jwt.claim.sub','',true);
 BEGIN PERFORM * FROM public.get_global_tracking_funnel_report('2026-08-01','2026-08-03',false); RAISE EXCEPTION 'service global'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM * FROM public.get_tracking_funnel_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false);
END; $$;

SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SELECT set_config('test.feature','on',false);

SELECT public.test_assert(NOT has_function_privilege('anon','public.get_tracking_funnel_report(uuid,date,date,boolean)','EXECUTE'),'anon execute');
SELECT public.test_assert(has_function_privilege('authenticated','public.get_tracking_funnel_report(uuid,date,date,boolean)','EXECUTE'),'authenticated lacks execute');
SELECT public.test_assert(NOT has_function_privilege('authenticated','public._run_tracking_funnel_projection(integer,integer,interval)','EXECUTE'),'authenticated projector');
SELECT public.test_assert(has_function_privilege('service_role','public._run_tracking_funnel_projection(integer,integer,interval)','EXECUTE'),'service lacks projector');
SELECT public.test_assert(NOT has_function_privilege('authenticated','public._rebuild_tracking_funnel_sessions(uuid,uuid[])','EXECUTE'),'authenticated rebuild');
SELECT public.test_assert(has_function_privilege('service_role','public._rebuild_tracking_funnel_sessions(uuid,uuid[])','EXECUTE'),'service lacks rebuild');
SELECT public.test_assert(NOT has_function_privilege('authenticated','public._reconcile_tracking_funnel_company_batch(uuid,interval,integer)','EXECUTE'),'authenticated reconciler');
SELECT public.test_assert(NOT has_function_privilege('authenticated','public._tracking_funnel_effective_at(timestamptz,timestamptz)','EXECUTE'),'authenticated effective_at helper');
SELECT public.test_assert(NOT has_table_privilege('authenticated','public.tracking_funnel_sessions','SELECT'),'direct private read');
SELECT public.test_assert(NOT has_table_privilege('authenticated','public.tracking_funnel_company_rollout','UPDATE'),'authenticated rollout mutation');
SELECT public.test_assert(EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_existing_meta_queue_sentinel' AND NOT tgisinternal),'Meta trigger removed');
SELECT public.test_assert(NOT EXISTS(
  SELECT 1
  FROM pg_indexes
  WHERE schemaname='public'
    AND indexname LIKE 'idx_tracking_funnel_sessions%'
    AND indexdef ILIKE '%anonymous_id%'
),'read-model B-tree leaks anonymous_id');

-- Backfill/cursor/idempotence.
DO $$ DECLARE i integer; rows_before integer; processed_before bigint;
BEGIN
 FOR i IN 1..30 LOOP
   PERFORM public._run_tracking_funnel_projection(10,2,interval '30 minutes');
   EXIT WHEN NOT EXISTS(SELECT 1 FROM public.tracking_funnel_projection_state WHERE NOT is_ready);
 END LOOP;
 PERFORM public.test_assert(NOT EXISTS(SELECT 1 FROM public.tracking_funnel_projection_state WHERE NOT is_ready OR cursor_created_at IS NULL OR cursor_event_id IS NULL),'cursor/backfill incomplete');
 PERFORM public.test_assert((SELECT count(*) FROM public.tracking_funnel_sessions)=8,'wrong projected session count');
 PERFORM public.test_assert((SELECT count(*) FROM public.tracking_funnel_sessions WHERE anonymous_id='shared')=3,'cross-company/session identity');
 PERFORM public.test_assert((SELECT anonymous_id='shared'
   AND first_event_created_at=first_page_view_at
   AND time_selected_at='2026-08-02 12:20+00'
   FROM public.tracking_funnel_sessions
   WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     AND session_id='10000000-0000-4000-8000-000000000002'),
   'pre-page event or anonymous id poisoned projection');
 PERFORM public.test_assert((SELECT anonymous_id=''
   FROM public.tracking_funnel_sessions
   WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     AND session_id='10000000-0000-4000-8000-000000000005'),
   'empty anonymous id was not preserved');
 SELECT count(*) INTO rows_before FROM public.tracking_funnel_sessions;
 SELECT sum(processed_events) INTO processed_before FROM public.tracking_funnel_projection_state;
 PERFORM public._run_tracking_funnel_projection(10,2,interval '30 minutes');
 PERFORM public.test_assert((SELECT count(*) FROM public.tracking_funnel_sessions)=rows_before AND (SELECT sum(processed_events) FROM public.tracking_funnel_projection_state)=processed_before,'projector not idempotent');
END; $$;

DO $$ DECLARE fast jsonb; model jsonb; fast_unique jsonb; model_unique jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step) INTO fast FROM public._tracking_funnel_counts_fast_company('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01 03:00+00','2026-08-04 03:00+00',false);
 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step) INTO model FROM public._tracking_funnel_counts_read_model_company('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01 03:00+00','2026-08-04 03:00+00',false);
 PERFORM public.test_assert(fast=model,'fast/read-model drift: '||fast::text||' / '||model::text);
 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step) INTO fast_unique FROM public._tracking_funnel_counts_fast_company('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01 03:00+00','2026-08-04 03:00+00',true);
 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step) INTO model_unique FROM public._tracking_funnel_counts_read_model_company('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01 03:00+00','2026-08-04 03:00+00',true);
 PERFORM public.test_assert(fast_unique=model_unique,'fast/read-model unique drift: '||fast_unique::text||' / '||model_unique::text);
END; $$;

DO $$ DECLARE fast bigint[]; model bigint[];
BEGIN
 SELECT array_agg(event_count ORDER BY array_position(
   ARRAY['page_view','date_select','time_select','form_fill','completed'], step
 )) INTO fast
 FROM public._tracking_funnel_counts_fast_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-10 03:00+00','2026-08-11 03:00+00',false);
 SELECT array_agg(event_count ORDER BY array_position(
   ARRAY['page_view','date_select','time_select','form_fill','completed'], step
 )) INTO model
 FROM public._tracking_funnel_counts_read_model_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-10 03:00+00','2026-08-11 03:00+00',false);
 PERFORM public.test_assert(fast=ARRAY[1,1,0,0,0]::bigint[],
   'delayed retry was assigned to server day: '||fast::text);
 PERFORM public.test_assert(fast=model,
   'delayed retry fast/read-model drift: '||fast::text||' / '||model::text);

 SELECT array_agg(event_count ORDER BY array_position(
   ARRAY['page_view','date_select','time_select','form_fill','completed'], step
 )) INTO fast
 FROM public._tracking_funnel_counts_fast_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-12 03:00+00','2026-08-13 03:00+00',false);
 SELECT array_agg(event_count ORDER BY array_position(
   ARRAY['page_view','date_select','time_select','form_fill','completed'], step
 )) INTO model
 FROM public._tracking_funnel_counts_read_model_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-12 03:00+00','2026-08-13 03:00+00',false);
 PERFORM public.test_assert(fast=ARRAY[1,0,0,0,0]::bigint[],
   'absurd clock did not fall back to created_at: '||fast::text);
 PERFORM public.test_assert(fast=model,
   'absurd clock fast/read-model drift: '||fast::text||' / '||model::text);
END; $$;

INSERT INTO public.tracking_funnel_company_rollout VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','read_model',now());
UPDATE public.tracking_funnel_global_rollout SET requested_source='read_model';
SELECT public.test_assert((SELECT count(DISTINCT data_source)=1 AND min(data_source)='read_model' FROM public.get_tracking_funnel_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false)),'company rollout');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SELECT public.test_assert((SELECT event_count=5 FROM public.get_global_tracking_funnel_report('2026-08-01','2026-08-03',true) WHERE step='page_view'),'global company+anonymous unique');

-- More recent raw events than one projector batch must force fast_fallback
-- until every batch completes.  Two sessions also exercise the independent
-- daily reconciliation cursor below.
INSERT INTO public.tracking_sessions VALUES
 ('10000000-0000-4000-8000-000000000006','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('10000000-0000-4000-8000-000000000007','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO public.tracking_events(
 id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at
) VALUES
 ('80000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000006','recent-6','recent-6-page','page_view','public',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '3 minutes'),
 ('80000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000006','recent-6','recent-6-date','date_select','public',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes'),
 ('80000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000007','recent-7','recent-7-page','page_view','public',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute');

SELECT public._run_tracking_funnel_projection(20,1,interval '30 minutes');
SELECT public.test_assert((SELECT NOT is_ready AND last_error IS NULL
  FROM public.tracking_funnel_projection_state
  WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'partial batch was incorrectly marked ready');
SELECT public.test_assert((SELECT count(DISTINCT data_source)=1 AND min(data_source)='fast_fallback'
  FROM public.get_tracking_funnel_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2026-08-01',
    (clock_timestamp() AT TIME ZONE 'America/Fortaleza')::date,
    false
  )), 'company did not fall back during backlog');
SELECT public.test_assert((SELECT NOT is_ready
  FROM public.tracking_funnel_global_projection_state WHERE singleton),
  'global readiness ignored a partial company');
SELECT public.test_assert((SELECT count(DISTINCT data_source)=1 AND min(data_source)='fast_fallback'
  FROM public.get_global_tracking_funnel_report(
    '2026-08-01',
    (clock_timestamp() AT TIME ZONE 'America/Fortaleza')::date,
    false
  )), 'global report did not fall back during tenant backlog');

DO $$ DECLARE i integer; fast jsonb; model jsonb; fast_unique jsonb; model_unique jsonb;
BEGIN
 FOR i IN 1..20 LOOP
   PERFORM public._run_tracking_funnel_projection(20,1,interval '30 minutes');
   EXIT WHEN NOT EXISTS(
     SELECT 1 FROM public.tracking_funnel_projection_state
     WHERE NOT is_ready OR last_error IS NOT NULL
   );
 END LOOP;
 PERFORM public.test_assert(NOT EXISTS(
   SELECT 1 FROM public.tracking_funnel_projection_state
   WHERE NOT is_ready OR last_error IS NOT NULL
 ), 'recent backlog did not finish');
 PERFORM public._run_tracking_funnel_projection(20,1,interval '30 minutes');
 PERFORM public.test_assert((SELECT is_ready
   FROM public.tracking_funnel_global_projection_state WHERE singleton),
   'global state did not become ready after all tenants');

 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step)
 INTO fast FROM public._tracking_funnel_counts_fast_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-01 03:00+00', clock_timestamp()+interval '1 day', false);
 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step)
 INTO model FROM public._tracking_funnel_counts_read_model_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-01 03:00+00', clock_timestamp()+interval '1 day', false);
 PERFORM public.test_assert(fast=model,'recent fast/read-model drift: '||fast::text||' / '||model::text);

 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step)
 INTO fast_unique FROM public._tracking_funnel_counts_fast_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-01 03:00+00', clock_timestamp()+interval '1 day', true);
 SELECT jsonb_agg(jsonb_build_array(step,event_count) ORDER BY step)
 INTO model_unique FROM public._tracking_funnel_counts_read_model_company(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '2026-08-01 03:00+00', clock_timestamp()+interval '1 day', true);
 PERFORM public.test_assert(fast_unique=model_unique,'recent unique drift: '||fast_unique::text||' / '||model_unique::text);
END; $$;

-- Late commit behind cursor but inside overlap.
INSERT INTO public.tracking_events(id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at)
VALUES('30000000-0000-4000-8000-000000000032','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000007','recent-7','a7-late','time_select','public',clock_timestamp(),clock_timestamp()-interval '2 minutes');
SELECT public._project_tracking_funnel_company_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,interval '30 minutes');
SELECT public.test_assert((SELECT time_selected_at IS NOT NULL FROM public.tracking_funnel_sessions WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND session_id='10000000-0000-4000-8000-000000000007'),'late commit overlap');

-- Isolated milestone deletion and complete session deletion.
DELETE FROM public.tracking_events WHERE id='30000000-0000-4000-8000-000000000004';
SELECT public._reconcile_tracking_funnel_company('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01 03:29+00','2026-08-01 03:31+00',100);
SELECT public.test_assert((SELECT form_filled_at IS NULL FROM public.tracking_funnel_sessions WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND session_id='10000000-0000-4000-8000-000000000001'),'isolated delete stale');
DELETE FROM public.tracking_events WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND session_id='10000000-0000-4000-8000-000000000004';
-- The window includes first_page/time but deliberately excludes the projected
-- last_event at 03:00:01, guarding against a stale-row deletion bug.
SELECT public._reconcile_tracking_funnel_company('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-04 02:59+00','2026-08-04 03:00+00',100);
SELECT public.test_assert(NOT EXISTS(SELECT 1 FROM public.tracking_funnel_sessions WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND session_id='10000000-0000-4000-8000-000000000004'),'deleted session stale');

UPDATE public.tracking_funnel_projection_state SET covered_through_at=NULL,is_ready=false WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SELECT public.test_assert((SELECT count(DISTINCT data_source)=1 AND min(data_source)='fast_fallback' FROM public.get_tracking_funnel_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false)),'read-model fallback');
SELECT public._project_tracking_funnel_company_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,interval '30 minutes');
UPDATE public.tracking_funnel_projection_state
SET is_ready=true,covered_through_at=clock_timestamp(),last_error='falha forçada'
WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SELECT public.test_assert((SELECT count(DISTINCT data_source)=1 AND min(data_source)='fast_fallback' FROM public.get_tracking_funnel_report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-01','2026-08-03',false)),'last_error did not force fallback');
SELECT public._project_tracking_funnel_company_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,interval '30 minutes');

-- Persisted per-tenant projection error, exponential backoff, round-robin
-- isolation, and recovery.  Empty anonymous_id itself must remain valid.
INSERT INTO public.companies VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','C');
INSERT INTO public.tracking_sessions VALUES('60000000-0000-4000-8000-000000000001','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.tracking_events(id,company_id,session_id,anonymous_id,event_id,event_name,tracking_source,occurred_at,created_at)
VALUES('60000000-0000-4000-8000-000000000002','cccccccc-cccc-4ccc-8ccc-cccccccccccc','60000000-0000-4000-8000-000000000001','','bad','page_view','public',clock_timestamp(),clock_timestamp());

CREATE FUNCTION public.test_fail_funnel_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id::text = current_setting('test.fail_funnel_company', true) THEN
    RAISE EXCEPTION 'falha injetada para %', NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_test_fail_funnel_projection
BEFORE INSERT OR UPDATE ON public.tracking_funnel_sessions
FOR EACH ROW EXECUTE FUNCTION public.test_fail_funnel_projection();

SELECT set_config('test.fail_funnel_company','cccccccc-cccc-4ccc-8ccc-cccccccccccc',false);
SELECT public._run_tracking_funnel_projection(20,100,interval '30 minutes');
SELECT public.test_assert((SELECT last_error IS NOT NULL
  AND NOT is_ready
  AND consecutive_errors=1
  AND next_attempt_at>clock_timestamp()
  FROM public.tracking_funnel_projection_state
  WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'projector error/backoff not persisted');
SELECT public.test_assert((SELECT count(DISTINCT data_source)=1
  AND min(data_source)='fast_fallback'
  FROM public.get_global_tracking_funnel_report(
    '2026-08-01',
    (clock_timestamp() AT TIME ZONE 'America/Fortaleza')::date,
    false
  )), 'global readiness ignored a tenant error');
SELECT public.test_assert(EXISTS(SELECT 1 FROM public.tracking_funnel_sessions WHERE company_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'tenant failure disturbed healthy tenant');
DO $$ DECLARE failed_started_at timestamptz; result jsonb;
BEGIN
 SELECT last_started_at INTO failed_started_at
 FROM public.tracking_funnel_projection_state
 WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 result := public._run_tracking_funnel_projection(1,100,interval '30 minutes');
 PERFORM public.test_assert((result->>'processed_companies')::integer=1
   AND (SELECT last_started_at=failed_started_at
     FROM public.tracking_funnel_projection_state
     WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
   'backoff tenant was retried or starved the round-robin scheduler');
END; $$;
SELECT set_config('test.fail_funnel_company','',false);
SELECT public._project_tracking_funnel_company_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc',100,interval '30 minutes');
SELECT public.test_assert((SELECT last_error IS NULL AND is_ready
  AND consecutive_errors=0 AND anonymous_id=''
  FROM public.tracking_funnel_projection_state state
  JOIN public.tracking_funnel_sessions session
    ON session.company_id=state.company_id
  WHERE state.company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'projector did not recover or preserve empty anonymous id');

-- Daily reconciliation is separately cursor-backed.  An error in C must be
-- persisted while A/B continue, and a >1-session window must resume by cursor.
SELECT public._reconcile_tracking_funnel_company_batch(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',interval '7 days',1);
SELECT public.test_assert((SELECT reconciliation_cursor_session_id IS NOT NULL
  AND reconciliation_window_start_at IS NOT NULL
  FROM public.tracking_funnel_projection_state
  WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'daily reconciliation did not persist partial cursor');
SELECT public._reconcile_tracking_funnel_company_batch(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',interval '7 days',1);
SELECT public.test_assert((SELECT reconciliation_cursor_session_id IS NULL
  AND reconciliation_window_start_at IS NULL
  AND last_reconciled_at IS NOT NULL
  FROM public.tracking_funnel_projection_state
  WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'daily reconciliation did not finish its cursor');

INSERT INTO public.companies VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','E');
INSERT INTO public.tracking_funnel_projection_state(company_id)
VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
UPDATE public.tracking_funnel_projection_state
SET next_reconciliation_attempt_at='-infinity'::timestamptz,
    last_reconciliation_started_at=NULL;
SELECT set_config('test.fail_funnel_company','cccccccc-cccc-4ccc-8ccc-cccccccccccc',false);
SELECT public._run_tracking_funnel_reconciliation(interval '7 days',20,10);
SELECT public.test_assert((SELECT last_reconciliation_error IS NOT NULL
  AND reconciliation_errors=1
  AND next_reconciliation_attempt_at>clock_timestamp()
  FROM public.tracking_funnel_projection_state
  WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'reconciliation error/backoff not persisted');
SELECT public.test_assert((SELECT last_reconciliation_started_at IS NOT NULL
  FROM public.tracking_funnel_projection_state
  WHERE company_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  'reconciliation stopped after another tenant failed');
SELECT set_config('test.fail_funnel_company','',false);
SELECT public._reconcile_tracking_funnel_company_batch(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',interval '7 days',10);
SELECT public.test_assert((SELECT last_reconciliation_error IS NULL
  AND reconciliation_errors=0
  FROM public.tracking_funnel_projection_state
  WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'reconciliation did not recover');
DROP TRIGGER trg_test_fail_funnel_projection ON public.tracking_funnel_sessions;
DROP FUNCTION public.test_fail_funnel_projection();
DELETE FROM public.companies WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

-- clear_company_event_data integration and unchanged Meta sentinel.
INSERT INTO public.meta_event_queue VALUES('70000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',NULL);
SELECT public.clear_company_event_data('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','meta_queue');
SELECT public.test_assert(EXISTS(SELECT 1 FROM public.tracking_funnel_sessions WHERE company_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'meta cleanup removed projection');
INSERT INTO public.meta_event_queue VALUES
 ('70000000-0000-4000-8000-000000000011','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-000000000001'),
 ('70000000-0000-4000-8000-000000000012','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL);
INSERT INTO public.meta_event_attempts VALUES
 ('71000000-0000-4000-8000-000000000011','70000000-0000-4000-8000-000000000011','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('71000000-0000-4000-8000-000000000012','70000000-0000-4000-8000-000000000012','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
SELECT public.clear_company_event_data('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event_log');
SELECT public.test_assert(NOT EXISTS(SELECT 1 FROM public.tracking_events WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') AND NOT EXISTS(SELECT 1 FROM public.tracking_funnel_sessions WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') AND NOT EXISTS(SELECT 1 FROM public.tracking_funnel_projection_state WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'event cleanup left funnel data');
SELECT public.test_assert(NOT EXISTS(SELECT 1 FROM public.meta_event_queue WHERE id='70000000-0000-4000-8000-000000000011') AND EXISTS(SELECT 1 FROM public.meta_event_queue WHERE id='70000000-0000-4000-8000-000000000012'),'existing Meta cleanup semantics changed');
SELECT public.test_assert(EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_existing_meta_queue_sentinel' AND NOT tgisinternal),'Meta trigger changed');

SELECT public.clear_company_event_data('cccccccc-cccc-4ccc-8ccc-cccccccccccc','all');
SELECT public.test_assert(NOT EXISTS(SELECT 1 FROM public.tracking_events WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  AND NOT EXISTS(SELECT 1 FROM public.tracking_sessions WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  AND NOT EXISTS(SELECT 1 FROM public.tracking_funnel_sessions WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  AND NOT EXISTS(SELECT 1 FROM public.tracking_funnel_projection_state WHERE company_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'all cleanup left funnel or tracking data');

-- The new private rows must not obstruct or outlive a company cascade.
INSERT INTO public.companies VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','D');
INSERT INTO public.tracking_funnel_projection_state(company_id)
VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
INSERT INTO public.tracking_funnel_company_rollout(company_id,requested_source)
VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','read_model');
INSERT INTO public.tracking_funnel_sessions(
  company_id,session_id,anonymous_id,first_event_created_at,first_page_view_at,
  max_stage,last_event_created_at
) VALUES(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'dddddddd-0000-4000-8000-000000000001','',clock_timestamp(),
  clock_timestamp(),1,clock_timestamp()
);
DELETE FROM public.companies WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SELECT public.test_assert(NOT EXISTS(SELECT 1 FROM public.tracking_funnel_sessions WHERE company_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  AND NOT EXISTS(SELECT 1 FROM public.tracking_funnel_projection_state WHERE company_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  AND NOT EXISTS(SELECT 1 FROM public.tracking_funnel_company_rollout WHERE company_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  'company cascade left funnel read-model data');
