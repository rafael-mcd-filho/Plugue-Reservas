import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = (name) => readFile(resolve(root, 'supabase/migrations', `${name}.sql`), 'utf8');
const db = new PGlite();
const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const table = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const day = '2026-11-03';
const scalar = async (sql, parameters = []) => (await db.query(sql, parameters)).rows[0]?.value;

// Load real deployed bodies, including their CRLF source and support identity
// adaptations, instead of testing copies of the implementation being added.
async function loadFunction(file, name, adaptSupport = false) {
  const sql = await migration(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `Missing function ${name}`);
  const end = sql.indexOf('$$;', start);
  assert.ok(end > start, `Missing body end ${name}`);
  let definition = sql.slice(start, end + 3);
  if (adaptSupport) definition = definition.replaceAll('auth.uid()', 'public.effective_auth_uid()');
  await db.exec(definition);
}

async function saveRule(slots, options = {}) {
  return scalar(`SELECT public.upsert_reservation_schedule_rule(
    _company_id := $1::uuid, _name := $2, _scope := $3,
    _rule_id := $4::uuid, _start_date := $5::date, _end_date := $6::date,
    _priority := $7, _blocks := $8::jsonb
  ) AS value`, [
    options.company ?? company, options.name ?? 'Agenda', options.scope ?? 'date_specific',
    options.id ?? null, options.date ?? day, options.end ?? day, options.priority ?? 100,
    JSON.stringify([{
      name: 'Padrao', availability_mode: options.mode ?? 'tables',
      weekdays: options.weekdays ?? null, slots,
    }]),
  ]);
}

async function availability(time, party = 2, date = day, companyId = company) {
  return (await db.query(`SELECT * FROM public.get_public_reservation_availability($1, $2, $3)
    WHERE time_slot = $4::time`, [companyId, date, party, time])).rows[0];
}

