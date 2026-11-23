// Method-specific financial contracts in isolated PostgreSQL. No network, token,
// provider writes or production data are used by this runner.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
let sequence = 1;
const uuid = () => `91000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const actor = uuid(), legacyCompany = uuid(), company = uuid(), legacyReservation = uuid(), reservation = uuid();
const metadata = { asaas_account_scope: 'platform', asaas_environment: 'production', asaas_account_id: 'wallet-method-tests' };
const rpc = async (name, args = []) => (await db.query(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`, args)).rows[0].value;
const terms = (pix, card, companyId = company) => rpc('save_reservation_settlement_method_terms', [companyId, pix, card, 'on_settlement', 0, null, true, actor]);
const row = async id => (await db.query('SELECT to_jsonb(s) value FROM reservation_payment_settlements s WHERE payment_id=$1', [id])).rows[0].value;
const add = async ({ companyId = company, reservationId = reservation, method = 'PIX', status = 'paid' } = {}) => {
  const id = uuid();
  await db.query(`INSERT INTO reservation_payments(id,company_id,reservation_id,metadata,asaas_payment_id,billing_type,status)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, companyId, reservationId, metadata, 'pay_' + id, method, status]);
  return id;
};
const sync = (id, method, changes = {}) => rpc('sync_reservation_payment_settlement', [id, {
  id: 'pay_' + id, status: 'RECEIVED', billingType: method, value: 2000, netValue: 1940,
  observed_at: new Date().toISOString(), ...changes,
}, 'method-fee-regression']);

try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text);
    CREATE TABLE companies(id uuid PRIMARY KEY,name text,deletion_requested_at timestamptz);
    CREATE TABLE reservations(id uuid PRIMARY KEY,company_id uuid REFERENCES companies(id),date date);
    CREATE TABLE reservation_payments(id uuid PRIMARY KEY,company_id uuid REFERENCES companies(id),reservation_id uuid REFERENCES reservations(id),
      metadata jsonb DEFAULT '{}',asaas_payment_id text,billing_type text,status text DEFAULT 'paid',created_at timestamptz DEFAULT now());
    GRANT USAGE ON SCHEMA public,storage TO anon,authenticated,service_role;
    GRANT SELECT,UPDATE ON reservation_payments TO service_role;`);
  await db.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [legacyCompany, 'Legacy company', company, 'Method-fee company']);
  await db.query('INSERT INTO reservations(id,company_id,date) VALUES($1,$2,current_date-2),($3,$4,current_date-2)', [legacyReservation, legacyCompany, reservation, company]);
  await db.exec(await readFile(new URL('../migrations/20261108190000_add_reservation_settlements_and_withdrawals.sql', import.meta.url), 'utf8'));
  await rpc('save_reservation_settlement_terms', [legacyCompany, 1000, 'on_settlement', 0, null, true, actor]);
  const legacy = await add({ companyId: legacyCompany, reservationId: legacyReservation });
  await sync(legacy, 'PIX');
  const before = {
    terms: (await db.query('SELECT to_jsonb(t) value FROM reservation_settlement_terms t WHERE company_id=$1', [legacyCompany])).rows[0].value,
    settlement: await row(legacy),
    ledger: (await db.query('SELECT jsonb_agg(to_jsonb(l) ORDER BY id) value FROM reservation_settlement_ledger l')).rows[0].value,
  };
  await db.exec(await readFile(new URL('../migrations/20261109130000_add_reservation_method_fees.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await db.query("SELECT to_jsonb(t)-'pix_fee_bps'-'credit_card_fee_bps' value FROM reservation_settlement_terms t WHERE company_id=$1", [legacyCompany])).rows[0].value, before.terms);
  assert.deepEqual((await db.query("SELECT to_jsonb(s)-'pix_fee_bps'-'credit_card_fee_bps'-'fee_billing_type' value FROM reservation_payment_settlements s WHERE payment_id=$1", [legacy])).rows[0].value, before.settlement);
  assert.deepEqual((await db.query('SELECT jsonb_agg(to_jsonb(l) ORDER BY id) value FROM reservation_settlement_ledger l')).rows[0].value, before.ledger);
  assert.equal((await row(legacy)).pix_fee_bps, null);
  await terms(200, 1500, legacyCompany);
  await sync(legacy, 'PIX');
  assert.equal((await row(legacy)).fee_bps, 1000, 'old settlements never adopt new method terms');
  assert.equal((await row(legacy)).available_balance_cents, 180000);
  await assert.rejects(db.query('UPDATE reservation_payment_settlements SET fee_bps=200 WHERE payment_id=$1', [legacy]), /taxa financeira/);

  const first = await terms(200, 1000);
  const pending = await add({ method: null, status: 'awaiting_method' });
  assert.equal((await row(pending)).terms_id, first.id);
  assert.equal((await row(pending)).pix_fee_bps, 200);
  assert.equal((await row(pending)).credit_card_fee_bps, 1000);
  assert.equal((await row(pending)).fee_billing_type, null);
  await terms(300, 1200);
  await db.query("UPDATE reservation_payments SET billing_type='CREDIT_CARD',status='paid' WHERE id=$1", [pending]);
  await sync(pending, 'CREDIT_CARD');
  assert.equal((await row(pending)).fee_bps, 1000, 'choosing a method after terms change still uses the creation-time pair');
  assert.equal((await row(pending)).fee_billing_type, 'CREDIT_CARD');
  assert.equal((await row(pending)).available_balance_cents, 180000);

  await terms(200, 1000);
  const pix = await add(); await sync(pix, 'PIX');
  const card = await add({ method: 'CREDIT_CARD' }); await sync(card, 'CREDIT_CARD');
  assert.equal((await row(pix)).fee_bps, 200);
  assert.equal((await row(pix)).available_balance_cents, 196000, 'processor cost remains inside platform commission');
  assert.equal((await row(card)).fee_bps, 1000);
  assert.equal((await row(card)).available_balance_cents, 180000);
  await assert.rejects(rpc('save_reservation_settlement_terms', [company, 500, 'on_settlement', 0, null, true, actor]), /Atualize a página/, 'stale one-rate clients cannot overwrite a different pair');
  const ledgerCount = (await db.query('SELECT count(*)::int n FROM reservation_settlement_ledger WHERE payment_id=$1', [pix])).rows[0].n;
  await sync(pix, 'PIX');
  assert.equal((await db.query('SELECT count(*)::int n FROM reservation_settlement_ledger WHERE payment_id=$1', [pix])).rows[0].n, ledgerCount);

  await sync(pix, 'PIX', { refunds: [{ status: 'DONE', value: 500 }] });
  assert.equal((await row(pix)).recognized_fee_cents, 3000, 'partial refund proportionally reverses the actual Pix fee');
  assert.equal((await row(pix)).available_balance_cents, 147000);

  const moment = Date.now();
  await sync(card, 'CREDIT_CARD', { observed_at: new Date(moment + 1000).toISOString() });
  await sync(card, 'PIX', { observed_at: new Date(moment + 3000).toISOString() });
  assert.equal((await row(card)).available_balance_cents, 0, 'a verified method discrepancy holds the old payable');
  assert.equal((await row(card)).blocked_balance_cents, 180000);
  assert.equal((await row(card)).fee_bps, 1000, 'discrepancy never reprices an existing charge');
  await sync(card, 'CREDIT_CARD', { observed_at: new Date(moment + 2000).toISOString() });
  assert.equal((await row(card)).available_balance_cents, 0, 'late valid data cannot clear a newer mismatch hold');
  await sync(card, 'CREDIT_CARD', { observed_at: new Date(moment + 4000).toISOString() });
  assert.equal((await row(card)).available_balance_cents, 180000, 'a newer verified matching observation can clear the hold');
  await db.query("UPDATE reservation_payments SET billing_type='PIX' WHERE id=$1", [card]);
  assert.equal((await row(card)).available_balance_cents, 0, 'local method mutation immediately holds an already-bound charge');
  assert.equal((await row(card)).fee_bps, 1000);
  await assert.rejects(db.query("UPDATE reservation_payment_settlements SET fee_billing_type='PIX',fee_bps=200 WHERE payment_id=$1", [card]), /método financeiro/);
  await assert.rejects(db.query('UPDATE reservation_payment_settlements SET pix_fee_bps=0 WHERE payment_id=$1', [pix]), /condições comerciais/);

  const unresolved = await add({ method: null });
  await sync(unresolved, 'PIX');
  assert.equal((await row(unresolved)).fee_billing_type, null, 'API data cannot choose a rate without a local payment method');
  assert.equal((await row(unresolved)).available_balance_cents, 0);

  await terms(0, 10000);
  const free = await add(); await sync(free, 'PIX', { value: 10, netValue: 9 });
  assert.equal((await row(free)).fee_bps, 0);
  assert.equal((await row(free)).available_balance_cents, 1000);
  const full = await add({ method: 'CREDIT_CARD' }); await sync(full, 'CREDIT_CARD', { value: 10, netValue: 9 });
  assert.equal((await row(full)).recognized_fee_cents, 1000);
  assert.equal((await row(full)).available_balance_cents, 0);
  await terms(3333, 4444);
  const rounded = await add(); await sync(rounded, 'PIX', { value: 0.05, netValue: 0.04 });
  assert.equal((await row(rounded)).recognized_fee_cents, 2);
  assert.equal((await row(rounded)).available_balance_cents, 3, 'fees round once in integer cents');
  const installment = await add({ method: 'CREDIT_CARD' });
  await sync(installment, 'CREDIT_CARD', { value: 100, netValue: 97, installment: 'historic-installment' });
  assert.equal((await row(installment)).fee_bps, 4444);
  assert.equal((await row(installment)).available_balance_cents, 0, 'method fees never make installments withdrawable automatically');
  assert.equal((await row(installment)).blocked_balance_cents, 5556);

  for (const [a, b] of [[null, 1000], [200, null], [-1, 1000], [200, 10001]]) await assert.rejects(terms(a, b), /percentuais|check constraint/);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(terms(200, 1000), error => error.code === '42501');
    await assert.rejects(db.query('SELECT pix_fee_bps,credit_card_fee_bps FROM reservation_settlement_terms'), error => error.code === '42501');
    await db.exec('RESET ROLE');
  }
  console.log('Method fee SQL regression passed: additive history preservation, frozen creation-time pair, authoritative method binding, independent Pix/card rates, cents/refunds, mismatch ordering/holds, stale-client protection, 0/100 boundaries, installment hold and service-only ACLs.');
} finally { await db.close(); }
