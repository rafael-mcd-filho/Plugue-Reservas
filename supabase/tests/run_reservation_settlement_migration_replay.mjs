// Full real migration replay and financial flow. PGlite only; Auth/Storage are
// fixtures and net.http_post is an inert recording stub. No HTTP or credentials.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(root, 'supabase/migrations');
const db = new PGlite();
const company = 'fedcba98-7654-4321-8765-000000000001';
const admin = 'fedcba98-7654-4321-8765-000000000002';
const requestKey = 'fedcba98-7654-4321-8765-000000000003';
const actor = async (role) => {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('request.headers','{}',false)", [JSON.stringify({ sub: admin, role })]);
  await db.exec(`SET ROLE ${role}`);
};
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const rpc = async (name, args = []) => scalar(`SELECT public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')}) value`, args);

try {
  // Reuse the repository's managed-platform fixture without running its older
  // feature-specific data assertions (those use legacy national phone inputs).
  const supportRunner = await readFile(resolve(root, 'supabase/tests/run_support_migration_replay.mjs'), 'utf8');
  const fixture = supportRunner.match(/await db\.exec\(String\.raw`([\s\S]*?)`\);/);
  assert.ok(fixture, 'Support replay must expose its Auth/Storage/cron fixture');
  await db.exec(fixture[1]);
  await db.exec(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    CREATE TABLE net.recorded_requests(id bigint GENERATED ALWAYS AS IDENTITY,url text,headers jsonb,body jsonb);
    CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}',params jsonb DEFAULT '{}',headers jsonb DEFAULT '{}',timeout_milliseconds integer DEFAULT 1000)
    RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE _id bigint; BEGIN
      INSERT INTO net.recorded_requests(url,headers,body) VALUES(url,headers,body) RETURNING id INTO _id;
      RETURN _id;
    END; $$;
  `);
  const migrations = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
  for (const required of ['20261108190000_', '20261108191000_', '20261108192000_']) {
    assert.ok(migrations.some(file => file.startsWith(required)), `Missing financial migration ${required}`);
  }
  for (const file of migrations) {
    if (file === '20260309211714_c61ee570-889c-44b5-9189-83eb8dc93983.sql') {
      await db.exec(`INSERT INTO companies(id,name,slug) VALUES('1e0da55b-f8e9-4199-80b6-79c64e93cb7a','Historical demo fixture','historical-demo');
        INSERT INTO restaurant_tables(id,company_id,number) VALUES
        ('9a83e0fe-79e0-40e1-bdd5-1cfbab07752f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',1),
        ('57be60f4-936e-42f9-ac7f-7f2049f5709f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',2);`);
    }
    const sql = (await readFile(resolve(directory, file), 'utf8'))
      .replace(/CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)[^;]*;/gi, '')
      .replace(/CREATE INDEX CONCURRENTLY/gi, 'CREATE INDEX');
    try { await db.exec(sql); }
    catch (error) { throw new Error(`Full financial migration replay failed in ${file}: ${error.message}`, { cause: error }); }
  }
  const cron = (await db.query("SELECT command FROM cron.job WHERE jobname='reconcile-reservation-settlements'")).rows[0];
  assert.ok(cron);
  assert.equal((await db.query(cron.command)).rows[0].request_id, null, 'new project cron is inert without configured account URL');
  assert.equal(await scalar('SELECT count(*)::int value FROM net.recorded_requests'), 0);

  await db.query("INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,'financial-admin@offline.test','{\"full_name\":\"Financial Test Admin\"}')", [admin]);
  await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'superadmin')", [admin]);
  await db.query("INSERT INTO companies(id,name,slug) VALUES($1,'Financial Replay Test','financial-replay-test')", [company]);
  await db.query("UPDATE platform_reservation_asaas_config SET provider_account_id='wallet-replay',api_token_encrypted='offline-ciphertext',status='configured',project_url='https://offline.invalid' WHERE id=true");
  await db.exec('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role');
  await actor('service_role');
  const reservation = await scalar(`INSERT INTO reservations(company_id,guest_name,guest_phone,date,time,status,party_size)
    VALUES($1,'Visitante Teste','+5511999999999',current_date-2,'18:00','pending_payment',2) RETURNING id value`, [company]);
  const missingTermsCharge = () => scalar(`INSERT INTO reservation_payments(company_id,reservation_id,base_amount,expires_at,metadata)
    VALUES($1,$2,2000,now()+interval '1 hour',$3) RETURNING id value`, [company, reservation,
    { asaas_account_scope: 'platform', asaas_account_id: 'wallet-replay', asaas_environment: 'production' }]);
  await assert.rejects(missingTermsCharge(), /Condições comerciais.*não configuradas/);
  assert.equal(await scalar('SELECT count(*)::int value FROM reservation_payments WHERE company_id=$1', [company]), 0, 'missing agreement rolls back the new central payment insert');
  await rpc('save_reservation_settlement_terms', [company, 1000, 'after_reservation', 0, null, false, admin]);
  await assert.rejects(missingTermsCharge(), /Condições comerciais.*desabilitadas/);
  await rpc('save_reservation_settlement_terms', [company, 1000, 'after_reservation', 0, null, true, admin]);
  await assert.rejects(rpc('save_company_payout_destination', [company, { kind: 'bank', holder_name: 'Empresa Teste', holder_document: '12345678000195' }, admin]), /check constraint/);
  await rpc('save_company_payout_destination', [company, { kind: 'pix', holder_name: 'Empresa Teste', holder_document: '12345678000195', pix_key_type: 'random', pix_key: 'fedcba98-7654-4321-8765-000000000004' }, admin]);
  const payment = await scalar(`INSERT INTO reservation_payments(company_id,reservation_id,base_amount,charged_amount,billing_type,expires_at,metadata,asaas_payment_id)
    VALUES($1,$2,2000,2000,'PIX',now()+interval '1 hour',$3,'pay_replay_1') RETURNING id value`, [company, reservation,
    { asaas_account_scope: 'platform', asaas_account_id: 'wallet-replay', asaas_environment: 'production' }]);
  assert.equal(await scalar('SELECT count(*)::int value FROM reservation_payment_settlements WHERE payment_id=$1', [payment]), 1, 'real INSERT trigger snapshots terms');
  const snapshot = { id: 'pay_replay_1', status: 'CONFIRMED', billingType: 'PIX', value: 2000, netValue: 1940, observed_at: new Date().toISOString() };
  await rpc('sync_reservation_payment_settlement', [payment, snapshot, 'full-schema-test']);
  assert.equal((await rpc('get_reservation_settlement_summary', [company])).available_cents, 0);
  await rpc('confirm_reservation_payment', [payment, company, 'CONFIRMED', new Date().toISOString(), {}, 'full-schema-test']);
  let summary = await rpc('get_reservation_settlement_summary', [company]);
  assert.equal(summary.pending_cents, 180000);
  assert.equal(summary.available_cents, 0);
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1', [reservation]), 'confirmed', 'old confirmation helper and financial trigger coexist');
  await rpc('sync_reservation_payment_settlement', [payment, { ...snapshot, status: 'RECEIVED', observed_at: new Date().toISOString() }, 'full-schema-test']);
  summary = await rpc('get_reservation_settlement_summary', [company]);
  assert.equal(summary.available_cents, 180000);
  assert.equal(summary.fee_cents, 20000);
  assert.equal(summary.provider_cost_cents, 6000);

  const withdrawal = await rpc('request_reservation_withdrawal', [company, 50000, requestKey, admin]);
  await rpc('transition_reservation_withdrawal', [withdrawal.id, 'processing', admin]);
  const receipt = `${company}/${withdrawal.id}/fedcba98-7654-4321-8765-000000000005.pdf`;
  await db.query('INSERT INTO storage.objects(bucket_id,name,owner) VALUES($1,$2,$3)', ['reservation-payout-receipts', receipt, admin]);
  const paidAt = new Date().toISOString();
  await rpc('transition_reservation_withdrawal', [withdrawal.id, 'paid', admin, null, receipt, 'OFFLINE-REPLAY-REFERENCE', paidAt]);
  await rpc('transition_reservation_withdrawal', [withdrawal.id, 'paid', admin, null, receipt, 'OFFLINE-REPLAY-REFERENCE', paidAt]);
  summary = await rpc('get_reservation_settlement_summary', [company]);
  assert.equal(summary.available_cents, 130000);
  assert.equal(summary.paid_cents, 50000);
  assert.equal(summary.reserved_cents, 0);
  await db.query("UPDATE reservation_payments SET status='refund_pending' WHERE id=$1", [payment]);
  summary = await rpc('get_reservation_settlement_summary', [company]);
  assert.equal(summary.available_cents, -50000);
  assert.equal(summary.blocked_cents, 180000, 'real payment status update atomically reserves refund money');
  await db.query("UPDATE reservation_payments SET status='paid' WHERE id=$1", [payment]);
  assert.equal((await rpc('get_reservation_settlement_summary', [company])).available_cents, 130000);
  const duplicateReferenceWithdrawal = await rpc('request_reservation_withdrawal', [company, 10000, 'fedcba98-7654-4321-8765-000000000006', admin]);
  await rpc('transition_reservation_withdrawal', [duplicateReferenceWithdrawal.id, 'processing', admin]);
  const secondReceipt = `${company}/${duplicateReferenceWithdrawal.id}/fedcba98-7654-4321-8765-000000000007.pdf`;
  await db.query('INSERT INTO storage.objects(bucket_id,name,owner) VALUES($1,$2,$3)', ['reservation-payout-receipts', secondReceipt, admin]);
  await assert.rejects(rpc('transition_reservation_withdrawal', [duplicateReferenceWithdrawal.id, 'paid', admin, null, secondReceipt,
    ' offline-replay-reference ', new Date().toISOString()]), error => error.code === '23505' && /reservation_withdrawals_paid_reference/.test(error.message));
  summary = await rpc('get_reservation_settlement_summary', [company]);
  assert.equal(summary.paid_cents, 50000, 'duplicate transfer reference cannot create another paid ledger entry');
  assert.equal(summary.reserved_cents, 10000, 'failed finalization rolls back its ledger mutations atomically');

  // Managed RLS/default privileges do not leak new bank or financial records.
  await actor('authenticated');
  for (const table of ['company_payout_destinations', 'reservation_settlement_ledger', 'reservation_withdrawals']) {
    await assert.rejects(db.query(`SELECT * FROM public.${table}`), error => error.code === '42501');
  }
  await assert.rejects(rpc('get_reservation_settlement_summary', [company]), error => error.code === '42501');
  await actor('service_role');
  const before = await scalar('SELECT count(*)::int value FROM reservations WHERE company_id=$1', [company]);
  await assert.rejects(db.query('UPDATE companies SET deletion_requested_at=now() WHERE id=$1', [company]), /histórico de repasses/);
  assert.equal(await scalar('SELECT deletion_requested_at value FROM companies WHERE id=$1', [company]), null, 'quarantine was not partially applied');
  assert.equal(await scalar('SELECT count(*)::int value FROM reservations WHERE company_id=$1', [company]), before);
  await assert.rejects(db.query('DELETE FROM reservation_payments WHERE id=$1', [payment]), /foreign key constraint/);
  await assert.rejects(db.query('DELETE FROM companies WHERE id=$1', [company]), /foreign key constraint/);

  await db.exec('RESET ROLE');
  await db.query("INSERT INTO system_settings(key,value) VALUES('internal_job_secret','offline-only-test-secret') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  await db.query(cron.command);
  const recorded = (await db.query('SELECT url,body FROM net.recorded_requests')).rows;
  assert.deepEqual(recorded, [{ url: 'https://offline.invalid/functions/v1/reconcile-reservation-settlements', body: { limit: 25 } }], 'scheduled job resolves this project and only invokes local recording stub');
  console.log(`Full reservation settlement migration replay passed: ${migrations.length} real migrations, new-payment trigger, old booking confirmation, fee/balance/withdrawal/refund flow, managed ACLs, deletion preflight, private receipt and inert cron.`);
} finally {
  await db.close();
}
