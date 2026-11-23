import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const db = new PGlite();
const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const missingCompany = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const pausedCompany = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const deletingCompany = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const signature = 'public.reuse_unassigned_company_admin(uuid,text,text,text)';
let sequence = 0;

// Use real relationship and uniqueness constraints, and run the production
// migration unchanged. These accounts deliberately have no table privileges:
// the service-only SECURITY DEFINER function is the authorization boundary.
const bootstrap = String.raw`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE unrelated_client NOLOGIN;
CREATE SCHEMA auth;
CREATE TYPE public.app_role AS ENUM ('superadmin', 'support', 'admin', 'operator');
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text UNIQUE,
  encrypted_password text NOT NULL DEFAULT 'existing-password-hash',
  banned_until timestamptz,
  deleted_at timestamptz,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  deletion_requested_at timestamptz
);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  email text,
  phone text,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z'
);
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  UNIQUE (user_id, role, company_id)
);
CREATE TABLE public.support_company_access (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_company_access ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, unrelated_client;
`;

async function owner(sql, params = []) {
  await db.exec('RESET ROLE');
  return db.query(sql, params);
}

async function call(companyId, email, name = 'Returning owner', phone = '84999999999', role = 'service_role') {
  await db.exec(`SET ROLE ${role}`);
  try {
    return (await db.query(
      'SELECT public.reuse_unassigned_company_admin($1,$2,$3,$4) AS user_id',
      [companyId, email, name, phone],
    )).rows[0].user_id;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function fixture({ auth = {}, profile = {}, withProfile = true } = {}) {
  const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const email = auth.email ?? `returning-${sequence}@test.local`;
  await owner(
    'INSERT INTO auth.users(id,email,banned_until,deleted_at,raw_app_meta_data) VALUES($1,$2,$3,$4,$5)',
    [id, email, auth.banned_until ?? null, auth.deleted_at ?? null, auth.metadata ?? {}],
  );
  if (withProfile) {
    await owner(
      'INSERT INTO public.profiles(id,full_name,email,phone,company_id,is_active) VALUES($1,$2,$3,$4,$5,$6)',
      [id, 'Previous owner', profile.email ?? email, 'old-phone', profile.company_id ?? null, profile.is_active ?? true],
    );
  }
  return { id, email };
}

async function snapshot() {
  await db.exec('RESET ROLE');
  const state = {};
  for (const table of ['auth.users', 'public.profiles', 'public.user_roles', 'public.support_company_access', 'public.companies']) {
    state[table] = (await db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
  }
  return state;
}

async function blocked(label, invoke, code = '23505') {
  const before = await snapshot();
  await assert.rejects(invoke, error => error.code === code, label);
  assert.deepEqual(await snapshot(), before, `${label}: rejected request must not change any data`);
}

try {
  await db.exec(bootstrap);
  await db.exec(await readFile(resolve(root, 'supabase/migrations/20261015120000_allow_unassigned_company_admin_reuse.sql'), 'utf8'));
  await db.exec(await readFile(resolve(root, 'supabase/migrations/20261015121000_guard_account_reuse_during_provisioning.sql'), 'utf8'));
  await owner('INSERT INTO public.companies(id,name) VALUES($1,$3),($2,$4)', [companyA, companyB, 'Company A', 'Company B']);
  await owner("INSERT INTO public.companies(id,name,status,deletion_requested_at) VALUES($1,'Paused company','paused',NULL),($2,'Deleting company','active',now())", [pausedCompany, deletingCompany]);

  const permissions = (await owner(`
    SELECT rolname, has_function_privilege(rolname, $1, 'EXECUTE') AS allowed
    FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'unrelated_client') ORDER BY rolname
  `, [signature])).rows;
  assert.deepEqual(permissions, [
    { rolname: 'anon', allowed: false },
    { rolname: 'authenticated', allowed: false },
    { rolname: 'service_role', allowed: true },
    { rolname: 'unrelated_client', allowed: false },
  ]);
  assert.equal((await owner('SELECT prosecdef FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0].prosecdef, true);

  const returning = await fixture({
    auth: { email: '  Returning.Owner@Test.Local  ' },
    profile: { email: 'stale-profile-email@test.local' },
  });
  for (const role of ['anon', 'authenticated', 'unrelated_client']) {
    await blocked(`${role} cannot call the reuse function`, () => call(companyA, returning.email, 'Unauthorized', null, role), '42501');
  }

  // Auth is authoritative even if the profile email is stale. Case and outer
  // whitespace must not hide an existing login or create a second identity.
  const authBefore = (await owner('SELECT * FROM auth.users WHERE id=$1', [returning.id])).rows[0];
  assert.equal(await call(companyA, ' RETURNING.OWNER@test.local '), returning.id);
  assert.deepEqual((await owner('SELECT * FROM auth.users WHERE id=$1', [returning.id])).rows[0], authBefore, 'reuse preserves the existing Auth identity and password');
  const reusedProfile = (await owner('SELECT * FROM public.profiles WHERE id=$1', [returning.id])).rows[0];
  assert.equal(reusedProfile.company_id, companyA);
  assert.equal(reusedProfile.full_name, 'Returning owner');
  assert.equal(reusedProfile.email, 'returning.owner@test.local');
  assert.equal(reusedProfile.phone, '84999999999');
  assert.equal(reusedProfile.is_active, true);
  assert.ok(new Date(reusedProfile.updated_at) > new Date('2000-01-01T00:00:00Z'));
  assert.deepEqual((await owner('SELECT user_id,role,company_id FROM public.user_roles WHERE user_id=$1', [returning.id])).rows, [
    { user_id: returning.id, role: 'admin', company_id: companyA },
  ]);
  await blocked('a claimed login cannot be assigned to another company', () => call(companyB, returning.email));
  await blocked('repeated assignment cannot add duplicate roles', () => call(companyA, returning.email));

  const linked = await fixture({ profile: { company_id: companyB } });
  await blocked('profile still linked to a company', () => call(companyA, linked.email));
  const inactive = await fixture({ profile: { is_active: false } });
  await blocked('inactive profile', () => call(companyA, inactive.email));
  const noProfile = await fixture({ withProfile: false });
  await blocked('Auth account without a profile', () => call(companyA, noProfile.email));
  const deleted = await fixture({ auth: { deleted_at: '2026-01-01T00:00:00Z' } });
  await blocked('deleted Auth account', () => call(companyA, deleted.email));
  const banned = await fixture({ auth: { banned_until: '2999-01-01T00:00:00Z' } });
  await blocked('banned Auth account', () => call(companyA, banned.email));

  for (const role of ['superadmin', 'support', 'admin', 'operator']) {
    const global = await fixture();
    await owner('INSERT INTO public.user_roles(user_id,role,company_id) VALUES($1,$2,NULL)', [global.id, role]);
    await blocked(`existing global ${role} role`, () => call(companyA, global.email));
    if (role === 'admin' || role === 'operator') {
      const member = await fixture();
      await owner('INSERT INTO public.user_roles(user_id,role,company_id) VALUES($1,$2,$3)', [member.id, role, companyB]);
      await blocked(`existing company ${role} role`, () => call(companyA, member.email));
    }
  }
  const delegated = await fixture();
  await owner('INSERT INTO public.support_company_access(user_id,company_id) VALUES($1,$2)', [delegated.id, companyB]);
  await blocked('support access grant without a role', () => call(companyA, delegated.email));

  // Fresh Auth creation and profile/role provisioning are separate requests.
  // The server-owned marker reserves that account during the unassigned gap.
  const provisioning = await fixture({ auth: { metadata: { provisioning_company_id: companyA } } });
  await blocked('fresh account is reserved for another provisioning request', () => call(companyB, provisioning.email));
  await blocked('fresh account cannot be claimed through reuse even for the original company', () => call(companyA, provisioning.email));
  const pausedProvisioning = await fixture({ auth: { metadata: { provisioning_company_id: pausedCompany } } });
  await blocked('existing paused company still owns its provisioning marker', () => call(companyA, pausedProvisioning.email));

  // Retaining the marker must not stop the original returning-customer case:
  // once its company is deleted, the untouched Auth identity is reusable.
  const deletedOriginal = await fixture({ auth: { metadata: { provisioning_company_id: missingCompany } } });
  const markedAuthBefore = (await owner('SELECT * FROM auth.users WHERE id=$1', [deletedOriginal.id])).rows[0];
  assert.equal(await call(companyB, deletedOriginal.email), deletedOriginal.id);
  assert.deepEqual((await owner('SELECT * FROM auth.users WHERE id=$1', [deletedOriginal.id])).rows[0], markedAuthBefore);

  const rollback = await fixture();
  await owner(`CREATE FUNCTION public.fixture_reject_admin_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated role constraint failure' USING ERRCODE='23514'; END; $$`);
  await owner(`CREATE TRIGGER fixture_reject_admin_insert BEFORE INSERT ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_admin_insert()`);
  await blocked('role insertion failure rolls back the profile update', () => call(companyA, rollback.email), '23514');
  await owner('DROP TRIGGER fixture_reject_admin_insert ON public.user_roles');
  assert.equal(await call(companyA, rollback.email), rollback.id, 'a failed transaction must leave the account eligible for retry');

  const expiredBan = await fixture({ auth: { banned_until: '2000-01-01T00:00:00Z' } });
  assert.equal(await call(companyB, expiredBan.email, 'Owner after expired ban', null), expiredBan.id);
  assert.equal((await owner('SELECT phone FROM public.profiles WHERE id=$1', [expiredBan.id])).rows[0].phone, null);

  const valid = await fixture();
  await blocked('unknown Auth email', () => call(companyA, 'not-an-existing-login@test.local'));
  await fixture({ auth: { email: 'ambiguous@test.local' } });
  await fixture({ auth: { email: 'AMBIGUOUS@test.local' } });
  await blocked('ambiguous normalized Auth email', () => call(companyA, 'ambiguous@test.local'));
  await blocked('missing target company', () => call(missingCompany, valid.email), '22023');
  await blocked('paused target company', () => call(pausedCompany, valid.email), '22023');
  await blocked('target company pending deletion', () => call(deletingCompany, valid.email), '22023');
  await blocked('missing company ID', () => call(null, valid.email), '22023');
  await blocked('empty email', () => call(companyA, '   '), '22023');
  await blocked('missing email', () => call(companyA, null), '22023');
  assert.equal(await call(companyA, valid.email, '   ', '   '), valid.id);
  const fallback = (await owner('SELECT full_name,phone FROM public.profiles WHERE id=$1', [valid.id])).rows[0];
  assert.deepEqual(fallback, { full_name: 'Previous owner', phone: null });

  console.log('Company admin reuse regression passed: service-only access, canonical Auth lookup, identity preservation, eligibility conflicts, provisioning reservation, second-claim rejection, and atomic rollback.');
} finally {
  await db.close();
}
