import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Offline PostgreSQL integration, with the actual schedule, occupancy, table,
// assignment and audit functions from the repository. No Supabase connection.
const db = new PGlite();
const company = randomUUID(), otherCompany = randomUUID(), actorId = randomUUID();
const map = randomUUID(), tableA = randomUUID(), tableB = randomUUID(), tableC = randomUUID();
let passed = 0;
const load = name => readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
async function fn(file, name) {
  const source = await load(file), start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `function ${name} exists`);
  const end = source.indexOf('\n$$;', start);
  assert.notEqual(end, -1);
  await db.exec(source.slice(start, end + 4));
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
async function owner() { await db.exec('RESET ROLE'); }
async function anon() { await owner(); await db.exec('SET ROLE anon'); }
async function options(r, date = null, party = null, visitor = 'fixture-browser') {
  return (await one('SELECT public.get_public_reservation_change_options($1,$2,$3,$4) AS result', [r.public_tracking_code, visitor, date, party])).result;
}
async function change(r, override = {}, requestId = randomUUID()) {
  return (await one('SELECT public.change_public_reservation($1,$2,$3,$4,$5,$6,$7) AS result', [
    r.public_tracking_code, override.visitor ?? 'fixture-browser', override.date ?? r.date,
    override.time ?? '20:00', override.party_size ?? r.party_size,
    override.revision ?? r.updated_at, requestId,
  ])).result;
}
async function add(override = {}) {
  await owner();
  const date = (await one("SELECT ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + 3)::text AS date")).date;
  const fields = { id: randomUUID(), company_id: company, public_tracking_code: randomUUID().replaceAll('-', ''),
    guest_name: 'Cliente fixture', guest_phone: '+5500000000000', guest_email: 'fixture@example.invalid',
    date, time: '19:00', party_size: 4, duration_minutes: 60, status: 'confirmed', table_id: tableA,
    created_in_mode: 'tables', visitor_id: 'original-browser', ...override };
  const r = await one(`INSERT INTO public.reservations (${Object.keys(fields).join(',')}) VALUES (${Object.keys(fields).map((_, i) => `$${i + 1}`).join(',')}) RETURNING *, date::text AS date, time::text AS time, updated_at::text AS updated_at`, Object.values(fields));
  await anon(); return r;
}
async function configure(values = {}) {
  await owner();
  const fields = { public_reservation_changes_enabled: true, public_reservation_change_min_notice_minutes: 120, max_guests_per_slot: 0, time_zone: 'America/Sao_Paulo', status: 'active', prepayment_enabled: false, ...values };
  await db.query(`UPDATE public.companies SET ${Object.keys(fields).map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${Object.keys(fields).length+1}`, [...Object.values(fields),company]);
  await anon();
}
async function rule(date, { mode='tables', maxParty=20, maxGuests=null, maxReservations=null, duration=60, times=['19:00','20:00','21:00'] }={}) {
  await owner();const id=randomUUID(),block=randomUUID();
  await db.query("INSERT INTO public.reservation_schedule_rules(id,company_id,name,scope,start_date,end_date,max_party_size_per_reservation,availability_mode) VALUES($1,$2,'Fixture','date_specific',$3,$3,$4,$5)",[id,company,date,maxParty,mode]);
  await db.query("INSERT INTO public.reservation_schedule_rule_blocks(id,rule_id,name,availability_mode) VALUES($1,$2,'Fixture',$3)",[block,id,mode]);
  for(const time of times) await db.query('INSERT INTO public.reservation_schedule_rule_slots(rule_id,block_id,time,max_guests_per_slot,max_reservations_per_slot,duration_minutes) VALUES($1,$2,$3,$4,$5,$6)',[id,block,time,maxGuests,maxReservations,duration]);
  await anon();return id;
}
async function test(name, run) {
  await owner();
  await db.exec('TRUNCATE public.reservation_public_change_requests, public.reservation_audit_logs, public.notifications, public.whatsapp_message_queue, public.pluguechat_message_queue, public.reservation_table_assignments, public.reservation_payments, public.reservations, public.reservation_schedule_rule_slots, public.reservation_schedule_rule_blocks, public.reservation_schedule_rules, public.reservation_payment_rules, public.blocked_dates, public.public_rate_limits CASCADE');
  await configure();
  try { await run(); console.log(`ok ${++passed} - ${name}`); }
  catch(error) { console.error(`not ok - ${name}`); throw error; }
}
async function capacityDayLockHeld(date) {
  return (await one(`SELECT EXISTS(SELECT 1 FROM pg_locks
    WHERE locktype='advisory' AND granted AND objsubid=1
      AND classid::bigint=((hashtextextended(format('reservation-capacity|%s|%s',$1::text,$2::text),0)>>32)&4294967295)
      AND objid::bigint=(hashtextextended(format('reservation-capacity|%s|%s',$1::text,$2::text),0)&4294967295)) AS held`,[company,date])).held;
}
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TYPE public.app_role AS ENUM('superadmin','admin','operator','user');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon')$$;
    CREATE FUNCTION public.has_role(_user uuid,_role public.app_role) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
    CREATE FUNCTION public.has_role_in_company(_user uuid,_role public.app_role,_company uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT _user='${actorId}'::uuid AND _role='admin' AND _company='${company}'::uuid$$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.profiles(id uuid,full_name text,email text);
    CREATE TABLE public.companies(id uuid PRIMARY KEY,status text DEFAULT 'active',time_zone text DEFAULT 'America/Sao_Paulo',reservation_duration integer DEFAULT 60,reservation_slot_interval_minutes integer DEFAULT 60,max_guests_per_slot integer DEFAULT 0,opening_hours jsonb,prepayment_enabled boolean DEFAULT false);
    CREATE FUNCTION public.company_feature_enabled(_company uuid,_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT prepayment_enabled FROM public.companies WHERE id=_company$$;
    CREATE TABLE public.table_maps(id uuid PRIMARY KEY,company_id uuid,name text,is_default boolean,is_enabled boolean,active_from timestamptz,active_to timestamptz,priority integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE public.restaurant_tables(id uuid PRIMARY KEY,company_id uuid,number integer,capacity integer,section text,status text,table_map_id uuid);
    CREATE TABLE public.reservations(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,guest_name text,guest_phone text,guest_email text,guest_birthdate date,date date,time time,party_size integer,status text,checked_in_at timestamptz,checked_in_party_size integer,duration_minutes integer,table_id uuid,created_in_mode text,table_assignment_state text,table_assignment_note text,applied_schedule_rule_id uuid,public_tracking_code text UNIQUE,occasion text,notes text,visitor_id text,origin_tracking_session_id uuid,origin_anonymous_id text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE public.reservation_table_assignments(reservation_id uuid,table_id uuid,sort_order integer DEFAULT 0,capacity_at_assignment integer,assigned_by uuid,PRIMARY KEY(reservation_id,table_id));
    CREATE TABLE public.reservation_payments(id uuid DEFAULT gen_random_uuid(),company_id uuid,reservation_id uuid,status text,paid_at timestamptz,expires_at timestamptz,metadata jsonb DEFAULT '{}',asaas_status text,last_checked_at timestamptz,error_details text);
    CREATE TABLE public.reservation_payment_events(id uuid DEFAULT gen_random_uuid(),company_id uuid,reservation_payment_id uuid,reservation_id uuid,event_type text,payload jsonb);
    CREATE TABLE public.reservation_payment_rules(id uuid DEFAULT gen_random_uuid(),company_id uuid,enabled boolean DEFAULT true,archived_at timestamptz,date_start date,date_end date);
    CREATE TABLE public.public_rate_limits(id uuid DEFAULT gen_random_uuid(),scope text,company_id uuid,identifier text,created_at timestamptz DEFAULT now());
    CREATE TABLE public.notifications(id uuid DEFAULT gen_random_uuid(),company_id uuid,title text,message text,type text,is_read boolean DEFAULT false,created_at timestamptz DEFAULT now());
    CREATE TABLE public.whatsapp_message_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reservation_id uuid,company_id uuid,type text,status text,error_details text,expires_at timestamptz);
    CREATE TABLE public.pluguechat_message_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reservation_id uuid,company_id uuid,type text,status text,cancel_reason text,cancelled_at timestamptz);
    CREATE TABLE public.whatsapp_message_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.pluguechat_message_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.blocked_dates(id uuid DEFAULT gen_random_uuid(),company_id uuid,date date,all_day boolean,start_time time,end_time time);
    CREATE TABLE public.reservation_schedule_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,name text,scope text,weekdays integer[],start_date date,end_date date,enabled boolean DEFAULT true,priority integer DEFAULT 100,max_party_size_per_reservation integer,archived_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),availability_mode text DEFAULT 'tables',publish_at timestamptz,default_duration_minutes integer);
    CREATE TABLE public.reservation_schedule_rule_blocks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),rule_id uuid,name text,weekdays integer[],availability_mode text DEFAULT 'tables',default_duration_minutes integer,sort_order integer DEFAULT 10,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE public.reservation_schedule_rule_slots(id uuid DEFAULT gen_random_uuid(),rule_id uuid,block_id uuid,time time,sort_order integer DEFAULT 100,created_at timestamptz DEFAULT now(),duration_minutes integer,max_party_size_per_reservation integer,max_guests_per_slot integer,max_reservations_per_slot integer,is_full boolean DEFAULT false);
    ALTER TABLE public.reservations ALTER COLUMN id SET DEFAULT gen_random_uuid(),ADD COLUMN source text,ADD COLUMN origin_waitlist_id uuid,ADD COLUMN origin_tracking_journey_id uuid,ADD COLUMN origin_affiliate_link_id uuid,ADD COLUMN origin_affiliate_code text,ADD COLUMN origin_affiliate_name text,ADD COLUMN origin_fbp text,ADD COLUMN origin_fbc text,ADD COLUMN attribution_snapshot jsonb;
    CREATE TABLE public.waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,guest_name text,guest_phone text,guest_email text,guest_birthdate date,status text,seated_at timestamptz,seated_party_size integer,notes text,updated_at timestamptz);
    CREATE TABLE public.waitlist_companions(id uuid DEFAULT gen_random_uuid(),waitlist_id uuid,company_id uuid,position integer,name text,phone text,email text,birthdate date);
    CREATE TABLE public.reservation_companions(id uuid DEFAULT gen_random_uuid(),reservation_id uuid,company_id uuid,position integer,name text,phone text,email text,birthdate date);
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
  `);
  await db.query('INSERT INTO auth.users VALUES($1)',[actorId]);
  await db.query("INSERT INTO public.companies(id,opening_hours) VALUES($1,$3),($2,$3)",[company,otherCompany,JSON.stringify(['dom','seg','ter','qua','qui','sex','sab'].map(day=>({day,open:'00:00',close:'23:59',closed:false})))]);
  await db.query("INSERT INTO public.table_maps(id,company_id,name,is_default,is_enabled,priority) VALUES($1,$2,'Principal',true,true,10)",[map,company]);
  for(const [id,number,capacity] of [[tableA,1,4],[tableB,2,8],[tableC,3,20]]) await db.query("INSERT INTO public.restaurant_tables VALUES($1,$2,$3,$4,'Salão','available',$5)",[id,company,number,capacity,map]);
  const auditFile = await load('20260419110000_add_reservation_audit_history');
  await db.exec(auditFile.slice(0,auditFile.indexOf('CREATE INDEX')));
  for(const name of ['format_reservation_status_label','get_reservation_audit_actor_role','get_reservation_audit_actor_name','audit_reservation_changes']) await fn('20260419110000_add_reservation_audit_history',name);
  await db.exec('CREATE TRIGGER trg_audit_reservation_changes AFTER INSERT OR UPDATE OR DELETE ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.audit_reservation_changes()');
  await fn('20260820130000_add_advanced_report_foundation','_is_valid_iana_time_zone');
  await fn('20260820130000_add_advanced_report_foundation','_company_report_time_zone');
  await fn('20260331201000_align_table_map_active_window_boundary','get_active_table_map');
  await fn('20261107141000_harden_reservation_payment_lifecycle','is_reservation_occupying_capacity');
  await fn('20260608150000_reservation_capacity_schedule_foundation','get_public_reservation_schedule');
  await fn('20260608150000_reservation_capacity_schedule_foundation','resolve_reservation_slot_duration');
  for(const name of ['count_overlapping_reservation_guests','count_slot_arrival_reservations']) await fn('20260615130000_reservation_capacity_helpers_and_table_options',name);
  for(const name of ['reservation_table_conflict_id','sync_legacy_reservation_table_assignment','validate_reservation_primary_table_conflict']) await fn('20260919120000_add_multi_table_reservation_assignments',name);
  await fn('20260615130000_reservation_capacity_helpers_and_table_options','pick_best_fit_reservation_table');
  await db.exec(`CREATE TRIGGER trg_sync_legacy_reservation_table_assignment AFTER INSERT OR UPDATE OF table_id,company_id,date,time,duration_minutes,party_size,created_in_mode ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_reservation_table_assignment();
    CREATE TRIGGER trg_validate_reservation_primary_table_conflict AFTER INSERT OR UPDATE OF table_id,company_id,date,time,duration_minutes,status ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.validate_reservation_primary_table_conflict()`);
  // The lock patch is applied to real, executable creation/edit/seating/payment
  // definitions rather than test stubs or a copied fragment of their conditions.
  await fn('20260611120000_complete_reservation_capacity_contract','create_public_reservation');
  await fn('20260615140000_create_panel_reservation','create_panel_reservation');
  await fn('20260615150000_update_panel_reservation','update_panel_reservation');
  await fn('20260615170000_waitlist_seating_auto_table','seat_waitlist_entry');
  await fn('20261107141000_harden_reservation_payment_lifecycle','confirm_reservation_payment');
  const beforeAudit=await one("SELECT pg_get_functiondef('public.audit_reservation_changes()'::regprocedure) AS definition");
  const migration=await load('20261122150000_public_reservation_changes');await db.exec(migration);await db.exec(migration);

  await test('existing and new companies are opted out by default; migration replay preserves explicit opt-in',async()=>{
    await owner();assert.equal((await one('SELECT public_reservation_changes_enabled FROM public.companies WHERE id=$1',[otherCompany])).public_reservation_changes_enabled,false);
    const newCompany=randomUUID();await db.query('INSERT INTO public.companies(id) VALUES($1)',[newCompany]);
    assert.equal((await one('SELECT public_reservation_changes_enabled FROM public.companies WHERE id=$1',[newCompany])).public_reservation_changes_enabled,false);
    await db.exec(migration);assert.equal((await one('SELECT public_reservation_changes_enabled FROM public.companies WHERE id=$1',[company])).public_reservation_changes_enabled,true);
    await assert.rejects(()=>db.query('UPDATE public.companies SET public_reservation_change_min_notice_minutes=-1 WHERE id=$1',[company]),{code:'23514'});
    await assert.rejects(()=>db.query('UPDATE public.companies SET public_reservation_change_min_notice_minutes=10081 WHERE id=$1',[company]),{code:'23514'});
  });
  await test('only public RPCs are executable; receipts, tables and private resolvers stay protected',async()=>{
    await owner();for(const name of ['public._public_reservation_change_snapshot(public.reservations)','public._public_reservation_change_reason(public.reservations,timestamptz)','public._public_reservation_change_slot(uuid,date,time,integer)'])assert.equal((await one("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed",[name])).allowed,false);
    assert.equal((await one("SELECT has_table_privilege('authenticated','public.reservation_public_change_requests','SELECT') AS allowed")).allowed,false);
    await anon();await assert.rejects(()=>one('SELECT * FROM public.reservation_public_change_requests'),{code:'42501'});
    await assert.rejects(()=>one('UPDATE public.reservations SET party_size=1'),{code:'42501'});
  });
  await test('disabled configuration keeps a complete denied contract and cannot be bypassed by mutation',async()=>{
    const r=await add();await configure({public_reservation_changes_enabled:false});
    const result=await options(r);assert.equal(result.allowed,false);assert.equal(result.reason,'disabled');assert.deepEqual(result.slots,[]);assert.equal(result.reservation.id,r.id);assert.equal(result.min_notice_minutes,120);
    assert.equal((await change(r)).reason,'disabled');
  });
  await test('requires a valid tracking credential and nonempty bounded device identifier; shared valid link works on another device',async()=>{
    const r=await add();for(const visitor of ['',null,'x'.repeat(201)])await assert.rejects(()=>options(r,null,null,visitor),{code:'22023'});
    await assert.rejects(()=>options({...r,public_tracking_code:'a'.repeat(32)}),{code:'P0002'});
    assert.equal((await options(r,null,null,'another-device')).allowed,true);
    const output=await options(r);assert.ok(!JSON.stringify(output).includes('+550000'));assert.ok(!JSON.stringify(output).includes('fixture@example.invalid'));assert.ok(!JSON.stringify(output).includes(tableA));
  });
  await test('same-slot quantity change excludes the reservation itself and assigns an appropriate larger table',async()=>{
    const r=await add();await rule(r.date,{maxReservations:1,maxGuests:6});
    assert.equal((await options(r,r.date,6)).slots.find(s=>s.time==='19:00').available,true);
    const result=await change(r,{time:'19:00',party_size:6});assert.equal(result.changed,true);assert.equal(result.reservation.id,r.id);
    await owner();const saved=await one('SELECT * FROM public.reservations WHERE id=$1',[r.id]);assert.equal(saved.table_id,tableB);assert.equal(saved.public_tracking_code,r.public_tracking_code);assert.equal(saved.guest_name,r.guest_name);assert.ok(saved.last_public_change_at);
    assert.deepEqual((await db.query('SELECT table_id FROM public.reservation_table_assignments WHERE reservation_id=$1',[r.id])).rows.map(x=>x.table_id),[tableB]);
  });
  await test('can reduce group size or change date/time while preserving identity and the tracking link',async()=>{
    const r=await add({party_size:8,table_id:tableB});const date=(await options(r)).date;
    const tomorrow=(await one('SELECT ($1::date+1)::text AS date',[date])).date;
    const result=await change(r,{date:tomorrow,time:'18:00',party_size:2});assert.equal(result.changed,true);assert.equal(result.reservation.date,tomorrow);assert.equal(result.reservation.time,'18:00');assert.equal(result.reservation.party_size,2);
    await owner();assert.equal(Number((await one('SELECT count(*) FROM public.reservations')).count),1);
  });
  await test('records one public audit update and one company notification with old/new values',async()=>{
    const r=await add();await change(r,{time:'20:00',party_size:3});await owner();
    const rows=(await db.query("SELECT * FROM public.reservation_audit_logs WHERE reservation_id=$1 AND action='updated'",[r.id])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].actor_source,'public');assert.equal(rows[0].actor_role,'user');assert.equal(rows[0].actor_name,r.guest_name);
    assert.equal(rows[0].details.changes.party_size.old,4);assert.equal(rows[0].details.changes.party_size.new,3);
    const notice=await one('SELECT * FROM public.notifications');assert.equal(notice.company_id,company);assert.equal(notice.title,'Reserva alterada pelo cliente');assert.ok(notice.message.includes('19:00'));assert.ok(notice.message.includes('20:00'));
    assert.equal((await one("SELECT current_setting('app.public_reservation_change',true) AS context")).context,'');
  });
  await test('notification escapes customer markup and uses the dedicated nonblocking operational type',async()=>{
    const r=await add({guest_name:'<img src=x onerror="alert(1)"> & \'Nome\''});await change(r);await owner();
    const notice=await one('SELECT * FROM public.notifications');assert.equal(notice.type,'reservation_change');assert.ok(!notice.message.includes('<img'));assert.ok(notice.message.includes('&lt;img'));assert.ok(notice.message.includes('&amp;'));assert.ok(notice.message.includes('&#39;Nome&#39;'));
  });
  await test('idempotent retry acknowledges the original change without additional audit or notifications',async()=>{
    const r=await add(),requestId=randomUUID();const first=await change(r,{},requestId);await configure({public_reservation_changes_enabled:false});
    const replay=await change(r,{},requestId);assert.equal(replay.changed,true);assert.equal(replay.replayed,true);assert.equal(replay.revision,first.revision);
    await assert.rejects(()=>change(r,{party_size:3},requestId),{code:'22023'});await owner();
    assert.equal(Number((await one("SELECT count(*) FROM public.reservation_audit_logs WHERE action='updated'")).count),1);assert.equal(Number((await one('SELECT count(*) FROM public.notifications')).count),1);
  });
  await test('stale revision and no-change requests preserve the booking and do not create work',async()=>{
    const r=await add();assert.equal((await change(r,{time:'19:00'})).reason,'no_changes');
    await owner();await db.query("UPDATE public.reservations SET notes='panel edit',updated_at=updated_at+interval '1 second' WHERE id=$1",[r.id]);await anon();assert.equal((await change(r)).reason,'stale');
    await owner();assert.equal(Number((await one('SELECT count(*) FROM public.notifications')).count),0);
  });
  await test('paid, pending, expired and refunded financial history always requires manual service',async()=>{
    for(const status of ['paid','pending','expired','refunded','chargeback','cancelled','failed']){
      const r=await add({time:'01:00',table_id:null});await owner();await db.query('INSERT INTO public.reservation_payments(company_id,reservation_id,status) VALUES($1,$2,$3)',[company,r.id,status]);await anon();
      assert.equal((await options(r)).reason,'payment');assert.equal((await change(r)).reason,'payment');
    }
  });
  await test('destination with an active payment rule remains unavailable, even for a currently free booking',async()=>{
    const r=await add(),date=(await one('SELECT ($1::date+1)::text AS date',[r.date])).date;
    await configure({prepayment_enabled:true});await owner();await db.query('INSERT INTO public.reservation_payment_rules(company_id,date_start,date_end) VALUES($1,$2,$2)',[company,date]);await anon();
    const output=await options(r,date);assert.equal(output.allowed,true);assert.ok(output.slots.length);assert.ok(output.slots.every(s=>!s.available&&s.reason==='payment'));
    assert.equal((await change(r,{date})).reason,'payment');
    await owner();await db.query('UPDATE public.reservation_payment_rules SET archived_at=now()');await anon();assert.equal((await change(r,{date})).changed,true);
  });
  await test('a disabled payment feature or disabled rule does not require a payment for the destination',async()=>{
    const r=await add();await owner();await db.query('INSERT INTO public.reservation_payment_rules(company_id,date_start,date_end) VALUES($1,$2,$2)',[company,r.date]);await anon();assert.equal((await change(r)).changed,true);
  });
  await test('only confirmed, not checked-in reservations may change',async()=>{
    for(const status of ['checked_in','cancelled','no-show','no_show','pending_payment','payment_expired','paid_after_expiration']){
      const r=await add({status,table_id:null});assert.equal((await options(r)).reason,'status');assert.equal((await change(r)).reason,'status');
    }
    const inconsistent=await add({checked_in_at:new Date().toISOString()});assert.equal((await change(inconsistent)).reason,'status');
  });
  await test('original and destination notice windows use the company timezone and reject elapsed slots',async()=>{
    const local=await one("SELECT (date_trunc('hour',statement_timestamp() AT TIME ZONE 'Pacific/Auckland')+interval '1 hour')::date::text AS date, to_char(date_trunc('hour',statement_timestamp() AT TIME ZONE 'Pacific/Auckland')+interval '1 hour','HH24:MI') AS time");
    await configure({time_zone:'Pacific/Auckland'});
    const r=await add({date:local.date,time:local.time,table_id:null});assert.equal((await options(r)).reason,'cutoff');
    const future=await add({table_id:null});const target=await options(future,local.date);assert.equal(target.time_zone,'Pacific/Auckland');assert.ok(target.slots.some(s=>s.reason==='cutoff'));
    assert.equal((await change(future,{date:local.date,time:local.time})).reason,'cutoff');
  });
  await test('notice boundary is inclusive and the instant before it is denied',async()=>{
    const r=await add();await owner();
    for(const [offset,expected]of[['2 hours',null],['1 hour 59 minutes 59.999999 seconds','cutoff']]){
      const row=await one("SELECT public._public_reservation_change_reason(jsonb_populate_record(r,jsonb_build_object('date',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo'+$2::interval)::date,'time',(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo'+$2::interval)::time)),statement_timestamp()) AS reason FROM public.reservations r WHERE id=$1",[r.id,offset]);assert.equal(row.reason,expected);
    }
  });
  await test('enforces group limits, exact arrivals, capacity and invalid input on the final write',async()=>{
    const r=await add();await rule(r.date,{mode:'capacity',maxGuests:6,maxParty:5,maxReservations:1});
    assert.equal((await change(r,{party_size:6})).reason,'party_size');
    await add({time:'20:00',party_size:4,table_id:null});assert.equal((await change(r)).reason,'full');
    for(const count of [0,21])await assert.rejects(()=>change(r,{party_size:count}),{code:'22023'});
    await owner();assert.equal((await one('SELECT party_size FROM public.reservations WHERE id=$1',[r.id])).party_size,4);
  });
  await test('quantity in a larger existing group is preserved in the preview and can be explicitly reduced',async()=>{
    const r=await add({party_size:22,table_id:null});const output=await options(r);assert.equal(output.reservation.party_size,22);assert.equal(output.max_party_size,20);assert.ok(output.slots.every(s=>!s.available));
    assert.equal((await change(r,{party_size:4})).changed,true);
  });
  await test('capacity mode clears table assignments and uses the new slot duration and rules',async()=>{
    const r=await add();await rule(r.date,{mode:'capacity',maxGuests:10,duration:90});const changed=await change(r,{party_size:5});assert.equal(changed.changed,true);
    await owner();const row=await one('SELECT * FROM public.reservations WHERE id=$1',[r.id]);assert.equal(row.table_id,null);assert.equal(row.created_in_mode,'capacity');assert.equal(row.duration_minutes,90);
    assert.equal(Number((await one('SELECT count(*) FROM public.reservation_table_assignments WHERE reservation_id=$1',[r.id])).count),0);
  });
  await test('blocked date/time, inactive tables and missing slots remain protected',async()=>{
    const r=await add();await owner();await db.query('INSERT INTO public.blocked_dates(company_id,date,all_day,start_time,end_time) VALUES($1,$2,false,\'20:00\',\'21:00\')',[company,r.date]);await anon();assert.equal((await change(r)).reason,'blocked');
    await owner();await db.exec('TRUNCATE public.blocked_dates');await db.query("UPDATE public.restaurant_tables SET status='maintenance' WHERE company_id=$1",[company]);await anon();assert.equal((await change(r)).reason,'full');
    await owner();await db.query("UPDATE public.restaurant_tables SET status='available' WHERE company_id=$1",[company]);await anon();await rule(r.date,{times:['19:00','21:00']});assert.equal((await change(r)).reason,'blocked');
  });
  await test('manual full-slot flags block autonomous changes, including the original slot',async()=>{
    const r=await add();await rule(r.date);await owner();await db.query('UPDATE public.reservation_schedule_rule_slots SET is_full=true');await anon();
    assert.ok((await options(r)).slots.every(slot=>!slot.available&&slot.reason==='full'));
    assert.equal((await change(r,{party_size:3})).reason,'full');assert.equal((await change(r,{time:'19:00',party_size:3})).reason,'full');
  });
  await test('secondary assigned tables participate in conflict checks and cannot be chosen for a larger group',async()=>{
    const r=await add();const occupied=await add({time:'20:00',party_size:2,table_id:tableB});await owner();await db.query('INSERT INTO public.reservation_table_assignments(reservation_id,table_id,sort_order,capacity_at_assignment) VALUES($1,$2,1,20)',[occupied.id,tableC]);await anon();
    assert.equal((await options(r,r.date,12)).slots.find(slot=>slot.time==='20:00').reason,'full');assert.equal((await change(r,{party_size:12})).reason,'full');
  });
  await test('dated active maps use the company timezone and best-fit never selects a foreign company table',async()=>{
    const r=await add();await owner();const specialMap=randomUUID(),specialTable=randomUUID(),foreignTable=randomUUID();
    const at=(await one("SELECT ($1::date+'20:00'::time) AT TIME ZONE 'America/Sao_Paulo' AS at",[r.date])).at;
    await db.query("INSERT INTO public.table_maps(id,company_id,name,is_default,is_enabled,priority,active_from,active_to) VALUES($1,$2,'Especial',false,true,1,$3,$3::timestamptz+interval '1 hour')",[specialMap,company,at]);
    await db.query("INSERT INTO public.restaurant_tables VALUES($1,$2,99,8,'Especial','available',$3),($4,$5,100,4,'Outra','available',null)",[specialTable,company,specialMap,foreignTable,otherCompany]);await anon();
    assert.equal((await change(r,{party_size:6})).changed,true);await owner();assert.equal((await one('SELECT table_id FROM public.reservations WHERE id=$1',[r.id])).table_id,specialTable);
    await db.query('DELETE FROM public.reservations WHERE id=$1',[r.id]);await db.query('DELETE FROM public.restaurant_tables WHERE id=ANY($1::uuid[])',[[specialTable,foreignTable]]);await db.query('DELETE FROM public.table_maps WHERE id=$1',[specialMap]);
  });
  await test('date bounds reject past and excessively distant destinations without changing the original',async()=>{
    const r=await add();for(const offset of [-1,366]){
      const date=(await one("SELECT ((statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+$1::integer)::text AS date",[offset])).date;
      assert.deepEqual((await options(r,date)).slots,[]);assert.equal((await change(r,{date})).reason,'unavailable');
    }
  });
  await test('queued stale confirmations and reminders are invalidated in both transports; unrelated messages survive',async()=>{
    const r=await add();await owner();for(const table of ['whatsapp_message_queue','pluguechat_message_queue'])for(const type of ['confirmation','confirmation_message','reminder_1h','reminder_24h','birthday'])await db.query(`INSERT INTO public.${table}(reservation_id,company_id,type,status) VALUES($1,$2,$3,'pending')`,[r.id,company,type]);await anon();assert.equal((await change(r)).changed,true);
    await owner();for(const [table,status]of[['whatsapp_message_queue','expired'],['pluguechat_message_queue','cancelled']]){const rows=(await db.query(`SELECT type,status FROM public.${table}`)).rows;assert.equal(rows.filter(x=>x.status===status).length,4);assert.equal(rows.find(x=>x.type==='birthday').status,'pending');}
  });
  await test('an in-flight message defers changes without touching reservation, queues, receipts or notifications',async()=>{
    for(const [table,status]of[['whatsapp_message_queue','processing'],['pluguechat_message_queue','processing'],['pluguechat_message_queue','provider_queued']]){
      const r=await add({time:'02:00',table_id:null});await owner();await db.query(`INSERT INTO public.${table}(reservation_id,company_id,type,status) VALUES($1,$2,'reminder_1h',$3)`,[r.id,company,status]);await anon();assert.equal((await change(r)).reason,'message_processing');
    }
    await owner();assert.equal(Number((await one('SELECT count(*) FROM public.notifications')).count),0);assert.equal(Number((await one('SELECT count(*) FROM public.reservation_public_change_requests')).count),0);
  });
  await test('a transactional notification failure rolls back the reservation, assignment, audit and queue cancellation',async()=>{
    const r=await add();await owner();await db.query("INSERT INTO public.whatsapp_message_queue(reservation_id,company_id,type,status) VALUES($1,$2,'reminder_1h','pending')",[r.id,company]);
    await db.exec("CREATE FUNCTION public.fixture_reject_notice() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture notice failure';END;$$;CREATE TRIGGER fixture_reject_notice BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_notice()");await anon();
    await assert.rejects(()=>change(r),/fixture notice failure/);await owner();
    assert.equal((await one('SELECT time::text FROM public.reservations WHERE id=$1',[r.id])).time,'19:00:00');assert.equal((await one('SELECT status FROM public.whatsapp_message_queue')).status,'pending');assert.equal(Number((await one("SELECT count(*) FROM public.reservation_audit_logs WHERE action='updated'")).count),0);
    await db.exec('DROP TRIGGER fixture_reject_notice ON public.notifications;DROP FUNCTION public.fixture_reject_notice()');
  });
  await test('rate limits are enforced on both public methods without changing the reservation',async()=>{
    const r=await add();await owner();await db.query("INSERT INTO public.public_rate_limits(scope,company_id,identifier) SELECT 'public_reservation_change_options',$1,'fixture-browser' FROM generate_series(1,120)",[company]);await anon();await assert.rejects(()=>options(r),/Muitas consultas/);
    await owner();await db.query("INSERT INTO public.public_rate_limits(scope,company_id,identifier) SELECT 'public_reservation_change_submit',$1,'fixture-browser' FROM generate_series(1,10)",[company]);await anon();await assert.rejects(()=>change(r),/Muitas tentativas/);
  });
  await test('normal panel/system edits retain their original audit classification after the guarded migration',async()=>{
    const r=await add();await owner();await db.query('UPDATE public.reservations SET party_size=3 WHERE id=$1',[r.id]);
    const row=await one("SELECT * FROM public.reservation_audit_logs WHERE reservation_id=$1 AND action='updated'",[r.id]);assert.equal(row.actor_source,'system');assert.equal(row.actor_role,'system');
    const definition=(await one("SELECT pg_get_functiondef('public.audit_reservation_changes()'::regprocedure) AS definition")).definition;
    assert.ok(definition.includes(beforeAudit.definition.slice(beforeAudit.definition.indexOf("  IF TG_OP = 'DELETE' THEN"))));
  });
  for(const kind of ['public-create','panel-create','panel-update','waitlist-seat','late-payment']) {
    await test(`${kind} shares the actual capacity-day lock when enabled and preserves its existing off/capacity behavior`,async()=>{
      for(const [enabled,mode]of[[false,'tables'],[true,'tables'],[false,'capacity']]){
        await configure({public_reservation_changes_enabled:enabled,max_guests_per_slot:20});await owner();await db.exec('BEGIN');
        try{
          const r=await add({table_id:kind==='panel-update'?tableA:null,status:kind==='late-payment'?'payment_expired':'confirmed'});
          await rule(r.date,{mode,maxGuests:20});await owner();
          await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[actorId]);
          if(kind==='public-create'){
            await one('SELECT public.create_public_reservation($1::jsonb) AS result',[JSON.stringify({company_id:company,date:r.date,time:'20:00',party_size:4,guest_name:'Interlock fixture',guest_phone:'+5500000000000',table_id:tableA})]);
          }else if(kind==='panel-create'){
            await one("SELECT public.create_panel_reservation($1,$2,'20:00',4,'Interlock fixture','+5500000000000') AS result",[company,r.date]);
          }else if(kind==='panel-update'){
            await one("SELECT public.update_panel_reservation($1,$2,'20:00',3,'Interlock fixture','+5500000000000') AS result",[r.id,r.date]);
          }else if(kind==='waitlist-seat'){
            const waiting=randomUUID();await db.query("INSERT INTO public.waitlist(id,company_id,guest_name,guest_phone,status) VALUES($1,$2,'Interlock fixture','+5500000000000','waiting')",[waiting,company]);
            await one("SELECT public.seat_waitlist_entry($1,4,'[]'::jsonb,null,null,$2,'20:00') AS result",[waiting,r.date]);
          }else{
            const payment=randomUUID();await db.query("INSERT INTO public.reservation_payments(id,company_id,reservation_id,status,expires_at) VALUES($1,$2,$3,'expired',now()-interval '1 hour')",[payment,company,r.id]);
            const result=(await one("SELECT public.confirm_reservation_payment($1,$2,'RECEIVED',now(),'{}'::jsonb,'fixture') AS result",[payment,company])).result;assert.equal(result.status,'paid');
          }
          const held=await capacityDayLockHeld(r.date);
          assert.equal(held,enabled||(mode==='capacity'&&kind!=='waitlist-seat'),`${kind} enabled=${enabled} mode=${mode}`);
        }finally{
          await owner();await db.exec('ROLLBACK');await db.query("SELECT set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.role','',false)");
        }
      }
    });
  }
  if (process.argv.includes('--auto-table-combinations')) {
    const { runAutoTableCombinationChangeScenarios } = await import('./auto-table-combination-change-scenarios.mjs');
    await runAutoTableCombinationChangeScenarios({ db, company, actorId, map, tableA, tableB, tableC,
      owner, anon, add, configure, rule, test, change, options, one, load });
  }
  console.log(`\n${passed} customer reservation change PostgreSQL cases passed; no network or external database used.`);
} catch(error) {
  console.error(JSON.stringify({message:error.message,code:error.code,detail:error.detail,hint:error.hint,position:error.position,where:error.where},null,2));process.exitCode=1;
} finally {await owner();await db.close();}
