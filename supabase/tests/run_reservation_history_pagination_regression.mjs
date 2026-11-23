import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';

// Execute the real invoker RPC and real PostgreSQL RLS without network, keys,
// Supabase services, provider requests or changes to any external database.
const db = new PGlite();
const companyA = randomUUID();
const companyB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const deniedUser = randomUUID();
const rlsDeniedUser = randomUUID();
const paymentHiddenUser = randomUUID();
let passed = 0;
let roleSet = false;
const signature = 'public.get_company_reservation_history(uuid,integer,integer,text,text,text,text,text,date,date,timestamptz,timestamptz)';
const migration = await readFile(new URL('../migrations/20261122130000_reservation_history_server_pagination.sql', import.meta.url), 'utf8');

async function one(sql, values = []) { return (await db.query(sql, values)).rows[0]; }
async function asOwner() { if (roleSet) { await db.exec('RESET ROLE'); roleSet = false; } }
async function actor(user = userA, role = 'authenticated', scope = '') {
  await asOwner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false),set_config('test.support_scope',$3,false)", [user ?? '', role, scope]);
  await db.exec(`SET ROLE ${role}`);
  roleSet = true;
}
async function history(overrides = {}) {
  const args = {
    company_id: companyA, page: 1, page_size: 15, search: '', operational_filter: 'all', status: 'all', entry_method: 'all', date_filter_mode: 'reservation',
    start_date: null, end_date: null, created_start_at: null, created_end_at: null, ...overrides,
  };
  return (await one('SELECT public.get_company_reservation_history($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS result', Object.values(args))).result;
}
async function insert(values = {}) {
  await asOwner();
  const row = { id: randomUUID(), company_id: companyA, guest_name: 'Isolated fixture', guest_phone: '+5562999988776', guest_phone_e164: null, date: '2026-11-22', time: '18:00', party_size: 2, checked_in_party_size: null, status: 'confirmed', source: 'reservation', origin_affiliate_link_id: null, origin_tracking_session_id: null, origin_anonymous_id: null, attribution_snapshot: null, created_at: '2026-11-21T15:00:00Z', ...values };
  await db.query(`INSERT INTO public.reservations(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
  await actor();
  return row;
}
async function test(name, body) {
  try { await actor(); await body(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function summary(snapshot, status) { return snapshot.by_status.find((row) => row.status === status); }

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
    CREATE TABLE public.test_authorities(user_id uuid,company_id uuid,reservations_view boolean,can_read_rows boolean,can_payments boolean);
    CREATE FUNCTION public.has_company_panel_permission(_user_id uuid,_company_id uuid,_permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT COALESCE((SELECT reservations_view FROM public.test_authorities WHERE user_id=_user_id AND company_id=_company_id),false)
        AND _permission='reservations_view'
        AND (COALESCE(current_setting('test.support_scope',true),'')='' OR current_setting('test.support_scope',true)=_company_id::text)
    $$;
    CREATE FUNCTION public.test_can_read(_company_id uuid,_payments boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS(SELECT 1 FROM public.test_authorities WHERE user_id=auth.uid() AND company_id=_company_id AND can_read_rows AND (NOT _payments OR can_payments))
        AND (COALESCE(current_setting('test.support_scope',true),'')='' OR current_setting('test.support_scope',true)=_company_id::text)
    $$;
    CREATE TABLE public.reservations(
      id uuid PRIMARY KEY,company_id uuid NOT NULL,guest_name text NOT NULL,guest_phone text NOT NULL,guest_phone_e164 text,
      date date NOT NULL,time time NOT NULL,party_size integer NOT NULL,checked_in_party_size integer,status text,source text,
      origin_affiliate_link_id uuid,origin_tracking_session_id uuid,origin_anonymous_id text,attribution_snapshot jsonb,
      created_at timestamptz NOT NULL,updated_at timestamptz DEFAULT now(),table_id uuid,table_map_id uuid,guest_email text,
      public_tracking_code text,occasion text,notes text,checked_in_at timestamptz,created_in_mode text
    );
    CREATE TABLE public.reservation_payments(
      id uuid PRIMARY KEY,company_id uuid NOT NULL,reservation_id uuid NOT NULL REFERENCES public.reservations(id),status text,
      paid_at timestamptz,billing_type text,charged_amount numeric,base_amount numeric,provider_secret text
    );
    ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.reservation_payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY scoped_reservations ON public.reservations FOR SELECT TO authenticated USING(public.test_can_read(company_id));
    CREATE POLICY scoped_payments ON public.reservation_payments FOR SELECT TO authenticated USING(public.test_can_read(company_id,true));
    GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
    GRANT SELECT ON public.reservations,public.reservation_payments TO authenticated,service_role;
  `);
  for (const [user, company, permission, rows, payments] of [
    [userA, companyA, true, true, true], [userB, companyB, true, true, true],
    [deniedUser, companyA, false, true, true], [rlsDeniedUser, companyA, true, false, true],
    [paymentHiddenUser, companyA, true, true, false],
  ]) await db.query('INSERT INTO public.test_authorities VALUES($1,$2,$3,$4,$5)', [user, company, permission, rows, payments]);
  await db.exec(migration);
  await db.exec(migration);
  await db.query(`INSERT INTO public.reservations(id,company_id,guest_name,guest_phone,date,time,party_size,status,source,created_at)
    SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,$1,'Volume Client '||g,'+5562999900000',date '2026-10-01'+(g%31),time '19:00',3,'confirmed','reservation',timestamptz '2026-10-01T15:00:00Z'
    FROM generate_series(1,5003) g`, [companyA]);
  const foreign = await insert({ company_id: companyB, guest_name: 'Volume foreign company' });

  await test('public and anonymous roles cannot execute the RPC', async () => {
    await asOwner();
    assert.equal((await one('SELECT has_function_privilege(\'anon\',$1,\'EXECUTE\') AS allowed', [signature])).allowed, false);
    assert.equal((await one('SELECT has_function_privilege(\'authenticated\',$1,\'EXECUTE\') AS allowed', [signature])).allowed, true);
    assert.equal((await one("SELECT prosecdef FROM pg_proc WHERE oid=$1::regprocedure", [signature])).prosecdef, false);
    await actor(null, 'anon');
    await assert.rejects(() => history(), { code: '42501' });
  });

  await test('requires a valid authenticated actor and reservations_view for this exact company', async () => {
    await actor(null);
    await assert.rejects(() => history(), { code: '42501' });
    await actor(deniedUser);
    await assert.rejects(() => history(), { code: '42501' });
    await actor(userB);
    await assert.rejects(() => history(), { code: '42501' });
  });

  await test('preserves reservation RLS even if a broader permission helper allows access', async () => {
    await actor(rlsDeniedUser);
    const result = await history();
    assert.equal(result.total, 0);
    assert.deepEqual(result.rows, []);
  });

  await test('keeps support actors inside the impersonated company boundary', async () => {
    await actor(userA, 'authenticated', companyB);
    await assert.rejects(() => history(), { code: '42501' });
  });

  await test('returns only 15 rows and full-filter counts for more than 5000 reservations', async () => {
    const start = performance.now();
    const result = await history({ search: 'Volume' });
    console.log(`# local PGlite 5003-row first-page query: ${(performance.now() - start).toFixed(1)}ms (not a production benchmark)`);
    assert.equal(result.rows.length, 15);
    assert.equal(result.total, 5003);
    assert.equal(result.total_people, 15009);
    assert.equal(summary(result, 'confirmed').count, 5003);
    assert.equal(result.page, 1);
    assert.equal(result.page_size, 15);
    assert.ok(result.rows.every((row) => row.company_id === companyA && row.id !== foreign.id));
    assert.ok(JSON.stringify(result).length < 20000);
    const previous = (await one("SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('reservation_payments','[]'::jsonb)) AS rows FROM public.reservations r WHERE r.company_id=$1 AND r.guest_name LIKE 'Volume%'", [companyA])).rows;
    const previousBytes = Buffer.byteLength(JSON.stringify(previous));
    const pagedBytes = Buffer.byteLength(JSON.stringify(result));
    assert.equal(previous.length, 5003);
    assert.ok(pagedBytes < previousBytes / 100);
    console.log(`# fixture payload: ${previousBytes} bytes for all ${previous.length} rows; ${pagedBytes} bytes for the page plus complete totals`);
  });

  await test('uses stable date, time and ID ordering without repeated rows between pages', async () => {
    const first = await history({ search: 'Volume' });
    const second = await history({ search: 'Volume', page: 2 });
    assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 30);
    const keys = [...first.rows, ...second.rows].map((row) => `${row.date}|${row.time}|${row.id}`);
    assert.deepEqual(keys, [...keys].sort().reverse());
  });

  await test('clamps an obsolete last-page request after rows were removed', async () => {
    const result = await history({ search: 'Volume', page: 99999 });
    assert.equal(result.page, 334);
    assert.equal(result.rows.length, 8);
    await asOwner();
    await db.query("DELETE FROM public.reservations WHERE guest_name LIKE 'Volume Client%' AND id IN (SELECT id FROM public.reservations WHERE company_id=$1 ORDER BY date,time,id LIMIT 9)", [companyA]);
    await actor();
    const after = await history({ search: 'Volume', page: 334 });
    assert.equal(after.total, 4994);
    assert.equal(after.page, 333);
    assert.equal(after.rows.length, 14);
  });

  await test('preserves normalized status filters, operational groups and checked-in people counts', async () => {
    for (const [status, party_size, checked_in_party_size] of [
      [' completed ',10,4], ['checked_in',8,null], ['pending',2,null], ['no_show',3,null],
      ['cancelled',1,null], ['pending_payment',9,null], ['payment_expired',5,null], ['payment_cancelled',6,null], ['paid_after_expiration',7,null],
    ]) await insert({ guest_name: 'Metric example', status, party_size, checked_in_party_size });
    const all = await history({ search: 'Metric' });
    assert.equal(all.total, 9);
    assert.equal(all.total_people, 45);
    assert.deepEqual(summary(all, 'checked_in'), { status: 'checked_in', count: 2, people: 12 });
    const active = await history({ search: 'Metric', operational_filter: 'active' });
    assert.equal(active.total, 3);
    assert.equal(active.total_people, 14);
    const lost = await history({ search: 'Metric', operational_filter: 'lost' });
    assert.equal(lost.total, 5);
    assert.equal(lost.total_people, 22);
    const checked = await history({ search: 'Metric', status: 'checked_in' });
    assert.equal(checked.total, 2);
    assert.ok(checked.rows.every((row) => row.status === 'checked_in'));
    assert.equal(checked.total_people, 12);
    assert.equal((await history({ search: 'Metric', operational_filter: 'active', status: 'cancelled' })).total, 0);
  });

  await test('preserves all four entry methods and their precedence', async () => {
    const affiliate = randomUUID();
    const tracking = randomUUID();
    await insert({ guest_name: 'Origin example', source: 'waitlist', origin_affiliate_link_id: affiliate, origin_tracking_session_id: tracking });
    await insert({ guest_name: 'Origin example', origin_affiliate_link_id: affiliate, origin_tracking_session_id: tracking });
    await insert({ guest_name: 'Origin example', origin_tracking_session_id: tracking });
    await insert({ guest_name: 'Origin example', origin_anonymous_id: 'visitor' });
    await insert({ guest_name: 'Origin example', attribution_snapshot: JSON.stringify({ tracking_source: ' public_web ' }) });
    await insert({ guest_name: 'Origin example', origin_anonymous_id: '   ' });
    for (const [entry_method, count] of [['waitlist',1],['affiliate',1],['online',3],['manual',1]]) {
      assert.equal((await history({ search: 'Origin', entry_method })).total, count);
    }
  });

  await test('treats percent, underscore and backslash as literal search characters', async () => {
    await insert({ guest_name: 'Literal%customer' });
    await insert({ guest_name: 'Literal_customer' });
    await insert({ guest_name: 'Literal\\customer' });
    await insert({ guest_name: 'LiteralXcustomer' });
    for (const search of ['%', '_', '\\']) assert.equal((await history({ search })).total, 1);
    assert.equal((await history({ search: "' OR 1=1 --" })).total, 0);
  });

  await test('matches case-insensitive names and preserves the existing accent-sensitive search', async () => {
    await insert({ guest_name: 'Áurea Especial' });
    assert.equal((await history({ search: 'ÁUREA' })).total, 1);
    assert.equal((await history({ search: 'Aurea' })).total, 0);
  });

  await test('searches displayed e164 or legacy phones and stripped digits without guessing country identities', async () => {
    const legacy = await insert({ guest_name: 'Legacy phone', guest_phone: '(62) 3333-4444' });
    const international = await insert({ guest_name: 'International phone', guest_phone: '2025550123', guest_phone_e164: '+12025550123' });
    const overridden = await insert({ guest_name: 'Canonical phone', guest_phone: '555111222', guest_phone_e164: '+442079460958' });
    assert.equal((await history({ search: '3333-4444' })).rows[0].id, legacy.id);
    assert.equal((await history({ search: '62 3333 4444' })).rows[0].id, legacy.id);
    assert.equal((await history({ search: '+1 (202) 555-0123' })).rows[0].id, international.id);
    assert.equal((await history({ search: '442079460958' })).rows[0].id, overridden.id);
    assert.equal((await history({ search: '555111222' })).total, 0);
    assert.equal((await history({ search: 'Canonical phone' })).rows[0].guest_phone, '+442079460958');
  });

  await test('keeps reservation date bounds inclusive and a partial range open-ended', async () => {
    await insert({ guest_name: 'Date bound', date: '2026-11-19' });
    await insert({ guest_name: 'Date bound', date: '2026-11-20' });
    await insert({ guest_name: 'Date bound', date: '2026-11-21' });
    await insert({ guest_name: 'Date bound', date: '2026-11-22' });
    assert.equal((await history({ search: 'Date bound', start_date: '2026-11-20', end_date: '2026-11-21' })).total, 2);
    assert.equal((await history({ search: 'Date bound', start_date: '2026-11-20' })).total, 3);
    assert.equal((await history({ search: 'Date bound', end_date: '2026-11-20' })).total, 4);
  });

  await test('uses exact created-at boundaries with the next local midnight exclusive', async () => {
    for (const created_at of ['2026-11-20T02:59:59.999Z','2026-11-20T03:00:00Z','2026-11-22T02:59:59.999Z','2026-11-22T03:00:00Z']) await insert({ guest_name: 'Created bound', created_at });
    assert.equal((await history({ search: 'Created bound', date_filter_mode: 'created', created_start_at: '2026-11-20T03:00:00Z', created_end_at: '2026-11-22T03:00:00Z' })).total, 2);
    assert.equal((await history({ search: 'Created bound', date_filter_mode: 'created', created_start_at: '2026-11-20T03:00:00Z' })).total, 3);
    assert.equal((await history({ search: 'Created bound', date_filter_mode: 'created', created_end_at: '2026-11-22T03:00:00Z' })).total, 4);
  });

  await test('keeps only the existing payment mini contract and honors payment RLS', async () => {
    const row = await insert({ guest_name: 'Payment example' });
    await asOwner();
    await db.query("INSERT INTO public.reservation_payments VALUES($1,$2,$3,'paid',now(),'PIX',90,80,'must-never-leak')", [randomUUID(), companyA, row.id]);
    await actor();
    const full = await history({ search: 'Payment example' });
    assert.equal(full.rows[0].reservation_payments.length, 1);
    assert.deepEqual(Object.keys(full.rows[0].reservation_payments[0]).sort(), ['id','status','paid_at','billing_type','charged_amount','base_amount'].sort());
    assert.ok(!JSON.stringify(full).includes('must-never-leak'));
    await actor(paymentHiddenUser);
    const hidden = await history({ search: 'Payment example' });
    assert.equal(hidden.total, 1);
    assert.deepEqual(hidden.rows[0].reservation_payments, []);
  });

  await test('returns an empty but complete page and summaries when a filter has no matches', async () => {
    const empty = await history({ search: 'Never matching fixture', page: 90 });
    assert.deepEqual(empty, { company_id: companyA, rows: [], total: 0, total_people: 0, by_status: [], page: 1, page_size: 15 });
  });

  await test('combines filters on the server and returns only matching rows and whole-filter totals', async () => {
    for (let index = 0; index < 40; index++) await insert({ guest_name: 'Combined filters', status: index % 2 ? 'cancelled' : 'completed', checked_in_party_size: 1, party_size: 6, date: index < 20 ? '2026-11-20' : '2026-11-21', source: index % 3 ? 'reservation' : 'waitlist' });
    const result = await history({ search: 'Combined filters', status: 'checked_in', operational_filter: 'active', entry_method: 'waitlist', start_date: '2026-11-21', end_date: '2026-11-21', page_size: 2 });
    assert.equal(result.total, 3);
    assert.equal(result.total_people, 3);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.by_status, [{ status: 'checked_in', count: 3, people: 3 }]);
    assert.ok(result.rows.every((row) => row.source === 'waitlist' && row.status === 'checked_in' && row.date === '2026-11-21'));
  });

  await test('rejects unsupported filters, oversized pages and malformed intervals', async () => {
    for (const invalid of [
      { page: 0 }, { page_size: 0 }, { page_size: 101 }, { operational_filter: 'anything' }, { status: 'completed' },
      { entry_method: 'paid' }, { date_filter_mode: 'other' }, { search: 'x'.repeat(201) },
      { start_date: '2026-11-22', end_date: '2026-11-21' }, { created_start_at: '2026-11-22T00:00:00Z', created_end_at: '2026-11-21T00:00:00Z' },
      { company_id: null },
    ]) await assert.rejects(() => history(invalid), { code: '22023' });
  });

  await test('keeps service-role reads explicitly scoped to the requested company', async () => {
    await actor(null, 'service_role');
    const result = await history({ company_id: companyB });
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].id, foreign.id);
  });

  console.log(`\n${passed} PostgreSQL pagination regression cases passed; no network or external database used.`);
} finally { await asOwner(); await db.close(); }
