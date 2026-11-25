import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL, migration, public creation, table assignment, occupancy and
// availability functions. Fixtures provide only identity and the schedule.
// No HTTP, credentials, provider charges or remote database are used.
const db = new PGlite();
const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherCompany = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const admin = '00000000-0000-4000-8000-000000000001';
const operator = '00000000-0000-4000-8000-000000000002';
const outsider = '00000000-0000-4000-8000-000000000003';
const salon = '10000000-0000-4000-8000-000000000001';
const premium = '10000000-0000-4000-8000-000000000002';
const foreignSection = '10000000-0000-4000-8000-000000000003';
const defaultMap = '20000000-0000-4000-8000-000000000001';
const specialMap = '20000000-0000-4000-8000-000000000002';
const salonTable = '30000000-0000-4000-8000-000000000001';
const premiumSmall = '30000000-0000-4000-8000-000000000002';
const premiumLarge = '30000000-0000-4000-8000-000000000003';
const specialPremium = '30000000-0000-4000-8000-000000000004';
const day = '2030-01-01';
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const migration = (file) => readFile(new URL(`../migrations/${file}.sql`, import.meta.url), 'utf8');
async function loadFunction(file, name) {
  const sql = await migration(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = sql.indexOf('$$;', start);
  assert.ok(end > start);
  await db.exec(sql.slice(start, end + 3));
}
async function actor(role, id = null) {
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role, sub: id })]);
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`SET ROLE ${role}`);
}
const ruleInput = (extra = {}) => ({
  company_id: company, name: 'Ambientes do jantar', enabled: true, date_start: day, date_end: '2030-01-04',
  pricing_mode: 'by_section', amount_type: 'per_person', base_amount: 40,
  pix_enabled: true, pix_amount: 40, credit_card_enabled: true, credit_card_amount: 45,
  max_credit_card_installments: 1, payment_deadline_minutes: 10, ...extra,
});
const sectionInputs = () => [
  { section_id: salon, public_name: 'Reserva normal', base_amount: 40, pix_amount: 40, credit_card_amount: 45, sort_order: 10 },
  { section_id: premium, public_name: 'Sacada Premium', description: 'Vista para o jardim', base_amount: 80, pix_amount: 80, credit_card_amount: 90, sort_order: 20 },
];
const createRule = (rule = ruleInput(), sections = sectionInputs()) => scalar(
  'SELECT create_reservation_payment_rule($1::jsonb,$2::jsonb) value', [JSON.stringify(rule), JSON.stringify(sections)]);
const options = (date = day, time = '18:00', size = 4) => scalar(
  'SELECT get_public_reservation_section_options($1,$2,$3,$4) value', [company, date, time, size]);
