import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const admin='11111111-1111-4111-8111-111111111111',tenant='22222222-2222-4222-8222-222222222222';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',B='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',C='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',D='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const image=`notification-images/${randomUUID()}.png`;
let passed=0;
async function owner(){await db.exec('RESET ROLE');}
async function service(){await owner();await db.query("SELECT set_config('request.jwt.claim.role','service_role',false),set_config('request.jwt.claim.sub','',false),set_config('test.support','false',false)");await db.exec('SET ROLE service_role');}
async function actor(user=tenant,{support=false,role='authenticated'}={}){await owner();await db.query("SELECT set_config('request.jwt.claim.role',$1,false),set_config('request.jwt.claim.sub',$2,false),set_config('test.support',$3,false)",[role,user??'',String(support)]);await db.exec(`SET ROLE ${role}`);}
async function rows(sql,args=[]){return(await db.query(sql,args)).rows;}
async function one(sql,args=[]){return(await rows(sql,args))[0];}
const recipient=(id,name,phone,status=phone?'queued':'skipped')=>({company_id:id,company_name:name,recipient_phone:phone,status,error_message:phone?null:'Sem contato'});
const recipients=[recipient(A,'Empresa A','+12025550101'),recipient(B,'Empresa B','+12025550102'),recipient(C,'Empresa C','+12025550101'),recipient(D,'Empresa D',null)];
async function create({id=randomUUID(),ids=[A,B,C,D],path=image,caption='Imagem com legenda\nSem HTML.',actorId=admin,contacts=recipients}={}){
  return rows('SELECT * FROM public.create_platform_whatsapp_notice_batch($1,$2,$3,$4,$5,$6::jsonb)',[id,ids,path,caption,actorId,JSON.stringify(contacts)]);
}
async function claim(limit=3,batch=null){return rows('SELECT * FROM public.claim_platform_whatsapp_notices($1,$2)',[limit,batch]);}
async function finish(row,status='accepted',{token=row.lease_token,providerId='provider-proof',error=null}={}){return(await one('SELECT public.finish_platform_whatsapp_notice($1,$2,$3,$4,$5) done',[row.id,token,status,providerId,error])).done;}
async function retry(row,phone=row.recipient_phone,attempts=row.attempts){return(await one('SELECT (public.retry_platform_whatsapp_notice($1,$2,$3,$4,$5)).*',[row.id,phone,phone?null:'Empresa sem contato',admin,attempts]));}
async function test(name,fn){
  await owner();await db.exec('TRUNCATE public.companies,public.platform_whatsapp_notice_batches,public.audit_logs CASCADE');
  await db.query("INSERT INTO public.companies(id,name,responsible_phone_e164,responsible_phone,responsible_phone_country) VALUES($1,'Empresa A','+12025550101',NULL,'US'),($2,'Empresa B','+12025550102',NULL,'US'),($3,'Empresa C','+12025550101',NULL,'US'),($4,'Empresa D',NULL,NULL,'BR')",[A,B,C,D]);
  await service();try{await fn();console.log(`ok ${++passed} - ${name}`);}catch(error){console.error(`not ok - ${name}`);throw error;}
}
try{
  await db.exec(`
    CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
    CREATE TYPE public.app_role AS ENUM('superadmin','admin','operator','support');
    CREATE TABLE public.user_roles(user_id uuid,role public.app_role,company_id uuid);
    CREATE FUNCTION public.has_role(_id uuid,_role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT COALESCE(current_setting('test.support',true),'false')<>'true' AND EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_id AND role=_role)$$;
    CREATE TABLE public.companies(id uuid PRIMARY KEY,name text NOT NULL,responsible_phone_e164 text,responsible_phone text,responsible_phone_country text,deletion_requested_at timestamptz);
    CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES auth.users(id),action text,entity_type text,entity_id uuid,details jsonb);
    GRANT SELECT ON public.audit_logs TO service_role;
    GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role,anon;
  `);
  await db.query('INSERT INTO auth.users VALUES($1),($2)',[admin,tenant]);
  await db.query("INSERT INTO public.user_roles VALUES($1,'superadmin',NULL),($2,'admin',$3)",[admin,tenant,A]);
  // Exercise the actual numbering-plan metadata and stored legacy contract,
  // rather than a permissive E.164-looking regular-expression test double.
  await db.exec(await readFile(new URL('../migrations/20261019115000_add_phone_number_metadata.sql',import.meta.url),'utf8'));
  const phoneContract=await readFile(new URL('../migrations/20261019120000_add_international_phone_contract.sql',import.meta.url),'utf8');
  await db.exec(phoneContract.slice(0,phoneContract.indexOf('CREATE OR REPLACE FUNCTION public.phone_identity_digits')));
  const migration=await readFile(new URL('../migrations/20261122140000_platform_whatsapp_notices.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);
  // Schedule migration is also harmless in a local database without pg_cron.
  await db.exec(await readFile(new URL('../migrations/20261122141000_schedule_platform_whatsapp_notices.sql',import.meta.url),'utf8'));

  await test('create snapshots one row per company and skips duplicate or missing contacts',async()=>{
    const notices=await create();assert.equal(notices.length,4);
    assert.deepEqual(notices.filter(n=>n.status==='queued').map(n=>n.company_id).sort(),[A,B]);
    assert.equal(notices.find(n=>n.company_id===C).status,'skipped');assert.match(notices.find(n=>n.company_id===C).error_message,/repetido/);
    assert.equal(notices.find(n=>n.company_id===D).recipient_phone,null);
    assert.equal((await one("SELECT count(*) n FROM public.audit_logs WHERE action='send_whatsapp_notification'")).n,1);
  });
  await test('replays canonical company sets without duplicate notices or rerouting contacts',async()=>{
    const id=randomUUID(),first=await create({id});
    await owner();await db.query("UPDATE public.companies SET responsible_phone_e164='+12025550199' WHERE id=$1",[A]);await service();
    const second=await create({id,ids:[D,C,B,A,A]});
    assert.deepEqual(second.map(n=>n.id).sort(),first.map(n=>n.id).sort());
    assert.equal(second.find(n=>n.company_id===A).recipient_phone,'+12025550101');
    assert.equal((await one('SELECT count(*) n FROM public.audit_logs')).n,1);
  });
  await test('same request cannot change payload, actor, image or selected company set',async()=>{
    const id=randomUUID();await create({id});
    for(const patch of [{caption:'Outro texto'},{path:`notification-images/${randomUUID()}.jpg`},{ids:[A]},{actorId:tenant}])await assert.rejects(()=>create({id,...patch}));
  });
  await test('invalid image, empty caption and excessive recipients leave no partial batch',async()=>{
    for(const patch of [{path:'https://evil.test/image.png'},{path:'notification-images/../../secret.png'},{path:`notification-images/${randomUUID()}.svg`},{caption:'   '},{caption:'x'.repeat(1001)},{ids:[]},{ids:[null]}])await assert.rejects(()=>create(patch),{code:'22023'});
    assert.equal((await one('SELECT count(*) n FROM public.platform_whatsapp_notice_batches')).n,0);
  });
  await test('recipients cannot supply another company, forged names or a public/other phone',async()=>{
    for(const contacts of [[...recipients.slice(0,3),recipient(randomUUID(),'Extra',null)],recipients.map((r,i)=>i? r:{...r,company_name:'Nome forjado'}),recipients.map((r,i)=>i? r:{...r,recipient_phone:'+12025550133'}),[recipients[0],recipients[0],recipients[2],recipients[3]]])await assert.rejects(()=>create({contacts}),{code:'22023'});
    assert.equal((await one('SELECT count(*) n FROM public.platform_whatsapp_notice_batches')).n,0);
  });
  await test('responsible raw fallback works only when canonical phone is empty',async()=>{
    await owner();await db.query("UPDATE public.companies SET responsible_phone_e164=NULL,responsible_phone='+12025550103' WHERE id=$1",[B]);await service();
    const result=await create({ids:[B],contacts:[recipient(B,'Empresa B','+12025550103')]});assert.equal(result[0].recipient_phone,'+12025550103');
    await owner();await db.query("UPDATE public.companies SET responsible_phone_e164='invalid' WHERE id=$1",[B]);await service();
    await assert.rejects(()=>create({ids:[B],contacts:[recipient(B,'Empresa B','+12025550103')]}),{code:'22023'});
  });
  await test('legacy eight-digit BR contacts retain the exact stored destination for create and retry',async()=>{
    await owner();await db.query("UPDATE public.companies SET responsible_phone_e164=NULL,responsible_phone='(11) 8888-2222',responsible_phone_country='BR' WHERE id=$1",[D]);await service();
    assert.equal((await one("SELECT public.phone_to_e164('(11) 8888-2222','BR') strict")).strict,null);
    assert.equal((await one("SELECT public.phone_stored_identity_digits(NULL,'(11) 8888-2222','BR') stored")).stored,'551188882222');
    const [notice]=await create({ids:[D],contacts:[recipient(D,'Empresa D','+551188882222')]});
    assert.equal(notice.status,'queued');assert.equal(notice.recipient_phone,'+551188882222');
    const [claimed]=await claim();await finish(claimed,'failed',{providerId:null,error:'Rejeição explícita'});
    const failed=await one('SELECT * FROM public.platform_whatsapp_notices WHERE id=$1',[notice.id]);
    assert.equal((await retry(failed,'+551188882222')).status,'queued');
    const [secondClaim]=await claim();await finish(secondClaim,'failed',{providerId:null,error:'Rejeição explícita'});
    const secondFailure=await one('SELECT * FROM public.platform_whatsapp_notices WHERE id=$1',[notice.id]);
    await owner();await db.query("UPDATE public.companies SET responsible_phone_e164='invalid' WHERE id=$1",[D]);await service();
    await assert.rejects(()=>create({ids:[D],contacts:[recipient(D,'Empresa D','+551188882222')]}),{code:'22023'});
    await assert.rejects(()=>retry(secondFailure,'+551188882222'),{code:'22023'});
  });
  await test('tenant/anonymous cannot read queue, private lease fields or invoke mutating RPCs',async()=>{
    await create();
    const names=['public.create_platform_whatsapp_notice_batch(uuid,uuid[],text,text,uuid,jsonb)','public.claim_platform_whatsapp_notices(integer,uuid)','public.finish_platform_whatsapp_notice(uuid,uuid,text,text,text)','public.retry_platform_whatsapp_notice(uuid,text,text,uuid,integer)'];
    await owner();for(const name of names)for(const role of ['anon','authenticated'])assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,name])).allowed,false);
    await actor();assert.equal((await one('SELECT count(id) n FROM public.platform_whatsapp_notices')).n,0);
    await assert.rejects(()=>create(),{code:'42501'});await assert.rejects(()=>claim(),{code:'42501'});
    await actor(null,{role:'anon'});await assert.rejects(()=>rows('SELECT id FROM public.platform_whatsapp_notices'),{code:'42501'});
    await actor(admin);assert.equal((await rows('SELECT id FROM public.platform_whatsapp_notices')).length,4);
    await assert.rejects(()=>rows('SELECT lease_token FROM public.platform_whatsapp_notices'),{code:'42501'});
    await assert.rejects(()=>db.query("UPDATE public.platform_whatsapp_notices SET status='queued'"),{code:'42501'});
    await actor(admin,{support:true});assert.equal((await rows('SELECT id FROM public.platform_whatsapp_notices')).length,0);
  });
  await test('claims are bounded, unique and cannot be claimed twice while processing',async()=>{
    await create();const first=await claim(1),second=await claim(3);assert.equal(first.length,1);assert.equal(second.length,1);
    assert.notEqual(first[0].id,second[0].id);assert.equal((await claim()).length,0);
    assert(first[0].lease_token);assert.equal(first[0].attempts,1);assert.equal(first[0].status,'processing');
    await assert.rejects(()=>claim(4),{code:'22023'});await assert.rejects(()=>claim(0),{code:'22023'});
  });
  await test('completion requires matching lease and accepted provider proof',async()=>{
    await create();const [notice]=await claim(1);
    assert.equal(await finish(notice,'accepted',{token:randomUUID()}),false);
    await assert.rejects(()=>finish(notice,'accepted',{providerId:null}),{code:'22023'});
    assert.equal(await finish(notice),true);assert.equal(await finish(notice),false);
    const accepted=await one('SELECT * FROM public.platform_whatsapp_notices WHERE id=$1',[notice.id]);assert.equal(accepted.status,'accepted');assert.equal(accepted.lease_token,null);
    await assert.rejects(()=>retry(accepted),{code:'22023'});
  });
  await test('expired processing is unknown and is never automatically requeued or completed late',async()=>{
    await create();const [notice]=await claim(1);
    await owner();await db.query("UPDATE public.platform_whatsapp_notices SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[notice.id]);await service();
    await claim();const unknown=await one('SELECT * FROM public.platform_whatsapp_notices WHERE id=$1',[notice.id]);assert.equal(unknown.status,'unknown');
    assert.equal(await finish(notice),false);await assert.rejects(()=>retry(unknown),{code:'22023'});
    assert.equal((await claim()).length,0);
  });
  await test('definitive failure can retry once per attempt snapshot without stale reopening',async()=>{
    await create();const [notice]=await claim(1);await finish(notice,'failed',{providerId:null,error:'Rejeitado'});
    const failed=await one('SELECT * FROM public.platform_whatsapp_notices WHERE id=$1',[notice.id]);
    assert.equal((await retry(failed)).status,'queued');assert.equal((await retry(failed)).status,'queued');
    const claimed=(await claim(3)).find(n=>n.id===notice.id);assert(claimed);assert.equal(claimed.attempts,2);
    await finish(claimed,'failed',{providerId:null,error:'Rejeitado novamente'});
    assert.equal((await retry(failed)).status,'failed');
    assert.equal((await one("SELECT count(*) n FROM public.audit_logs WHERE action='retry_whatsapp_notification'")).n,1);
  });
  await test('retry re-resolves only the same company responsible contact',async()=>{
    const [notice]=await create({ids:[D],contacts:[recipients[3]]});
    await owner();await db.query("UPDATE public.companies SET responsible_phone_e164='+12025550104' WHERE id=$1",[D]);await service();
    await assert.rejects(()=>retry(notice,'+12025550102'),{code:'22023'});
    const queued=await retry(notice,'+12025550104');assert.equal(queued.status,'queued');assert.equal(queued.company_id,D);
  });
  await test('duplicate retry cannot send a shared number twice within the original batch',async()=>{
    const notices=await create();const duplicate=notices.find(n=>n.company_id===C);
    const skipped=await retry(duplicate);assert.equal(skipped.status,'skipped');assert.match(skipped.error_message,/repetido/);
  });
  await test('deletion preserves historical snapshots and prevents queued deliveries',async()=>{
    const notices=await create();await owner();await db.query('DELETE FROM public.companies WHERE id=$1',[A]);await service();
    const claimed=await claim();assert.equal(claimed.some(n=>n.id===notices.find(n=>n.company_id===A).id),false);
    const historical=await one('SELECT * FROM public.platform_whatsapp_notices WHERE id=$1',[notices.find(n=>n.company_id===A).id]);
    assert.equal(historical.company_id,null);assert.equal(historical.company_name,'Empresa A');assert.equal(historical.status,'skipped');
    const skipped=await retry(historical,null);assert.equal(skipped.status,'skipped');assert.equal(skipped.company_name,'Empresa A');
  });
  await test('a deletion request made after queueing skips that company before claiming',async()=>{
    const [notice]=await create({ids:[A],contacts:[recipients[0]]});
    await owner();await db.query('UPDATE public.companies SET deletion_requested_at=now() WHERE id=$1',[A]);await service();
    assert.equal((await claim()).length,0);
    const skipped=await one('SELECT * FROM public.platform_whatsapp_notices WHERE id=$1',[notice.id]);
    assert.equal(skipped.status,'skipped');assert.equal(skipped.company_id,A);assert.equal(skipped.attempts,0);assert.equal(skipped.lease_token,null);
    assert.match(skipped.error_message,/não está disponível/);
  });
  console.log(`${passed} platform WhatsApp notice SQL regressions passed.`);
}finally{await db.close();}
