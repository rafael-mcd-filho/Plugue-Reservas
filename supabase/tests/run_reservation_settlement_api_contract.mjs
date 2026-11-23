// Real API validators and real PostgreSQL RPCs, with offline Auth/Storage only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const company = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const reservation = '33333333-3333-4333-8333-333333333333';
const payment = '44444444-4444-4444-8444-444444444444';
const idempotency = '55555555-5555-4555-8555-555555555555';
let role = 'superadmin';
const objects = new Map();
async function load(path, dependencies, deno = {}) {
  const exports = {};
  const compiled = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, Headers, Blob, Uint8Array, atob, crypto: globalThis.crypto, console,
  })(exports, name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; }, deno);
  return exports;
}
const database = {
  async rpc(name, args) {
    assert.match(name, /^[a-z_]+$/);
    const values = Object.entries(args);
    try {
      const result = await db.query(`SELECT public.${name}(${values.map(([key], index) => { assert.match(key, /^_[a-z_]+$/); return `${key} => $${index + 1}`; }).join(',')}) AS result`, values.map(([, value]) => value));
      return { data: result.rows[0].result, error: null };
    } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
  },
  from(table) {
    assert.equal(table, 'reservation_withdrawals');
    const filters = [];
    const query = {
      select: () => query,
      eq: (key, value) => { assert.match(key, /^[a-z_]+$/); filters.push([key, value]); return query; },
      async maybeSingle() {
        const rows = await db.query(`SELECT * FROM public.reservation_withdrawals WHERE ${filters.map(([key], index) => `${key}=$${index + 1}`).join(' AND ')}`, filters.map(([, value]) => value));
        // PostgREST sends timestamps as JSON strings, while PGlite's direct
        // table driver returns Date instances. Preserve the real HTTP boundary.
        return { data: rows.rows[0] ? JSON.parse(JSON.stringify(rows.rows[0])) : null, error: null };
      },
    };
    return query;
  },
  storage: { from(bucket) {
    assert.equal(bucket, 'reservation-payout-receipts');
    return {
      async upload(path, bytes, options) {
        assert.equal(options.upsert, false);
        await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', [bucket, path]);
        objects.set(path, new Blob([bytes], { type: options.contentType }));
        return { data: { path }, error: null };
      },
      async download(path) { return { data: objects.get(path) ?? null, error: objects.has(path) ? null : { message: 'missing' } }; },
    };
  } },
};
try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text);
    CREATE TABLE public.companies(id uuid PRIMARY KEY,name text,deletion_requested_at timestamptz);
    CREATE TABLE public.reservations(id uuid PRIMARY KEY,company_id uuid REFERENCES companies(id),date date);
    CREATE TABLE public.reservation_payments(id uuid PRIMARY KEY,company_id uuid REFERENCES companies(id),reservation_id uuid REFERENCES reservations(id),
      metadata jsonb DEFAULT '{}',asaas_payment_id text,billing_type text DEFAULT 'PIX',status text DEFAULT 'paid',created_at timestamptz DEFAULT now());
    GRANT USAGE ON SCHEMA public,storage TO anon,authenticated,service_role;
    GRANT SELECT,UPDATE ON public.reservation_payments TO service_role;`);
  await db.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Empresa API']);
  await db.query('INSERT INTO reservations(id,company_id,date) VALUES($1,$2,current_date-2)', [reservation, company]);
  await db.exec(await readFile(new URL('../migrations/20261108190000_add_reservation_settlements_and_withdrawals.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/20261109130000_add_reservation_method_fees.sql', import.meta.url), 'utf8'));
  const helpers = await load('../functions/_shared/reservation-settlements-api.ts', {
    './internal-auth.ts': { getRequestAuthContext: async () => ({ supabaseAdmin: database, actorUser: { id: actor },
      user: { id: actor }, actorRoleRows: [{ role, company_id: company }], isSupport: false, impersonation: null }) },
  });
  let handler;
  await load('../functions/manage-reservation-settlements/index.ts', {
    '../_shared/reservation-settlements-api.ts': helpers,
    '../_shared/reservation-payments.ts': { corsHeaders: {}, jsonResponse: (body, status = 200) => new Response(JSON.stringify(body), { status }) },
  }, { serve: fn => { handler = fn; } });
  async function request(body, expectedStatus = 200) {
    const response = await handler(new Request('https://offline.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    const result = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(result));
    return result;
  }
  const terms = await request({ action: 'save_terms', company_id: company, pix_fee_bps: 200, credit_card_fee_bps: 1000, release_policy: 'after_reservation', hold_days: 0, effective_at: null, enabled: true });
  assert.equal(terms.pix_fee_bps, 200);
  assert.equal(terms.credit_card_fee_bps, 1000);
  assert.ok(terms.effective_at, 'immediate terms receive a server-generated effective timestamp');
  role = 'admin';
  const bank = await request({ action: 'save_destination', company_id: company, destination: { kind: 'bank', holder_name: 'Empresa API', holder_document: '12345678000195', bank_code: '12345678', bank_name: 'Banco teste', agency: '001', account_number: '12345-6', account_type: 'checking' } });
  assert.equal(bank.bank_code, '12345678', '8-digit ISPB accepted by validators must also be accepted by SQL');
  const pix = await request({ action: 'save_destination', company_id: company, destination: { kind: 'pix', holder_name: 'Empresa API', holder_document: '12345678000195', pix_key_type: 'random', pix_key: idempotency } });
  assert.equal(pix.pix_key_type, 'random', 'Pix key enum agrees between UI, API and SQL');
  await db.query('INSERT INTO reservation_payments(id,company_id,reservation_id,metadata,asaas_payment_id) VALUES($1,$2,$3,$4,$5)', [payment, company, reservation,
    { asaas_account_scope: 'platform', asaas_account_id: 'wallet-test', asaas_environment: 'production' }, 'pay_api_contract']);
  const synced = await database.rpc('sync_reservation_payment_settlement', { _payment_id: payment,
    _provider_snapshot: { id: 'pay_api_contract', status: 'RECEIVED', billingType: 'PIX', value: 1000, netValue: 980, observed_at: new Date().toISOString() }, _source: 'offline-contract' });
  assert.equal(synced.error, null, JSON.stringify(synced.error));
  assert.equal(synced.data.fee_bps, 200);
  assert.equal(synced.data.fee_billing_type, 'PIX');
  assert.equal(Number(synced.data.available_balance_cents), 98000);
  const asked = await request({ action: 'request_withdrawal', company_id: company, amount: '100.01', idempotency_key: idempotency });
  assert.equal(Number(asked.amount_cents), 10001);
  assert.equal(asked.destination_snapshot.pix_key_type, 'random');
  const replay = await request({ action: 'request_withdrawal', company_id: company, amount: '100.01', idempotency_key: idempotency });
  assert.equal(replay.id, asked.id);
  assert.equal((await db.query("SELECT count(*)::int n FROM reservation_settlement_ledger WHERE entry_type='withdrawal_requested'")).rows[0].n, 1);
  role = 'superadmin';
  await request({ action: 'transition_withdrawal', withdrawal_id: asked.id, status: 'processing' });
  const document = await request({ action: 'upload_receipt', withdrawal_id: asked.id, mime_type: 'application/pdf', content_base64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64') });
  const completion = { action: 'transition_withdrawal', withdrawal_id: asked.id, status: 'paid', receipt_path: document.receipt_path, bank_reference: 'E2E-OFFLINE-123', paid_at: new Date().toISOString() };
  const paid = await request(completion);
  assert.equal(paid.status, 'paid');
  assert.equal((await request(completion)).id, paid.id, 'lost response retry is idempotently acknowledged');
  assert.equal((await db.query("SELECT count(*)::int n FROM reservation_settlement_ledger WHERE entry_type='withdrawal_paid'")).rows[0].n, 1);
  role = 'admin';
  const duplicateRequest = await request({ action: 'request_withdrawal', company_id: company, amount: '5.00', idempotency_key: '66666666-6666-4666-8666-666666666666' });
  role = 'superadmin';
  await request({ action: 'transition_withdrawal', withdrawal_id: duplicateRequest.id, status: 'processing' });
  const duplicateDocument = await request({ action: 'upload_receipt', withdrawal_id: duplicateRequest.id, mime_type: 'application/pdf', content_base64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64') });
  const conflict = await request({ ...completion, withdrawal_id: duplicateRequest.id, receipt_path: duplicateDocument.receipt_path,
    bank_reference: ' e2e-offline-123 ', paid_at: new Date().toISOString() }, 409);
  assert.equal(conflict.error, 'Esta transferência já foi registrada em outro saque.');
  assert.equal((await db.query('SELECT status FROM reservation_withdrawals WHERE id=$1', [duplicateRequest.id])).rows[0].status, 'processing', 'duplicate transfer conflict rolls back completion');
  assert.equal((await db.query("SELECT count(*)::int n FROM reservation_settlement_ledger WHERE entry_type='withdrawal_paid'")).rows[0].n, 1, 'one bank transfer cannot pay two requests');
  console.log('Reservation settlement API/PostgreSQL contract passed: immediate fee terms, random Pix/ISPB destination, exact cents, idempotent request, immutable private proof, completed payout and unique bank transfer reference.');
} finally { await db.close(); }