const reserve = (extra = {}, status = 'pending_payment') => scalar(
  'SELECT to_jsonb(create_public_reservation($1::jsonb,$2)) value', [JSON.stringify({
    company_id: company, date: day, time: '18:00', party_size: 4,
    guest_name: 'Cliente', guest_phone: '+5511999999999', guest_birthdate: '1990-01-01',
    selected_section_id: premium, ...extra,
  }), status]);

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role' $$;
    CREATE FUNCTION public.effective_auth_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;
    CREATE FUNCTION public.effective_auth_uid(uuid) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;
    CREATE TYPE app_role AS ENUM ('superadmin','admin','operator');
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE user_roles(user_id uuid, role app_role, company_id uuid);
    CREATE FUNCTION has_role(uuid,app_role) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role=$2) $$;
    CREATE FUNCTION has_role_in_company(uuid,app_role,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role=$2 AND company_id=$3) $$;
    CREATE TABLE companies(id uuid PRIMARY KEY,status text DEFAULT 'active',reservation_duration integer DEFAULT 60,
      max_guests_per_slot integer DEFAULT 10000,feature_enabled boolean DEFAULT true,public_reservation_change_min_notice_minutes integer DEFAULT 0,
      public_reservation_changes_enabled boolean DEFAULT false);
    CREATE FUNCTION _company_report_time_zone(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'UTC'::text $$;
    CREATE FUNCTION company_feature_enabled(uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT COALESCE((SELECT feature_enabled FROM companies WHERE id=$1),false) $$;
    CREATE TABLE table_sections(id uuid PRIMARY KEY,company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
      code text,name text,UNIQUE(company_id,code));
    CREATE TABLE table_maps(id uuid PRIMARY KEY,company_id uuid,name text,is_default boolean,is_enabled boolean,
      active_from timestamptz,active_to timestamptz,priority integer DEFAULT 100,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE restaurant_tables(id uuid PRIMARY KEY,company_id uuid,table_map_id uuid,number integer,
      capacity integer,section text,status text DEFAULT 'available');
    CREATE TABLE reservations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),public_tracking_code text,company_id uuid,table_id uuid,
      guest_name text,guest_phone text,guest_email text,guest_birthdate date,date date,time time,party_size integer,
      duration_minutes integer,status text,occasion text,notes text,visitor_id text,origin_tracking_session_id uuid,
      origin_tracking_journey_id uuid,origin_anonymous_id text,origin_affiliate_link_id uuid,origin_affiliate_code text,
      origin_affiliate_name text,origin_fbp text,origin_fbc text,attribution_snapshot jsonb,source text,
      applied_schedule_rule_id uuid,created_in_mode text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),table_assignment_note text);
    CREATE TABLE reservation_table_assignments(reservation_id uuid REFERENCES reservations(id) ON DELETE CASCADE,
      table_id uuid,sort_order integer,capacity_at_assignment integer,assigned_by uuid,PRIMARY KEY(reservation_id,table_id));
    CREATE TABLE reservation_audit_logs(reservation_id uuid,company_id uuid,actor_user_id uuid,actor_name text,
      actor_role text,actor_source text,action text,summary text,details jsonb);
    CREATE TABLE reservation_payment_events(company_id uuid,reservation_payment_id uuid,reservation_id uuid,event_type text,payload jsonb);
    CREATE FUNCTION get_reservation_audit_actor_name(uuid,text,boolean) RETURNS text LANGUAGE sql AS $$ SELECT 'Admin'::text $$;
    CREATE FUNCTION get_reservation_audit_actor_role(uuid,uuid,boolean) RETURNS text LANGUAGE sql AS $$ SELECT 'admin'::text $$;
    CREATE FUNCTION resolve_reservation_slot_duration(uuid,date,time) RETURNS integer LANGUAGE sql AS $$ SELECT 60 $$;
    CREATE TABLE blocked_dates(company_id uuid,date date,all_day boolean,start_time time,end_time time);
    CREATE TABLE reservation_schedule_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,name text,scope text,
      weekdays integer[],start_date date,end_date date,enabled boolean,priority integer,max_party_size_per_reservation integer,
      availability_mode text DEFAULT 'tables',publish_at timestamptz,default_duration_minutes integer,archived_at timestamptz);
    CREATE TABLE reservation_schedule_rule_blocks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),rule_id uuid REFERENCES reservation_schedule_rules(id) ON DELETE CASCADE,
      name text,weekdays integer[],availability_mode text,default_duration_minutes integer,sort_order integer);
    CREATE TABLE reservation_schedule_rule_slots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),time time,duration_minutes integer,max_party_size_per_reservation integer,
      max_reservations_per_slot integer,max_guests_per_slot integer,block_id uuid REFERENCES reservation_schedule_rule_blocks(id) ON DELETE CASCADE,
      rule_id uuid REFERENCES reservation_schedule_rules(id) ON DELETE CASCADE,sort_order integer,created_at timestamptz DEFAULT now(),is_full boolean DEFAULT false);
    INSERT INTO reservation_schedule_rules(id,name) VALUES('99999999-9999-4999-8999-999999999999','Agenda fixture');
    INSERT INTO reservation_schedule_rule_blocks(id,rule_id,name,availability_mode)
      VALUES('99999999-9999-4999-8999-999999999998','99999999-9999-4999-8999-999999999999','Bloco fixture','tables');
    INSERT INTO reservation_schedule_rule_slots(time,duration_minutes,max_party_size_per_reservation,max_reservations_per_slot,
      max_guests_per_slot,block_id,rule_id,sort_order,created_at)
      SELECT time,60,20,NULL,10000,'99999999-9999-4999-8999-999999999998','99999999-9999-4999-8999-999999999999',0,now()
      FROM unnest(ARRAY['18:00'::time,'18:30'::time,'19:00'::time]) time;
    CREATE TABLE test_schedule(availability_mode text); INSERT INTO test_schedule VALUES('tables');
    CREATE FUNCTION get_public_reservation_schedule(uuid,date)
      RETURNS TABLE(source text,slots jsonb,availability_mode text,default_duration_minutes integer,
        max_party_size_per_reservation integer,rule_id uuid,block_id uuid,rule_name text,block_name text,publish_at timestamptz)
      LANGUAGE sql AS $$ SELECT 'rule','["18:00","18:30","19:00"]'::jsonb,availability_mode,60,20,
        '99999999-9999-4999-8999-999999999999'::uuid,'99999999-9999-4999-8999-999999999998'::uuid,
        'Agenda fixture','Bloco fixture',NULL::timestamptz FROM test_schedule $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT SELECT ON user_roles TO authenticated,service_role;
  `);
  const originalPaymentSql = await migration('20260519170000_add_asaas_reservation_prepayments');
  await db.exec(originalPaymentSql.slice(
    originalPaymentSql.indexOf('CREATE TABLE IF NOT EXISTS public.reservation_payment_rules ('),
    originalPaymentSql.indexOf('CREATE TABLE IF NOT EXISTS public.reservation_payment_events (')));
  await loadFunction('20260519170000_add_asaas_reservation_prepayments', 'validate_reservation_payment_rule');
  await loadFunction('20260804195000_allow_used_payment_rules_company_delete', 'prevent_used_reservation_payment_rule_delete');
  await db.exec(`
    CREATE TRIGGER trg_validate_reservation_payment_rule BEFORE INSERT OR UPDATE ON reservation_payment_rules
      FOR EACH ROW EXECUTE FUNCTION validate_reservation_payment_rule();
    CREATE TRIGGER trg_prevent_used_reservation_payment_rule_delete BEFORE DELETE ON reservation_payment_rules
      FOR EACH ROW EXECUTE FUNCTION prevent_used_reservation_payment_rule_delete();
    ALTER TABLE reservation_payment_rules ENABLE ROW LEVEL SECURITY;
  `);
  await db.exec(originalPaymentSql.slice(
    originalPaymentSql.indexOf('DROP POLICY IF EXISTS "Company staff can view reservation payment rules"'),
    originalPaymentSql.indexOf('DROP POLICY IF EXISTS "Company staff can view reservation payments"')));
  await loadFunction('20260611120000_complete_reservation_capacity_contract', 'create_public_reservation');
  await loadFunction('20260608150000_reservation_capacity_schedule_foundation', 'upsert_reservation_schedule_rule');
  await loadFunction('20260331201000_align_table_map_active_window_boundary', 'get_active_table_map');
  await loadFunction('20261107141000_harden_reservation_payment_lifecycle', 'is_reservation_occupying_capacity');
  for(const name of ['count_overlapping_reservation_guests','count_slot_arrival_reservations']) {
    await loadFunction('20260615130000_reservation_capacity_helpers_and_table_options',name);
  }
  await loadFunction('20261107141000_harden_reservation_payment_lifecycle','confirm_reservation_payment');
  for (const name of ['reservation_table_conflict_id', 'sync_legacy_reservation_table_assignment',
    'validate_reservation_primary_table_conflict', 'assign_reservation_tables', 'get_public_reservation_availability']) {
    await loadFunction('20260919120000_add_multi_table_reservation_assignments', name);
  }
  await loadFunction('20260615130000_reservation_capacity_helpers_and_table_options','pick_best_fit_reservation_table');
  await loadFunction('20260615140000_create_panel_reservation','create_panel_reservation');
  await loadFunction('20260615150000_update_panel_reservation','update_panel_reservation');
  await loadFunction('20261122150000_public_reservation_changes','_public_reservation_change_slot');
  // Replay the actual intervening is_full definition patches before the new
  // migration. Testing only the older foundation upsert hid an anchor drift.
  await loadFunction('20260615120000_admin_reservation_day_capacity','get_admin_reservation_day_capacity');
  await db.exec(await migration('20261103120000_add_manually_full_schedule_slots'));
  await db.exec(await migration('20261103121000_allow_panel_bookings_in_full_slots'));
  if(process.env.SECTION_PRICING_DEPLOYED_CONTEXT) {
    const snapshot=JSON.parse(await readFile(process.env.SECTION_PRICING_DEPLOYED_CONTEXT,'utf8'));
    assert.ok(snapshot.functions && typeof snapshot.functions==='object');
    // The snapshot contains definitions only; no identities, rows or remote
    // access are needed. Current production has a fifth assignment argument.
    if(Object.keys(snapshot.functions).some(key=>key.startsWith('assign_reservation_tables(uuid,uuid[],boolean,text,boolean)'))) {
      await db.exec('DROP FUNCTION public.assign_reservation_tables(uuid,uuid[],boolean,text)');
    }
    for(const [signature,definition] of Object.entries(snapshot.functions)) {
      if(signature.startsWith('get_public_reservation_by_tracking_code(')) continue;
      assert.equal(typeof definition,'string');
      await db.exec(definition);
    }
  }
  await db.exec(`
    CREATE TRIGGER trg_sync_legacy_reservation_table_assignment AFTER INSERT OR UPDATE OF
      table_id,company_id,date,time,duration_minutes,party_size,created_in_mode ON reservations
      FOR EACH ROW EXECUTE FUNCTION sync_legacy_reservation_table_assignment();
    CREATE TRIGGER trg_validate_reservation_primary_table_conflict BEFORE INSERT OR UPDATE OF
      table_id,company_id,date,time,duration_minutes,status ON reservations
      FOR EACH ROW EXECUTE FUNCTION validate_reservation_primary_table_conflict();
    GRANT SELECT,INSERT,UPDATE,DELETE ON reservation_payment_rules TO authenticated,service_role;
    GRANT ALL ON reservations,reservation_payments,reservation_table_assignments TO service_role;
    GRANT SELECT ON reservations TO authenticated;
    GRANT SELECT ON reservation_schedule_rule_slots,reservation_schedule_rules,reservation_schedule_rule_blocks TO authenticated;
    REVOKE ALL ON FUNCTION create_public_reservation(jsonb,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION create_public_reservation(jsonb,text) TO anon,authenticated,service_role;
  `);
  await db.query('INSERT INTO companies(id) VALUES($1),($2)', [company, otherCompany]);
  await db.query("UPDATE reservation_schedule_rules SET company_id=$1 WHERE id='99999999-9999-4999-8999-999999999999'",[company]);
  await db.query('INSERT INTO auth.users(id) VALUES($1),($2),($3)', [admin, operator, outsider]);
  await db.query("INSERT INTO user_roles VALUES($1,'admin',$3),($2,'operator',$3)", [admin, operator, company]);
  await db.query(`INSERT INTO table_sections VALUES($1,$4,'salao','Salão'),($2,$4,'sacada','Sacada'),($3,$5,'salao','Outra empresa')`,
    [salon, premium, foreignSection, company, otherCompany]);
  await db.query(`INSERT INTO table_maps(id,company_id,name,is_default,is_enabled,active_from,active_to)
    VALUES($1,$3,'Padrão',true,true,NULL,NULL),($2,$3,'Evento',false,true,'2030-01-02 00:00+00','2030-01-03 00:00+00')`,
    [defaultMap, specialMap, company]);
  await db.query(`INSERT INTO restaurant_tables(id,company_id,table_map_id,number,capacity,section)
    VALUES($1,$5,$6,1,4,'salao'),($2,$5,$6,2,2,'sacada'),($3,$5,$6,3,6,'sacada'),($4,$5,$7,4,8,'sacada')`,
    [salonTable, premiumSmall, premiumLarge, specialPremium, company, defaultMap, specialMap]);
  // A legacy single rule exists before the migration and must remain identical.
  const legacy = await scalar(`INSERT INTO reservation_payment_rules(company_id,name,enabled,date_start,date_end,
    amount_type,base_amount,pix_enabled,pix_amount) VALUES($1,'Legado',true,'2030-02-01','2030-02-01',
    'fixed_per_reservation',30,true,30) RETURNING to_jsonb(reservation_payment_rules) value`, [company]);
  const sectionMigration = await migration('20261124120000_add_reservation_section_pricing');
  await db.exec(sectionMigration);
  await db.query(`INSERT INTO reservation_schedule_rule_slot_sections(company_id,slot_id,section_id,capacity_guests,sort_order)
    SELECT $1,id,section_id,CASE WHEN section_id=$2::uuid THEN 4 ELSE 6 END,position
    FROM reservation_schedule_rule_slots CROSS JOIN (VALUES($2::uuid,10),($3::uuid,20)) sections(section_id,position)`,[company,salon,premium]);
  await db.exec('UPDATE reservation_schedule_rule_slots SET allow_section_selection=true');
  assert.deepEqual(await scalar('SELECT to_jsonb(r) - \'pricing_mode\' value FROM reservation_payment_rules r WHERE id=$1', [legacy.id]), legacy);
  assert.equal(await scalar('SELECT pricing_mode value FROM reservation_payment_rules WHERE id=$1', [legacy.id]), 'single');

  await actor('authenticated', operator);
  await assert.rejects(createRule(), /Sem permissao/);
  await actor('authenticated', outsider);
  await assert.rejects(createRule(), /Sem permissao/);
  await actor('anon');
  await assert.rejects(createRule(), /permission denied/);
  await assert.rejects(db.query('SELECT * FROM reservation_payment_rule_sections'), /permission denied/);
  await actor('authenticated', admin);
  const scheduleBlocks=[{name:'Capacidade com ambientes',availability_mode:'capacity',slots:[{
    time:'20:00',duration_minutes:60,max_guests_per_slot:10,allow_section_selection:true,
    sections:[{section_id:salon,capacity_guests:4,sort_order:10},{section_id:premium,capacity_guests:6,sort_order:20}],
  }]}];
  const saveSchedule=(blocks)=>scalar(`SELECT upsert_reservation_schedule_rule($1,'Agenda com ambientes','date_specific',NULL,'2030-04-01',NULL,true,100,NULL,$2::jsonb) value`,
    [company,JSON.stringify(blocks)]);
  const savedSchedule=await saveSchedule(scheduleBlocks);
  assert.equal(await scalar('SELECT allow_section_selection value FROM reservation_schedule_rule_slots WHERE rule_id=$1',[savedSchedule]),true);
  assert.equal(await scalar(`SELECT sum(ss.capacity_guests)::integer value FROM reservation_schedule_rule_slot_sections ss
    JOIN reservation_schedule_rule_slots s ON s.id=ss.slot_id WHERE s.rule_id=$1`,[savedSchedule]),10,'schedule RPC atomically persists slot environments');
  const scheduleCount=await scalar('SELECT count(*)::integer value FROM reservation_schedule_rules');
  await assert.rejects(saveSchedule([{...scheduleBlocks[0],slots:[{...scheduleBlocks[0].slots[0],sections:[]}]}]),/pelo menos um ambiente/);
  await assert.rejects(saveSchedule([{...scheduleBlocks[0],slots:[{...scheduleBlocks[0].slots[0],sections:[{section_id:salon,capacity_guests:11}]}]}]),/supera o limite/);
  await assert.rejects(saveSchedule([{...scheduleBlocks[0],slots:[{...scheduleBlocks[0].slots[0],sections:[{section_id:foreignSection,capacity_guests:1}]}]}]),/mesma empresa/);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_schedule_rules'),scheduleCount,'invalid schedule options roll back rule, blocks and slots');
  const pricingSections=(await db.query('SELECT * FROM list_reservation_pricing_sections($1,$2,$3)',[company,day,'2030-01-02'])).rows;
  assert.deepEqual(pricingSections.map(s=>s.id).sort(),[salon,premium].sort());
  assert.deepEqual((await db.query('SELECT * FROM list_reservation_pricing_sections($1,$2,$2)',[company,'2030-01-02'])).rows.map(s=>s.id),[premium],
    'pricing section union respects the effective special map');
  const initialCount = await scalar('SELECT count(*)::integer value FROM reservation_payment_rules');
  await assert.rejects(createRule(ruleInput(), []), /pelo menos um ambiente/);
  await assert.rejects(createRule(ruleInput(), [sectionInputs()[0], { ...sectionInputs()[1], section_id: foreignSection }]), /mesma empresa/);
  await assert.rejects(createRule(ruleInput(), [sectionInputs()[0], sectionInputs()[0]]), /unique constraint/);
  await assert.rejects(createRule(ruleInput(), [{ ...sectionInputs()[0], credit_card_amount: null }]), /meios de pagamento/);
  await assert.rejects(createRule(ruleInput(), [sectionInputs()[0]]), /Configure o valor do ambiente/,
    'activation requires prices for every effective environment in the calendar');
  await assert.rejects(createRule(ruleInput({ pricing_mode: 'single' })), /valor unico/);
  const specialOnly=await createRule(ruleInput({date_start:'2030-01-02',date_end:'2030-01-02'}),[sectionInputs()[1]]);
  await db.query('DELETE FROM reservation_payment_rules WHERE id=$1',[specialOnly.id]);
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO blocked_dates VALUES($1,$2,true,NULL,NULL)',[company,day]);
  await actor('authenticated',admin);
  const closedOnly=await createRule(ruleInput({date_start:day,date_end:day}),[sectionInputs()[1]]);
  await db.query('DELETE FROM reservation_payment_rules WHERE id=$1',[closedOnly.id]);
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM blocked_dates WHERE company_id=$1',[company]);
  await actor('authenticated',admin);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_rules'), initialCount, 'failed atomic creation leaves no parent');
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_rule_sections'), 0, 'failed atomic creation leaves no child');

  const rule = await createRule();
  assert.equal(rule.sections.length, 2);
  assert.equal(rule.enabled, true);
  const normalOption = rule.sections.find((s) => s.section_id === salon);
  const premiumOption = rule.sections.find((s) => s.section_id === premium);
  const singleCapacityRule=await createRule(ruleInput({name:'Preço único automático',pricing_mode:'single',
    date_start:'2030-02-02',date_end:'2030-02-02',amount_type:'fixed_per_reservation'}),[]);
  assert.equal(singleCapacityRule.pricing_mode,'single');
  await assert.rejects(createRule(), /Ja existe regra ativa/);
  const draft = await createRule(ruleInput({ name: 'Rascunho', enabled: false, date_start: '2030-03-01', date_end: '2030-03-01' }), []);
  await assert.rejects(db.query('UPDATE reservation_payment_rules SET enabled=true WHERE id=$1', [draft.id]), /pelo menos um ambiente/);
  await assert.rejects(db.query('UPDATE reservation_payment_rule_sections SET company_id=$1 WHERE id=$2', [otherCompany, premiumOption.id]), /vinculo/);
  await actor('authenticated', operator);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_rule_sections'), 2);
  assert.equal((await db.query('UPDATE reservation_payment_rule_sections SET base_amount=1 RETURNING id')).rows.length, 0, 'operator cannot edit children');
  await actor('authenticated', outsider);
  assert.equal(await scalar('SELECT count(*)::integer value FROM reservation_payment_rule_sections'), 0, 'RLS hides another company');

  await actor('anon');
  const firstOptions = await options();
  assert.equal(firstOptions.enabled, true);
  assert.equal(firstOptions.rule_id, rule.id);
  assert.deepEqual(firstOptions.options.map((s) => [s.public_name, s.base_amount, s.pix_amount, s.credit_card_amount, s.available]),
    [['Reserva normal',40,40,45,true],['Sacada Premium',80,80,90,true]]);
  assert.equal(firstOptions.options[0].amount_type, 'per_person');
  const legacyOptions=await options('2030-02-01');
  assert.equal(legacyOptions.enabled,false,'single paid prices suppress public environment selection');
  assert.deepEqual(legacyOptions.options,[]);
  assert.equal(legacyOptions.configuration_error,undefined);
  assert.equal(legacyOptions.automatic_allocation_available,true);
  assert.equal((await options('2030-02-01','18:00',7)).automatic_allocation_available,false,
    'automatic availability respects fitting tables in the effective map');
  assert.equal(firstOptions.options[0].id,salon,'option identity is the physical environment');
  assert.equal(firstOptions.options[0].payment_rule_section_id,normalOption.id);
  const eventOptions = await options('2030-01-02');
  assert.equal(eventOptions.options.find((s) => s.section_id === salon).available, false, 'default map tables cannot leak into special map');
  assert.equal(eventOptions.options.find((s) => s.section_id === premium).available, true);
  assert.equal((await options(day, '17:00')).options.every((s) => !s.available), true, 'outside schedule is unavailable');
  assert.equal((await options(day, '18:00', 7)).options.every((s) => !s.available), true, 'chair totals cannot replace a fitting table');

  await actor('service_role');
  await assert.rejects(reserve({date:'2030-02-01'}),/valor unico aloca o ambiente automaticamente/);
  const singleAutoNormal=await reserve({date:'2030-02-01',selected_section_id:null,table_id:premiumLarge,selected_section_name:'Forged allocation'});
  assert.equal(singleAutoNormal.selected_section_id,salon,'single price automatically chooses the smallest suitable allowed table');
  assert.equal(singleAutoNormal.selected_section_name,'Salão');
  assert.equal(singleAutoNormal.table_id,salonTable,'browser table cannot override automatic environment allocation');
  assert.equal((await options('2030-02-01')).automatic_allocation_available,true,'another allowed environment remains available');
  await db.exec('RESET ROLE');
  await db.query(`UPDATE reservation_schedule_rule_slot_sections ss SET enabled=false FROM reservation_schedule_rule_slots s
    WHERE ss.slot_id=s.id AND s.rule_id='99999999-9999-4999-8999-999999999999' AND s.time='18:00' AND ss.section_id=$1`,[premium]);
  await actor('service_role');
  assert.equal((await options('2030-02-01')).automatic_allocation_available,false,
    'a globally free table in an excluded environment cannot enable automatic checkout');
  await db.exec('RESET ROLE');
  await db.query(`UPDATE reservation_schedule_rule_slot_sections ss SET enabled=true FROM reservation_schedule_rule_slots s
    WHERE ss.slot_id=s.id AND s.rule_id='99999999-9999-4999-8999-999999999999' AND s.time='18:00' AND ss.section_id=$1`,[premium]);
  await db.query('INSERT INTO blocked_dates VALUES($1,$2,true,NULL,NULL)',[company,'2030-02-01']);
  await actor('service_role');
  assert.equal((await options('2030-02-01')).automatic_allocation_available,false,'global blocked windows override eligible automatic inventory');
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM blocked_dates WHERE company_id=$1',[company]);
  await actor('service_role');
  const singleAutoPremium=await reserve({date:'2030-02-01',selected_section_id:null});
  assert.equal(singleAutoPremium.selected_section_id,premium,'automatic allocation can use another allowed environment after the first is full');
  assert.equal(singleAutoPremium.table_id,premiumLarge);
  assert.equal((await options('2030-02-01')).automatic_allocation_available,false);
  await assert.rejects(reserve({date:'2030-02-01',selected_section_id:null}),/Nenhum ambiente disponivel/);
  await assert.rejects(reserve({ selected_section_id: null }), /Escolha o ambiente/);
  await assert.rejects(reserve({ selected_section_id: foreignSection }), /Ambiente indisponivel/);
  await assert.rejects(reserve({ section_option_id: normalOption.id }), /Ambiente indisponivel/);
  const booking = await reserve({ table_id: salonTable, selected_section_name: 'Preço fraudado', section_option_id: premiumOption.id });
  assert.equal(booking.table_id, premiumLarge, 'server overrides a table from another section with best-fit in the selected section');
  assert.equal(booking.selected_section_id, premium);
  assert.equal(booking.selected_section_name, 'Sacada Premium', 'contract name comes from server configuration');
  await db.exec('RESET ROLE');
  await assert.rejects(db.query("UPDATE restaurant_tables SET section='salao' WHERE id=$1",[premiumLarge]),/ambiente contratado/,
    'editing a physical table cannot move a contracted reservation to another environment');
  await actor('service_role');
  assert.equal((await options()).options.find((s) => s.section_id === premium).available, false);
  assert.equal((await options()).options.find((s) => s.section_id === salon).available, true, 'sold-out premium does not close normal section');
  await assert.rejects(reserve(), /Ambiente indisponivel/);
  const payment = await scalar(`INSERT INTO reservation_payments(company_id,reservation_id,rule_id,rule_snapshot,base_amount,expires_at)
    VALUES($1,$2,$3,$4::jsonb,320,now()+interval '10 minutes') RETURNING id value`,
    [company, booking.id, rule.id, JSON.stringify({ ...rule, selected_section_id: premium, section_option_id: premiumOption.id })]);
  await db.query("UPDATE reservations SET created_at=now()-interval '1 hour' WHERE id=$1", [booking.id]);
  assert.equal((await options()).options.find((s) => s.section_id === premium).available, false, 'valid payment hold preserves selected section inventory');
  await assert.rejects(db.query('UPDATE reservations SET table_id=$1 WHERE id=$2', [salonTable, booking.id]), /ambiente contratado/);
  await assert.rejects(db.query('UPDATE reservations SET selected_section_id=NULL WHERE id=$1', [booking.id]), /ambiente contratado/);
  await assert.rejects(db.query('UPDATE reservations SET table_id=NULL WHERE id=$1', [booking.id]), /manter uma mesa/);
  await assert.rejects(db.query('INSERT INTO reservation_table_assignments(reservation_id,table_id,sort_order,capacity_at_assignment) VALUES($1,$2,1,4)', [booking.id, salonTable]), /ambiente contratado/);
  await actor('authenticated', admin);
  await assert.rejects(db.query('SELECT * FROM assign_reservation_tables($1,$2::uuid[],false,NULL)', [booking.id, [salonTable]]), /ambiente contratado/);
  await assert.rejects(db.query('SELECT * FROM assign_reservation_tables($1,$2::uuid[],true,NULL)', [booking.id, []]), /manter uma mesa/);
  assert.equal(await scalar('SELECT table_id value FROM reservations WHERE id=$1', [booking.id]), premiumLarge, 'failed manual reassignment is atomic');
  await assert.rejects(db.query('UPDATE reservation_payment_rule_sections SET base_amount=1 WHERE id=$1', [premiumOption.id]), /Regra ja usada/);
  await assert.rejects(db.query('DELETE FROM reservation_payment_rule_sections WHERE id=$1', [normalOption.id]), /Regra ja usada/);
  await assert.rejects(db.query("UPDATE reservation_payment_rules SET pricing_mode='single' WHERE id=$1", [rule.id]), /Regra ja usada/);
  await db.exec('RESET ROLE');
  await db.query("UPDATE table_sections SET name='Sacada renomeada' WHERE id=$1", [premium]);
  assert.equal(await scalar('SELECT selected_section_name value FROM reservations WHERE id=$1', [booking.id]), 'Sacada Premium');
  await db.query("UPDATE reservation_payments SET expires_at=now()-interval '1 minute' WHERE id=$1", [payment]);
  await actor('service_role');
  assert.equal((await options()).options.find((s) => s.section_id === premium).available, true, 'expired holds release only their occupied inventory');
  const reopened = await reserve();
  assert.equal(reopened.table_id, premiumLarge);
  const eventBooking = await reserve({ date: '2030-01-02' });
  assert.equal(eventBooking.table_id, specialPremium);

  await db.exec('RESET ROLE');
  await db.exec("UPDATE test_schedule SET availability_mode='capacity'");
  await db.exec("UPDATE reservation_schedule_rules SET availability_mode='capacity'");
  await actor('service_role');
  assert.equal((await options('2030-02-02')).enabled,false);
  assert.equal((await options('2030-02-02')).automatic_allocation_available,true);
  const autoCapacityNormal=await reserve({date:'2030-02-02',selected_section_id:null});
  assert.equal(autoCapacityNormal.selected_section_id,salon);
  assert.equal(autoCapacityNormal.table_id,null);
  const autoCapacityPremium=await reserve({date:'2030-02-02',selected_section_id:null});
  assert.equal(autoCapacityPremium.selected_section_id,premium,'single-price capacity allocation respects each environment quota');
  assert.equal((await options('2030-02-02')).automatic_allocation_available,false,'capacity preview rejects a group that exceeds remaining environment quotas');
  assert.equal((await options('2030-02-02','18:00',2)).automatic_allocation_available,true,'smaller groups can still fit the remaining environment quota');
  await assert.rejects(reserve({date:'2030-02-02',selected_section_id:null,party_size:3}),/Nenhum ambiente disponivel/);
  assert.equal((await options('2030-01-03')).options.every((s) => s.available), true);
  const capacityBooking=await reserve({date:'2030-01-03',party_size:4});
  assert.equal(capacityBooking.table_id,null,'capacity environment booking does not allocate a table');
  assert.equal(capacityBooking.selected_section_id,premium);
  assert.equal((await options('2030-01-03')).options.find(s=>s.section_id===premium).available,false);
  assert.equal((await options('2030-01-03')).options.find(s=>s.section_id===salon).available,true);
  await assert.rejects(reserve({date:'2030-01-03',time:'18:30',party_size:3}),/Capacidade do ambiente/);
  const nonoverlap=await reserve({date:'2030-01-03',time:'19:00',party_size:4});
  assert.ok(nonoverlap.id,'nonoverlapping intervals reuse environment capacity');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE test_schedule SET availability_mode='tables'");
  await db.exec("UPDATE reservation_schedule_rules SET availability_mode='tables'");
  await db.query('INSERT INTO blocked_dates VALUES($1,$2,true,NULL,NULL)', [company, '2030-01-04']);
  await actor('anon');
  assert.equal((await options('2030-01-04')).options.every((s) => !s.available), true);
  await db.exec('RESET ROLE');
  await db.query('UPDATE companies SET feature_enabled=false WHERE id=$1', [company]);
  await actor('service_role');
  const freeOptions=await options('2030-01-04');
  assert.equal(freeOptions.enabled,true,'turning payment off preserves availability selection');
  assert.equal(freeOptions.options.every(s=>s.base_amount===null&&s.amount_type===null),true);
  await assert.rejects(reserve({date:'2030-01-04',selected_section_id:null}),/Escolha o ambiente/);
  const freeBooking=await reserve({date:'2030-01-04',time:'19:00',selected_section_id:salon},'confirmed').catch(error=>{
    assert.match(error.message,/bloqueado/);return null;
  });
  assert.equal(freeBooking,null,'global date blocks remain enforced on free environments');
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM blocked_dates WHERE company_id=$1',[company]);
  await actor('service_role');
  const singleBooking=await reserve({date:'2030-01-04',selected_section_id:salon,table_id:premiumLarge},'confirmed');
  assert.equal(singleBooking.selected_section_id,salon);
  assert.equal(singleBooking.table_id,salonTable,'free booking resolves chosen environment on server');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservation_schedule_rule_slots SET allow_section_selection=false WHERE time='19:00'");
  await actor('service_role');
  assert.equal((await options('2030-01-04','19:00')).enabled,false,'per-slot switch disables selection independently');
  await assert.rejects(reserve({date:'2030-01-04',time:'19:00'}),/nao esta habilitada/);
  const legacyFlow=await reserve({date:'2030-01-04',time:'19:00',selected_section_id:null,table_id:salonTable},'confirmed');
  assert.equal(legacyFlow.selected_section_id,null);
  await db.exec('RESET ROLE');
  await db.query('UPDATE companies SET feature_enabled=true WHERE id=$1', [company]);
  await actor('service_role');
  await assert.rejects(reserve({date:'2030-01-03',time:'19:00',selected_section_id:null}),/exige escolha de ambiente/);
  await actor('authenticated', admin);
  await db.query('UPDATE reservation_payment_rules SET enabled=false WHERE id=$1', [rule.id]);
  await actor('anon');
  assert.equal((await options()).enabled, true, 'disabling payment preserves public environment selection');
  assert.equal((await options()).options.every(s=>s.base_amount===null),true);
  await actor('authenticated', admin);
  await assert.rejects(db.query('UPDATE reservation_payment_rules SET enabled=true WHERE id=$1',[rule.id]),/Ative a escolha de ambiente/,
    'activation detects a previously disabled selection slot before exposing broken public checkout');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservation_schedule_rule_slots SET allow_section_selection=true WHERE time='19:00'");
  await actor('authenticated',admin);
  await db.query('UPDATE reservation_payment_rules SET enabled=true WHERE id=$1', [rule.id]);
  await db.query('UPDATE reservation_payment_rules SET enabled=false,archived_at=now() WHERE id=$1', [rule.id]);
  await actor('anon');
  assert.equal((await options()).enabled, true, 'archiving payment preserves public environment selection');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservation_schedule_rule_slots SET allow_section_selection=false WHERE time='19:00'");
  assert.equal(await scalar('SELECT selected_section_name value FROM reservations WHERE id=$1', [booking.id]), 'Sacada Premium', 'activation changes preserve historical contracts');
  await db.exec("UPDATE test_schedule SET availability_mode='capacity'");
  await db.exec("UPDATE reservation_schedule_rules SET availability_mode='capacity' WHERE id='99999999-9999-4999-8999-999999999999'");
  await db.exec("UPDATE reservation_schedule_rule_blocks SET availability_mode='capacity' WHERE id='99999999-9999-4999-8999-999999999998'");
  await actor('service_role');
  const competing=await Promise.allSettled([
    reserve({date:'2030-01-05',party_size:4}),reserve({date:'2030-01-05',party_size:4}),
  ]);
  assert.equal(competing.filter(r=>r.status==='fulfilled').length,1,'creation revalidates stale competing submissions against environment stock');
  assert.equal(competing.filter(r=>r.status==='rejected').length,1);
  // A real late receipt must be recorded even if its environment was sold after
  // the original hold expired; triggering a DB error would lose reconciliation.
  const expiring=await reserve({date:'2030-01-06',party_size:4});
  await db.query("UPDATE reservations SET created_at=now()-interval '1 hour' WHERE id=$1",[expiring.id]);
  const latePayment=await scalar(`INSERT INTO reservation_payments(company_id,reservation_id,base_amount,charged_amount,billing_type,status,expires_at)
    VALUES($1,$2,80,80,'PIX','expired',now()-interval '1 minute') RETURNING id value`,[company,expiring.id]);
  await reserve({date:'2030-01-06',party_size:4});
  assert.deepEqual(await scalar("SELECT confirm_reservation_payment($1,$2,'RECEIVED',now(),'{}','offline-test') value",[latePayment,company]),
    {status:'late_paid',changed:true});
  assert.equal(await scalar('SELECT status value FROM reservations WHERE id=$1',[expiring.id]),'paid_after_expiration');
  await actor('authenticated',admin);
  const manualCapacity=await scalar(`SELECT to_jsonb(create_panel_reservation($1,$2,'18:00',1,'Reserva manual','+5511999999999')) value`,[company,'2030-01-07']);
  assert.equal(manualCapacity.selected_section_id,null,'manual unlocated capacity reservations remain possible');
  await actor('service_role');
  assert.equal((await options('2030-01-07','18:00',6)).options.find(s=>s.section_id===premium).available,false,
    'unlocated manual/legacy groups conservatively consume every possible environment');
  await assert.rejects(reserve({date:'2030-01-07',party_size:6}),/Capacidade do ambiente/);
  await reserve({date:'2030-01-07',party_size:5});
  await actor('authenticated',admin);
  await assert.rejects(db.query(`SELECT create_panel_reservation($1,$2,'18:00',1,'Outro manual','+5511999999999')`,[company,'2030-01-07']),
    /Capacidade do ambiente/,'manual bookings cannot exceed an already contracted section quota');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE test_schedule SET availability_mode='tables'");
  await db.exec("UPDATE reservation_schedule_rules SET availability_mode='tables' WHERE id='99999999-9999-4999-8999-999999999999'");
  await db.exec("UPDATE reservation_schedule_rule_blocks SET availability_mode='tables' WHERE id='99999999-9999-4999-8999-999999999998'");
  await db.query(`UPDATE reservation_schedule_rule_slot_sections ss SET capacity_guests=4 FROM reservation_schedule_rule_slots s
    WHERE ss.slot_id=s.id AND s.rule_id='99999999-9999-4999-8999-999999999999' AND ss.section_id=$1`,[premium]);
  await actor('authenticated',admin);
  const manualTable=await scalar(`SELECT to_jsonb(create_panel_reservation($1,$2,'18:00',3,'Mesa manual','+5511999999999',NULL,NULL,NULL,NULL,$3)) value`,
    [company,'2030-01-08',premiumLarge]);
  assert.equal(manualTable.selected_section_id,null);
  await actor('service_role');
  assert.equal((await options('2030-01-08','18:00',2)).options.find(s=>s.section_id===premium).available,false,
    'optional guest quotas in table mode count legacy assigned groups once');
  await assert.rejects(reserve({date:'2030-01-08',party_size:2}),/Capacidade do ambiente/);
  const editable=await reserve({date:'2030-01-09',party_size:4},'confirmed');
  await actor('authenticated',admin);
  const edited=await scalar(`SELECT to_jsonb(update_panel_reservation($1,$2,'18:30',4,'Cliente','+5511999999999',NULL,NULL,NULL,NULL,false,false,NULL)) value`,
    [editable.id,'2030-01-09']);
  assert.equal(edited.table_id,premiumLarge,'panel auto-reassignment remains inside the contracted environment');
  assert.equal(edited.selected_section_id,premium);
  await actor('service_role');
  const changeDay=await scalar("SELECT (current_date+2)::text value");
  const changeBooking=await reserve({date:changeDay,party_size:4},'confirmed');
  const changeSlot=await scalar("SELECT _public_reservation_change_slot($1,$2,'18:30',4) value",[changeBooking.id,changeDay]);
  assert.equal(changeSlot.available,true);
  assert.equal(changeSlot.table_id,premiumLarge,'customer changes keep the booked section instead of picking the globally smallest table');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE test_schedule SET availability_mode='capacity'");
  await db.exec("UPDATE reservation_schedule_rule_blocks SET availability_mode='capacity' WHERE id='99999999-9999-4999-8999-999999999998'");
  await actor('service_role');
  await reserve({date:'2030-01-10',time:'18:30',party_size:4},'confirmed');
  await actor('authenticated',admin);
  await assert.rejects(db.query(`SELECT create_panel_reservation($1,$2,'19:00',1,'Manual em outro horario','+5511999999999')`,[company,'2030-01-10']),
    /Capacidade do ambiente/,'a slot with selection off cannot overfill an overlapping selected environment');
  assert.equal(await scalar("SELECT has_function_privilege('anon','public.resolve_public_reservation_section(jsonb,uuid,date,time,integer,integer,text)','EXECUTE') value"), false);
  if (process.argv.includes('--auto-table-combinations')) {
    const { runAutoTableCombinationScenarios } = await import('./auto-table-combinations-scenarios.mjs');
    await runAutoTableCombinationScenarios({ db, company, otherCompany, admin, operator, outsider, salon, premium, actor, loadFunction, migration });
  }
  console.log('Reservation section pricing SQL regressions passed: atomic rules/RLS, prices, maps, best-fit, holds, history and manual assignment guards.');
} catch (error) {
  console.error({ message: error.message, code: error.code, where: error.where, stack: error.stack });
  process.exitCode = 1;
} finally {
  await db.close();
}
