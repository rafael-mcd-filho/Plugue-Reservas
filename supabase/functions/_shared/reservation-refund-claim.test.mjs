// Offline requests only. Provider calls are deterministic stubs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

class AsaasApiError extends Error {
  constructor(message,status) { super(message);this.status=status; }
}
const companyId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function evaluate(file,modules,deno={env:{get:()=>undefined}}) {
  const compiled=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const exports={};
  vm.runInNewContext(`(function(exports,require,Deno){${compiled}\n})`,{
    Request,Response,URL,console,crypto:globalThis.crypto,
  })(exports,name=>{ assert.ok(Object.hasOwn(modules,name),`Unexpected dependency ${name}`);return modules[name]; },deno);
  return exports;
}

function harness({ providerError=null,concurrent=false,webhookBeforeError=false,claimError=false,installment=false }={}) {
  const payment={id:'payment',company_id:companyId,reservation_id:'reservation',payment_token:'token',
    status:'paid',asaas_payment_id:'pay_1',asaas_status:'RECEIVED',metadata:{preserved:'yes'},
    base_amount:30,charged_amount:30,billing_type:'PIX',rule_snapshot:{},updated_at:new Date(0).toISOString()};
  const records={reservation_payments:[payment],reservations:[{id:'reservation',company_id:companyId,
    status:'confirmed',guest_name:'Guest',party_size:2}],companies:[{id:companyId,name:'Company'}],reservation_payment_events:[]};
  let revision=0;let refunds=0;let reads=0;let handler;let claims=0;
  let releaseReads;const readBarrier=new Promise(resolve=>{releaseReads=resolve;});
  const mutate=(row,changes)=>{Object.assign(row,changes);row.updated_at=new Date(++revision).toISOString();};
  const admin={from(table){
    let operation='select';let input;let single=false;const filters=[];
    const value=(row,key)=>key.startsWith('metadata->>')?row.metadata?.[key.slice(11)]:row[key];
    const query={
      select:()=>query,eq:(key,expected)=>{filters.push(row=>value(row,key)===expected);return query;},
      in:(key,values)=>{filters.push(row=>values.includes(value(row,key)));return query;},
      single:()=>{single=true;return query;},maybeSingle:()=>{single=true;return query;},
      update:changes=>{operation='update';input=changes;return query;},
      insert:entry=>{operation='insert';input=entry;return query;},
      then(resolve){
        if (claimError&&operation==='update'&&input.status==='refund_pending') {
          return Promise.resolve({error:{message:'claim database unavailable'},data:null}).then(resolve);
        }
        let rows=records[table].filter(row=>filters.every(filter=>filter(row)));
        if(operation==='update') {rows.forEach(row=>mutate(row,input));if(input.refund_request_id||input.metadata?.refund_request?.result==='submitting')claims+=rows.length;}
        if(operation==='insert'){records[table].push(structuredClone(input));rows=[input];}
        return Promise.resolve({data:structuredClone(single?rows[0]??null:rows),error:null}).then(resolve);
      },
    };return query;
  }};
  const shared=evaluate('./reservation-payments.ts',{});
  evaluate('../refund-reservation-payment/index.ts',{
    '../_shared/reservation-settlement-sync.ts':{synchronizeReservationSettlement:async()=>null},
    '../_shared/internal-auth.ts':{assertUserCanAccessCompany:async()=>({supabaseAdmin:admin})},
    '../_shared/reservation-asaas-config.ts':{getReservationAsaasCredentials:async()=>({apiToken:'offline',environment:'sandbox'})},
    '../_shared/asaas.ts':{AsaasApiError,getAsaasPayment:async()=>{
      reads++;
      if(concurrent&&reads<=2){if(reads===2)releaseReads();await readBarrier;}
      return{id:'pay_1',status:refunds&&!providerError?'REFUNDED':'RECEIVED',installment:installment?'installment_1':null};
    },refundAsaasPayment:async()=>{
      refunds++;
      if(providerError){if(webhookBeforeError)mutate(payment,{status:'refunded',asaas_status:'REFUNDED'});throw providerError;}
    },getAsaasExternalPaymentOutcome:(_event,status)=>status==='REFUNDED'?'refunded':'refund_pending',
    getAsaasRefundedValue:()=>null,getAsaasActiveChargebackStatus:()=>null},
    '../_shared/reservation-payments.ts':{...shared,markReservationPaymentProviderOutcome:async(_admin,_payment,outcome)=>{
      mutate(payment,{status:outcome});return structuredClone(payment);
    }},
  },{env:{get:()=>undefined},serve:fn=>{handler=fn;}});
  return{payment,records,refunds:()=>refunds,reads:()=>reads,claims:()=>claims,send:(overrides={})=>handler(new Request('https://offline.invalid/refund',{
    method:'POST',body:JSON.stringify({company_id:companyId,payment_token:'token',value:10,...overrides}),
  }))};
}

