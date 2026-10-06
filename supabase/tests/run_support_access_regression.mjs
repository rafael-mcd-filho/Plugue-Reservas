import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const db = new PGlite();
const ids = {
  superadmin: '00000000-0000-4000-8000-000000000001',
  support: '00000000-0000-4000-8000-000000000002',
  otherSupport: '00000000-0000-4000-8000-000000000003',
  admin: '00000000-0000-4000-8000-000000000004',
  operator: '00000000-0000-4000-8000-000000000005',
  companyA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  companyB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  login: '11111111-1111-4111-8111-111111111111',
  otherLogin: '22222222-2222-4222-8222-222222222222',
};

// Minimal deployed schema plus representative real policy shapes. The actual
// permission migration and both new migrations are executed without rewriting.
const bootstrap = String.raw`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE TABLE auth.users(id uuid PRIMARY KEY, banned_until timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');
CREATE TABLE public.companies(id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL, status text NOT NULL DEFAULT 'active');
CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id), full_name text, email text, company_id uuid REFERENCES companies(id), is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.user_roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id), role public.app_role NOT NULL, company_id uuid REFERENCES companies(id));
CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id), action text NOT NULL, entity_type text, entity_id uuid, details jsonb);
CREATE TABLE public.company_user_panel_permissions(user_id uuid REFERENCES auth.users(id), company_id uuid REFERENCES companies(id), permission_overrides jsonb, PRIMARY KEY(user_id, company_id));
CREATE TABLE public.reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), date date NOT NULL, status text NOT NULL, party_size integer NOT NULL DEFAULT 1);
CREATE TABLE public.tenant_children(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid NOT NULL REFERENCES reservations(id));
CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES companies(id), user_id uuid REFERENCES auth.users(id));
CREATE TABLE public.system_settings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text, value text);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
CREATE FUNCTION storage.foldername(_name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(_name, '/'); $$;
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = _role); $$;
CREATE FUNCTION public.has_role_in_company(_user_id uuid, _role public.app_role, _company_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = _role AND company_id = _company_id); $$;
CREATE FUNCTION public.get_my_memberships() RETURNS TABLE(role public.app_role, company_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT ur.role, ur.company_id FROM public.user_roles ur WHERE ur.user_id = auth.uid(); $$;
CREATE FUNCTION public.fixture_company_rpc(_company_id uuid) RETURNS SETOF public.reservations LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT r.* FROM public.reservations r WHERE r.company_id = _company_id AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.company_id = _company_id); $$;
CREATE FUNCTION public.fixture_public_actor() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid(); $$;
CREATE FUNCTION public.fixture_audited_mutation(_company_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role_in_company(auth.uid(), 'admin', _company_id) THEN RAISE EXCEPTION 'denied' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.audit_logs(user_id, action, details) VALUES(auth.uid(), 'fixture_mutation', '{}'); RETURN true;
END; $$;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_children ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_user_panel_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Superadmins can manage all companies" ON companies FOR ALL TO authenticated USING(public.has_role(auth.uid(), 'superadmin')) WITH CHECK(public.has_role(auth.uid(), 'superadmin'));
CREATE POLICY "Users can view their own company" ON companies FOR SELECT TO authenticated USING(id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));
CREATE POLICY "Public companies" ON companies FOR SELECT TO PUBLIC USING(status = 'active');
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT TO authenticated USING(id = auth.uid());
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE TO authenticated USING(id = auth.uid()) WITH CHECK(id = auth.uid());
CREATE POLICY "Admins can view company profiles" ON profiles FOR SELECT TO authenticated USING(public.has_role_in_company(auth.uid(), 'admin', company_id));
CREATE POLICY "Users can view own roles" ON user_roles FOR SELECT TO authenticated USING(user_id = auth.uid());
CREATE POLICY "Superadmins can manage all roles" ON user_roles FOR ALL TO authenticated USING(public.has_role(auth.uid(), 'superadmin')) WITH CHECK(public.has_role(auth.uid(), 'superadmin'));
CREATE POLICY "Admins can manage roles in their company" ON user_roles FOR ALL TO authenticated USING(public.has_role_in_company(auth.uid(), 'admin', company_id)) WITH CHECK(public.has_role_in_company(auth.uid(), 'admin', company_id) AND role <> 'superadmin');
CREATE POLICY "Company staff can view reservations" ON reservations FOR SELECT TO authenticated USING(public.has_role_in_company(auth.uid(), 'admin', company_id) OR public.has_role_in_company(auth.uid(), 'operator', company_id));
CREATE POLICY "Superadmin reservations" ON reservations FOR ALL TO authenticated USING(public.has_role(auth.uid(), 'superadmin')) WITH CHECK(public.has_role(auth.uid(), 'superadmin'));
CREATE POLICY "Public insert reservation" ON reservations FOR INSERT TO authenticated WITH CHECK(true);
CREATE POLICY "Children follow reservations" ON tenant_children FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM reservations r WHERE r.id = reservation_id));
CREATE POLICY "Public insert child" ON tenant_children FOR INSERT TO authenticated WITH CHECK(true);
CREATE POLICY "Superadmin logs" ON audit_logs FOR SELECT TO authenticated USING(public.has_role(auth.uid(), 'superadmin'));
CREATE POLICY "Own company notifications" ON notifications FOR SELECT TO authenticated USING(company_id IN (SELECT company_id FROM user_roles WHERE user_id = auth.uid()));
CREATE POLICY "Own overrides" ON company_user_panel_permissions FOR SELECT TO authenticated USING(user_id = auth.uid());
CREATE POLICY "Superadmin overrides" ON company_user_panel_permissions FOR SELECT TO authenticated USING(public.has_role(auth.uid(), 'superadmin'));
CREATE POLICY "Superadmin settings" ON system_settings FOR ALL TO authenticated USING(public.has_role(auth.uid(), 'superadmin')) WITH CHECK(public.has_role(auth.uid(), 'superadmin'));
CREATE POLICY "Public assets" ON storage.objects FOR SELECT TO PUBLIC USING(bucket_id = 'system-assets');
CREATE POLICY "Admin logo upload" ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id = 'system-assets' AND (storage.foldername(name))[1] = 'company-logos' AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.company_id::text = (storage.foldername(name))[2]));
GRANT USAGE ON SCHEMA public, auth, storage TO authenticated, service_role;
GRANT USAGE ON SCHEMA public, auth, storage TO anon;
GRANT SELECT ON companies TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, storage TO authenticated;
`;

