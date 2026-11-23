import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Offline PostgreSQL with the published generic function and the additive
// announcement function. No Supabase, provider or real company is contacted.
const db = new PGlite();
const company = randomUUID(), otherCompany = randomUUID();
const admin = randomUUID(), operator = randomUUID(), otherUser = randomUUID(), superadmin = randomUUID();
let passed = 0;
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await rows(sql, args))[0];
async function owner() { await db.exec('RESET ROLE'); }
async function actor(id = admin, role = 'authenticated') {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  await db.exec(`SET ROLE ${role}`);
}
async function notices(limit = 20, companyId = company) {
  return rows('SELECT * FROM public.get_company_announcement_notifications($1,$2)', [companyId, limit]);
}
async function add(type, { user = admin, companyId = company, readAt = null, createdAt = '2026-11-22T12:00:00Z' } = {}) {
  await owner();
  const id = randomUUID();
  await db.query('INSERT INTO public.notifications(id,company_id,title,message,type,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [id, companyId, `${type} fixture`, 'Conteúdo fictício', type, createdAt]);
  await db.query('INSERT INTO public.notification_recipients(notification_id,company_id,user_id,read_at) VALUES($1,$2,$3,$4)',
    [id, companyId, user, readAt]);
  return id;
}
async function test(name, run) {
  await owner();
  await db.exec('TRUNCATE public.notifications,public.notification_recipients');
  await db.query('UPDATE public.profiles SET is_active=true WHERE id=$1', [admin]);
  try { await run(); console.log(`ok ${++passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
    CREATE TYPE public.app_role AS ENUM('superadmin','admin','operator','support');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,is_active boolean DEFAULT true);
    CREATE TABLE public.user_roles(user_id uuid,company_id uuid,role public.app_role);
    CREATE FUNCTION public.has_role_in_company(_user uuid,_role public.app_role,_company uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user AND company_id=_company AND role=_role)$$;
    CREATE TABLE public.notifications(id uuid PRIMARY KEY,company_id uuid,title text,message text,image_url text,type text NOT NULL,is_read boolean DEFAULT false,read_at timestamptz,created_by uuid,created_at timestamptz);
    CREATE TABLE public.notification_recipients(notification_id uuid,company_id uuid,user_id uuid,read_at timestamptz);
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
  `);
  await db.query('INSERT INTO public.profiles(id) VALUES($1),($2),($3),($4)', [admin, operator, otherUser, superadmin]);
  await db.query("INSERT INTO public.user_roles VALUES($1,$4,'admin'),($2,$4,'operator'),($3,$5,'admin'),($6,NULL,'superadmin')", [admin, operator, otherUser, company, otherCompany, superadmin]);

  const published = await readFile(new URL('../migrations/20260601150000_add_individual_notification_reads.sql', import.meta.url), 'utf8');
  const start = published.indexOf('CREATE OR REPLACE FUNCTION public.get_company_notifications(');
  const end = published.indexOf('\n$$;', start);
  await db.exec(published.slice(start, end + 4));
  const original = (await one("SELECT pg_get_functiondef('public.get_company_notifications(uuid,integer)'::regprocedure) AS definition")).definition;
  const migration = await readFile(new URL('../migrations/20261122151000_public_reservation_change_notices.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);

  const announcementBeforeAcl = (await one("SELECT pg_get_functiondef('public.get_company_announcement_notifications(uuid,integer)'::regprocedure) AS definition")).definition;
  await test('reproduces the explicit anon default grant that survives revoking PUBLIC, while the body still rejects anonymous callers', async () => {
    assert.equal((await one("SELECT has_function_privilege('anon','public.get_company_announcement_notifications(uuid,integer)','EXECUTE') AS allowed")).allowed, true);
    await actor(null, 'anon');
    await assert.rejects(() => notices(), /Nao autorizado/);
  });

  await owner();
  const aclFix = await readFile(new URL('../migrations/20261123110000_restrict_announcement_notifications_acl.sql', import.meta.url), 'utf8');
  await db.exec(aclFix);
  await db.exec(aclFix);
  await test('removes inherited anonymous execution idempotently without changing the function body or authenticated access', async () => {
    assert.equal((await one("SELECT pg_get_functiondef('public.get_company_announcement_notifications(uuid,integer)'::regprocedure) AS definition")).definition, announcementBeforeAcl);
    assert.equal((await one("SELECT has_function_privilege('anon','public.get_company_announcement_notifications(uuid,integer)','EXECUTE') AS allowed")).allowed, false);
    assert.equal((await one("SELECT has_function_privilege('authenticated','public.get_company_announcement_notifications(uuid,integer)','EXECUTE') AS allowed")).allowed, true);
    await actor(null, 'anon');
    await assert.rejects(() => notices(), { code: '42501' });
  });

  await test('adds an announcement RPC without replacing the generic notification contract', async () => {
    assert.equal((await one("SELECT pg_get_functiondef('public.get_company_notifications(uuid,integer)'::regprocedure) AS definition")).definition, original);
    assert.equal((await one("SELECT has_function_privilege('authenticated','public.get_company_announcement_notifications(uuid,integer)','EXECUTE') AS allowed")).allowed, true);
    assert.equal((await one("SELECT has_function_privilege('anon','public.get_company_announcement_notifications(uuid,integer)','EXECUTE') AS allowed")).allowed, false);
    assert.equal((await one("SELECT has_table_privilege('authenticated','public.notifications','SELECT') AS allowed")).allowed, false);
  });

  await test('filters operational changes before LIMIT so many changes cannot hide an older announcement', async () => {
    const announcement = await add('warning', { createdAt: '2026-11-20T12:00:00Z' });
    const otherType = await add('existing_custom_type', { createdAt: '2026-11-19T12:00:00Z' });
    for (let i = 0; i < 125; i++) await add('reservation_change', { createdAt: '2026-11-22T12:00:00Z' });
    await actor();
    assert.deepEqual((await notices(20)).map((row) => row.id), [announcement, otherType]);
    const generic = await rows('SELECT * FROM public.get_company_notifications($1,$2)', [company, 20]);
    assert.equal(generic.length, 20);
    assert.ok(generic.every((row) => row.type === 'reservation_change'));
  });

  await test('uses individual recipient reads and returns no other user or company recipients', async () => {
    const unread = await add('info');
    const read = await add('success', { readAt: '2026-11-22T13:00:00Z' });
    await add('info', { user: operator });
    await add('info', { user: otherUser, companyId: otherCompany });
    await actor();
    const result = await notices();
    assert.equal(result.length, 2);
    assert.equal(result.find((row) => row.id === unread).is_read, false);
    assert.equal(result.find((row) => row.id === read).is_read, true);
    await owner();
    assert.equal((await one('SELECT count(*) AS count FROM public.notification_recipients WHERE read_at IS NOT NULL')).count, 1);
  });

  await test('allows the company operator using the same role and active profile checks', async () => {
    const own = await add('info', { user: operator });
    await add('info');
    await actor(operator);
    assert.deepEqual((await notices()).map((row) => row.id), [own]);
  });

  await test('rejects a request outside the current company and a global superadmin without the original company role', async () => {
    await actor(admin);
    await assert.rejects(() => notices(20, otherCompany), /Nao autorizado/);
    await actor(superadmin);
    await assert.rejects(() => notices(), /Nao autorizado/);
  });

  await test('rejects an inactive or missing profile and anonymous calls', async () => {
    await db.query('UPDATE public.profiles SET is_active=false WHERE id=$1', [admin]);
    await actor();
    await assert.rejects(() => notices(), /Nao autorizado/);
    await owner();
    await db.query('DELETE FROM public.profiles WHERE id=$1', [admin]);
    await actor();
    await assert.rejects(() => notices(), /Nao autorizado/);
    await owner();
    await db.query('INSERT INTO public.profiles(id) VALUES($1)', [admin]);
    await actor(null, 'anon');
    await assert.rejects(() => notices(), { code: '42501' });
  });

  await test('keeps the existing default, minimum and maximum result bounds', async () => {
    for (let i = 0; i < 125; i++) await add('info');
    await actor();
    assert.equal((await notices(null)).length, 20);
    assert.equal((await notices(0)).length, 1);
    assert.equal((await notices(1000)).length, 100);
  });

  console.log(`Passed ${passed} public reservation change notice cases.`);
} finally {
  await db.close();
}
