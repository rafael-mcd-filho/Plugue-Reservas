import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Offline PostgreSQL: real public creation RPC, feature contract and delegated
// role helpers. Schedule/identity tables are fixtures; no provider is contacted.
const db = new PGlite();
const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const admin = '00000000-0000-4000-8000-000000000001';
const operator = '00000000-0000-4000-8000-000000000002';
const support = '00000000-0000-4000-8000-000000000003';
const outsider = '00000000-0000-4000-8000-000000000004';
const superadmin = '00000000-0000-4000-8000-000000000005';
const supportSession = '11111111-1111-4111-8111-111111111111';
const loginSession = '22222222-2222-4222-8222-222222222222';
const day = '2030-01-01';
const migration = (file) => readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8');
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
async function loadFunction(file, name) {
  const sql = await migration(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `Missing function ${name}`);
  const end = sql.indexOf('$$;', start);
  assert.ok(end > start, `Missing function end ${name}`);
  await db.exec(sql.slice(start, end + 3));
}
async function actor(role, userId = null, impersonation = null) {
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims',$1,false), set_config('request.headers',$2,false)`, [
    JSON.stringify({ role, sub: userId, session_id: loginSession }),
    JSON.stringify(impersonation ? { 'x-support-impersonation': impersonation } : {}),
  ]);
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`SET ROLE ${role}`);
}
async function create(company = companyA, date = day, status = 'confirmed') {
  return scalar('SELECT (public.create_public_reservation($1::jsonb,$2)).id AS value', [
    JSON.stringify({ company_id: company, date, time: '18:00', guest_name: 'Cliente', guest_phone: '+5511999999999', party_size: 2 }), status,
  ]);
}
async function blocked(operation) {
  await assert.rejects(operation, (error) => error.code === '42501' && /fluxo de pagamento/.test(error.message));
}

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role'$$;
    CREATE TYPE public.app_role AS ENUM ('superadmin','admin','operator','support');
    CREATE TABLE auth.users(id uuid PRIMARY KEY,banned_until timestamptz);
    CREATE TABLE companies(id uuid PRIMARY KEY,name text,slug text,status text DEFAULT 'active',plan_tier text DEFAULT 'enterprise',reservation_duration integer DEFAULT 60,max_guests_per_slot integer DEFAULT 10000);
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text,email text,company_id uuid,is_active boolean DEFAULT true);
    CREATE TABLE user_roles(user_id uuid,role public.app_role,company_id uuid);
    CREATE TABLE company_user_panel_permissions(user_id uuid,company_id uuid,permission_overrides jsonb);
    CREATE TABLE support_company_access(user_id uuid,company_id uuid);
    CREATE TABLE support_impersonation_sessions(id uuid PRIMARY KEY,actor_user_id uuid,auth_session_id uuid,target_user_id uuid,company_id uuid,ended_at timestamptz,expires_at timestamptz);
    CREATE TABLE company_feature_overrides(company_id uuid,feature_key text,enabled boolean);
    CREATE TABLE reservation_payment_rules(company_id uuid,enabled boolean,date_start date,date_end date,archived_at timestamptz);
    CREATE TABLE reservations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),public_tracking_code text,company_id uuid,table_id uuid,
      guest_name text,guest_phone text,guest_email text,guest_birthdate date,date date,time time,party_size integer,
      duration_minutes integer,status text,occasion text,notes text,visitor_id text,origin_tracking_session_id uuid,
      origin_tracking_journey_id uuid,origin_anonymous_id text,origin_affiliate_link_id uuid,origin_affiliate_code text,
      origin_affiliate_name text,origin_fbp text,origin_fbc text,attribution_snapshot jsonb,source text,
      applied_schedule_rule_id uuid,created_in_mode text,created_at timestamptz DEFAULT now());
    CREATE TABLE blocked_dates(company_id uuid,date date,all_day boolean,start_time time,end_time time);
    CREATE TABLE reservation_schedule_rule_slots(time time,duration_minutes integer,max_party_size_per_reservation integer,max_reservations_per_slot integer,max_guests_per_slot integer,block_id uuid,rule_id uuid,sort_order integer,created_at timestamptz);
    INSERT INTO reservation_schedule_rule_slots VALUES('18:00',60,20,NULL,10000,NULL,'99999999-9999-4999-8999-999999999999',0,now());
    CREATE FUNCTION get_public_reservation_schedule(uuid,date)
      RETURNS TABLE(source text,slots jsonb,availability_mode text,default_duration_minutes integer,max_party_size_per_reservation integer,rule_id uuid,block_id uuid)
      LANGUAGE sql AS $$SELECT 'rule','["18:00"]'::jsonb,'capacity',60,20,'99999999-9999-4999-8999-999999999999'::uuid,NULL::uuid$$;
    CREATE FUNCTION is_reservation_occupying_capacity(uuid,text,timestamptz) RETURNS boolean LANGUAGE sql AS $$SELECT $2 IN ('confirmed','pending_payment')$$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT ALL ON reservations TO anon,authenticated,service_role;
  `);
  const supportSql = await migration('20261006121000_add_support_access_and_impersonation');
  const helperStart = supportSql.indexOf('CREATE FUNCTION public.is_support_actor()');
  const helperEnd = supportSql.indexOf('CREATE POLICY "Support and superadmin can view support grants"');
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  await db.exec(supportSql.slice(helperStart, helperEnd));
  await loadFunction('20260526010000_restore_reservation_prepayment_feature_flag', 'company_feature_enabled');
  await loadFunction('20260611120000_complete_reservation_capacity_contract', 'create_public_reservation');
  await db.exec('REVOKE ALL ON FUNCTION create_public_reservation(jsonb,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION create_public_reservation(jsonb,text) TO anon,authenticated,service_role;');
  await db.query(`INSERT INTO companies(id,name,slug) VALUES($1,'Empresa A','a'),($2,'Empresa B','b');`, [companyA, companyB]);
  for (const [id, role, company] of [[admin,'admin',companyA],[admin,'admin',companyB],[operator,'operator',companyA],[support,'support',null],[superadmin,'superadmin',null]]) {
    await db.query('INSERT INTO auth.users(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    await db.query('INSERT INTO profiles(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    await db.query('INSERT INTO user_roles(user_id,role,company_id) VALUES($1,$2,$3)', [id,role,company]);
  }
  await db.query(`INSERT INTO company_feature_overrides VALUES($1,'reservation_prepayment',true),($2,'reservation_prepayment',true)`, [companyA,companyB]);
  await db.query('INSERT INTO reservation_payment_rules VALUES($1,true,$3,$3,NULL),($2,true,$3,$3,NULL)', [companyA,companyB,day]);
  await db.query('INSERT INTO support_company_access VALUES($1,$2)', [support,companyA]);
  await db.query(`INSERT INTO support_impersonation_sessions VALUES($1,$2,$3,$4,$5,NULL,now()+interval '1 hour')`, [supportSession,support,loginSession,admin,companyA]);

  const guardSql = await migration('20261107143000_require_public_reservation_prepayment');
  await db.exec(guardSql);
  await db.exec(guardSql); // Idempotent replay.
  await actor('anon');
  await blocked(() => create());
  await blocked(() => create(companyA,day,'pending_payment'));
  await blocked(() => db.query(`INSERT INTO reservations(company_id,date,status) VALUES($1,$2,'confirmed')`, [companyA,day]));
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservations'), 0, 'denied creation leaves no orphan reservation');
  assert.ok(await create(companyA,'2030-01-02'), 'public dates without a payment rule remain available');
  await blocked(() => create(companyA,'2030-01-02','pending_payment'));

  await actor('authenticated', outsider);
  await blocked(() => create());
  await actor('authenticated', operator);
  assert.ok(await create(), 'manual operator bookings remain allowed');
  await blocked(() => create(companyB));
  await actor('authenticated', admin);
  assert.ok(await create(), 'manual admin bookings remain allowed');
  await actor('authenticated', superadmin);
  assert.ok(await create(), 'manual superadmin bookings remain allowed');
  await actor('authenticated', support);
  await blocked(() => create());
  await actor('authenticated', support, supportSession);
  assert.ok(await create(), 'valid delegated support retains panel booking access');
  await blocked(() => create(companyB)); // Target admin also belongs to B; delegation must stay in A.
  await db.exec('RESET ROLE');
  await db.query(`UPDATE support_impersonation_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1`, [supportSession]);
  await actor('authenticated', support, supportSession);
  await blocked(() => create());
  await actor('service_role');
  assert.ok(await create(companyA,day,'pending_payment'), 'payment Edge Function can create its pending reservation');
  assert.ok(await create(), 'trusted backend creation remains supported');

  // Disabled/archived rules and a disabled feature must preserve existing
  // public booking behavior rather than forcing prepayment on unrelated dates.
  await db.exec('RESET ROLE');
  await db.query('UPDATE reservation_payment_rules SET enabled=false WHERE company_id=$1', [companyA]);
  await actor('anon');
  assert.ok(await create());
  await db.exec('RESET ROLE');
  await db.query('UPDATE reservation_payment_rules SET enabled=true,archived_at=now() WHERE company_id=$1', [companyA]);
  await actor('anon');
  assert.ok(await create());
  await db.exec('RESET ROLE');
  await db.query('UPDATE reservation_payment_rules SET archived_at=NULL WHERE company_id=$1', [companyA]);
  await db.query('UPDATE company_feature_overrides SET enabled=false WHERE company_id=$1', [companyA]);
  await actor('anon');
  assert.ok(await create());
  console.log('Public reservation prepayment SQL regressions passed (anonymous bypass, orphan prevention, staff, service role and delegated support).');
} catch (error) {
  console.error({ message: error.message, code: error.code, where: error.where });
  process.exitCode = 1;
} finally { await db.close(); }
