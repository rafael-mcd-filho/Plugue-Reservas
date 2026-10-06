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
const superadmin = '00000000-0000-4000-8000-000000000001';
const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const login = '11111111-1111-4111-8111-111111111111';

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
  for (const file of files) {
    if (file === '20260309211714_c61ee570-889c-44b5-9189-83eb8dc93983.sql') {
      // Historical demo data expects objects that were created through the app.
      await db.exec(`INSERT INTO companies(id,name,slug) VALUES('1e0da55b-f8e9-4199-80b6-79c64e93cb7a','Historical demo fixture','historical-demo'); INSERT INTO restaurant_tables(id,company_id,number) VALUES('9a83e0fe-79e0-40e1-bdd5-1cfbab07752f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',1),('57be60f4-936e-42f9-ac7f-7f2049f5709f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',2);`);
    }
    const sql = (await readFile(resolve(migrationDirectory, file), 'utf8'))
      .replace(/CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)[^;]*;/gi, '')
      .replace(/CREATE INDEX CONCURRENTLY/gi, 'CREATE INDEX');
    try { await db.exec(sql); } catch (error) { throw new Error(`Migration replay failed in ${file}: ${error.message}`, { cause: error }); }
  }
  await db.query(`INSERT INTO companies(id,name,slug) VALUES($1,'Empresa A','empresa-a'),($2,'Empresa B','empresa-b')`, [companyA, companyB]);
  for (const [id, role, name] of [[superadmin, 'superadmin', 'Root'], [support, 'support', 'Suporte'], [admin, 'admin', 'Admin']]) {
    await db.query(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)`, [id, `${role}@test.local`, JSON.stringify({ full_name: name })]);
    await db.query('UPDATE profiles SET company_id=$2 WHERE id=$1', [id, role === 'admin' ? companyA : null]);
    await db.query('INSERT INTO user_roles(user_id,role,company_id) VALUES($1,$2,$3)', [id, role, role === 'admin' ? companyA : null]);
  }
  await db.query(`INSERT INTO user_roles(user_id,role,company_id) VALUES($1,'admin',$2)`, [admin, companyB]);
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
  console.log(`Support full-schema migration replay passed (${files.length} actual migrations, inert cron/net; real RLS and company RPCs).`);
} catch (error) {
  console.error(error.message);
  if (error.cause) console.error(error.cause.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
