import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Real canonical CRM read-model migrations + the real CRM-02 migration. Only
// authentication/permission policy and unrelated operational tables are fixtures.
// No network, credentials, provider requests or external database are used.
const db = new PGlite();
const load = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const migration = (name) => load(`../migrations/${name}.sql`);
const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherCompany = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = '00000000-0000-4000-8000-000000000001';
let passed = 0;
let roleSet = false;
const tracked = [];
const steps = [
  ['-- @apply-old-recurrence', '20260814120000_fix_customer_recurrence_waitlist_fallback'],
  ['-- @apply-core-migration', '20260814130000_add_server_side_crm_leads_read_model'],
  ['-- @apply-export-migration', '20260814140000_add_crm_leads_canonical_export'],
  ['-- @apply-recurrence-pagination-filter-migration', '20260817120000_add_recurrence_minimum_visits_filter'],
  ['-- @apply-unbounded-pagination-migration', '20260817130000_remove_crm_report_pagination_ceiling'],
  ['-- @apply-recurrence-profile-migration', '20260819115000_add_recurrence_lead_profile_lookup'],
];
async function one(sql, args = []) { return (await db.query(sql, args)).rows[0]; }
async function owner() { if (roleSet) { await db.exec('RESET ROLE'); roleSet = false; } }
async function actor(options = {}) {
  await owner();
  const config = { role: 'authenticated', user: actorId, leads: 'on', reservations: 'on', messages: 'on', finance: 'on', scope: company, ...options };
  for (const [key, value] of Object.entries({
    'request.jwt.claim.role': config.role, 'request.jwt.claim.sub': config.user,
    'test.crm_leads': config.leads, 'test.crm_reservations': config.reservations,
    'test.crm_messages': config.messages, 'test.crm_finance': config.finance, 'test.crm_scope': config.scope,
  })) await db.query('SELECT set_config($1,$2,false)', [key, value]);
  await db.exec(`SET ROLE ${config.role}`); roleSet = true;
}
async function relationship(key, section = 'summary', options = {}) {
  const { page = 1, pageSize = 25, companyId = company } = options;
  return (await one('SELECT public.get_company_crm_relationship($1,$2,$3,$4,$5) AS result', [companyId,key,section,page,pageSize])).result;
}
async function reservation(values = {}) {
  await owner();
  const row = { id: randomUUID(), company_id: company, guest_name: 'Relationship holder', guest_phone: '+5511987654321', guest_phone_e164: '+5511987654321', guest_phone_country: 'BR', status: 'confirmed', date: '2026-11-22', time: '19:00', party_size: 3, created_at: new Date().toISOString(), source: 'reservation', ...values };
  await db.query(`INSERT INTO public.reservations(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>`$${index+1}`).join(',')})`, Object.values(row));
  tracked.push(row.id);
  await actor();
  return row;
}
async function companion(reservationId, values = {}) {
  await owner();
  const row = { id: randomUUID(), reservation_id: reservationId, position: 1, name: 'Relationship companion', phone: '+5511976543210', phone_e164: '+5511976543210', phone_country: 'BR', created_at: new Date().toISOString(), ...values };
  await db.query(`INSERT INTO public.reservation_companions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>`$${index+1}`).join(',')})`, Object.values(row));
  await actor();
  return row;
}
async function keyFor(reservationId, role = 'holder') {
  await owner();
  const key = (await one('SELECT customer_key FROM public._get_crm_contact_records($1) WHERE visit_id=$2 AND role_kind=$3 LIMIT 1', [company,reservationId,role])).customer_key;
  await actor();
  return key;
}
async function resetFixtures() {
  await owner();
  await db.exec('TRUNCATE public.reservation_payments,public.whatsapp_message_logs,public.pluguechat_message_logs,public.reservation_companions,public.waitlist_companions,public.waitlist,public.reservations,public.crm_leads CASCADE');
  tracked.length = 0;
  await db.query("UPDATE public.companies SET time_zone='America/Sao_Paulo' WHERE id=$1", [company]);
  await actor();
}
async function test(name, body) {
  try { await resetFixtures(); await body(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

try {
  const harness = await load('./crm_leads_server_read_model_regression.sql');
  let cursor = 0;
  for (const [marker, name] of steps) {
    const position = harness.indexOf(marker, cursor);
    assert.ok(position >= 0, `Missing canonical CRM marker ${marker}`);
    await db.exec(harness.slice(cursor, position));
    if (cursor === 0) await db.exec(`
      CREATE TYPE public.app_role AS ENUM ('superadmin','admin','operator');
      CREATE TABLE public.companies(id uuid PRIMARY KEY,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO public.companies(id,name) VALUES('${company}','Company A'),('${otherCompany}','Company B'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Company C');
      CREATE FUNCTION public.has_role(uuid,public.app_role) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.has_role_in_company(uuid,public.app_role,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    `);
    await db.exec(await migration(name));
    cursor = position + marker.length;
  }
  await db.exec(harness.slice(cursor));
  await db.exec(await migration('20260820130000_add_advanced_report_foundation'));
  await db.exec(await migration('20260827130000_expand_customer_recurrence_temporal_analysis'));
  await db.exec(await migration('20261007120000_add_crm_lead_profile_editing'));
  await db.exec(`
    ALTER TABLE public.reservations ADD source text NOT NULL DEFAULT 'reservation', ADD guest_phone_e164 text, ADD guest_phone_country text NOT NULL DEFAULT 'BR';
    ALTER TABLE public.reservation_companions ADD phone_e164 text, ADD phone_country text NOT NULL DEFAULT 'BR';
    ALTER TABLE public.waitlist ADD guest_phone_e164 text, ADD guest_phone_country text NOT NULL DEFAULT 'BR';
    ALTER TABLE public.waitlist_companions ADD phone_e164 text, ADD phone_country text NOT NULL DEFAULT 'BR';
    ALTER TABLE public.crm_leads ADD phone_e164 text, ADD phone_country text NOT NULL DEFAULT 'BR';
    CREATE TABLE public.reservation_payments(id uuid PRIMARY KEY,company_id uuid,reservation_id uuid,status text,billing_type text,base_amount numeric,charged_amount numeric,paid_at timestamptz,created_at timestamptz DEFAULT now(),provider_secret text,provider_payload jsonb);
    CREATE TABLE public.whatsapp_message_logs(id uuid PRIMARY KEY,company_id uuid,reservation_id uuid,phone text,type text,status text,created_at timestamptz DEFAULT now(),message text,error_details text,provider_secret text);
    CREATE TABLE public.pluguechat_message_logs(id uuid PRIMARY KEY,company_id uuid,reservation_id uuid,phone text,type text,status text,created_at timestamptz DEFAULT now(),provider_status text,template_name text,parameters jsonb,provider_secret text,error_details text);
  `);
  await db.exec(await migration('20261019115000_add_phone_number_metadata'));
  const phoneContract = await migration('20261019120000_add_international_phone_contract');
  await db.exec(phoneContract.slice(0, phoneContract.indexOf('-- Fixed allowlist')));
  const identityContract = await migration('20261019121000_use_international_phone_identity');
  await db.exec(identityContract.slice(0, identityContract.indexOf('CREATE OR REPLACE FUNCTION public.claim_whatsapp_dispatch')));
  // Auth helpers are the only access-policy fixtures. The actual RPC validates
  // them before using the actual canonical profiles and contact records.
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.has_company_panel_permission(_user_id uuid,_company_id uuid,_permission text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT CASE
        WHEN _user_id IS DISTINCT FROM '${actorId}'::uuid OR _company_id::text IS DISTINCT FROM current_setting('test.crm_scope',true) THEN false
        WHEN _permission='leads_view' THEN CASE current_setting('test.crm_leads',true) WHEN 'on' THEN true WHEN 'null' THEN NULL ELSE false END
        WHEN _permission='reservations_view' THEN CASE current_setting('test.crm_reservations',true) WHEN 'on' THEN true WHEN 'null' THEN NULL ELSE false END
        WHEN _permission='automations_view' THEN CASE current_setting('test.crm_messages',true) WHEN 'on' THEN true WHEN 'null' THEN NULL ELSE false END
        ELSE false END;
    $$;
    CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid,_role public.app_role) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE OR REPLACE FUNCTION public.has_role_in_company(_user_id uuid,_role public.app_role,_company_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT _user_id='${actorId}'::uuid AND _company_id::text=current_setting('test.crm_scope',true) AND _role='admin'
        AND CASE current_setting('test.crm_finance',true) WHEN 'on' THEN true WHEN 'null' THEN NULL ELSE false END;
    $$;
    GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
  `);
  const crmMigration = await migration('20261122131000_crm_customer_relationship');
  await db.exec(crmMigration);
  await db.exec(crmMigration);

  await test('keeps the relationship RPC private to authenticated and service roles', async () => {
    await owner();
    const signature = 'public.get_company_crm_relationship(uuid,text,text,integer,integer)';
    assert.equal((await one("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", [signature])).allowed,false);
    assert.equal((await one("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", [signature])).allowed,true);
    assert.equal((await one("SELECT has_function_privilege('authenticated','public._get_crm_relationship_reservations(uuid,text)','EXECUTE') AS allowed")).allowed,false);
    await actor({ role:'anon', user:'' });
    await assert.rejects(() => relationship('phone:5511987654321'), { code:'42501' });
  });

  await test('requires a valid authenticated actor, leads permission and the exact company scope', async () => {
    const row = await reservation(); const key = await keyFor(row.id);
    for (const options of [{ user:'' },{ leads:'off' },{ leads:'null' },{ scope:otherCompany }]) {
      await actor(options);
      await assert.rejects(() => relationship(key), { code:'42501' });
    }
    await actor();
    await assert.rejects(() => relationship(key,'summary',{ companyId:otherCompany }), { code:'42501' });
  });

  await test('rejects identities absent from the canonical profile and invalid request bounds', async () => {
    await assert.rejects(() => relationship('phone:5511000000000'),{ code:'P0002' });
    const row = await reservation(); const key = await keyFor(row.id);
    for (const [identity, section, options] of [[key,'other',{}],[key,'reservations',{ page:0 }],[key,'reservations',{ pageSize:101 }],['','summary',{}],['x'.repeat(501),'summary',{}]]) {
      await assert.rejects(() => relationship(identity,section,options),{ code:'22023' });
    }
  });

  await test('uses the real canonical holder/companion identity and deduplicates a shared participation', async () => {
    const row = await reservation({ status:'completed' });
    await companion(row.id,{ phone:row.guest_phone,phone_e164:row.guest_phone_e164 });
    await companion(row.id,{ position:2 });
    const holderKey = await keyFor(row.id);
    const holder = await relationship(holderKey,'reservations');
    assert.equal(holder.total,1);
    assert.equal(holder.rows[0].relationship_role,'holder');
    assert.equal(holder.rows[0].status,'checked_in');
    const companionState = await relationship('phone:5511976543210','reservations');
    assert.equal(companionState.total,1);
    assert.equal(companionState.rows[0].relationship_role,'companion');
    assert.equal(companionState.rows[0].holder_name,row.guest_name);
  });

  await test('separates cancelled, no-show and presence states while keeping all reservation relationships', async () => {
    for (const status of ['completed','checked_in','cancelled','no_show','payment_expired','pending_payment']) await reservation({ status });
    const key = 'phone:5511987654321';
    const snapshot = await relationship(key,'reservations');
    assert.equal(snapshot.total,6);
    assert.equal(snapshot.summary.cancelled_count,1);
    assert.equal(snapshot.summary.no_show_count,1);
    assert.equal(snapshot.rows.filter(row=>row.status==='checked_in').length,2);
    assert.equal(snapshot.rows.filter(row=>row.status==='no-show').length,1);
  });

  await test('uses the company time zone to distinguish upcoming wall-clock reservations from past ones', async () => {
    await owner();
    await db.query("UPDATE public.companies SET time_zone='America/New_York' WHERE id=$1",[company]);
    const wall = await one("SELECT ((now() AT TIME ZONE 'America/New_York')+interval '1 minute')::date AS future_date,((now() AT TIME ZONE 'America/New_York')+interval '1 minute')::time AS future_time,((now() AT TIME ZONE 'America/New_York')-interval '1 minute')::date AS past_date,((now() AT TIME ZONE 'America/New_York')-interval '1 minute')::time AS past_time");
    const future = await reservation({ date:wall.future_date,time:wall.future_time,status:'confirmed' });
    await reservation({ date:wall.future_date,time:wall.future_time,status:'pending_payment' });
    await reservation({ date:wall.past_date,time:wall.past_time,status:'confirmed' });
    await reservation({ date:wall.future_date,time:wall.future_time,status:'cancelled' });
    await reservation({ date:wall.future_date,time:wall.future_time,status:'checked_in' });
    const snapshot = await relationship('phone:5511987654321','reservations');
    assert.equal(snapshot.summary.upcoming_count,2);
    assert.equal(snapshot.rows.filter(row=>row.is_upcoming).length,2);
    assert.ok(snapshot.rows.find(row=>row.id===future.id).is_upcoming);
    assert.ok(snapshot.rows.slice(0,2).every(row=>row.is_upcoming));
  });

  await test('pages more than one thousand reservations while keeping complete summary counts', async () => {
    await owner();
    await db.query(`INSERT INTO public.reservations(id,company_id,status,guest_name,guest_phone,guest_phone_e164,guest_phone_country,date,time,party_size,created_at,source)
      SELECT gen_random_uuid(),$1,'confirmed','Volume holder','+5511987654321','+5511987654321','BR',date '2026-11-22',time '19:00',3,now(),'reservation' FROM generate_series(1,1203)`,[company]);
    await actor();
    const first = await relationship('phone:5511987654321','reservations');
    const second = await relationship('phone:5511987654321','reservations',{ page:2 });
    assert.equal(first.total,1203); assert.equal(first.summary.reservation_count,1203); assert.equal(first.rows.length,25);
    assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,50);
    const last = await relationship('phone:5511987654321','reservations',{ page:999 });
    assert.equal(last.page,49); assert.equal(last.rows.length,3);
  });

  await test('links payments only to holder reservations, never to a companion merely sharing the visit', async () => {
    const row = await reservation(); await companion(row.id);
    await owner();
    await db.query("INSERT INTO public.reservation_payments(id,company_id,reservation_id,status,billing_type,base_amount,charged_amount,paid_at,provider_secret,provider_payload) VALUES($1,$2,$3,'paid','PIX',80,90,now(),'must-not-leak','{\"token\":\"must-not-leak\"}')",[randomUUID(),company,row.id]);
    await actor();
    const holder = await relationship('phone:5511987654321','payments');
    const guest = await relationship('phone:5511976543210','payments');
    assert.equal(holder.total,1); assert.equal(holder.rows[0].charged_amount,90); assert.equal(holder.rows[0].reservation_id,row.id);
    assert.equal(guest.total,0); assert.deepEqual(guest.rows,[]);
    assert.ok(!JSON.stringify(holder).includes('must-not-leak'));
    assert.ok(!('provider_payload' in holder.rows[0]));
  });

  await test('returns only direct-recipient communications and never the holder messages to a companion', async () => {
    const row = await reservation(); await companion(row.id);
    await owner();
    await db.query("INSERT INTO public.whatsapp_message_logs(id,company_id,reservation_id,phone,type,status,message,provider_secret,error_details) VALUES($1,$2,$3,'+5511987654321','waitlist_called','sent','Safe holder notice','must-not-leak','provider-raw-secret')",[randomUUID(),company,row.id]);
    await db.query("INSERT INTO public.pluguechat_message_logs(id,company_id,reservation_id,phone,type,status,provider_status,template_name,parameters,provider_secret) VALUES($1,$2,$3,'+5511976543210','confirmation_message','sent','SENT','Approved example','{\"secret\":\"must-not-leak\"}','must-not-leak')",[randomUUID(),company,row.id]);
    await actor();
    const holder = await relationship('phone:5511987654321','messages');
    const guest = await relationship('phone:5511976543210','messages');
    assert.equal(holder.total,1); assert.equal(holder.rows[0].channel,'evolution');
    assert.equal(guest.total,1); assert.equal(guest.rows[0].channel,'pluguechat_official');
    for(const state of [holder,guest]) {
      assert.ok(!JSON.stringify(state).includes('must-not-leak'));
      assert.ok(!JSON.stringify(state).includes('provider-raw-secret'));
      assert.ok(state.rows.every(row=>!('parameters' in row)&&!('phone' in row)&&!('error_details' in row)));
    }
  });

  await test('does not match message recipients by suffix, name or shared reservation', async () => {
    const row=await reservation();
    await owner();
    for(const phone of ['987654321','+55119876543210','+5511987654322']) await db.query("INSERT INTO public.whatsapp_message_logs(id,company_id,reservation_id,phone,type,status,message) VALUES($1,$2,$3,$4,'confirmation_message','sent','Different recipient')",[randomUUID(),company,row.id,phone]);
    await actor();
    assert.equal((await relationship('phone:5511987654321','messages')).total,0);
  });

  await test('keeps Russian international and identical bare Brazilian digits as distinct canonical people', async () => {
    const russian=await reservation({ guest_name:'Russian guest',guest_phone:'+79991234567',guest_phone_e164:'+79991234567',guest_phone_country:'RU' });
    const brazilian=await reservation({ guest_name:'Brazilian guest',guest_phone:'79991234567',guest_phone_e164:null,guest_phone_country:'BR' });
    const russianKey=await keyFor(russian.id); const brazilianKey=await keyFor(brazilian.id);
    assert.equal(russianKey,'phone:79991234567'); assert.equal(brazilianKey,'phone:5579991234567');
    await owner();
    for(const [phone,text] of [['+79991234567','Russian only'],['79991234567','Brazilian only']]) await db.query("INSERT INTO public.whatsapp_message_logs(id,company_id,reservation_id,phone,type,status,message) VALUES($1,$2,$3,$4,'confirmation_message','sent',$5)",[randomUUID(),company,russian.id,phone,text]);
    await actor();
    const ru=await relationship(russianKey,'messages'); const br=await relationship(brazilianKey,'messages');
    assert.equal(ru.total,1); assert.equal(br.total,1);
    assert.equal(ru.rows[0].message_preview,'Russian only'); assert.equal(br.rows[0].message_preview,'Brazilian only');
    assert.equal((await relationship(russianKey,'reservations')).total,1); assert.equal((await relationship(brazilianKey,'reservations')).total,1);
  });

  await test('retains the stable manually edited profile key and its original reservation relationship', async () => {
    const row=await reservation(); const key=await keyFor(row.id);
    await owner();
    await db.query("INSERT INTO public.crm_leads(id,company_id,full_name,phone,phone_e164,phone_country,phone_normalized,profile_customer_key,source,imported_at,created_at,updated_at) VALUES($1,$2,'Edited name','+5511965432109','+5511965432109','BR','5511965432109',$3,'manual_edit',now(),now(),now())",[randomUUID(),company,key]);
    const profile=await one('SELECT customer_key,latest_name FROM public._get_crm_lead_profiles($1) WHERE customer_key=$2',[company,key]);
    assert.equal(profile.customer_key,key); assert.equal(profile.latest_name,'Edited name');
    await actor();
    const result=await relationship(key,'reservations');
    assert.equal(result.canonical_customer_key,key); assert.equal(result.total,1); assert.equal(result.rows[0].id,row.id);
  });

  await test('supports email-only identities without borrowing another guest phone for communications', async () => {
    const row=await reservation({ guest_phone:null,guest_phone_e164:null,guest_email:'email-only@example.test' });
    const key=await keyFor(row.id);
    assert.equal(key,'email:email-only@example.test');
    assert.equal((await relationship(key,'reservations')).total,1);
    assert.equal((await relationship(key,'messages')).total,0);
  });

  await test('respects section permissions and never exposes hidden summaries as zero', async () => {
    await reservation();
    for(const denied of ['off','null']) {
      await actor({ reservations:denied,messages:denied,finance:denied });
      const summary=await relationship('phone:5511987654321');
      assert.deepEqual(summary.capabilities,{ reservations:false,payments:false,messages:false });
      assert.equal(summary.summary.reservation_count,null);
      for(const section of ['reservations','payments','messages']) await assert.rejects(()=>relationship('phone:5511987654321',section),{ code:'42501' });
    }
    await actor({ finance:'off' });
    assert.equal((await relationship('phone:5511987654321')).capabilities.payments,false);
    await assert.rejects(()=>relationship('phone:5511987654321','payments'),{ code:'42501' });
    assert.equal((await relationship('phone:5511987654321','reservations')).total,1);
  });

  await test('keeps other-company reservations, payments and communications outside the selected identity', async () => {
    const ours=await reservation();
    const theirs=await reservation({ company_id:otherCompany });
    await owner();
    await db.query("INSERT INTO public.reservation_payments VALUES($1,$2,$3,'paid','PIX',999,999,now(),now(),'foreign-secret','{}')",[randomUUID(),otherCompany,theirs.id]);
    await db.query("INSERT INTO public.whatsapp_message_logs(id,company_id,reservation_id,phone,type,status,message) VALUES($1,$2,$3,'+5511987654321','confirmation_message','sent','Foreign message')",[randomUUID(),otherCompany,theirs.id]);
    await actor();
    const reservations=await relationship('phone:5511987654321','reservations');
    assert.equal(reservations.total,1); assert.equal(reservations.rows[0].id,ours.id);
    assert.equal((await relationship('phone:5511987654321','payments')).total,0);
    assert.equal((await relationship('phone:5511987654321','messages')).total,0);
  });

  console.log(`\n${passed} canonical CRM relationship PostgreSQL cases passed; no network or external database used.`);
} catch(error) {
  // PGlite errors contain the full SQL and minified runtime in their default
  // stack; keep failures actionable without leaking complete fixture payloads.
  console.error(JSON.stringify({ message:error.message,code:error.code,detail:error.detail,hint:error.hint,where:error.where,position:error.position },null,2));
  process.exitCode=1;
} finally { await owner(); await db.close(); }
