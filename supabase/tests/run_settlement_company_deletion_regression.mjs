import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE companies(id uuid PRIMARY KEY,deletion_requested_at timestamptz);
CREATE TABLE company_deletion_requests(id uuid PRIMARY KEY,company_id uuid,status text,updated_at timestamptz,last_error text);
CREATE TABLE reservation_settlement_terms(company_id uuid);
CREATE TABLE company_payout_destinations(company_id uuid);
CREATE TABLE reservation_payment_settlements(company_id uuid);
CREATE TABLE reservation_withdrawals(company_id uuid);
CREATE TABLE deletion_batches(company_id uuid);
CREATE FUNCTION public._process_company_deletion_batch(_request_id uuid,_batch_size integer DEFAULT 3000)
RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
  INSERT INTO deletion_batches SELECT company_id FROM company_deletion_requests WHERE id=_request_id;
  RETURN jsonb_build_object('status','running');
END;$$;
`);
await db.exec(readFileSync(new URL('../migrations/20261108191000_guard_financial_company_deletion.sql', import.meta.url), 'utf8'));
const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const request = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
await db.query('INSERT INTO companies(id) VALUES($1),($2)', [company, other]);
// An already queued request can gain financial history before its next batch.
await db.query("INSERT INTO company_deletion_requests VALUES($1,$2,'running',now(),NULL)", [request, company]);
await db.query('INSERT INTO reservation_settlement_terms VALUES($1)', [company]);
await assert.rejects(db.query("INSERT INTO company_deletion_requests VALUES(gen_random_uuid(),$1,'grace_period',now(),NULL)", [company]), /histórico de repasses/);
await assert.rejects(db.query('UPDATE companies SET deletion_requested_at=now() WHERE id=$1', [company]), /histórico de repasses/);
const held = await db.query('SELECT _process_company_deletion_batch($1,1) AS result', [request]);
assert.equal(held.rows[0].result.status, 'needs_attention');
assert.equal((await db.query('SELECT count(*)::integer AS count FROM deletion_batches')).rows[0].count, 0);
assert.equal((await db.query('SELECT deletion_requested_at FROM companies WHERE id=$1', [company])).rows[0].deletion_requested_at, null);
// Companies without settlement records retain the original deletion behavior.
await db.query("INSERT INTO company_deletion_requests VALUES(gen_random_uuid(),$1,'running',now(),NULL)", [other]);
await db.query('SELECT _process_company_deletion_batch(id,1) FROM company_deletion_requests WHERE company_id=$1', [other]);
assert.equal((await db.query('SELECT count(*)::integer AS count FROM deletion_batches')).rows[0].count, 1);
await db.exec('SET ROLE authenticated');
await assert.rejects(db.query('SELECT _process_company_deletion_batch($1,1)', [request]), /permission denied/);
await db.exec('RESET ROLE; SET ROLE service_role');
await assert.rejects(db.query('SELECT _process_company_deletion_batch_without_settlements($1,1)', [request]), /permission denied/);
await db.exec('RESET ROLE');
await db.close();
console.log('Settlement company deletion guards: passed (preflight, queued jobs, unchanged legacy path, roles).');
