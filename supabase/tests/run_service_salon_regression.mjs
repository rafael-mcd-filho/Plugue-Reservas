import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite();
const company=randomUUID(),other=randomUUID(),user=randomUUID(),outsider=randomUUID(),map=randomUUID(),tableA=randomUUID(),tableB=randomUUID();
let roleSet=false,passed=0;
const load=name=>readFile(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8');
const rpc='public.get_company_service_salon(uuid,date,time without time zone)';
async function owner(){if(roleSet){await db.exec('RESET ROLE');roleSet=false;}}
async function actor({id=user,tables='true',reservations='true',scope=company,role='authenticated'}={}){
  await owner();await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false),set_config('test.tables',$3,false),set_config('test.reservations',$4,false),set_config('test.scope',$5,false)",[id??'',role,tables,reservations,scope??'']);
  await db.exec(`SET ROLE ${role}`);roleSet=true;
}
async function one(sql,args=[]){return(await db.query(sql,args)).rows[0];}
async function salon({unit=company,date='2026-11-22',time='19:10'}={}){return(await one('SELECT public.get_company_service_salon($1,$2,$3) AS value',[unit,date,time])).value;}
async function add(overrides={}){
  await owner();const r={id:randomUUID(),company_id:company,guest_name:'Ana fixture',date:'2026-11-22',time:'19:00',party_size:4,checked_in_party_size:null,status:'confirmed',checked_in_at:null,duration_minutes:60,source:'reservation',origin_waitlist_id:null,created_in_mode:'tables',table_id:tableA,created_at:'2026-11-21T15:00:00Z',...overrides};
  await db.query(`INSERT INTO public.reservations(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(r));await actor();return r;
}
async function test(name,body){await owner();await db.exec('TRUNCATE public.reservation_table_assignments,public.reservation_payments,public.reservations');await actor();try{await body();console.log(`ok ${++passed} - ${name}`);}catch(e){console.error(`not ok - ${name}`);throw e;}}
try{
  await db.exec(`
    CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
    CREATE FUNCTION public.has_company_panel_permission(_user uuid,_company uuid,_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT CASE WHEN _user='${user}'::uuid AND _company::text=current_setting('test.scope',true) THEN nullif(current_setting(CASE _permission WHEN 'tables_view' THEN 'test.tables' ELSE 'test.reservations' END,true),'null')::boolean ELSE false END$$;
    CREATE TABLE public.companies(id uuid PRIMARY KEY,time_zone text,reservation_duration integer,availability_mode text DEFAULT 'tables');
    CREATE TABLE public.table_maps(id uuid PRIMARY KEY,company_id uuid,name text,is_default boolean,is_enabled boolean,active_from timestamptz,active_to timestamptz,priority integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE public.restaurant_tables(id uuid PRIMARY KEY,company_id uuid,number integer,capacity integer,section text,status text,table_map_id uuid);
    CREATE TABLE public.reservations(id uuid PRIMARY KEY,company_id uuid,guest_name text,date date,time time,party_size integer,checked_in_party_size integer,status text,checked_in_at timestamptz,duration_minutes integer,source text,origin_waitlist_id uuid,created_in_mode text,table_id uuid,created_at timestamptz);
    ALTER TABLE public.reservations ADD COLUMN guest_phone text DEFAULT '+5500000000000',ADD COLUMN guest_phone_e164 text,ADD COLUMN guest_email text,ADD COLUMN public_tracking_code text DEFAULT 'fixture',ADD COLUMN occasion text,ADD COLUMN notes text,ADD COLUMN updated_at timestamptz DEFAULT now();
    CREATE TABLE public.reservation_table_assignments(reservation_id uuid,table_id uuid,PRIMARY KEY(reservation_id,table_id));
    CREATE TABLE public.reservation_payments(id uuid DEFAULT gen_random_uuid(),company_id uuid,reservation_id uuid,status text,expires_at timestamptz,provider_secret text);
    CREATE FUNCTION public.get_public_reservation_schedule(_company uuid,_date date) RETURNS TABLE(availability_mode text) LANGUAGE sql STABLE AS $$SELECT c.availability_mode FROM public.companies c WHERE c.id=_company$$;
    CREATE SEQUENCE public.resolver_calls;
    CREATE FUNCTION public.resolve_reservation_slot_duration(_company uuid,_date date,_time time) RETURNS integer LANGUAGE sql VOLATILE AS $$SELECT nextval('public.resolver_calls')*0+coalesce(reservation_duration,30) FROM public.companies WHERE id=_company$$;
    GRANT USAGE ON SCHEMA auth,public TO authenticated,service_role;
  `);
  await db.query('INSERT INTO public.companies VALUES($1,\'America/Sao_Paulo\',60,\'tables\'),($2,\'Pacific/Auckland\',60,\'tables\')',[company,other]);
  await db.query("INSERT INTO public.table_maps(id,company_id,name,is_default,is_enabled,priority) VALUES($1,$2,'Principal',true,true,10)",[map,company]);
  for(const [id,number,section,status] of [[tableA,1,'Salão','available'],[tableB,2,'Varanda','maintenance']])await db.query('INSERT INTO public.restaurant_tables VALUES($1,$2,$3,4,$4,$5,$6)',[id,company,number,section,status,map]);
  const foundation=await load('20260820130000_add_advanced_report_foundation');
  const validator=foundation.slice(foundation.indexOf('CREATE OR REPLACE FUNCTION public._is_valid_iana_time_zone'),foundation.indexOf('CREATE OR REPLACE FUNCTION public._assert_company_advanced_report_access'));
  const zone=foundation.slice(foundation.indexOf('CREATE OR REPLACE FUNCTION public._company_report_time_zone'),foundation.indexOf('CREATE OR REPLACE FUNCTION public._validate_advanced_report_range'));
  await db.exec(validator);await db.exec(zone);
  await db.exec(await load('20260331201000_align_table_map_active_window_boundary'));
  const migration=await load('20261122132000_service_today_salon');await db.exec(migration);await db.exec(migration);

  await test('anonymous/public ACL is revoked and both company permissions are mandatory',async()=>{
    await owner();assert.equal((await one("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed",[rpc])).allowed,false);
    assert.equal((await one("SELECT has_function_privilege('anon','public.get_company_service_salon_reservation(uuid,uuid)','EXECUTE') AS allowed")).allowed,false);
    assert.equal((await one('SELECT prosecdef FROM pg_proc WHERE oid=$1::regprocedure',[rpc])).prosecdef,true);
    await actor({role:'anon',id:null});await assert.rejects(()=>salon(),{code:'42501'});
    for(const [tables,reservations] of [['false','true'],['true','false'],['null','true'],['true','null']]){await actor({tables,reservations});await assert.rejects(()=>salon(),{code:'42501'});}
    await actor({id:null});await assert.rejects(()=>salon(),{code:'42501'});
  });
  await test('support and outsider actors remain inside the exact company scope',async()=>{
    await actor({scope:other});await assert.rejects(()=>salon(),{code:'42501'});
    await actor({id:outsider});await assert.rejects(()=>salon(),{code:'42501'});
    await actor();await assert.rejects(()=>salon({unit:other}),{code:'42501'});
  });
  await test('uses the company timezone and returns the explicit reference and active map',async()=>{
    const result=await salon();assert.equal(result.reference_at,'2026-11-22T22:10:00+00:00');assert.equal(result.time_zone,'America/Sao_Paulo');assert.equal(result.map.id,map);assert.equal(result.tables.length,2);
    const current=await salon({date:(await one("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS date")).date,time:null});
    const expected=(await one("SELECT date_trunc('minute',now() AT TIME ZONE 'America/Sao_Paulo')::time::text AS time")).time;
    assert.equal(current.reference_time.slice(0,5),expected.slice(0,5));
  });
  await test('respects half-open special-map boundaries and never returns another company map tables',async()=>{
    const special=randomUUID(),specialTable=randomUUID();await owner();
    await db.query("INSERT INTO public.table_maps(id,company_id,name,is_default,is_enabled,active_from,active_to,priority) VALUES($1,$2,'Evento',false,true,'2026-11-22T21:00Z','2026-11-22T23:00Z',1)",[special,company]);
    await db.query("INSERT INTO public.restaurant_tables VALUES($1,$2,99,4,'Evento','available',$3)",[specialTable,company,special]);
    await actor();const before=await salon({time:'17:59'}),inside=await salon({time:'18:00'}),end=await salon({time:'20:00'});
    assert.equal(before.map.id,map);assert.equal(inside.map.id,special);assert.deepEqual(inside.tables.map(t=>t.id),[specialTable]);assert.equal(end.map.id,map);
    await owner();await db.query('DELETE FROM public.restaurant_tables WHERE id=$1',[specialTable]);await db.query('DELETE FROM public.table_maps WHERE id=$1',[special]);
  });
  await test('returns a complete day beyond the PostgREST 1000-row limit without private fields',async()=>{
    await owner();await db.query("INSERT INTO public.reservations(id,company_id,guest_name,date,time,party_size,status,duration_minutes,created_at) SELECT gen_random_uuid(),$1,'Volume '||g,'2026-11-22','19:00',2,'confirmed',60,now() FROM generate_series(1,1203) g",[company]);await actor();
    const result=await salon();assert.equal(result.reservations.length,1203);assert.equal(new Set(result.reservations.map(r=>r.id)).size,1203);assert.ok(result.reservations.every(r=>!('guest_phone'in r)&&!('notes'in r)&&!('provider_secret'in r)));
  });
  await test('uses unique canonical reservation rows for multi-table and seated-waitlist occupancy',async()=>{
    const r=await add({status:'checked_in',checked_in_party_size:3,source:'waitlist',origin_waitlist_id:randomUUID(),checked_in_at:'2026-11-22T22:00Z'});
    await owner();await db.query('INSERT INTO public.reservation_table_assignments VALUES($1,$2),($1,$3)',[r.id,tableA,tableB]);await actor();
    const result=await salon();assert.equal(result.reservations.length,1);assert.deepEqual(new Set(result.reservations[0].table_ids),new Set([tableA,tableB]));assert.equal(result.reservations[0].checked_in_party_size,3);
  });
  await test('does not expose a malformed cross-company primary or additional table association',async()=>{
    const foreignTable=randomUUID();await owner();await db.query("INSERT INTO public.restaurant_tables VALUES($1,$2,88,4,'Foreign','available',null)",[foreignTable,other]);
    const r=await add({table_id:foreignTable});await owner();await db.query('INSERT INTO public.reservation_table_assignments VALUES($1,$2)',[r.id,foreignTable]);await actor();
    assert.deepEqual((await salon()).reservations[0].table_ids,[]);assert.ok((await salon()).tables.every(t=>t.id!==foreignTable));
    await owner();await db.query('DELETE FROM public.restaurant_tables WHERE id=$1',[foreignTable]);
  });
  await test('excludes lost status variants and preserves pending payment as a separate state',async()=>{
    for(const status of ['cancelled','no_show','no-show','payment_expired','payment_cancelled','paid_after_expiration'])await add({status});
    await add({status:'completed'});await add({status:'pending_payment'});
    const result=await salon();assert.deepEqual(result.reservations.map(r=>r.status).sort(),['checked_in','pending_payment']);
  });
  await test('validates payment retention without returning amounts or provider payloads',async()=>{
    const stale=await add({status:'pending_payment'}),held=await add({status:'pending_payment'}),recent=await add({status:'pending_payment',created_at:new Date().toISOString()});
    await owner();await db.query("INSERT INTO public.reservation_payments(company_id,reservation_id,status,expires_at,provider_secret) VALUES($1,$2,'pending',now()-interval '1 minute','secret'),($1,$3,'pending',now()+interval '10 minutes','secret')",[company,stale.id,held.id]);await actor();
    const rows=(await salon()).reservations;assert.equal(rows.find(r=>r.id===stale.id).payment_hold_active,false);assert.equal(rows.find(r=>r.id===held.id).payment_hold_active,true);assert.equal(rows.find(r=>r.id===recent.id).payment_hold_active,true);assert.ok(rows.every(r=>!JSON.stringify(r).includes('secret')));
  });
  await test('includes cross-midnight and arbitrary multi-day stored durations',async()=>{
    const overnight=await add({date:'2026-11-21',time:'23:30',duration_minutes:120});
    const multi=await add({date:'2026-11-19',time:'12:00',duration_minutes:6000});
    const expired=await add({date:'2026-11-21',time:'23:00',duration_minutes:60});
    const rows=(await salon({time:'00:30'})).reservations;assert.ok(rows.some(r=>r.id===overnight.id));assert.ok(rows.some(r=>r.id===multi.id));assert.ok(!rows.some(r=>r.id===expired.id));
  });
  await test('includes late check-ins and early arrivals across midnight even outside scheduled day bounds',async()=>{
    const late=await add({date:'2026-11-20',time:'18:00',status:'checked_in',checked_in_at:'2026-11-22T02:50Z',duration_minutes:120});
    const early=await add({date:'2026-11-23',time:'00:20',status:'checked_in',checked_in_at:'2026-11-23T02:50Z',duration_minutes:120});
    const rows=(await salon()).reservations;assert.ok(rows.some(r=>r.id===late.id));assert.ok(rows.some(r=>r.id===early.id));
  });
  await test('supports uncapped company fallback for null legacy duration without scanning all old resolver rows',async()=>{
    await owner();await db.query('UPDATE public.companies SET reservation_duration=3000 WHERE id=$1',[company]);
    const legacy=await add({date:'2026-11-20',time:'23:00',duration_minutes:null});
    await owner();await db.query("INSERT INTO public.reservations(id,company_id,guest_name,date,time,party_size,status,duration_minutes,created_at) SELECT gen_random_uuid(),$1,'Old '||g,'2020-01-01','19:00',2,'confirmed',null,now() FROM generate_series(1,2500) g",[company]);
    await db.exec('ALTER SEQUENCE public.resolver_calls RESTART WITH 1');await actor();
    const rows=(await salon()).reservations;assert.ok(rows.some(r=>r.id===legacy.id));assert.equal(rows.length,1);
    await owner();assert.ok(Number((await one('SELECT last_value FROM public.resolver_calls')).last_value)<20);await db.query('UPDATE public.companies SET reservation_duration=60 WHERE id=$1',[company]);
  });
  await test('keeps foreign reservations and service reads scoped and validates required inputs',async()=>{
    await add({company_id:other,guest_name:'Foreign reservation',table_id:null});await add();assert.equal((await salon()).reservations.length,1);
    await actor({role:'service_role',id:null});assert.equal((await salon({unit:other})).reservations.length,1);await assert.rejects(()=>salon({unit:null}),{code:'22023'});await assert.rejects(()=>salon({date:null}),{code:'22023'});
  });
  await test('rechecks both permissions between an authorized snapshot and opening private reservation details',async()=>{
    const r=await add();assert.ok((await salon()).reservations.some(row=>row.id===r.id));
    const detail=()=>one('SELECT public.get_company_service_salon_reservation($1,$2) AS value',[company,r.id]);
    for(const grants of [{tables:'false'},{reservations:'false'},{tables:'null'}]){await actor(grants);await assert.rejects(detail,{code:'42501'});}
    await actor();const result=(await detail()).value;assert.equal(result.company_id,company);assert.equal(result.reservation_id,r.id);assert.equal(result.row.guest_name,'Ana fixture');assert.equal(result.row.guest_phone,'+5500000000000');assert.ok(!('provider_secret'in result.row));
  });
  await test('reservation details stay fenced by company and reject missing identities',async()=>{
    const foreign=await add({company_id:other,table_id:null});
    await assert.rejects(()=>one('SELECT public.get_company_service_salon_reservation($1,$2)',[company,foreign.id]),{code:'P0002'});
    await assert.rejects(()=>one('SELECT public.get_company_service_salon_reservation($1,$2)',[other,foreign.id]),{code:'42501'});
    await assert.rejects(()=>one('SELECT public.get_company_service_salon_reservation($1,$2)',[company,null]),{code:'22023'});
  });
  console.log(`\n${passed} Salon PostgreSQL cases passed; no network or external database used.`);
}catch(error){console.error(JSON.stringify({message:error.message,code:error.code,detail:error.detail,hint:error.hint,position:error.position},null,2));process.exitCode=1;}
finally{await owner();await db.close();}