test('two concurrent refund requests submit only one irreversible provider request',async()=>{
  const h=harness({concurrent:true});
  const responses=await Promise.all([h.send(),h.send()]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  assert.equal(h.refunds(),1);assert.equal(h.claims(),1);
  assert.equal(h.payment.metadata.preserved,'yes');
});

test('a timeout keeps a pending claim, records uncertainty and rejects a repeated submission',async()=>{
  const h=harness({providerError:new TypeError('network timeout')});
  const response=await h.send();
  assert.equal(response.status,502);
  assert.equal((await response.json()).code,'REFUND_RESULT_UNCERTAIN');
  assert.equal(h.payment.status,'refund_pending');
  assert.equal(h.payment.metadata.refund_request.result,'uncertain');
  assert.ok(h.records.reservation_payment_events.some(event=>event.event_type==='payment_refund_uncertain'));
  assert.equal((await h.send()).status,409);assert.equal(h.refunds(),1);
});

test('a definite provider validation rejection restores only the owned claim',async()=>{
  const h=harness({providerError:new AsaasApiError('invalid refund amount',400)});
  assert.equal((await h.send()).status,400);
  assert.equal(h.payment.status,'paid');
  assert.equal(h.payment.metadata.refund_request.result,'rejected');
  assert.ok(h.records.reservation_payment_events.some(event=>event.event_type==='payment_refund_rejected'));
});

test('a concurrent webhook cannot be overwritten by refund rejection cleanup',async()=>{
  const h=harness({providerError:new AsaasApiError('invalid refund amount',400),webhookBeforeError:true});
  assert.equal((await h.send()).status,400);
  assert.equal(h.payment.status,'refunded');assert.equal(h.payment.asaas_status,'REFUNDED');
});

test('ambiguous HTTP failures retain the claim instead of authorizing another refund',async()=>{
  for(const status of[408,409,429,500]){
    const h=harness({providerError:new AsaasApiError('provider result unavailable',status)});
    assert.equal((await h.send()).status,502,`${status}`);
    assert.equal(h.payment.status,'refund_pending',`${status}`);
    assert.equal((await h.send()).status,409,`${status}`);
    assert.equal(h.refunds(),1,`${status}`);
  }
});

test('claim failure and installment guard both stop before any refund submission',async()=>{
  const failed=harness({claimError:true});
  assert.equal((await failed.send()).status,500);assert.equal(failed.refunds(),0);
  const installment=harness({installment:true});
  assert.equal((await installment.send()).status,409);assert.equal(installment.refunds(),0);assert.equal(installment.claims(),0);
});

test('invalid partial amounts are never silently converted into a full refund',async()=>{
  for(const value of[0,-1,NaN,Infinity,null,'10',30.01,1.001]){
    const h=harness();
    assert.equal((await h.send({value})).status,400,`${value}`);
    assert.equal(h.refunds(),0,`${value}`);assert.equal(h.reads(),0,`${value}`);assert.equal(h.claims(),0,`${value}`);
  }
});

test('omitting the amount still allows the explicitly requested full refund',async()=>{
  const h=harness();
  assert.equal((await h.send({value:undefined})).status,200);
  assert.equal(h.refunds(),1);
  assert.equal(h.payment.metadata.refund_request.value,null);
});
