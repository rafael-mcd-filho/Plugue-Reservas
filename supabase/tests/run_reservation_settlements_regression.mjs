// Real SQL in isolated PostgreSQL/WASM. Never connects to Supabase or Asaas.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const ids = {
  company: '00000000-0000-4000-8000-000000000001', other: '00000000-0000-4000-8000-000000000002',
  actor: '00000000-0000-4000-8000-000000000003', reservation: '00000000-0000-4000-8000-000000000004',
  payment: '00000000-0000-4000-8000-000000000005', old: '00000000-0000-4000-8000-000000000006',
};
let sequence = 20;
const uuid = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const meta = { asaas_account_scope: 'platform', asaas_account_id: 'wallet-central', asaas_environment: 'production' };
const rpc = async (name, args = []) => (await db.query(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS result`, args)).rows[0].result;
const summary = () => rpc('get_reservation_settlement_summary', [ids.company]);
const terms = async (bps = 1000, policy = 'after_reservation', hold = 0, enabled = true) => rpc('save_reservation_settlement_terms', [ids.company, bps, policy, hold, null, enabled, ids.actor]);
const sync = async (payment, providerId, changes = {}) => rpc('sync_reservation_payment_settlement', [payment, {
  id: providerId, status: 'RECEIVED', billingType: 'PIX', value: 2000, netValue: 1940,
  observed_at: new Date().toISOString(), ...changes,
}, 'offline-test']);
const destination = async (key = 'finance@example.test') => rpc('save_company_payout_destination', [ids.company, {
  kind: 'pix', holder_name: 'Empresa Teste', holder_document: '12345678000195', pix_key_type: 'email', pix_key: key,
}, ids.actor]);
const request = (amount, key = uuid()) => rpc('request_reservation_withdrawal', [ids.company, amount, key, ids.actor]);
const transition = (id, status, reason = null, receipt = null, reference = null, paidAt = null) => rpc('transition_reservation_withdrawal', [id, status, ids.actor, reason, receipt, reference, paidAt]);
const addPayment = async ({ id = uuid(), providerId = `pay_${sequence}`, metadata = meta, reservation = ids.reservation, createdAt = null } = {}) => {
  await db.query(`INSERT INTO public.reservation_payments(id,company_id,reservation_id,metadata,asaas_payment_id,created_at)
    VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()))`, [id, ids.company, reservation, metadata, providerId, createdAt]);
  return { id, providerId };
};

try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text);
    CREATE TABLE public.companies(id uuid PRIMARY KEY,name text,deletion_requested_at timestamptz);
    CREATE TABLE public.reservations(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,date date);
    CREATE TABLE public.reservation_payments(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
      reservation_id uuid REFERENCES public.reservations(id) ON DELETE CASCADE,metadata jsonb DEFAULT '{}',
      asaas_payment_id text,billing_type text DEFAULT 'PIX',status text DEFAULT 'paid',created_at timestamptz DEFAULT now());
    GRANT USAGE ON SCHEMA public,storage TO anon,authenticated,service_role;
    GRANT SELECT,UPDATE ON public.reservation_payments TO service_role;
  `);
  await db.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [ids.company, 'Empresa Teste', ids.other, 'Outra Empresa']);
  await db.query("INSERT INTO reservations(id,company_id,date) VALUES($1,$2,current_date-2)", [ids.reservation, ids.company]);
  await addPayment({ id: ids.old, providerId: 'pay_old', createdAt: '2026-01-01T00:00:00Z' });
  await db.exec(await readFile(new URL('../migrations/20261108190000_add_reservation_settlements_and_withdrawals.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/20261109130000_add_reservation_method_fees.sql', import.meta.url), 'utf8'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reservation_payment_settlements')).rows[0].n, 0, 'no historical opening balance');
  assert.equal(await sync(ids.old, 'pay_old'), null, 'sync never initializes old payments');
  await assert.rejects(addPayment(), /Condições comerciais.*não configuradas/, 'a new central charge cannot bypass a missing fee agreement');

  await assert.rejects(terms(-1), /check constraint/);
  await assert.rejects(terms(10001), /check constraint/);
  await assert.rejects(rpc('save_reservation_settlement_terms', [ids.company, 1000, 'after_reservation', 0, '2026-01-01T00:00:00Z', true, ids.actor]), /retroativamente/);
  const firstTerms = await terms();
  await addPayment({ id: ids.payment, providerId: 'pay_1' });
  const initialized = (await db.query('SELECT * FROM reservation_payment_settlements WHERE payment_id=$1', [ids.payment])).rows[0];
  assert.equal(initialized.terms_id, firstTerms.id);
  assert.equal(initialized.fee_bps, 1000);
  assert.equal(Number(initialized.gross_cents), 0, 'method amount is not guessed before authoritative observation');
  for (const metadata of [{}, { ...meta, asaas_environment: 'sandbox' }]) {
    const excluded = await addPayment({ metadata });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM reservation_payment_settlements WHERE payment_id=$1', [excluded.id])).rows[0].n, 0);
  }
  await assert.rejects(sync(ids.payment, 'wrong-id'), /Snapshot não corresponde/);
  await assert.rejects(sync(ids.payment, 'pay_1', { value: 'not-money' }), /Valor bruto inválido/);
  await sync(ids.payment, 'pay_1', { status: 'CONFIRMED' });
  let balances = await summary();
  assert.equal(balances.pending_cents, 180000);
  assert.equal(balances.available_cents, 0, 'confirmation is not settlement');
  assert.equal(balances.fee_cents, 20000);
  assert.equal(balances.provider_cost_cents, 6000);
  const randomDestination = await rpc('save_company_payout_destination', [ids.company, {
    kind: 'pix', holder_name: 'Empresa Teste', holder_document: '12345678000195', pix_key_type: 'random', pix_key: uuid(),
  }, ids.actor]);
  assert.equal(randomDestination.pix_key_type, 'random');
  const bankDestination = await rpc('save_company_payout_destination', [ids.company, {
    kind: 'bank', holder_name: 'Empresa Teste', holder_document: '12345678000195', bank_code: '12345678',
    agency: '0001', account_number: '12345-6', account_type: 'checking',
  }, ids.actor]);
  assert.equal(bankDestination.bank_code, '12345678', 'ISPB is accepted consistently with the API');
  await destination();
  await assert.rejects(request(1), /Saldo disponível insuficiente/);
  await sync(ids.payment, 'pay_1');
  balances = await summary();
  assert.equal(balances.available_cents, 180000, 'Asaas costs are absorbed by platform');
  const ledgerCount = (await db.query('SELECT count(*)::int AS n FROM reservation_settlement_ledger')).rows[0].n;
  await sync(ids.payment, 'pay_1');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reservation_settlement_ledger')).rows[0].n, ledgerCount, 'duplicate snapshots add no financial movement');
  await sync(ids.payment, 'pay_1', { status: 'CONFIRMED', observed_at: '2020-01-01T00:00:00Z' });
  assert.equal((await summary()).available_cents, 180000, 'out-of-order snapshots cannot revert newer observations');

  const requestKey = uuid();
  const withdrawal = await request(50000, requestKey);
  assert.equal((await request(50000, requestKey)).id, withdrawal.id);
  await assert.rejects(request(40000, requestKey), /outros dados/);
  assert.equal((await summary()).available_cents, 130000);
  assert.equal((await summary()).reserved_cents, 50000);
  await destination('new-finance@example.test');
  assert.equal((await db.query('SELECT destination_snapshot FROM reservation_withdrawals WHERE id=$1', [withdrawal.id])).rows[0].destination_snapshot.pix_key, 'finance@example.test');
  await transition(withdrawal.id, 'under_review');
  await transition(withdrawal.id, 'processing');
  await assert.rejects(rpc('transition_reservation_withdrawal', [withdrawal.id, 'processing', ids.other]), /outro administrador/);
  await assert.rejects(rpc('cancel_reservation_withdrawal', [withdrawal.id, ids.company, ids.actor]), /Transição de saque não permitida/);
  await assert.rejects(transition(withdrawal.id, 'paid'), /obrigatórios/);
  const receipt = `${ids.company}/${withdrawal.id}/${uuid()}.pdf`;
  await assert.rejects(transition(withdrawal.id, 'paid', null, receipt, 'E2E-REFERENCE', new Date().toISOString()), /Comprovante não encontrado/);
  await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['reservation-payout-receipts', receipt]);
  const paidAt = new Date().toISOString();
  await transition(withdrawal.id, 'paid', null, receipt, 'E2E-REFERENCE', paidAt);
  await transition(withdrawal.id, 'paid', null, receipt, 'E2E-REFERENCE', paidAt);
  await assert.rejects(transition(withdrawal.id, 'paid', null, receipt, 'DIFFERENT-REFERENCE', paidAt), /imutável/);
  balances = await summary();
  assert.equal(balances.available_cents, 130000);
  assert.equal(balances.reserved_cents, 0);
  assert.equal(balances.paid_cents, 50000, 'paid transition is idempotent');
  await assert.rejects(transition(withdrawal.id, 'requested'), /Transição de saque não permitida/);

  // The existing refund compare-and-swap automatically places a serialized hold.
  await db.query("UPDATE reservation_payments SET status='refund_pending' WHERE id=$1", [ids.payment]);
  balances = await summary();
  assert.equal(balances.available_cents, -50000);
  assert.equal(balances.blocked_cents, 180000);
  await assert.rejects(request(1), /Saldo disponível insuficiente/);
  await db.query("UPDATE reservation_payments SET status='paid' WHERE id=$1", [ids.payment]);
  assert.equal((await summary()).available_cents, 130000, 'definitively rejected refund releases only its hold');
  await sync(ids.payment, 'pay_1', { refunds: [{ status: 'PENDING', value: 100 }, { status: 'CANCELLED', value: 100 }] });
  assert.equal((await summary()).available_cents, -50000, 'provider-pending refund conservatively holds the balance even before local state changes');
  assert.equal((await summary()).refunded_cents, 0, 'uncompleted refunds do not become completed financial debits');
  await sync(ids.payment, 'pay_1', { refunds: [{ status: 'CANCELLED', value: 100 }] });
  assert.equal((await summary()).available_cents, 130000, 'a cancelled provider refund has no hold or completed debit');
  await sync(ids.payment, 'pay_1', { refunds: [{ status: 'DONE', value: 100 }] });
  balances = await summary();
  assert.equal(balances.available_cents, 121000);
  assert.equal(balances.fee_cents, 19000, 'commission is reversed proportionally');
  await sync(ids.payment, 'pay_1', { refunds: [] });
  assert.equal((await summary()).available_cents, 121000, 'older refund lists cannot erase a completed refund');

  // Two requests submitted together cannot spend the same balance.
  const attempts = await Promise.allSettled([request(80000), request(80000)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  const reserved = attempts.find(result => result.status === 'fulfilled').value;
  await sync(ids.payment, 'pay_1', { status: 'REFUNDED', refunds: [{ status: 'DONE', value: 2000 }] });
  await assert.rejects(transition(reserved.id, 'processing'), /Saldo comprometido/);
  await rpc('cancel_reservation_withdrawal', [reserved.id, ids.company, ids.actor]);
  balances = await summary();
  assert.equal(balances.available_cents, -50000, 'refund after payout becomes negative payable');
  assert.equal(balances.fee_cents, 0);
  assert.equal(balances.refunded_cents, 200000);
  assert.equal(balances.reserved_cents, 0);

  // Rate version changes never rewrite the first charge.
  await terms(800);
  const later = await addPayment();
  await sync(later.id, later.providerId, { value: 100, netValue: 97 });
  assert.equal((await db.query('SELECT fee_bps FROM reservation_payment_settlements WHERE payment_id=$1', [ids.payment])).rows[0].fee_bps, 1000);
  assert.equal((await db.query('SELECT fee_bps FROM reservation_payment_settlements WHERE payment_id=$1', [later.id])).rows[0].fee_bps, 800);
  assert.equal((await db.query('SELECT available_balance_cents FROM reservation_payment_settlements WHERE payment_id=$1', [later.id])).rows[0].available_balance_cents, 9200);
  await db.query("UPDATE reservation_payment_settlements SET observed_at=now()-interval '25 hours' WHERE payment_id=$1", [later.id]);
  await rpc('release_due_reservation_settlements', [ids.company]);
  assert.equal((await db.query('SELECT available_balance_cents FROM reservation_payment_settlements WHERE payment_id=$1', [later.id])).rows[0].available_balance_cents, 0, 'stale provider data is not withdrawable');
  await sync(later.id, later.providerId, { value: 100, netValue: 97 });
  await db.query("UPDATE reservation_payments SET metadata=$2 WHERE id=$1", [later.id, { ...meta, asaas_account_id: 'different-wallet' }]);
  assert.equal(Number((await db.query('SELECT available_balance_cents FROM reservation_payment_settlements WHERE payment_id=$1', [later.id])).rows[0].available_balance_cents), 0, 'changed account scope revokes the projected balance immediately');
  await db.query('UPDATE reservation_payments SET metadata=$2 WHERE id=$1', [later.id, meta]);
  await db.query("UPDATE reservation_payments SET status='cancelled' WHERE id=$1", [later.id]);
  assert.equal(Number((await db.query('SELECT available_balance_cents FROM reservation_payment_settlements WHERE payment_id=$1', [later.id])).rows[0].available_balance_cents), 0, 'unresolved cancelled reservation receipts cannot be withdrawn');
  await db.query("UPDATE reservation_payments SET status='paid' WHERE id=$1", [later.id]);
  await db.query("UPDATE reservation_payment_settlements SET reconciliation_error='provider unavailable' WHERE payment_id=$1", [later.id]);
  await rpc('refresh_reservation_payment_settlement', [later.id, 'lookup_failed']);
  assert.equal((await db.query('SELECT available_balance_cents FROM reservation_payment_settlements WHERE payment_id=$1', [later.id])).rows[0].available_balance_cents, 0);

  const futureReservation = uuid();
  await db.query('INSERT INTO reservations(id,company_id,date) VALUES($1,$2,current_date+5)', [futureReservation, ids.company]);
  const future = await addPayment({ reservation: futureReservation });
  await sync(future.id, future.providerId, { value: 100, netValue: 97 });
  assert.equal(Number((await db.query('SELECT pending_balance_cents FROM reservation_payment_settlements WHERE payment_id=$1', [future.id])).rows[0].pending_balance_cents), 9200, 'after-reservation default prevents early release');
  for (const changes of [{ billingType: 'RECEIVED_IN_CASH' }, { installment: 'installment_1' }, { netValue: null }]) {
    const manual = await addPayment();
    await sync(manual.id, manual.providerId, { value: 100, netValue: 97, ...changes });
    assert.equal(Number((await db.query('SELECT available_balance_cents FROM reservation_payment_settlements WHERE payment_id=$1', [manual.id])).rows[0].available_balance_cents), 0);
  }
  await terms(800, 'on_settlement', 0, false);
  await assert.rejects(addPayment(), /Condições comerciais.*desabilitadas/, 'disabled terms stop new central charges atomically');
  await rpc('save_reservation_settlement_terms', [ids.company, 700, 'on_settlement', 0, new Date(Date.now() + 2 * 86400000).toISOString(), true, ids.actor]);
  assert.equal((await summary()).terms.enabled, false, 'scheduled terms do not apply before their effective time');
  assert.equal((await summary()).terms_history[0].fee_bps, 700, 'scheduled changes remain visible in history');
  await assert.rejects(addPayment(), /Condições comerciais.*desabilitadas/, 'future enabled terms cannot bypass the currently disabled agreement');

  const otherSummary = await rpc('get_reservation_settlement_summary', [ids.other]);
  assert.equal(otherSummary.available_cents, 0);
  assert.deepEqual(otherSummary.withdrawals, []);
  await assert.rejects(db.exec('UPDATE reservation_settlement_ledger SET available_delta_cents=0'), /histórico financeiro/);
  await assert.rejects(db.exec('DELETE FROM reservation_withdrawal_events'), /histórico financeiro/);
  await assert.rejects(db.query('DELETE FROM reservation_payments WHERE id=$1', [ids.payment]), /foreign key constraint/);
  await assert.rejects(db.query('DELETE FROM companies WHERE id=$1', [ids.company]), /foreign key constraint/);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(summary(), /permission denied/);
    await assert.rejects(terms(), /permission denied/);
    await assert.rejects(db.exec('SELECT * FROM reservation_withdrawals'), /permission denied/);
    await assert.rejects(db.exec('SELECT * FROM company_payout_destinations'), /permission denied/);
    await db.exec('RESET ROLE');
  }
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='reservation-payout-receipts'")).rows[0].public, false);
  console.log('Reservation settlements SQL regression passed: snapshot terms, settlement versus confirmation, absorbed fees, holds/refunds, stale/error fail-closed, withdrawal idempotency, serialized overspend prevention, frozen destination, private receipt evidence, tenant ACLs and retained history.');
} finally {
  await db.close();
}