async function admin(time) {
  return (await db.query(`SELECT * FROM public.get_admin_reservation_day_capacity($1, $2)
    WHERE time_slot = $3::time`, [company, day, time])).rows[0];
}

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid $$;
    CREATE FUNCTION public.effective_auth_uid() RETURNS uuid LANGUAGE sql AS $$ SELECT auth.uid() $$;
    CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');
    CREATE FUNCTION public.has_role(uuid, public.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION public.has_role_in_company(uuid, public.app_role, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION public.has_company_panel_permission(uuid, uuid, text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE public.companies (
      id uuid PRIMARY KEY, status text DEFAULT 'active', reservation_duration integer DEFAULT 30,
      reservation_slot_interval_minutes integer DEFAULT 30, max_guests_per_slot integer DEFAULT 0,
      opening_hours jsonb DEFAULT '[{"day":"ter","open":"18:00","close":"22:00"}]'
    );
    CREATE TABLE public.blocked_dates(company_id uuid, date date, all_day boolean, start_time time, end_time time);
    CREATE TABLE public.reservation_schedule_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id),
      name text, scope text, weekdays integer[], start_date date, end_date date, enabled boolean DEFAULT true,
      priority integer DEFAULT 100, max_party_size_per_reservation integer, archived_at timestamptz,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      availability_mode text, publish_at timestamptz, default_duration_minutes integer
    );
    CREATE TABLE public.reservation_schedule_rule_blocks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_id uuid REFERENCES public.reservation_schedule_rules(id) ON DELETE CASCADE,
      name text, weekdays integer[], availability_mode text, default_duration_minutes integer,
      sort_order integer, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.reservation_schedule_rule_slots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_id uuid REFERENCES public.reservation_schedule_rules(id) ON DELETE CASCADE,
      block_id uuid REFERENCES public.reservation_schedule_rule_blocks(id) ON DELETE CASCADE,
      time time, sort_order integer, duration_minutes integer, max_party_size_per_reservation integer,
      max_reservations_per_slot integer, max_guests_per_slot integer, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.table_maps(id uuid PRIMARY KEY, company_id uuid, name text);
    CREATE TABLE public.restaurant_tables (
      id uuid PRIMARY KEY, company_id uuid, number integer, capacity integer, section text,
      status text DEFAULT 'available', table_map_id uuid
    );
    CREATE FUNCTION public.get_active_table_map(uuid, timestamptz) RETURNS SETOF public.table_maps
      LANGUAGE sql AS $$ SELECT * FROM public.table_maps WHERE company_id = $1 LIMIT 1 $$;
    CREATE TABLE public.reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, table_id uuid,
      guest_name text, guest_phone text, guest_email text, guest_birthdate date, date date, time time,
      party_size integer, duration_minutes integer DEFAULT 30, status text DEFAULT 'confirmed',
      occasion text, notes text, source text DEFAULT 'reservation', created_in_mode text DEFAULT 'tables',
      applied_schedule_rule_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      checked_in_at timestamptz, checked_in_party_size integer, public_tracking_code text, table_assignment_note text,
      visitor_id text, origin_tracking_session_id uuid, origin_tracking_journey_id uuid,
      origin_anonymous_id text, origin_affiliate_link_id uuid, origin_affiliate_code text,
      origin_affiliate_name text, origin_fbp text, origin_fbc text, attribution_snapshot jsonb
    );
    CREATE TABLE public.reservation_table_assignments(reservation_id uuid, table_id uuid);
    CREATE TABLE public.reservation_payments (
      id uuid, reservation_id uuid, status text, expires_at timestamptz, created_at timestamptz,
      paid_at timestamptz, billing_type text
    );
    INSERT INTO public.companies(id) VALUES ('${company}'), ('${companyB}');
    INSERT INTO public.restaurant_tables(id, company_id, number, capacity) VALUES ('${table}', '${company}', 1, 10);
    INSERT INTO public.restaurant_tables(id, company_id, number, capacity) VALUES (gen_random_uuid(), '${company}', 2, 10);
  `);
  const foundation = '20260608150000_reservation_capacity_schedule_foundation';
  await loadFunction(foundation, 'get_public_reservation_schedule');
  await loadFunction(foundation, 'upsert_reservation_schedule_rule', true);
  await loadFunction('20260601130000_add_slot_specific_reservation_limits', 'is_reservation_occupying_capacity');
  await loadFunction('20260919120000_add_multi_table_reservation_assignments', 'get_public_reservation_availability');
  await loadFunction('20260615120000_admin_reservation_day_capacity', 'get_admin_reservation_day_capacity', true);
  const capacityHelpers = '20260615130000_reservation_capacity_helpers_and_table_options';
  for (const name of ['count_overlapping_reservation_guests', 'count_slot_arrival_reservations',
    'reservation_table_conflict_id', 'pick_best_fit_reservation_table']) await loadFunction(capacityHelpers, name);
  await loadFunction('20260611120000_complete_reservation_capacity_contract', 'create_public_reservation');
  await loadFunction('20260615140000_create_panel_reservation', 'create_panel_reservation', true);
  await loadFunction('20260615150000_update_panel_reservation', 'update_panel_reservation', true);
  await loadFunction('20260923120000_optimize_public_reservation_flow', 'get_public_reservation_booking_context');
  await db.exec(`REVOKE ALL ON FUNCTION public.get_public_reservation_availability(uuid,date,integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid,date,integer) TO anon;`);

  const ruleId = await saveRule([{ time: '18:00' }, { time: '19:00' }, { time: '20:00' }]);
  const existingId = await scalar(`INSERT INTO public.reservations(company_id, date, time, party_size, guest_name)
    VALUES ($1, $2, '19:00', 2, 'Existente') RETURNING id AS value`, [company, day]);
  const migrationSql = await migration('20261103120000_add_manually_full_schedule_slots');
  await db.exec(migrationSql);
  await db.exec(migrationSql); // Replay and body-patch guards must be idempotent.
  const panelCorrectionSql = await migration('20261103121000_allow_panel_bookings_in_full_slots');
  await db.exec(panelCorrectionSql);
  await db.exec(panelCorrectionSql);
  assert.equal(await scalar('SELECT count(*)::integer AS value FROM public.reservation_schedule_rule_slots WHERE is_full'), 0);
  assert.equal((await availability('19:00')).unavailable_reason, null);

  await saveRule([{ time: '18:00' }, { time: '19:00', is_full: true }, { time: '20:00' }], { id: ruleId });
  assert.deepEqual(await scalar(`SELECT slots AS value FROM public.get_public_reservation_schedule($1, $2)`, [company, day]),
    ['18:00', '19:00', '20:00']);
  const full = await availability('19:00');
  assert.equal(full.available, false);
  assert.equal(full.unavailable_reason, 'manually_full');
  assert.equal(full.available_tables, 0);
  assert.equal(full.total_guests, 2, 'real occupancy is retained');
  assert.equal((await availability('18:00')).available, true);
  assert.equal((await availability('20:00')).available, true);
  assert.equal((await availability('19:00', 20)).unavailable_reason, 'manually_full');
  const operational = await admin('19:00');
  assert.equal(operational.configuration_issue, 'manually_full');
  assert.equal(operational.status, 'full');
  assert.equal(operational.occupying_guest_count, 2);
  assert.equal(operational.capacity_limit, 20);
  assert.equal(operational.remaining_capacity, 18, 'admin reports physical capacity accurately');
  const context = (await db.query(`SELECT * FROM public.get_public_reservation_booking_context($1, $2, 2)
    WHERE time_slot = '19:00'`, [company, day])).rows[0];
  assert.equal(context.available, false);
  assert.equal(context.unavailable_reason, 'manually_full');
  assert.equal(context.recommended_table_id, null);

  const reservationJson = JSON.stringify({ company_id: company, date: day, time: '19:00', party_size: 2,
    guest_name: 'Publico', guest_phone: '+5511999999999', table_id: table });
  await assert.rejects(() => scalar('SELECT public.create_public_reservation($1::jsonb) AS value', [reservationJson]), /lotado/);
  await assert.rejects(() => scalar('SELECT public.create_public_reservation($1::jsonb) AS value',
    [JSON.stringify({ ...JSON.parse(reservationJson), time: '19:00:01' })]), /lotado/,
  'seconds must not bypass the published minute');
  const panelCreated = await scalar(`SELECT to_jsonb(public.create_panel_reservation($1,$2,'19:00',2,'Painel','+5511999999999',
    _allow_unassigned := true)) AS value`, [company, day]);
  assert.equal(panelCreated.time, '19:00:00', 'staff may create on a slot closed online');
  await db.query(`INSERT INTO public.reservations(company_id,date,time,party_size)
    VALUES ($1,$2,'19:00',2),($1,$2,'19:00:59',2)`, [company, day]);
  const otherId = await scalar(`INSERT INTO public.reservations(company_id,date,time,party_size,guest_name,guest_phone)
    VALUES ($1,$2,'18:00',2,'Move','+5511999999999') RETURNING id AS value`, [company, day]);
  await db.query(`UPDATE public.reservations SET time='19:00' WHERE id=$1`, [otherId]);
  await db.query(`UPDATE public.reservations SET time='18:00' WHERE id=$1`, [otherId]);
  const panelMoved = await scalar(`SELECT to_jsonb(public.update_panel_reservation($1,$2,'19:00',2,'Move','+5511999999999',
    _allow_unassigned := true)) AS value`, [otherId, day]);
  assert.equal(panelMoved.time, '19:00:00', 'staff may move an existing reservation into a slot closed online');
  await assert.rejects(() => scalar(`SELECT public.create_panel_reservation($1,$2,'19:00',20,'Grande','+5511999999999',
    _table_id := $3) AS value`, [company, day, table]), /Mesa indisponivel/,
  'closing online does not bypass table size checks');
  await saveRule([{ time: '18:00' }, { time: '19:00', is_full: true, max_reservations_per_slot: 1 },
    { time: '20:00' }], { id: ruleId });
  await assert.rejects(() => scalar(`SELECT public.create_panel_reservation($1,$2,'19:00',2,'Painel','+5511999999999',
    _allow_unassigned := true) AS value`, [company, day]), /Limite de reservas/);
  await saveRule([{ time: '18:00' }, { time: '19:00', is_full: true }, { time: '20:00' }], { id: ruleId });
  await db.query(`UPDATE public.reservations SET guest_name='Corrigido',status='checked_in',time=time WHERE id=$1`, [existingId]);
  assert.equal(await scalar(`SELECT status AS value FROM public.reservations WHERE id=$1`, [existingId]), 'checked_in');
  await scalar(`SELECT public.update_panel_reservation($1,$2,'19:00',2,'Contato corrigido','+5511999999999') AS value`, [existingId, day]);
  await db.query(`UPDATE public.reservations SET status='cancelled' WHERE id=$1`, [existingId]);
  await db.query(`UPDATE public.reservations SET status='confirmed' WHERE id=$1`, [existingId]);
  await db.query(`UPDATE public.reservations SET status='no_show' WHERE id=$1`, [existingId]);
  await db.query(`UPDATE public.reservations SET status='checked_in' WHERE id=$1`, [existingId]);

  // Company isolation and rule precedence: unrelated full slots never leak.
  await saveRule([{ time: '19:00', is_full: true }], { company: companyB });
  assert.equal((await availability('18:00')).available, true);
  await saveRule([{ time: '19:00', is_full: false }], { priority: 1, name: 'Prioritaria' });
  assert.notEqual((await availability('19:00')).unavailable_reason, 'manually_full');
  await db.exec(`UPDATE public.reservation_schedule_rules SET enabled=false WHERE name='Prioritaria';`);
  assert.equal((await availability('19:00')).unavailable_reason, 'manually_full');

  // Missing flags are backward compatible and unchecking reopens the slot.
  await saveRule([{ time: '18:00' }, { time: '19:00', is_full: false }, { time: '20:00' }], { id: ruleId });
  assert.notEqual((await availability('19:00')).unavailable_reason, 'manually_full');
  assert.equal((await admin('19:00')).configuration_issue, null);
  await db.query(`INSERT INTO public.reservations(company_id,date,time,party_size) VALUES ($1,$2,'19:00',1)`, [company, day]);
  await assert.rejects(() => saveRule([{ time: '19:00', is_full: 'true' }]), /Estado de lotacao/);
  await assert.rejects(() => saveRule([{ time: '19:00', is_full: false }], { mode: 'capacity' }), /Informe o limite/);
  await assert.rejects(() => saveRule([{ time: '19:00', is_full: true }], { mode: 'capacity' }), /Informe o limite/);

  await saveRule([{ time: '18:00', max_guests_per_slot: 30 }, { time: '19:00', is_full: true, max_guests_per_slot: 30 }], { id: ruleId, mode: 'capacity' });
  assert.equal((await availability('18:00')).available, true);
  assert.equal((await availability('19:00')).unavailable_reason, 'manually_full');
  assert.equal((await admin('19:00')).status, 'full');
  await assert.rejects(() => scalar('SELECT public.create_public_reservation($1::jsonb) AS value', [reservationJson]), /lotado/);
  const capacityCreated = await scalar(`SELECT to_jsonb(public.create_panel_reservation($1,$2,'19:00',2,'Painel','+5511999999999')) AS value`, [company, day]);
  assert.equal(capacityCreated.created_in_mode, 'capacity');
  await db.query(`UPDATE public.reservations SET time='18:00' WHERE id=$1`, [otherId]);
  const capacityMoved = await scalar(`SELECT to_jsonb(public.update_panel_reservation($1,$2,'19:00',2,'Move','+5511999999999',
    _allow_unassigned := true)) AS value`, [otherId, day]);
  assert.equal(capacityMoved.created_in_mode, 'capacity');
  await db.query(`INSERT INTO public.reservations(company_id,date,time,party_size)
    VALUES ($1,$2,'19:00',1)`, [company, day]);
  // Usual physical limits still apply despite staff bypassing the online flag.
  await assert.rejects(() => scalar(`SELECT public.create_panel_reservation($1,$2,'19:00',50,'Grande','+5511999999999') AS value`,
    [company, day]), /Limite de pessoas/);
  await assert.rejects(() => scalar(`SELECT public.update_panel_reservation($1,$2,'19:00',50,'Grande','+5511999999999') AS value`,
    [otherId, day]), /Limite de pessoas/);
  // Existing bookings retain normal contact/cancellation behavior.
  await scalar(`SELECT public.update_panel_reservation($1,$2,'19:00',2,'Contato legado','+5511999999999') AS value`, [existingId, day]);
  await db.query(`UPDATE public.reservations SET notes='Nota preservada',status='cancelled' WHERE id=$1`, [existingId]);

  // Definitions and ACLs keep changes applied by earlier migrations.
  assert.match(await scalar(`SELECT pg_get_functiondef('public.upsert_reservation_schedule_rule(uuid,text,text,uuid,date,date,boolean,integer,timestamptz,jsonb)'::regprocedure) AS value`), /public.effective_auth_uid\(\)/);
  assert.equal(await scalar(`SELECT has_function_privilege('anon','public.get_public_reservation_availability(uuid,date,integer)','EXECUTE') AS value`), true);
  assert.equal(await scalar(`SELECT has_function_privilege('anon','public.assert_reservation_slot_not_full(uuid,date,time)','EXECUTE') AS value`), false);
  assert.equal(await scalar(`SELECT to_regprocedure('public.enforce_reservation_slot_not_full()') IS NULL AS value`), true);
  for (const signature of [
    'public.create_panel_reservation(uuid,date,time,integer,text,text,text,date,text,text,uuid,boolean,text,text)',
    'public.update_panel_reservation(uuid,date,time,integer,text,text,text,text,text,uuid,boolean,boolean,text)',
  ]) {
    const definition = await scalar('SELECT pg_get_functiondef($1::regprocedure) AS value', [signature]);
    assert.doesNotMatch(definition, /assert_reservation_slot_not_full/);
    assert.match(definition, /effective_auth_uid/);
  }
  process.stdout.write('OK: manually full slots close only public bookings; panel/direct create, moves and reactivation remain allowed, subject to normal capacity checks.\n');
} catch (error) {
  process.stderr.write(`Manual-full schedule regression failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  await db.close();
}
