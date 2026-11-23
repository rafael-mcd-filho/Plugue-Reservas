import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';
import {parsePhoneNumberFromString} from 'libphonenumber-js/max';

const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',actor='33333333-3333-4333-8333-333333333333';
const requestId='44444444-4444-4444-8444-444444444444',imagePath='notification-images/55555555-5555-4555-8555-555555555555.png';
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const projectUrl='https://notice-fixture.supabase.co';
const noNetwork=()=>{throw new Error('External network is forbidden in offline tests');};
const deno={env:{get:key=>key==='SUPABASE_URL'?projectUrl:undefined}};
function compile(text,dependencies={}){
  const out={};
  const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(`(function(exports,require,Deno){${js}\n})`,{
    Request,Response,Headers,URL,Blob,Uint8Array,AbortController,Error,setTimeout,clearTimeout,TextDecoder,crypto:globalThis.crypto,fetch:noNetwork,console:{error(){},log(){}},
  })(out,name=>{assert.ok(Object.hasOwn(dependencies,name),`Unexpected dependency ${name}`);return dependencies[name];},deno);
  return out;
}
const source=file=>readFileSync(new URL(file,import.meta.url),'utf8');
const core=compile(source('./phone-core.ts'));
const phone=core.createPhoneTools(parsePhoneNumberFromString);
const common=compile(source('./platform-whatsapp-notices.ts'),{'./phone.ts':phone});
// Load the existing authorization body with a per-test identity source. No
// token/service credentials or real Auth request is used by this harness.
function authorize(context){
  const text=source('./internal-auth.ts').slice(source('./internal-auth.ts').indexOf('export async function assertSuperadmin'));
  const out={};const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(`(function(exports,getRequestAuthContext){${js}\n})`,{Error})(out,async()=>context);
  return out.assertSuperadmin;
}
function database({companies=[{id:a,name:'Fixture A',responsible_phone:'+5511999991111'},{id:b,name:'Fixture B',responsible_phone:'+5511888882222'}],blob=new Blob([png],{type:'image/png'}),config=true}={}){
  const state={companies,batches:[],rows:[],calls:[],downloads:0,finishFailure:false,leaseReadFailure:false};
  const settings=config?[{key:'evolution_api_url',value:'https://evolution.invalid'},{key:'evolution_api_token',value:'private-evolution-key'},{key:'internal_job_secret',value:'private-job-key'}]:[];
  const db={storage:{from(bucket){assert.equal(bucket,'system-assets');return{async download(path){state.downloads++;assert.equal(path,imagePath);return{data:blob,error:null};}};}},
    from(table){
      const filters=[];let start=0,end=Infinity,single=false,upsert=null;
      const builder={select(){return builder;},eq(key,value){filters.push(row=>row[key]===value);return builder;},in(key,value){filters.push(row=>value.includes(row[key]));return builder;},order(){return builder;},range(a,b){start=a;end=b;return builder;},maybeSingle(){single=true;return builder;},upsert(row){upsert=row;return builder;},
        then(resolve,reject){try{
          state.calls.push({table,upsert});
          if(table==='platform_whatsapp_notices'&&state.leaseReadFailure)return Promise.resolve({data:null,error:{message:'private read failure'}}).then(resolve,reject);
          let rows=table==='companies'?state.companies:table==='platform_whatsapp_notice_batches'?state.batches:table==='platform_whatsapp_notices'?state.rows:table==='system_settings'?settings:[];
          for(const filter of filters)rows=rows.filter(filter);
          const count=rows.length;rows=rows.slice(start,end+1);
          return Promise.resolve({data:single?rows[0]??null:rows,error:null,count}).then(resolve,reject);
        }catch(e){return Promise.reject(e).then(resolve,reject);}}
      };return builder;
    },
    async rpc(name,args){
      state.calls.push({rpc:name,args});
      if(name==='create_platform_whatsapp_notice_batch'){
        state.batches.push({id:args._request_id,company_ids:args._company_ids,image_path:args._image_path,caption:args._caption,created_by:args._actor_id});
        const rows=args._recipients.map((r,index)=>({...r,id:`66666666-6666-4666-8666-${String(index).padStart(12,'0')}`,batch_id:args._request_id,image_path:args._image_path,caption:args._caption,attempts:0,created_at:'2026-11-22T15:00:00Z',processed_at:null,lease_token:'secret-lease',provider_message_id:'private-provider-id'}));
        state.rows.push(...rows);return{data:rows,error:null};
      }
      if(name==='claim_platform_whatsapp_notices'){
        const claimed=state.rows.filter(r=>r.status==='queued'&&(!args._batch_id||r.batch_id===args._batch_id)).slice(0,args._limit);
        for(const row of claimed){row.status='processing';row.attempts++;row.lease_token=globalThis.crypto.randomUUID();row.lease_expires_at=new Date(Date.now()+120_000).toISOString();}
        return{data:claimed.map(r=>({...r})),error:null};
      }
      if(name==='finish_platform_whatsapp_notice'){
        if(state.finishFailure){state.finishFailure=false;return{data:null,error:{message:'lost DB acknowledgement'}};}
        const row=state.rows.find(r=>r.id===args._notice_id&&r.lease_token===args._lease_token&&r.status==='processing');
        if(!row)return{data:false,error:null};
        Object.assign(row,{status:args._status,error_message:args._error_message,provider_message_id:args._provider_message_id,processed_at:'2026-11-22T15:01:00Z'});return{data:true,error:null};
      }
      if(name==='retry_platform_whatsapp_notice'){
        const row=state.rows.find(r=>r.id===args._notice_id);assert(row);
        if(row.attempts===args._expected_attempts)Object.assign(row,{status:args._recipient_phone?'queued':'skipped',recipient_phone:args._recipient_phone,error_message:args._error_message});
        return{data:row,error:null};
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };return{db,state};
}
function harness(options={}){
  const {db,state}=database(options);const ctx={supabaseAdmin:db,actorUser:{id:actor},actorRoleRows:[{role:'superadmin'}],isSupport:false,impersonation:null};
  const auth=authorize(options.context===undefined?ctx:options.context);
  const authModule={assertSuperadmin:auth,createSupabaseAdminClient:()=>db,isAuthorizedInternalJob:async()=>false};
  const worker=compile(source('./platform-whatsapp-notices-worker.ts'),{'./internal-auth.ts':authModule,'./platform-whatsapp-notices.ts':common});
  let processingCalls=0;
  const api=compile(source('./platform-whatsapp-notices-api.ts'),{'./internal-auth.ts':authModule,'./platform-whatsapp-notices.ts':common,'./platform-whatsapp-notices-worker.ts':worker});
  const post=async(body,deps={})=>api.handlePlatformWhatsAppNotices(new Request('https://local.invalid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{
    projectUrl,process:async()=>{processingCalls++;return{};},...deps,
  });
  return{db,state,worker,api,post,processingCalls:()=>processingCalls};
}
const create={action:'create',request_id:requestId,company_ids:[a,b],image_path:imagePath,caption:'Aviso\nSegunda linha'};

test('only actual global superadmins can create notices; auth is checked before any database/storage/provider action',async()=>{
  for(const ctx of [null,{actorRoleRows:[{role:'admin'}]},{actorRoleRows:[{role:'operator'}]},{actorRoleRows:[{role:'superadmin'}],isSupport:true},{actorRoleRows:[{role:'superadmin'}],impersonation:{companyId:a}}]){
    const h=harness({context:ctx});const result=await h.post(create);assert.ok([401,403].includes(result.status));assert.equal(h.state.downloads,0);assert.equal(h.state.calls.length,0);assert.equal(h.processingCalls(),0);
  }
});
test('requires uploaded image, plain caption and bounded company scope; refuses injected sender or arbitrary URLs',async()=>{
  for(const patch of [{image_path:'https://outside.invalid/x.jpg'},{image_path:'notification-images/x.svg'},{caption:' '},{caption:'x'.repeat(1001)},{company_ids:[]},{company_ids:['bad']},{instance_name:'OTHER'},{phone:'+5511999991111'}]){
    const h=harness();const res=await h.post({...create,...patch});assert.equal(res.status,400);assert.equal(h.processingCalls(),0);assert.equal(h.state.rows.length,0);
  }
});
test('validates actual uploaded bytes, MIME and max size rather than trusting path extension',async()=>{
  for(const blob of [new Blob(['<svg onload=evil />'],{type:'image/png'}),new Blob([png],{type:'image/svg+xml'}),new Blob([new Uint8Array(5*1024*1024+1)],{type:'image/png'})]){
    const h=harness({blob});assert.equal((await h.post(create)).status,400);assert.equal(h.state.rows.length,0);
  }
});
test('caption limit uses the same UTF-16 length as browser maxLength and client response parsing',async()=>{
  assert.equal(common.requireNoticeCaption('😀'.repeat(500)).length,1000);
  assert.throws(()=>common.requireNoticeCaption('😀'.repeat(501)));
  const h=harness();assert.equal((await h.post({...create,caption:'😀'.repeat(1000)})).status,400);assert.equal(h.state.downloads,0);assert.equal(h.state.rows.length,0);
});
test('resolves only responsible contacts, snapshots missing contacts as skipped and deduplicates a shared responsible phone',async()=>{
  const c='77777777-7777-4777-8777-777777777777';
  const h=harness({companies:[{id:a,name:'A',responsible_phone_e164:'+5511999991111',phone:'+5511888880000'},{id:b,name:'B',responsible_phone:'+5511999991111'},{id:c,name:'C',phone:'+5511888889999',whatsapp:'+5511888889999'}]});
  const res=await h.post({...create,company_ids:[c,a,b,a]});assert.equal(res.status,200);const body=await res.json();assert.equal(body.total,3);assert.deepEqual(h.state.rows.map(r=>r.status),['queued','skipped','skipped']);assert.equal(h.state.rows[2].recipient_phone,null);assert.equal(body.instance_name,'RWSL');assert.equal(body.contact_kind,'responsible');
  assert.equal(h.processingCalls(),1);assert(!JSON.stringify(body).includes('secret-lease'));assert(!JSON.stringify(body).includes('private-provider-id'));assert(!JSON.stringify(body).includes('private-evolution-key'));
});
test('a populated invalid canonical responsible phone never falls back to a different raw/primary contact',()=>{
  assert.equal(common.responsibleNoticeContact({responsible_phone_e164:'invalid',responsible_phone:'+5511999991111',phone:'+5511888882222'}).phone,null);
  assert.equal(common.responsibleNoticeContact({responsible_phone:'(11) 99999-1111'}).phone,'+5511999991111');
});
test('create retries reuse exact request payload without duplicate queue rows, downloads or dispatch calls',async()=>{
  const h=harness();assert.equal((await h.post(create)).status,200);const firstRows=h.state.rows.map(r=>r.id);assert.equal((await h.post({...create,company_ids:[b,a]})).status,200);assert.deepEqual(h.state.rows.map(r=>r.id),firstRows);assert.equal(h.state.downloads,1);assert.equal(h.processingCalls(),1);
  assert.equal((await h.post({...create,caption:'changed'})).status,409);assert.equal(h.state.rows.length,2);
});
test('unknown/deleted company is rejected before creating partial batch',async()=>{
  const h=harness({companies:[]});assert.equal((await h.post(create)).status,400);assert.equal(h.state.rows.length,0);
});
test('list paginates independent WhatsApp history and never queries the tenant panel notifications',async()=>{
  const h=harness();await h.post(create);const res=await h.post({action:'list',offset:1,limit:1});const data=await res.json();assert.equal(data.rows.length,1);assert.equal(data.total,2);assert(!h.state.calls.some(c=>c.table==='notifications'));
});
test('retry resolves the latest responsible registration and never retries accepted/processing/unknown',async()=>{
  const h=harness();await h.post(create);const row=h.state.rows[0];row.status='failed';row.attempts=1;h.state.companies[0].responsible_phone='+5511999997777';
  assert.equal((await h.post({action:'retry',notice_id:row.id})).status,200);assert.equal(row.recipient_phone,'+5511999997777');assert.equal(row.status,'queued');
  for(const status of ['accepted','processing','unknown']){row.status=status;assert.equal((await h.post({action:'retry',notice_id:row.id})).status,409);}
});
test('provider adapter sends a single image+caption through RWSL and accepts only a concrete message key',async()=>{
  const h=harness();let sent;
  const outcome=await h.worker.dispatchPlatformNotice({url:'https://evolution.invalid',token:'private-key'},{recipient_phone:'+5511999991111',caption:'Aviso\nLegenda'},{mime:'image/png',url:`${projectUrl}/image.png`},{fetch:async(url,init)=>{sent={url,init};return new Response(JSON.stringify({key:{id:'provider-accepted'}}),{status:201});}});
  assert.equal(outcome.status,'accepted');assert.equal(outcome.providerMessageId,'provider-accepted');assert.equal(sent.url,'https://evolution.invalid/message/sendMedia/RWSL');
  assert.deepEqual(JSON.parse(sent.init.body),{number:'5511999991111',mediatype:'image',mimetype:'image/png',caption:'Aviso\nLegenda',media:`${projectUrl}/image.png`,fileName:'aviso.png'});
});
test('provider timeout/network, 5xx and unacknowledged 2xx are unknown; explicit refusals are retryable failures',async()=>{
  const h=harness(),row={recipient_phone:'+5511999991111',caption:'Aviso'},image={mime:'image/png',url:`${projectUrl}/image.png`},config={url:'https://evolution.invalid',token:'secret'};
  for(const status of [200,202,500,502])assert.equal((await h.worker.dispatchPlatformNotice(config,row,image,{fetch:async()=>new Response('{}',{status})})).status,'unknown');
  for(const status of [400,401,403,404,422,429])assert.equal((await h.worker.dispatchPlatformNotice(config,row,image,{fetch:async()=>new Response('{"private":"secret"}',{status})})).status,'failed');
  const network=await h.worker.dispatchPlatformNotice(config,row,image,{fetch:async()=>{throw new Error('private network details secret');}});assert.equal(network.status,'unknown');assert(!network.errorMessage.includes('secret'));
  const timed=await h.worker.dispatchPlatformNotice(config,row,image,{timeoutMs:1,fetch:async(_url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))});assert.equal(timed.status,'unknown');
});
test('worker claims each notice once, finishes with its token and never sends again after lost database acknowledgement',async()=>{
  const h=harness();await h.post({...create,company_ids:[a]});let providerCalls=0;h.state.finishFailure=true;
  const result=await h.worker.processPlatformWhatsAppNotices(h.db,{projectUrl,fetch:async()=>{providerCalls++;return new Response(JSON.stringify({key:{id:'accepted-key'}}));}});
  assert.equal(providerCalls,1);assert.equal(result.persistence_errors,1);assert.equal(h.state.rows[0].status,'unknown');
  await h.worker.processPlatformWhatsAppNotices(h.db,{projectUrl,fetch:async()=>{providerCalls++;return new Response('{}');}});assert.equal(providerCalls,1);
});
test('worker validates storage again immediately before send and records failure without contacting provider',async()=>{
  const h=harness();await h.post({...create,company_ids:[a]});h.db.storage.from=()=>({download:async()=>({data:new Blob(['not an image'],{type:'image/png'}),error:null})});let calls=0;
  const result=await h.worker.processPlatformWhatsAppNotices(h.db,{projectUrl,fetch:async()=>{calls++;return new Response('{}');}});assert.equal(result.failed,1);assert.equal(calls,0);assert.equal(h.state.rows[0].status,'failed');
});
test('storage preparation has a deadline and a late image can never resume a provider send',async()=>{
  const h=harness();await h.post({...create,company_ids:[a]});let release;let calls=0;
  h.db.storage.from=()=>({download:()=>new Promise(resolve=>{release=()=>resolve({data:new Blob([png],{type:'image/png'}),error:null});})});
  const result=await h.worker.processPlatformWhatsAppNotices(h.db,{projectUrl,preparationTimeoutMs:1,fetch:async()=>{calls++;return new Response('{}');}});
  assert.equal(result.failed,1);assert.equal(calls,0);assert.equal(h.state.rows[0].status,'failed');
  release();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,0);
});
test('a claim that expired or was replaced during image preparation never reaches the provider',async()=>{
  for(const invalidation of ['expired','token','status']){
    const h=harness();await h.post({...create,company_ids:[a]});let calls=0;
    h.db.storage.from=()=>({download:async()=>{
      const row=h.state.rows[0];if(invalidation==='expired')row.lease_expires_at=new Date(Date.now()-1000).toISOString();
      else if(invalidation==='token')row.lease_token='different-owner';else row.status='unknown';
      return{data:new Blob([png],{type:'image/png'}),error:null};
    }});
    const result=await h.worker.processPlatformWhatsAppNotices(h.db,{projectUrl,fetch:async()=>{calls++;return new Response('{}');}});
    assert.equal(result.unknown,1);assert.equal(calls,0);assert.notEqual(h.state.rows[0].status,'queued');
    assert(!h.state.calls.some(call=>call.rpc==='finish_platform_whatsapp_notice'));
  }
});
test('a company entering deletion during preparation is checked again before any provider call',async()=>{
  const h=harness();await h.post({...create,company_ids:[a]});let calls=0;
  h.db.storage.from=()=>({download:async()=>{h.state.companies[0].deletion_requested_at=new Date().toISOString();return{data:new Blob([png],{type:'image/png'}),error:null};}});
  const result=await h.worker.processPlatformWhatsAppNotices(h.db,{projectUrl,fetch:async()=>{calls++;return new Response('{}');}});
  assert.equal(result.unknown,1);assert.equal(calls,0);assert.notEqual(h.state.rows[0].status,'queued');
});
test('failure to read the current lease prevents provider contact even when the claim was valid',async()=>{
  const h=harness();await h.post({...create,company_ids:[a]});h.state.leaseReadFailure=true;let calls=0;
  const result=await h.worker.processPlatformWhatsAppNotices(h.db,{projectUrl,fetch:async()=>{calls++;return new Response('{}');}});
  assert.equal(calls,0);assert.equal(result.failed,1);assert.equal(h.state.rows[0].status,'failed');
});
test('process endpoint rejects unauthorized users and only accepts bounded worker parameters',async()=>{
  const h=harness({context:null});const req=body=>new Request('https://local.invalid',{method:'POST',body:JSON.stringify(body)});
  const denied=await h.worker.handleProcessPlatformWhatsAppNotices(req({}));assert.equal(denied.status,401);
  for(const body of [{limit:4},{instance_name:'OTHER'},{batch_id:'invalid'}]){
    const res=await h.worker.handleProcessPlatformWhatsAppNotices(req(body),{isInternal:async()=>true,admin:()=>h.db,process:async()=>{throw new Error('should not process');}});assert.equal(res.status,400);
  }
});
