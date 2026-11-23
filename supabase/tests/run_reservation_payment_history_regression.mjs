import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Ephemeral PostgreSQL only. This test has no provider, network or production
// connections and does not change the existing company-deletion workflow.
const db = new PGlite();
const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const companyCascade = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const companyWorker = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actor = '11111111-1111-4111-8111-111111111111';
const ids = {
  paid: '10000000-0000-4000-8000-000000000001',
  pending: '10000000-0000-4000-8000-000000000002',
  unpaidDirect: '10000000-0000-4000-8000-000000000003',
  unpaidRpc: '10000000-0000-4000-8000-000000000004',
  foreign: '10000000-0000-4000-8000-000000000005',
  cascade: '10000000-0000-4000-8000-000000000006',
  worker: '10000000-0000-4000-8000-000000000007',
};
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0]?.value; }
function actualFunction(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `Missing actual function ${name}`);
  return source.slice(start, source.indexOf('$$;', start) + 3);
}
async function login(role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims',$1,false)`, [JSON.stringify({sub: actor, role})]);
  await db.exec(`SET ROLE ${role}`);
}
const rejectsHistory = operation => assert.rejects(operation, error => error.code === '23503' && /historico de pagamento/.test(error.message));

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
    CREATE TABLE companies(id uuid PRIMARY KEY);
    CREATE TABLE test_delete_permissions(user_id uuid,company_id uuid);
    CREATE FUNCTION has_company_panel_permission(uuid,uuid,text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT $3='reservations_delete' AND EXISTS(SELECT 1 FROM test_delete_permissions WHERE user_id=$1 AND company_id=$2) $$;
    CREATE TABLE reservations(id uuid PRIMARY KEY,company_id uuid REFERENCES companies(id) ON DELETE CASCADE,status text DEFAULT 'confirmed');
    CREATE TABLE reservation_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
      reservation_id uuid REFERENCES reservations(id) ON DELETE CASCADE,status text,asaas_payment_id text);
    CREATE TABLE reservation_payment_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
      reservation_id uuid REFERENCES reservations(id) ON DELETE CASCADE,reservation_payment_id uuid REFERENCES reservation_payments(id) ON DELETE CASCADE);
    ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY staff_read ON reservations FOR SELECT TO authenticated USING(has_company_panel_permission(auth.uid(),company_id,'reservations_delete'));
    CREATE POLICY staff_delete ON reservations FOR DELETE TO authenticated USING(has_company_panel_permission(auth.uid(),company_id,'reservations_delete'));
    ALTER TABLE reservation_payments ENABLE ROW LEVEL SECURITY;
    GRANT SELECT,DELETE ON reservations TO authenticated;
    GRANT SELECT ON reservation_payments TO authenticated;
    GRANT ALL ON companies,reservations,reservation_payments,reservation_payment_events TO service_role;
    CREATE TABLE company_deletion_phase_order(phase_index integer PRIMARY KEY,table_name text UNIQUE);
  `);
  const oldRpc = await readFile(new URL('../migrations/20260422151000_add_company_panel_permission_helper_and_reservation_delete_rpc.sql', import.meta.url), 'utf8');
  await db.exec(actualFunction(oldRpc, 'delete_company_reservation'));
  await db.exec('GRANT EXECUTE ON FUNCTION delete_company_reservation(uuid) TO authenticated');
  await db.exec(await readFile(new URL('../migrations/20261107150000_preserve_reservation_payment_history.sql', import.meta.url), 'utf8'));
  const deletionSchema = await readFile(new URL('../migrations/20260826161000_add_company_deletion_requests.sql', import.meta.url), 'utf8');
  const orderStart = deletionSchema.indexOf('INSERT INTO public.company_deletion_phase_order (phase_index, table_name) VALUES');
  assert.ok(orderStart >= 0);
  await db.exec(deletionSchema.slice(orderStart, deletionSchema.indexOf(';', orderStart) + 1));

  for (const id of [companyA, companyB, companyCascade, companyWorker]) await db.query('INSERT INTO companies VALUES($1)', [id]);
  await db.query('INSERT INTO test_delete_permissions VALUES($1,$2)', [actor,companyA]);
  for (const [key,id] of Object.entries(ids)) {
    const company = key==='foreign' ? companyB : key==='cascade' ? companyCascade : key==='worker' ? companyWorker : companyA;
    await db.query('INSERT INTO reservations(id,company_id) VALUES($1,$2)', [id,company]);
    if (!key.startsWith('unpaid')) {
      const paymentId = await scalar('INSERT INTO reservation_payments(company_id,reservation_id,status,asaas_payment_id) VALUES($1,$2,$3,$4) RETURNING id value',
        [company,id,key==='pending'?'awaiting_method':'paid',key==='pending'?null:`pay_${key}`]);
      await db.query('INSERT INTO reservation_payment_events(company_id,reservation_id,reservation_payment_id) VALUES($1,$2,$3)', [company,id,paymentId]);
    }
  }

  await login();
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payments'),0,'the trigger must protect history even when caller RLS cannot read it');
  await rejectsHistory(db.query('DELETE FROM reservations WHERE id=$1',[ids.paid]));
  await rejectsHistory(db.query('SELECT delete_company_reservation($1)',[ids.paid]));
  await rejectsHistory(db.query('DELETE FROM reservations WHERE id=$1',[ids.pending]));
  assert.equal((await db.query('DELETE FROM reservations WHERE id=$1 RETURNING id',[ids.unpaidDirect])).rows.length,1);
  assert.equal(await scalar('SELECT delete_company_reservation($1) value',[ids.unpaidRpc]),true);
  assert.equal((await db.query('DELETE FROM reservations WHERE id=$1 RETURNING id',[ids.foreign])).rows.length,0,'cross-company RLS remains enforced');
  await assert.rejects(db.query('DELETE FROM companies WHERE id=$1',[companyA]),error=>error.code==='42501');

  await login('service_role');
  await rejectsHistory(db.query('DELETE FROM reservations WHERE id=$1',[ids.paid]));
  await db.query('UPDATE reservations SET status=$1 WHERE id=$2',['cancelled',ids.paid]);
  await rejectsHistory(db.query('DELETE FROM reservations WHERE id=$1',[ids.paid]));
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payments WHERE reservation_id=$1',[ids.paid]),1);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_events WHERE reservation_id=$1',[ids.paid]),1);

  // Final company cascades remain supported, including data omitted from a
  // phase list: the already-deleted parent is no longer visible to the guard.
  await db.query('DELETE FROM companies WHERE id=$1',[companyCascade]);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservations WHERE id=$1',[ids.cascade]),0);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payments WHERE company_id=$1',[companyCascade]),0);

  // Walk the real workflow's relevant phase ordering without changing it.
  await db.exec('RESET ROLE');
  const phases=(await db.query(`SELECT table_name FROM company_deletion_phase_order WHERE table_name IN
    ('reservation_payment_events','reservation_payments','reservations') ORDER BY phase_index`)).rows.map(row=>row.table_name);
  assert.deepEqual(phases,['reservation_payment_events','reservation_payments','reservations']);
  await login('service_role');
  for (const tableName of phases) await db.query(`DELETE FROM public.${tableName} WHERE company_id=$1`,[companyWorker]);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservations WHERE company_id=$1',[companyWorker]),0);
  await db.query('DELETE FROM companies WHERE id=$1',[companyWorker]);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payments WHERE company_id=$1',[companyB]),1,'other company history stays intact');
  console.log('Reservation payment history guard regressions passed (direct DELETE, actual RPC, RLS, service role, cancellation, company cascade and existing worker phase order).');
} finally { await db.close(); }
