import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// Replay the repository's actual SQL schema and policies locally. Supabase's
// Auth/Storage schemas are fixtures; cron/net are inert stubs and cannot invoke
// external endpoints. Business migrations and the new support migrations are
// executed unchanged. Unavailable CREATE EXTENSION pg_cron/pg_net is omitted;
// concurrent index builds become ordinary builds in this single-session engine.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const db = new PGlite();
const migrationDirectory = resolve(root, 'supabase/migrations');
const support = '00000000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-000000000004';
const operator = '00000000-0000-4000-8000-000000000005';
const superadmin = '00000000-0000-4000-8000-000000000001';
const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const login = '11111111-1111-4111-8111-111111111111';
const historicalActor = '00000000-0000-4000-8000-000000000006';
const historicalAudit = '00000000-0000-4000-8000-000000000007';

async function actor(id, session = null) {
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)`, [
    JSON.stringify({ sub: id, role: 'authenticated', session_id: login }),
    JSON.stringify(session ? { 'x-support-impersonation': session } : {}),
  ]);
  await db.exec('SET ROLE authenticated');
}
async function scalar(sql, params = []) { return (await db.query(sql, params)).rows[0]?.value; }

try {
  await db.exec(String.raw`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions; CREATE SCHEMA cron; CREATE SCHEMA net;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}', banned_until timestamptz, created_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role' $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claims',true),'')::jsonb $$;
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(_name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(_name,'/'); $$;
    CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
    CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE result bigint; BEGIN INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) ON CONFLICT(jobname) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command RETURNING jobid INTO result; RETURN result; END; $$;
    CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobid=job_id; RETURN FOUND; END; $$;
    CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobname=job_name; RETURN FOUND; END; $$;
    CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds integer DEFAULT 1000) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    GRANT USAGE ON SCHEMA auth,storage,public TO anon,authenticated,service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
  `);
  const files = (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql')).sort();
  const liveAclMigration = files.find(file => file.startsWith('20261006143500_'));
  assert.ok(liveAclMigration, 'Expected the incremental live-funnel anonymous ACL migration');
  const auditActorMigration = files.find(file => file.startsWith('20261006150000_'));
  assert.ok(auditActorMigration, 'Expected the additive audit actor preservation migration');
  for (const file of files) {
    if (file === '20260309211714_c61ee570-889c-44b5-9189-83eb8dc93983.sql') {
      // Historical demo data expects objects that were created through the app.
      await db.exec(`INSERT INTO companies(id,name,slug) VALUES('1e0da55b-f8e9-4199-80b6-79c64e93cb7a','Historical demo fixture','historical-demo'); INSERT INTO restaurant_tables(id,company_id,number) VALUES('9a83e0fe-79e0-40e1-bdd5-1cfbab07752f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',1),('57be60f4-936e-42f9-ac7f-7f2049f5709f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',2);`);
    }
    if (file === liveAclMigration) {
      // Production retained a historical explicit anon ACL. Revoking PUBLIC
      // alone does not remove this grant; reproduce it before the ACL fix.
      await db.exec('GRANT EXECUTE ON FUNCTION public.get_live_funnel_presence(uuid,integer) TO anon');
      assert.equal(await scalar(`SELECT has_function_privilege('anon','public.get_live_funnel_presence(uuid,integer)','EXECUTE') value`),true);
    }
    if (file === auditActorMigration) {
      // Existing history must be backfilled from the real pre-migration schema.
      await db.query(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,'historical-auth@test.local','{"full_name":"Auth historical name"}')`, [historicalActor]);
      await db.query(`UPDATE profiles SET full_name='Historical profile name',email='historical-profile@test.local' WHERE id=$1`, [historicalActor]);
      await db.query(`INSERT INTO audit_logs(id,user_id,action,details) VALUES($1,$2,'historical_actor_fixture','{"retained":true}')`, [historicalAudit,historicalActor]);
    }
    const sql = (await readFile(resolve(migrationDirectory, file), 'utf8'))
      .replace(/CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)[^;]*;/gi, '')
      .replace(/CREATE INDEX CONCURRENTLY/gi, 'CREATE INDEX');
    try { await db.exec(sql); } catch (error) { throw new Error(`Migration replay failed in ${file}: ${error.message}`, { cause: error }); }
  }
  assert.equal(await scalar(`SELECT has_function_privilege('anon','public.get_live_funnel_presence(uuid,integer)','EXECUTE') value`),false);
  assert.equal(await scalar(`SELECT has_function_privilege('authenticated','public.get_live_funnel_presence(uuid,integer)','EXECUTE') value`),true);
  const historicalSnapshot = {
    user_id: historicalActor, actor_user_id: historicalActor,
    actor_name: 'Historical profile name', actor_email: 'historical-profile@test.local',
  };
  assert.deepEqual((await db.query('SELECT user_id,actor_user_id,actor_name,actor_email FROM audit_logs WHERE id=$1',[historicalAudit])).rows[0],historicalSnapshot);
  await db.query(`INSERT INTO companies(id,name,slug) VALUES($1,'Empresa A','empresa-a'),($2,'Empresa B','empresa-b')`, [companyA, companyB]);
  for (const [id, role, name] of [[superadmin, 'superadmin', 'Root'], [support, 'support', 'Suporte'], [admin, 'admin', 'Admin'], [operator, 'operator', 'Operador']]) {
    await db.query(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)`, [id, `${role}@test.local`, JSON.stringify({ full_name: name })]);
    const companyId = ['admin', 'operator'].includes(role) ? companyA : null;
    await db.query('UPDATE profiles SET company_id=$2 WHERE id=$1', [id, companyId]);
    await db.query('INSERT INTO user_roles(user_id,role,company_id) VALUES($1,$2,$3)', [id, role, companyId]);
  }
  await db.query(`INSERT INTO user_roles(user_id,role,company_id) VALUES($1,'admin',$2)`, [admin, companyB]);
  await db.query(`INSERT INTO user_roles(user_id,role,company_id) VALUES($1,'operator',$2)`, [operator, companyB]);
  await db.query(`INSERT INTO reservations(company_id,guest_name,guest_phone,date,time,status,party_size,guest_birthdate) VALUES($1,'Visitante A','11999999999','2026-10-06','18:00','confirmed',2,'1990-01-01'),($2,'Visitante B','11888888888','2026-10-06','18:00','confirmed',100,'1990-01-01')`, [companyA, companyB]);
  const reservationA = (await db.query('SELECT id FROM reservations WHERE company_id=$1', [companyA])).rows[0].id;
  const reservationB = (await db.query('SELECT id FROM reservations WHERE company_id=$1', [companyB])).rows[0].id;
  const paymentA = await scalar(`INSERT INTO reservation_payments(company_id,reservation_id,base_amount,expires_at) VALUES($1,$2,10,now()+interval '1 hour') RETURNING id value`, [companyA,reservationA]);
  const notificationA = await scalar(`INSERT INTO notifications(company_id,title,message) VALUES($1,'Aviso A','Mensagem A') RETURNING id value`,[companyA]);
  const notificationB = await scalar(`INSERT INTO notifications(company_id,title,message) VALUES($1,'Aviso B','Mensagem B') RETURNING id value`,[companyB]);
  await actor(superadmin);
  assert.equal(await scalar('SELECT set_support_company_access($1,$2) value', [support, [companyA]]), true);
  await actor(support);
  assert.equal((await db.query('SELECT * FROM companies')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM reservations')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM support_list_companies()')).rows.length, 1);
  const context = await scalar('SELECT start_support_impersonation($1,$2) value', [companyA, admin]);
  await actor(support, context.id);
  assert.deepEqual((await db.query('SELECT id FROM companies')).rows.map(row => row.id), [companyA]);
  assert.equal((await db.query('SELECT * FROM reservations')).rows.length, 1);
  const plan = (await db.query('EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM reservations')).rows[0]['QUERY PLAN'][0].Plan;
  const planText = JSON.stringify(plan);
  assert.match(planText, /InitPlan/);
  assert.match(planText, /get_support_impersonation_context/);
  assert.equal(plan.Filter.includes('support_company_scope_allows'), false);
  assert.equal((await db.query('SELECT * FROM get_company_feature_flags($1)', [companyA])).rows.length > 0, true);
  assert.equal((await db.query('SELECT * FROM get_company_feature_flags($1)', [companyB])).rows.length, 0);
  await assert.rejects(db.query('SELECT * FROM get_admin_reservation_calendar_metrics($1,$2,$3)', [companyB, '2026-10-06', '2026-10-06']), error => /permiss|autoriz|Acesso|access/i.test(error.message));
  assert.equal((await db.query('SELECT * FROM audit_logs')).rows.length, 0);
  assert.equal(await scalar('SELECT mark_notifications_read($1) value',[[notificationB]]),0);
  assert.equal(await scalar('SELECT mark_notifications_read($1) value',[[notificationA]]),1);
  await assert.rejects(db.query('UPDATE reservation_payments SET reservation_id=$1 WHERE id=$2', [reservationB,paymentA]), error => error.code==='42501');
  await assert.rejects(db.query('UPDATE reservation_payments SET asaas_payment_id=$1 WHERE id=$2', ['foreign-asaas-payment',paymentA]), error => error.code==='42501');
  // Verify the reference policy itself, independently of the defense-in-depth
  // provider identity trigger. This is only the isolated in-memory database.
  await db.exec('RESET ROLE');
  assert.equal(await scalar('SELECT read_at value FROM notification_recipients WHERE user_id=$1 AND notification_id=$2',[admin,notificationB]),null);
  await db.exec('ALTER TABLE reservation_payments DISABLE TRIGGER protect_support_payment_identity');
  await actor(support,context.id);
  await assert.rejects(db.query('UPDATE reservation_payments SET reservation_id=$1 WHERE id=$2', [reservationB,paymentA]), error => error.code==='42501' && /row-level security/i.test(error.message));
  await db.exec('RESET ROLE');
  await db.exec('ALTER TABLE reservation_payments ENABLE TRIGGER protect_support_payment_identity');
  await actor(support,context.id);
  await db.query(`UPDATE reservations SET notes='Local support audit verification' WHERE company_id=$1`, [companyA]);
  await db.exec('RESET ROLE');
  const reservationAudit = (await db.query(`SELECT actor_user_id,actor_role FROM reservation_audit_logs WHERE actor_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [support])).rows[0];
  assert.deepEqual(reservationAudit, { actor_user_id: support, actor_role: 'support' });
  const supportMutation = (await db.query(`SELECT user_id,details FROM audit_logs WHERE action='support_update' AND entity_type='reservations' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.equal(supportMutation.user_id, support);
  assert.equal(supportMutation.details.target_user_id, admin);
  assert.equal(supportMutation.details.company_id, companyA);
  assert.equal(supportMutation.details.session_id, context.id);
  assert.deepEqual(supportMutation.details.changed_fields.includes('notes'), true);
  const scopeMissing = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relname NOT LIKE 'support_%' AND c.relname NOT IN ('profiles','user_roles') AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attname='company_id' AND NOT attisdropped) AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid AND polname='support_tenant_scope')`)).rows;
  assert.deepEqual(scopeMissing, []);
  await db.query(`SELECT set_config('request.jwt.claims','{"role":"anon"}',false),set_config('request.headers','{}',false)`);
  await db.exec('SET ROLE anon');
  assert.equal((await db.query('SELECT * FROM get_public_company_by_slug($1)', ['empresa-a'])).rows.length, 1);

  // A busy live funnel used to revalidate support delegation through the event
  // RLS policy once per event. Reproduce with real schema/policies, then apply
  // only the incremental fix and compare identical results and elapsed time.
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims','{}',false),set_config('request.headers','{}',false)`);
  await db.query(`INSERT INTO tracking_events(company_id,anonymous_id,event_id,event_name,occurred_at)
    SELECT $1,'live-page-'||n,'live-page-'||n,'page_view',now() FROM generate_series(1,1000) AS n`, [companyA]);
  await db.query(`INSERT INTO tracking_events(company_id,anonymous_id,event_id,event_name,occurred_at,tracking_source) VALUES
    ($1,'live-flow','live-flow-page','page_view',now()-interval '3 minutes','public'),
    ($1,'live-flow','live-flow-date','date_select',now()-interval '2 minutes','public'),
    ($1,'live-flow','live-flow-time','time_select',now()-interval '1 minute','public'),
    ($1,'live-final','live-final-page','page_view',now()-interval '2 minutes','public'),
    ($1,'live-final','live-final-conversion','reservation_created',now()-interval '1 minute','public'),
    ($1,'live-date','live-date','date_select',now(),'public'),
    ($1,'live-form','live-form','lead_captured',now(),'public'),
    ($1,'live-stale','live-stale','page_view',now()-interval '6 minutes','public'),
    ($1,'live-internal','live-internal','page_view',now(),'internal'),
    ($2,'live-other','live-other','time_select',now(),'public')`, [companyA, companyB]);
  const oldLiveMigration = await readFile(resolve(migrationDirectory, '20260429120000_optimize_tracking_query_performance.sql'), 'utf8');
  await db.exec(oldLiveMigration.slice(oldLiveMigration.indexOf('CREATE OR REPLACE FUNCTION public.get_live_funnel_presence(')));
  await actor(support, context.id);
  const previousLiveStarted = performance.now();
  const previousLiveRows = (await db.query('SELECT * FROM get_live_funnel_presence($1,5)', [companyA])).rows;
  const previousLiveMs = performance.now() - previousLiveStarted;
  await db.exec('RESET ROLE');
  await db.exec(await readFile(resolve(migrationDirectory, '20261006143000_fix_support_live_funnel_presence.sql'), 'utf8'));
  await actor(support, context.id);
  const fixedLiveStarted = performance.now();
  const liveRows = (await db.query('SELECT * FROM get_live_funnel_presence($1,5)', [companyA])).rows;
  const fixedLiveMs = performance.now() - fixedLiveStarted;
  assert.deepEqual(liveRows, previousLiveRows);
  assert.deepEqual(liveRows.map(row => [row.stage,row.stage_count]), [
    ['page_view',1000],['date_select',1],['time_select',1],['form_fill',1],['completed',1],
  ]);
  assert.equal(liveRows.every(row => row.total_active===1004 && row.window_minutes===5),true);
  const liveDenied = companyId => assert.rejects(
    db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyId]), error => error.code==='42501');
  await liveDenied(companyB);
  await liveDenied(null);
  await actor(support);
  await liveDenied(companyA);
  await actor(admin);
  assert.deepEqual((await db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyA])).rows,liveRows);
  await liveDenied(null);
  await actor(operator);
  assert.deepEqual((await db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyA])).rows,liveRows);
  assert.equal((await db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyB])).rows[0].total_active,1);
  await liveDenied(null);
  await actor(superadmin);
  assert.deepEqual((await db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyA])).rows,liveRows);
  assert.equal((await db.query('SELECT * FROM get_live_funnel_presence(NULL,5)')).rows[0].total_active,1005);

  await actor(support);
  const operatorContext = await scalar('SELECT start_support_impersonation($1,$2) value',[companyA,operator]);
  await actor(support,operatorContext.id);
  assert.deepEqual((await db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyA])).rows,liveRows);
  await liveDenied(companyB);
  await db.query(`SELECT set_config('request.jwt.claims',$1,false)`,[
    JSON.stringify({sub:support,role:'authenticated',session_id:'22222222-2222-4222-8222-222222222222'}),
  ]);
  await liveDenied(companyA);
  await actor(support,operatorContext.id);
  await db.exec('RESET ROLE');
  await db.query(`INSERT INTO company_user_panel_permissions(user_id,company_id,permission_overrides)
    VALUES($1,$2,'{"dashboard_view":false}')`,[operator,companyA]);
  await actor(operator);
  await liveDenied(companyA);
  await actor(support,operatorContext.id);
  await liveDenied(companyA);
  await db.exec('RESET ROLE');
  await db.query(`UPDATE company_user_panel_permissions SET permission_overrides='{"dashboard_view":true}' WHERE user_id=$1 AND company_id=$2`,[operator,companyA]);
  await actor(support,operatorContext.id);
  assert.deepEqual((await db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyA])).rows,liveRows);
  await db.exec('RESET ROLE');
  await db.query(`UPDATE support_impersonation_sessions SET started_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE id=$1`,[operatorContext.id]);
  await actor(support,operatorContext.id);
  await liveDenied(companyA);
  await actor(support);
  const revokedContext = await scalar('SELECT start_support_impersonation($1,$2) value',[companyA,operator]);
  await actor(superadmin);
  await db.query('SELECT set_support_company_access($1,$2)',[support,[]]);
  await actor(support,revokedContext.id);
  await liveDenied(companyA);
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims','{"role":"anon"}',false),set_config('request.headers','{}',false)`);
  await db.exec('SET ROLE anon');
  await liveDenied(companyA);
  await db.exec('RESET ROLE');
  await db.exec('GRANT EXECUTE ON FUNCTION public.get_live_funnel_presence(uuid,integer) TO anon');
  await db.exec('SET ROLE anon');
  // The guarded definer must also reject an anonymous request if an explicit
  // execute grant is accidentally restored by a later deployment.
  await assert.rejects(db.query('SELECT * FROM get_live_funnel_presence($1,5)',[companyA]),
    error => error.code==='42501' && /Nao autorizado/.test(error.message));
  await db.exec('RESET ROLE');
  await db.exec(await readFile(resolve(migrationDirectory,liveAclMigration),'utf8'));
  assert.equal(await scalar(`SELECT has_function_privilege('anon','public.get_live_funnel_presence(uuid,integer)','EXECUTE') value`),false);

  // Canonical snapshots cannot be spoofed on insert or rewritten later. New
  // records still require a live Auth actor, preserving FK validation.
  await db.query(`SELECT set_config('request.jwt.claims','{}',false),set_config('request.headers','{}',false)`);
  const spoofedAudit = await scalar(`INSERT INTO audit_logs(user_id,action,actor_user_id,actor_name,actor_email)
    VALUES($1,'snapshot_spoof_fixture',$2,'Forged actor','forged@test.local') RETURNING id value`,[support,superadmin]);
  const supportSnapshot = { user_id:support,actor_user_id:support,actor_name:'Suporte',actor_email:'support@test.local' };
  assert.deepEqual((await db.query('SELECT user_id,actor_user_id,actor_name,actor_email FROM audit_logs WHERE id=$1',[spoofedAudit])).rows[0],supportSnapshot);
  for (const [column,value] of [['actor_user_id',superadmin],['actor_name','Rewritten name'],['actor_email','rewritten@test.local'],['user_id',superadmin]]) {
    await assert.rejects(db.query(`UPDATE audit_logs SET ${column}=$1 WHERE id=$2`,[value,spoofedAudit]),error => error.code==='23514');
  }
  await assert.rejects(db.query(`INSERT INTO audit_logs(user_id,action) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff','invalid_actor_fixture')`),
    error => error.code==='23503' && error.constraint==='audit_logs_user_id_fkey');
  await assert.rejects(db.query(`INSERT INTO audit_logs(user_id,action,actor_user_id) VALUES(NULL,'null_actor_fixture',$1)`,[support]),
    error => error.code==='23502' && error.column==='user_id');

  await db.query(`UPDATE profiles SET full_name='',email=NULL WHERE id=$1`,[historicalActor]);
  assert.deepEqual((await db.query('SELECT user_id,actor_user_id,actor_name,actor_email FROM audit_logs WHERE id=$1',[historicalAudit])).rows[0],historicalSnapshot);
  const fallbackAudit = await scalar(`INSERT INTO audit_logs(user_id,action) VALUES($1,'auth_fallback_fixture') RETURNING id value`,[historicalActor]);
  assert.deepEqual((await db.query('SELECT actor_user_id,actor_name,actor_email FROM audit_logs WHERE id=$1',[fallbackAudit])).rows[0],{
    actor_user_id:historicalActor,actor_name:'Auth historical name',actor_email:'historical-auth@test.local',
  });

  // Simulate GoTrue's role: it can delete Auth users but has no direct access
  // to audit/profile tables or the snapshot trigger function.
  await db.exec(`CREATE ROLE fixture_auth_admin NOLOGIN;
    GRANT USAGE ON SCHEMA auth TO fixture_auth_admin;
    GRANT SELECT,DELETE ON auth.users TO fixture_auth_admin;`);
  assert.equal(await scalar(`SELECT has_table_privilege('fixture_auth_admin','public.audit_logs','UPDATE') value`),false);
  assert.equal(await scalar(`SELECT has_table_privilege('fixture_auth_admin','public.profiles','SELECT') value`),false);
  assert.equal(await scalar(`SELECT has_function_privilege('fixture_auth_admin','public.capture_audit_log_actor()','EXECUTE') value`),false);

  await actor(superadmin);
  await db.query('SELECT set_support_company_access($1,$2)',[support,[companyA]]);
  await actor(support);
  const deletedTargetSession = await scalar('SELECT start_support_impersonation($1,$2) value',[companyA,operator]);
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims','{}',false),set_config('request.headers','{}',false)`);
  const targetAudit = await scalar(`INSERT INTO audit_logs(user_id,action) VALUES($1,'deleted_target_fixture') RETURNING id value`,[operator]);
  await db.exec('SET ROLE fixture_auth_admin');
  await db.query('DELETE FROM auth.users WHERE id=$1',[operator]);
  await db.exec('RESET ROLE');
  assert.equal(await scalar('SELECT count(*) value FROM support_impersonation_sessions WHERE id=$1',[deletedTargetSession.id]),0);
  assert.equal(await scalar('SELECT count(*) value FROM profiles WHERE id=$1',[operator]),0);
  assert.equal(await scalar('SELECT count(*) value FROM user_roles WHERE user_id=$1',[operator]),0);
  assert.equal(await scalar('SELECT count(*) value FROM company_user_panel_permissions WHERE user_id=$1',[operator]),0);
  assert.deepEqual((await db.query('SELECT user_id,actor_user_id,actor_name,actor_email FROM audit_logs WHERE id=$1',[targetAudit])).rows[0],{
    user_id:null,actor_user_id:operator,actor_name:'Operador',actor_email:'operator@test.local',
  });

  await actor(support);
  await db.query('SELECT start_support_impersonation($1,$2)',[companyA,admin]);
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims','{}',false),set_config('request.headers','{}',false)`);
  const auditsBeforeDeletion = (await db.query('SELECT id,action,entity_type,entity_id,details,actor_user_id,actor_name,actor_email FROM audit_logs ORDER BY id')).rows;
  assert.equal(auditsBeforeDeletion.filter(log => log.actor_user_id===support).length>0,true);
  await db.exec('SET ROLE fixture_auth_admin');
  await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[support,historicalActor]]);
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT id,action,entity_type,entity_id,details,actor_user_id,actor_name,actor_email FROM audit_logs ORDER BY id')).rows,auditsBeforeDeletion);
  assert.deepEqual((await db.query('SELECT user_id,actor_user_id,actor_name,actor_email FROM audit_logs WHERE id=$1',[spoofedAudit])).rows[0],{...supportSnapshot,user_id:null});
  assert.deepEqual((await db.query('SELECT user_id,actor_user_id,actor_name,actor_email FROM audit_logs WHERE id=$1',[historicalAudit])).rows[0],{...historicalSnapshot,user_id:null});
  assert.equal(await scalar('SELECT count(*) value FROM audit_logs WHERE actor_user_id=ANY($1::uuid[]) AND user_id IS NOT NULL',[[support,operator,historicalActor]]),0);
  assert.equal(await scalar('SELECT count(*) value FROM support_company_access WHERE user_id=$1',[support]),0);
  assert.equal(await scalar('SELECT count(*) value FROM support_impersonation_sessions WHERE actor_user_id=$1',[support]),0);
  assert.equal(await scalar('SELECT count(*) value FROM profiles WHERE id=$1',[support]),0);
  assert.equal(await scalar('SELECT count(*) value FROM user_roles WHERE user_id=$1',[support]),0);
  assert.equal(await scalar('SELECT count(*) value FROM auth.users WHERE id=ANY($1::uuid[])',[[superadmin,admin]]),2);
  assert.equal(await scalar('SELECT count(*) value FROM reservations WHERE id=ANY($1::uuid[])',[[reservationA,reservationB]]),2);
  await assert.rejects(db.query('UPDATE audit_logs SET user_id=$1 WHERE id=$2',[superadmin,spoofedAudit]),error => error.code==='23514');
  console.log('Audit actor deletion regression passed: historical/new snapshots, canonical inserts, immutable identity, FK validation, restricted Auth role, preserved history, and support actor/target cascades.');
  console.log(`Support live-funnel regression passed (same 1,004 sessions; invoker ${previousLiveMs.toFixed(1)} ms -> guarded RPC ${fixedLiveMs.toFixed(1)} ms locally; tenant/permission/login/expiry/revocation/anonymous boundaries).`);
  console.log(`Support full-schema migration replay passed (${files.length} actual migrations, inert cron/net; real RLS and company RPCs).`);
} catch (error) {
  console.error(error.message);
  if (error.cause) console.error(error.cause.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
