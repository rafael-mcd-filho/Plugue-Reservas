// Offline migration regression: normalize future rules without rewriting any
// old payment or provider link. No credentials, HTTP or external database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const company = '11111111-1111-4111-8111-111111111111';
const rule = '22222222-2222-4222-8222-222222222222';
const paid = '33333333-3333-4333-8333-333333333333';
const awaiting = '44444444-4444-4444-8444-444444444444';
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.reservation_payment_rules(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,name text,date_start date,date_end date,
      enabled boolean DEFAULT false,archived_at timestamptz,amount_type text,base_amount numeric,
      pix_enabled boolean,pix_amount numeric,credit_card_enabled boolean,credit_card_amount numeric,
      max_credit_card_installments integer,payment_deadline_minutes integer,customer_notice text,cancellation_policy text);
    CREATE TABLE public.reservation_payments(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),rule_id uuid,status text,billing_type text,max_installments integer,
      rule_snapshot jsonb,asaas_payment_link_id text,metadata jsonb DEFAULT '{}');
  `);
  const original = await readFile(new URL('../migrations/20260519170000_add_asaas_reservation_prepayments.sql', import.meta.url), 'utf8');
  const start = original.indexOf('CREATE OR REPLACE FUNCTION public.validate_reservation_payment_rule()');
  assert.ok(start >= 0);
  await db.exec(original.slice(start, original.indexOf('$$;', start) + 3));
  await db.exec(`CREATE TRIGGER trg_validate_reservation_payment_rule BEFORE INSERT OR UPDATE ON reservation_payment_rules
    FOR EACH ROW EXECUTE FUNCTION validate_reservation_payment_rule();`);
  await db.query(`INSERT INTO reservation_payment_rules(id,company_id,name,date_start,date_end,credit_card_enabled,max_credit_card_installments)
    VALUES($1,$2,'Legacy rule',current_date,current_date,true,2)`, [rule, company]);
  await db.query(`INSERT INTO reservation_payments(id,rule_id,status,billing_type,max_installments,rule_snapshot,asaas_payment_link_id,metadata)
    VALUES($1,$3,'paid','CREDIT_CARD',2,'{"credit_card_enabled":true,"max_credit_card_installments":2}','legacy-link','{"asaas_installment_id":"legacy-group"}'),
      ($2,$3,'awaiting_method',NULL,NULL,'{"credit_card_enabled":true,"max_credit_card_installments":2}',NULL,'{}')`, [paid, awaiting, rule]);
  const before = await scalar('SELECT jsonb_agg(to_jsonb(p) ORDER BY id) value FROM reservation_payments p');
  await db.exec(await readFile(new URL('../migrations/20261109131000_require_single_card_reservation_payments.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(p) ORDER BY id) value FROM reservation_payments p'), before, 'Migration preserves every old payment, snapshot and provider link');
  assert.equal(await scalar('SELECT max_credit_card_installments value FROM reservation_payment_rules WHERE id=$1', [rule]), 1);
  const used = await db.query('UPDATE reservation_payment_rules SET enabled=true,max_credit_card_installments=21 WHERE id=$1 RETURNING max_credit_card_installments', [rule]);
  assert.equal(used.rows[0].max_credit_card_installments, 1, 'Stale client cannot re-enable parcels on an already-used rule');
  await assert.rejects(db.query('UPDATE reservation_payment_rules SET base_amount=50 WHERE id=$1', [rule]), /Regra ja usada nao pode ser editada/);
  assert.equal(await scalar('UPDATE reservation_payment_rules SET archived_at=now(),enabled=false,max_credit_card_installments=21 WHERE id=$1 RETURNING max_credit_card_installments value', [rule]), 1, 'Archiving a previously-used rule remains available');
  const fresh = await scalar(`INSERT INTO reservation_payment_rules(company_id,credit_card_enabled,max_credit_card_installments)
    VALUES($1,true,21) RETURNING max_credit_card_installments value`, [company]);
  assert.equal(fresh, 1);
  assert.equal(await scalar(`INSERT INTO reservation_payment_rules(company_id,credit_card_enabled,max_credit_card_installments)
    VALUES($1,false,21) RETURNING max_credit_card_installments value`, [company]), null);
  const created = (await db.query(`INSERT INTO reservation_payments(status,billing_type,max_installments,rule_snapshot)
    VALUES('pending','CREDIT_CARD',21,'{"credit_card_enabled":true,"max_credit_card_installments":21}')
    RETURNING max_installments,rule_snapshot`)).rows[0];
  assert.equal(created.max_installments, 1);
  assert.equal(created.rule_snapshot.max_credit_card_installments, 1);
  const selected = (await db.query(`UPDATE reservation_payments SET status='pending',billing_type='CREDIT_CARD',max_installments=21
    WHERE id=$1 RETURNING max_installments,rule_snapshot`, [awaiting])).rows[0];
  assert.equal(selected.max_installments, 1);
  assert.equal(selected.rule_snapshot.max_credit_card_installments, 2, 'Selection preserves the old rule snapshot');
  await db.query("UPDATE reservation_payments SET status='refunded' WHERE id=$1", [paid]);
  const historical = (await db.query('SELECT * FROM reservation_payments WHERE id=$1', [paid])).rows[0];
  assert.equal(historical.max_installments, 2);
  assert.equal(historical.asaas_payment_link_id, 'legacy-link');
  assert.equal(historical.metadata.asaas_installment_id, 'legacy-group');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await scalar(`SELECT has_function_privilege($1,'public.enforce_new_reservation_single_card_payment()','EXECUTE') value`, [role]), false);
  }
  console.log('Single-payment card SQL regression passed: rules normalized, stale clients clamped, original history and guards preserved.');
} finally { await db.close(); }
