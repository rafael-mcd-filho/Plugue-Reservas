import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Execute the actual transaction migration against local PostgreSQL. Fixtures
// stub provider scheduling only; no external service is contacted.
const db = new PGlite();
const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reservation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const payment = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const table = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const migration = new URL('../migrations/20261107141000_harden_reservation_payment_lifecycle.sql', import.meta.url);
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0]?.value; }
async function confirm() {
  return scalar(`SELECT public.confirm_reservation_payment($1,$2,'RECEIVED',now(),'{"provider_paid_at":{"precision":"timestamp"}}','offline-test') value`, [payment,company]);
}
async function outcome(status='refunded') {
  return scalar(`SELECT apply_reservation_payment_outcome($1,$2,$3,'REFUNDED','{}','Estorno','payment_refunded','{}') value`,[payment,company,status]);
}
async function reset({ paymentStatus = 'pending', reservationStatus = 'pending_payment', expired = false } = {}) {
  await db.exec('TRUNCATE reservation_payment_events,reservation_table_assignments,reservation_payments,reservations');
  await db.query(`INSERT INTO reservations(id,company_id,status,date,time,party_size,duration_minutes,table_id)
    VALUES($1,$2,$3,'2030-01-01','18:00',2,60,$4)`, [reservation,company,reservationStatus,table]);
  await db.query(`INSERT INTO reservation_payments(id,company_id,reservation_id,status,expires_at)
    VALUES($1,$2,$3,$4,now()+($5||' hours')::interval)`, [payment,company,reservation,paymentStatus,expired ? '-1' : '1']);
}

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE companies(id uuid PRIMARY KEY,max_guests_per_slot integer);
    CREATE TABLE reservations(id uuid PRIMARY KEY,company_id uuid,status text,date date,time time,party_size integer,duration_minutes integer,table_id uuid,updated_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE reservation_payments(id uuid PRIMARY KEY,company_id uuid,reservation_id uuid,status text,expires_at timestamptz,asaas_status text,paid_at timestamptz,last_checked_at timestamptz,error_details text,metadata jsonb DEFAULT '{}',asaas_payment_id text,payment_link_external_reference text,asaas_payment_link_id text,cancelled_at timestamptz);
    CREATE TABLE reservation_table_assignments(reservation_id uuid,table_id uuid);
    CREATE TABLE reservation_payment_events(company_id uuid,reservation_payment_id uuid,reservation_id uuid,event_type text,payload jsonb);
    CREATE TABLE asaas_webhook_events(id uuid);
    CREATE TABLE reservation_schedule_rule_slots(block_id uuid,time time,max_guests_per_slot integer,max_reservations_per_slot integer);
    CREATE TABLE system_settings(key text,value text);
    INSERT INTO system_settings VALUES('internal_job_secret','offline-job-secret');
    CREATE TABLE platform_reservation_asaas_config(id boolean PRIMARY KEY,project_url text);
    INSERT INTO platform_reservation_asaas_config VALUES(true,null);
    CREATE TABLE test_schedule(availability_mode text,block_id uuid);
    INSERT INTO test_schedule VALUES('tables',null);
    CREATE FUNCTION get_public_reservation_schedule(uuid,date) RETURNS TABLE(availability_mode text,block_id uuid)
      LANGUAGE sql AS $$ SELECT * FROM test_schedule $$;
    CREATE FUNCTION resolve_reservation_slot_duration(uuid,date,time) RETURNS integer LANGUAGE sql AS $$ SELECT 60 $$;
    CREATE FUNCTION count_overlapping_reservation_guests(uuid,date,time,integer,uuid) RETURNS integer LANGUAGE sql AS $$
      SELECT COALESCE(sum(party_size),0)::integer FROM reservations WHERE company_id=$1 AND date=$2 AND id<>$5 AND status='confirmed'
      AND date+time < $2+$3+make_interval(mins=>$4) AND date+time+make_interval(mins=>duration_minutes)>$2+$3 $$;
    CREATE FUNCTION count_slot_arrival_reservations(uuid,date,time,uuid) RETURNS integer LANGUAGE sql AS $$
      SELECT count(*)::integer FROM reservations WHERE company_id=$1 AND date=$2 AND time=$3 AND id<>$4 AND status='confirmed' $$;
    CREATE FUNCTION reservation_table_conflict_id(uuid,date,time,integer,uuid,uuid) RETURNS uuid LANGUAGE sql AS $$
      SELECT r.id FROM reservations r LEFT JOIN reservation_table_assignments a ON a.reservation_id=r.id
      WHERE r.company_id=$1 AND r.date=$2 AND (r.table_id=$5 OR a.table_id=$5) AND r.id<>$6 AND r.status='confirmed'
      AND r.date+r.time<$2+$3+make_interval(mins=>$4) AND r.date+r.time+make_interval(mins=>r.duration_minutes)>$2+$3 LIMIT 1 $$;
    CREATE SCHEMA cron; CREATE SCHEMA net;
    CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY,jobname text UNIQUE,schedule text,command text);
    CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN DELETE FROM cron.job WHERE jobid=$1; RETURN FOUND; END$$;
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE plpgsql AS $$DECLARE _id bigint; BEGIN
      INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) ON CONFLICT(jobname)
      DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid INTO _id; RETURN _id; END$$;
    CREATE TABLE net.requests(url text,headers jsonb,body jsonb);
    CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}',params jsonb DEFAULT '{}',headers jsonb DEFAULT '{}')
      RETURNS bigint LANGUAGE plpgsql AS $$BEGIN INSERT INTO net.requests(url,headers,body) VALUES($1,$4,$2); RETURN 1; END$$;
  `);
  await db.query('INSERT INTO companies(id,max_guests_per_slot) VALUES($1,20)', [company]);
  const migrationSql=await readFile(migration,'utf8');
  assert.equal(migrationSql.includes('hdpxqqiudiotanrybvcf'),false,'new lifecycle jobs must never fall back to the production host');
  await db.exec(migrationSql);
  const multiTableMigration = await readFile(new URL('../migrations/20260919120000_add_multi_table_reservation_assignments.sql',import.meta.url),'utf8');
  function actualFunction(name) {
    const start=multiTableMigration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    assert.ok(start>=0);
    return multiTableMigration.slice(start,multiTableMigration.indexOf('$$;',start)+3);
  }
  // Use the actual production conflict function AND trigger, rather than a
  // hand-built trigger that could hide an incompatible occupancy status.
  await db.exec(actualFunction('reservation_table_conflict_id'));
  await db.exec(actualFunction('validate_reservation_primary_table_conflict'));
  await db.exec(`CREATE TRIGGER trg_validate_reservation_primary_table_conflict AFTER INSERT OR UPDATE OF table_id,company_id,date,time,duration_minutes,status
    ON reservations FOR EACH ROW EXECUTE FUNCTION validate_reservation_primary_table_conflict()`);

  await reset();
  assert.deepEqual(await confirm(), { status: 'paid', changed: true });
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1',[reservation]), 'confirmed');
  assert.deepEqual(await confirm(), { status: 'paid', changed: false });
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_events'), 1, 'retry must not duplicate audit events');

  await reset({ paymentStatus:'refunded', reservationStatus:'payment_cancelled' });
  assert.deepEqual(await confirm(), { status:'refunded', changed:false }, 'stale receipt must not overwrite a refund');

  await reset({ reservationStatus:'cancelled' });
  assert.deepEqual(await confirm(), { status:'late_paid', changed:true });
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1',[reservation]), 'cancelled', 'financial receipt must not reopen explicit cancellation');

  await reset({ expired:true, reservationStatus:'payment_expired',paymentStatus:'expired' });
  await db.query(`INSERT INTO reservations(id,company_id,status,date,time,party_size,duration_minutes) VALUES($1,$2,'confirmed','2030-01-01','18:30',2,60)`,[other,company]);
  await db.query('INSERT INTO reservation_table_assignments VALUES($1,$2)',[other,table]);
  assert.deepEqual(await confirm(), { status:'late_paid', changed:true }, 'overlap with a secondary table must be detected');
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1',[reservation]), 'paid_after_expiration');
  assert.equal(await scalar('SELECT is_reservation_occupying_capacity(id,status,created_at) value FROM reservations WHERE id=$1',[reservation]),false);

  await reset({ expired:true, reservationStatus:'payment_expired',paymentStatus:'expired' });
  await db.exec(`UPDATE test_schedule SET availability_mode='capacity'; UPDATE companies SET max_guests_per_slot=2`);
  await db.query(`INSERT INTO reservations(id,company_id,status,date,time,party_size,duration_minutes) VALUES($1,$2,'confirmed','2030-01-01','18:30',2,60)`,[other,company]);
  assert.deepEqual(await confirm(), { status:'late_paid', changed:true }, 'late capacity bookings must be revalidated');
  await db.exec(`UPDATE test_schedule SET availability_mode='tables'; UPDATE companies SET max_guests_per_slot=20`);

  await reset();
  await db.exec(`CREATE FUNCTION fail_confirmation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture reservation failure'; END$$;
    CREATE TRIGGER fail_confirmation_fixture BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION fail_confirmation_fixture()`);
  await assert.rejects(confirm(), /fixture reservation failure/);
  assert.equal(await scalar('SELECT status value FROM reservation_payments WHERE id=$1',[payment]), 'pending', 'payment update must roll back with reservation failure');
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_events'), 0);
  await assert.rejects(outcome(), /fixture reservation failure/);
  assert.equal(await scalar('SELECT status value FROM reservation_payments WHERE id=$1',[payment]), 'pending', 'refund outcome must roll back with reservation failure');
  await db.exec('DROP TRIGGER fail_confirmation_fixture ON reservations');

  assert.equal((await outcome()).status,'refunded');
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1',[reservation]),'payment_cancelled');
  assert.equal((await outcome('refund_pending')).status,'refunded','late progress event must not undo full refund');
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_events'),1);
  // Repair an old split update even if the financial status already matches.
  await db.query('UPDATE reservations SET status=$1 WHERE id=$2',['confirmed',reservation]);
  await outcome();
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1',[reservation]),'payment_cancelled');

  await reset();
  await db.query('UPDATE reservations SET company_id=$1 WHERE id=$2',[other,reservation]);
  await assert.rejects(outcome(),/Reserva nao encontrada/);
  assert.equal(await scalar('SELECT status value FROM reservation_payments WHERE id=$1',[payment]),'pending');

  await reset({ paymentStatus:'paid',reservationStatus:'confirmed' });
  await db.query(`SELECT record_reservation_installment_snapshot($1,$2,'installment-one','pay_first','{"status":"RECEIVED","value":10}')`,[payment,company]);
  await db.query(`SELECT record_reservation_installment_snapshot($1,$2,'installment-one','pay_second','{"status":"REFUNDED","value":10}')`,[payment,company]);
  const installmentMetadata=await scalar('SELECT metadata value FROM reservation_payments WHERE id=$1',[payment]);
  assert.equal(installmentMetadata.needs_manual_installment_reconciliation,true);
  assert.equal(Object.keys(installmentMetadata.asaas_installment_payments).length,2,'observations must preserve independent provider IDs');
  assert.equal((await outcome()).status,'paid','a single installment outcome must not mutate the whole reservation payment');
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1',[reservation]),'confirmed');

  await assert.rejects(scalar(`SELECT confirm_reservation_payment($1,$2,'RECEIVED',now(),'{}','test') value`,[payment,other]), /Pagamento nao encontrado/);
  assert.equal(await scalar(`SELECT has_function_privilege('authenticated','public.confirm_reservation_payment(uuid,uuid,text,timestamptz,jsonb,text)','EXECUTE') value`),false);
  assert.equal(await scalar(`SELECT has_function_privilege('service_role','public.confirm_reservation_payment(uuid,uuid,text,timestamptz,jsonb,text)','EXECUTE') value`),true);

  await reset();
  await db.query('UPDATE reservation_payments SET asaas_payment_id=$1 WHERE id=$2',['pay_cron_fixture',payment]);
  const jobs=(await db.query('SELECT jobname,schedule,command FROM cron.job ORDER BY jobname')).rows;
  assert.deepEqual(jobs.map(job => [job.jobname,job.schedule]),[
    ['expire-reservation-payments','*/1 * * * *'],['reconcile-reservation-payments','*/10 * * * *'],
  ]);
  for (const job of jobs) await db.exec(job.command);
  assert.equal(await scalar('SELECT count(*)::integer value FROM net.requests'),0,'unset project URL must make both jobs inert');
  await db.query('UPDATE platform_reservation_asaas_config SET project_url=$1',['https://local-sandbox-project.supabase.invalid/']);
  for (const job of jobs) await db.exec(job.command);
  const requests=(await db.query('SELECT * FROM net.requests ORDER BY url')).rows;
  assert.deepEqual(requests.map(request => request.url),[
    'https://local-sandbox-project.supabase.invalid/functions/v1/expire-reservation-payments',
    'https://local-sandbox-project.supabase.invalid/functions/v1/reconcile-reservation-payments',
  ]);
  assert.ok(requests.every(request => request.headers['x-job-secret']==='offline-job-secret'));
  await db.exec(`TRUNCATE net.requests; UPDATE platform_reservation_asaas_config SET project_url='  '`);
  for (const job of jobs) await db.exec(job.command);
  assert.equal(await scalar('SELECT count(*)::integer value FROM net.requests'),0,'blank project URL must also fail closed');
  console.log('Reservation payment lifecycle SQL regressions passed.');
} finally { await db.close(); }