async function actor(userId, sessionId = ids.login, impersonationId = null) {
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)`, [
    JSON.stringify({ sub: userId, session_id: sessionId, role: 'authenticated' }),
    JSON.stringify(impersonationId ? { 'x-support-impersonation': impersonationId } : {}),
  ]);
  await db.exec('SET ROLE authenticated');
}
async function scalar(sql, params = []) { return (await db.query(sql, params)).rows[0]?.value; }
async function rejected(sql, params = [], code = '42501') {
  await assert.rejects(db.query(sql, params), error => error.code === code);
}
async function owner(sql, params = []) { await db.exec('RESET ROLE'); return db.query(sql, params); }

try {
  // The enum alteration deliberately executes in its own committed transaction.
  await db.exec(bootstrap);
  await db.exec(await readFile(resolve(root, 'supabase/migrations/20260422151000_add_company_panel_permission_helper_and_reservation_delete_rpc.sql'), 'utf8'));
  await db.exec(await readFile(resolve(root, 'supabase/migrations/20261006120000_add_support_role.sql'), 'utf8'));
  await db.exec(await readFile(resolve(root, 'supabase/migrations/20261006121000_add_support_access_and_impersonation.sql'), 'utf8'));
  await owner(`INSERT INTO auth.users(id) SELECT unnest($1::uuid[])`, [[ids.superadmin, ids.support, ids.otherSupport, ids.admin, ids.operator]]);
  await owner(`INSERT INTO companies(id,name,slug) VALUES($1,'Empresa A','empresa-a'),($2,'Empresa B','empresa-b')`, [ids.companyA, ids.companyB]);
  for (const [key, name] of [['superadmin', 'Superadmin'], ['support', 'Suporte'], ['otherSupport', 'Outro suporte'], ['admin', 'Admin'], ['operator', 'Operador']]) {
    await owner(`INSERT INTO profiles(id,full_name,email,company_id) VALUES($1,$2,$3,$4)`, [ids[key], name, `${key}@test.local`, ['admin', 'operator'].includes(key) ? ids.companyA : null]);
  }
  await owner(`INSERT INTO user_roles(user_id,role,company_id) VALUES($1,'superadmin',NULL),($2,'support',NULL),($3,'support',NULL),($4,'admin',$6),($4,'admin',$7),($5,'operator',$6),($5,'operator',$7)`, [ids.superadmin, ids.support, ids.otherSupport, ids.admin, ids.operator, ids.companyA, ids.companyB]);
  await owner(`INSERT INTO company_user_panel_permissions VALUES($1,$2,'{"reservations_delete":false,"calendar_view":false}')`, [ids.operator, ids.companyA]);
  await owner(`INSERT INTO reservations(company_id,date,status,party_size) VALUES($1,'2026-10-06','confirmed',3),($1,'2026-10-06','checked_in',2),($1,'2026-10-07','cancelled',4),($2,'2026-10-06','confirmed',100)`, [ids.companyA, ids.companyB]);
  await owner(`INSERT INTO tenant_children(reservation_id) SELECT id FROM reservations`);
  await owner(`INSERT INTO notifications(company_id,user_id) VALUES($1,$3),($2,$3)`, [ids.companyA, ids.companyB, ids.admin]);
  await owner(`INSERT INTO system_settings(key,value) VALUES('secret','must not be visible')`);

  await db.query(`SELECT set_config('request.jwt.claims','{}',false), set_config('request.headers','{}',false)`);
  await db.exec('SET ROLE anon');
  assert.equal((await db.query('SELECT * FROM companies')).rows.length, 2);
  assert.equal(await scalar('SELECT fixture_public_actor() value'), null);
  await rejected('SELECT support_list_companies()');

  await actor(ids.superadmin);
  assert.equal(await scalar('SELECT public.set_support_company_access($1,$2) value', [ids.support, [ids.companyA]]), true);
  await actor(ids.support);
  assert.deepEqual((await db.query('SELECT * FROM public.support_list_companies()')).rows.map(c => c.id), [ids.companyA]);
  assert.equal(await scalar('SELECT public.effective_auth_uid() value'), null);
  assert.equal((await db.query('SELECT * FROM reservations')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM companies')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM profiles')).rows[0].id, ids.support);
  assert.deepEqual((await db.query('SELECT * FROM get_my_memberships()')).rows, [{ role: 'support', company_id: null }]);
  assert.equal((await db.query('SELECT * FROM public.support_list_impersonation_candidates($1)', [ids.companyB])).rows.length, 0);
  await rejected('SELECT public.start_support_impersonation($1,$2)', [ids.companyB, ids.admin]);
  await rejected('SELECT public.set_support_company_access($1,$2)', [ids.support, [ids.companyB]]);
  await rejected(`INSERT INTO reservations(company_id,date,status) VALUES($1,'2026-10-06','confirmed')`, [ids.companyA]);
  const dashboard = await scalar('SELECT support_dashboard(NULL,$1,$2) value', ['2026-10-06', '2026-10-06']);
  assert.deepEqual(dashboard, { companyCount: 1, reservationCount: 2, confirmedCount: 1, checkedInCount: 1, cancelledCount: 0, noShowCount: 0, totalGuests: 5 });
  await rejected('SELECT support_dashboard($1,$2,$3)', [ids.companyB, '2026-10-06', '2026-10-06']);
  await rejected('SELECT support_dashboard(NULL,$1,$2)', ['2026-10-07', '2026-10-06'], '22023');

  const operatorSession = await scalar('SELECT start_support_impersonation($1,$2) value', [ids.companyA, ids.operator]);
  assert.equal(operatorSession.actorUserId, ids.support);
  assert.equal(operatorSession.effectiveRole, 'operator');
  await actor(ids.support, ids.login, operatorSession.id);
  assert.equal(await scalar('SELECT effective_auth_uid() value'), ids.operator);
  assert.equal(await scalar('SELECT auth.uid() value'), ids.support);
  assert.equal(await scalar(`SELECT has_company_panel_permission($1,$2,'calendar_view') value`, [ids.support, ids.companyA]), false);
  assert.equal(await scalar(`SELECT has_company_panel_permission($1,$2,'reservations_view') value`, [ids.support, ids.companyA]), true);
  assert.equal(await scalar(`SELECT has_company_panel_permission($1,$2,'reservations_view') value`, [ids.support, ids.companyB]), false);
  assert.equal(await scalar(`SELECT has_role($1,'superadmin') value`, [ids.superadmin]), false);
  assert.equal((await db.query('SELECT * FROM reservations')).rows.length, 3);
  assert.equal((await db.query('SELECT * FROM tenant_children')).rows.length, 3);
  assert.equal((await db.query('SELECT * FROM fixture_company_rpc($1)', [ids.companyB])).rows.length, 0);
  const reservationA = (await db.query('SELECT id FROM reservations LIMIT 1')).rows[0].id;
  await rejected('SELECT delete_company_reservation($1)', [reservationA], 'P0001');
  await rejected(`INSERT INTO reservations(company_id,date,status) VALUES($1,'2026-10-06','confirmed')`, [ids.companyB]);
  const reservationB = (await owner('SELECT id FROM reservations WHERE company_id = $1', [ids.companyB])).rows[0].id;
  await actor(ids.support, ids.login, operatorSession.id);
  await rejected('INSERT INTO tenant_children(reservation_id) VALUES($1)', [reservationB]);
  assert.equal((await db.query('SELECT * FROM system_settings')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM audit_logs')).rows.length, 0);

  // Stealing a session UUID is insufficient: both actor and Auth session match.
  await actor(ids.otherSupport, ids.login, operatorSession.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  await actor(ids.support, ids.otherLogin, operatorSession.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  assert.equal((await db.query('SELECT * FROM reservations')).rows.length, 0);
  await actor(ids.support, ids.login, 'not-a-uuid');
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);

  await actor(ids.support);
  const adminSession = await scalar('SELECT start_support_impersonation($1,$2) value', [ids.companyA, ids.admin]);
  await actor(ids.support, ids.login, operatorSession.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  await actor(ids.support, ids.login, adminSession.id);
  assert.equal(await scalar(`SELECT has_role_in_company($1,'admin',$2) value`, [ids.support, ids.companyA]), true);
  assert.equal(await scalar(`SELECT has_role_in_company($1,'admin',$2) value`, [ids.support, ids.companyB]), false);
  assert.equal((await db.query('SELECT * FROM notifications')).rows.length, 1);
  await db.query('SELECT fixture_audited_mutation($1)', [ids.companyA]);
  await rejected('SELECT fixture_audited_mutation($1)', [ids.companyB]);
  const log = (await owner(`SELECT user_id FROM audit_logs WHERE action = 'fixture_mutation'`)).rows[0];
  assert.equal(log.user_id, ids.support);
  await actor(ids.support, ids.login, adminSession.id);
  await db.query(`INSERT INTO storage.objects(bucket_id,name) VALUES('system-assets',$1)`, [`company-logos/${ids.companyA}/logo.png`]);
  await rejected(`INSERT INTO storage.objects(bucket_id,name) VALUES('system-assets',$1)`, [`company-logos/${ids.companyB}/logo.png`]);

  // Live invalidation has no cache window at the authorization boundary.
  await owner(`UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1`, [ids.admin]);
  await actor(ids.support, ids.login, adminSession.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  assert.equal((await db.query('SELECT * FROM support_list_impersonation_candidates($1)', [ids.companyA])).rows.some(row => row.user_id === ids.admin), false);
  await owner('UPDATE auth.users SET banned_until=NULL WHERE id=$1', [ids.admin]);
  await actor(ids.support, ids.login, adminSession.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  const beforeActorBan = await scalar('SELECT start_support_impersonation($1,$2) value', [ids.companyA, ids.admin]);
  await owner(`UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1`, [ids.support]);
  await actor(ids.support, ids.login, beforeActorBan.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  await rejected('SELECT support_dashboard()');
  await owner('UPDATE auth.users SET banned_until=NULL WHERE id=$1', [ids.support]);
  await actor(ids.support, ids.login, beforeActorBan.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  const beforeDeactivation = await scalar('SELECT start_support_impersonation($1,$2) value', [ids.companyA, ids.admin]);
  await owner('UPDATE profiles SET is_active = false WHERE id = $1', [ids.admin]);
  await actor(ids.support, ids.login, beforeDeactivation.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  await owner('UPDATE profiles SET is_active = true WHERE id = $1', [ids.admin]);
  await actor(ids.support, ids.login, beforeDeactivation.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  const beforeGrantRemoval = await scalar('SELECT start_support_impersonation($1,$2) value', [ids.companyA, ids.admin]);
  await actor(ids.superadmin);
  await db.query('SELECT set_support_company_access($1,$2)', [ids.support, []]);
  await actor(ids.support, ids.login, beforeGrantRemoval.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  assert.equal((await db.query('SELECT * FROM reservations')).rows.length, 0);
  await actor(ids.superadmin);
  await db.query('SELECT set_support_company_access($1,$2)', [ids.support, [ids.companyA]]);
  await actor(ids.support, ids.login, beforeGrantRemoval.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  await actor(ids.support);
  const expired = await scalar('SELECT start_support_impersonation($1,$2) value', [ids.companyA, ids.admin]);
  await owner(`UPDATE support_impersonation_sessions SET started_at = now()-interval '2 hours', expires_at = now()-interval '1 hour' WHERE id = $1`, [expired.id]);
  await actor(ids.support, ids.login, expired.id);
  assert.equal(await scalar('SELECT get_support_impersonation_context() value'), null);
  const stopped = await scalar('SELECT start_support_impersonation($1,$2) value', [ids.companyA, ids.admin]);
  assert.equal(await scalar('SELECT stop_support_impersonation($1) value', [stopped.id]), true);
  assert.equal(await scalar('SELECT stop_support_impersonation($1) value', [stopped.id]), false);

  await actor(ids.admin);
  await rejected('SELECT set_support_company_access($1,$2)', [ids.support, [ids.companyB]]);
  await rejected(`INSERT INTO user_roles(user_id,role,company_id) VALUES($1,'support',NULL)`, [ids.operator], '23514');
  await rejected(`UPDATE user_roles SET role='support' WHERE user_id=$1 AND company_id=$2`, [ids.operator, ids.companyA], '23514');
  await owner('SELECT 1');
  await rejected(`INSERT INTO user_roles(user_id,role,company_id) VALUES($1,'admin',$2)`, [ids.support, ids.companyA], '23514');
  console.log('Support access regression passed: scoped RLS/RPCs, Auth-session binding, exact operator permissions, audit actors, storage, and live revocation.');
} finally {
  await db.close();
}
