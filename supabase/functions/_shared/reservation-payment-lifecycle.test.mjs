// Offline lifecycle regression tests. No provider credentials or network calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
class AsaasApiError extends Error {
  constructor(message,status) { super(message);this.status=status; }
}

function evaluate(file, modules, deno = { env: { get: () => undefined } }) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, console,
  })(exports, name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  }, deno);
  return exports;
}

function database(records, failures = {}) {
  return { from(table) {
    let action = 'select'; let input; let single = false;
    const filters = [];
    const query = {
      select: () => query,
      eq: (key, value) => { filters.push(row => row[key] === value); return query; },
      is: (key, value) => { filters.push(row => (row[key] ?? null) === value); return query; },
      in: (key, values) => { filters.push(row => values.includes(row[key])); return query; },
      lte: (key,value) => { filters.push(row => row[key]<=value); return query; },
      or: () => query,
      order: () => query,
      limit: () => query,
      update: value => { action = 'update'; input = value; return query; },
      insert: value => { action = 'insert'; input = value; return query; },
      single: () => { single = true; return query; },
      maybeSingle: () => { single = true; return query; },
      then(resolve) {
        const key = `${table}:${action}`;
        if (failures[key]) return Promise.resolve({ error: { message: failures[key] }, data: null }).then(resolve);
        records[table] ??= [];
        let rows = records[table].filter(row => filters.every(filter => filter(row)));
        if (action === 'insert') {
          if (table === 'asaas_webhook_events' && records[table].some(row => row.event_id === input.event_id)) {
            return Promise.resolve({ error: { message: 'duplicate key', code: '23505' }, data: null }).then(resolve);
          }
          const row = { id: `generated-${records[table].length}`, created_at: new Date().toISOString(), ...input };
          records[table].push(row); rows = [row];
        } else if (action === 'update') {
          rows.forEach(row => Object.assign(row, input));
        }
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
      },
    };
    return query;
  } };
}

function webhookHarness({ previous, payment = true, confirmError = false, platform = false, providerPayment,
  eventType = 'PAYMENT_RECEIVED',centralConfig=false,providerLookup,lookupError,settlementError=false } = {}) {
  const records = {
    reservation_payments: payment ? [{ id: 'local-payment', company_id: companyId, reservation_id: 'reservation',
      asaas_payment_id: 'pay_1',asaas_payment_link_id:'link_1', status: 'pending', metadata: platform ? { asaas_account_scope: 'platform',
        asaas_account_id: 'account-central', asaas_environment: 'production' } : {} }] : [],
    asaas_webhook_events: previous ? [{ id: 'event-row', event_id: 'evt_1', company_id: companyId,
      processing_started_at: null, created_at: '2026-01-01T00:00:00Z', ...previous }] : [],
    platform_reservation_asaas_config: platform||centralConfig ? [{ status: 'error', provider_account_id: 'account-central',
      api_environment: 'production', api_token_encrypted: 'ciphertext', webhook_auth_token: 'central-token' }] : [],
    company_asaas_configs: [{ company_id: companyId, webhook_auth_token: 'tenant-token' }],
  };
  const admin = database(records);
  let handler; let confirmations = 0; let outcomes = 0;let providerReads=0;
  admin.rpc = async (name,args) => {
    const row = records.reservation_payments[0];
    if (name==='record_reservation_installment_snapshot') {
      row.metadata = { ...row.metadata,asaas_installment_id:args._installment_id,needs_manual_installment_reconciliation:true };
      return { data:row,error:null };
    }
    assert.equal(name,'apply_reservation_payment_outcome'); outcomes++;
    return { data:row,error:null };
  };
  const shared = evaluate('./reservation-payments.ts', {});
  evaluate('../asaas-webhook/index.ts', {
    '../_shared/reservation-settlement-sync.ts': { synchronizeReservationSettlement: async () => {
      if (settlementError) throw new Error('financial synchronization failed');
    } },
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => admin },
    '../_shared/reservation-asaas-config.ts':{getGlobalReservationAsaasConfig:async()=>({
      ...records.platform_reservation_asaas_config[0],credentials:{apiToken:'central-offline',environment:'production'},
    })},
    '../_shared/asaas.ts': {
      AsaasApiError,getAsaasPayment:async(credentials,id)=>{
        providerReads++;
        assert.equal(credentials.apiToken,'central-offline');
        if(lookupError)throw lookupError;
        return providerLookup??{id,status:'RECEIVED'};
      },
      getAsaasExternalPaymentOutcome: (_event,status) => status==='REFUNDED' ? 'refunded' : null, isAsaasPaidStatus: status => status === 'RECEIVED',
      isAsaasPaymentApprovalEvent: event=>event==='PAYMENT_RECEIVED'||event==='PAYMENT_CONFIRMED',
      getAsaasActiveChargebackStatus: () => null,getAsaasRefundedValue: () => null,
    },
    '../_shared/reservation-payments.ts': { ...shared, confirmReservationPayment: async () => {
      confirmations++;
      if (confirmError) throw new Error('database confirmation failed');
    } },
  }, { env: { get: () => undefined }, serve: fn => { handler = fn; } });
  return { records, confirmations: () => confirmations,outcomes:() => outcomes,providerReads:()=>providerReads,
    send: (token = platform ? 'central-token' : 'tenant-token',scope='') => handler(new Request(
    `https://offline.invalid/asaas-webhook?company_id=${companyId}${scope?'&scope='+scope:''}`, {
      method: 'POST', headers: { 'asaas-access-token': token },
      body: JSON.stringify({ id: 'evt_1', event:eventType, payment: providerPayment ?? { id: 'pay_1', status: 'RECEIVED' } }),
    },
  )) };
}

test('webhook retries a failed event instead of acknowledging it as processed', async () => {
  const harness = webhookHarness({ previous: { processing_status: 'failed' } });
  assert.equal((await harness.send()).status, 200);
  assert.equal(harness.confirmations(), 1);
  assert.equal(harness.records.asaas_webhook_events[0].processing_status, 'processed');
});

test('webhook remains retryable when financial synchronization fails after booking confirmation', async () => {
  const harness = webhookHarness({ settlementError: true });
  assert.equal((await harness.send()).status, 500);
  assert.equal(harness.records.asaas_webhook_events[0].processing_status, 'failed');
  assert.match(harness.records.asaas_webhook_events[0].error_details, /financial synchronization/);
});

test('a previously ignored event can be retried after its local payment exists', async () => {
  const harness = webhookHarness({ previous: { processing_status: 'ignored' } });
  assert.equal((await harness.send()).status, 200);
  assert.equal(harness.confirmations(), 1);
});

test('already processed events are acknowledged without another confirmation', async () => {
  const harness = webhookHarness({ previous: { processing_status: 'processed' } });
  assert.equal((await harness.send()).status, 200);
  assert.equal(harness.confirmations(), 0);
});

test('an in-flight webhook is retried later and an abandoned lease can be reclaimed', async () => {
  const active = webhookHarness({ previous: { processing_status: 'received', processing_started_at: new Date().toISOString() } });
  assert.equal((await active.send()).status, 503);
  assert.equal(active.confirmations(), 0);
  const abandoned = webhookHarness({ previous: { processing_status: 'received', processing_started_at: '2026-01-01T00:00:00Z' } });
  assert.equal((await abandoned.send()).status, 200);
  assert.equal(abandoned.confirmations(), 1);
});

test('confirmation failure is returned to the provider and recorded for retry', async () => {
  const harness = webhookHarness({ confirmError: true });
  assert.equal((await harness.send()).status, 500);
  assert.equal(harness.records.asaas_webhook_events[0].processing_status, 'failed');
});

test('the old webhook acknowledges central charges using a valid legacy token without mutating them', async () => {
  const harness = webhookHarness({ platform: true });
  const response=await harness.send('tenant-token');
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.ignored,true);assert.equal(result.reason,'legacy_webhook_for_central_payment');
  assert.equal(harness.confirmations(),0);assert.equal(harness.records.asaas_webhook_events.length,0);
  assert.equal((await harness.send('invalid-legacy-token')).status,401);
  assert.equal((await harness.send('central-token')).status, 200);
});

test('a central-account token cannot mutate a legacy charge belonging to another account', async () => {
  const legacy = webhookHarness({centralConfig:true,lookupError:new AsaasApiError('not found',404)});
  const ignored=await legacy.send('central-token','platform');
  assert.equal(ignored.status,200);
  assert.equal((await ignored.json()).ignored,true);
  assert.equal(legacy.confirmations(),0);
  assert.equal(legacy.records.asaas_webhook_events.length,0);
  assert.equal(legacy.records.reservation_payments[0].status,'pending');
  const changedAccount = webhookHarness({ platform:true });
  changedAccount.records.platform_reservation_asaas_config[0].provider_account_id = 'another-account';
  assert.equal((await changedAccount.send('central-token')).status, 401);
});

test('central webhook verifies and processes legacy receipts in its own account without migrating their scope',async()=>{
  const legacy=webhookHarness({centralConfig:true,providerLookup:{id:'pay_1',status:'RECEIVED'}});
  assert.equal((await legacy.send('central-token','platform')).status,200);
  assert.equal(legacy.providerReads(),1);assert.equal(legacy.confirmations(),1);
  assert.equal(Object.hasOwn(legacy.records.reservation_payments[0].metadata,'asaas_account_scope'),false);
});

test('legacy payment-link and external-reference bindings are verified against the central provider snapshot',async()=>{
  for(const binding of['paymentLink','externalReference']){
    const legacy=webhookHarness({centralConfig:true,providerPayment:{id:'pay_new',paymentLink:'link_1',status:'RECEIVED'},
      providerLookup:{id:'pay_new',status:'RECEIVED',...(binding==='paymentLink'?{paymentLink:'link_1'}:{externalReference:'ref_1'})}});
    legacy.records.reservation_payments[0].payment_link_external_reference='ref_1';
    assert.equal((await legacy.send('central-token','platform')).status,200,binding);
    assert.equal(legacy.confirmations(),1,binding);
    assert.equal(legacy.records.reservation_payments[0].asaas_payment_id,'pay_1',binding);
  }
  const mismatch=webhookHarness({centralConfig:true,providerPayment:{id:'pay_new',paymentLink:'link_1',status:'RECEIVED'},
    providerLookup:{id:'pay_new',status:'RECEIVED',paymentLink:'different-link',externalReference:'different-ref'}});
  const response=await mismatch.send('central-token','platform');
  assert.equal(response.status,200);assert.equal((await response.json()).ignored,true);
  assert.equal(mismatch.confirmations(),0);assert.equal(mismatch.records.asaas_webhook_events.length,0);
});

test('transient account verification failures are retried rather than acknowledged or applied',async()=>{
  const legacy=webhookHarness({centralConfig:true,lookupError:new AsaasApiError('provider unavailable',503)});
  assert.equal((await legacy.send('central-token','platform')).status,500);
  assert.equal(legacy.confirmations(),0);assert.equal(legacy.records.asaas_webhook_events.length,0);
});

test('account-verified legacy events apply the current snapshot rather than a stale approval event',async()=>{
  const legacy=webhookHarness({centralConfig:true,providerLookup:{id:'pay_1',status:'PENDING'}});
  assert.equal((await legacy.send('central-token','platform')).status,200);
  assert.equal(legacy.confirmations(),0);assert.equal(legacy.outcomes(),0);
});

test('the dedicated central webhook rejects a company legacy token',async()=>{
  for(const platform of[false,true]){
    const legacy=webhookHarness({centralConfig:true,platform});
    assert.equal((await legacy.send('tenant-token','platform')).status,401);
    assert.equal(legacy.providerReads(),0);assert.equal(legacy.confirmations(),0);
    assert.equal(legacy.records.asaas_webhook_events.length,0);
  }
});

test('an installment event preserves the first canonical payment ID and does not refund the whole reservation',async () => {
  const harness=webhookHarness({ eventType:'PAYMENT_REFUNDED',providerPayment:{ id:'pay_2',paymentLink:'link_1',
    installment:'installment_1',status:'REFUNDED',value:10 } });
  assert.equal((await harness.send()).status,200);
  assert.equal(harness.records.reservation_payments[0].asaas_payment_id,'pay_1');
  assert.equal(harness.records.reservation_payments[0].status,'pending');
  assert.equal(harness.records.reservation_payments[0].metadata.needs_manual_installment_reconciliation,true);
  assert.equal(harness.outcomes(),0);
  assert.equal(harness.confirmations(),0);
});

test('confirmation propagates transaction errors without sending automation', async () => {
  const shared = evaluate('./reservation-payments.ts', {});
  const admin = database({ reservations: [{ id: 'reservation', company_id: companyId, status: 'pending_payment' }] });
  admin.rpc = async () => ({ error: { message: 'transaction rolled back' } });
  await assert.rejects(shared.confirmReservationPayment(admin, { id: 'payment', company_id: companyId,
    reservation_id: 'reservation', metadata: {} }, 'RECEIVED', 'test'), /transaction rolled back/);
});

test('provider outcome propagates a failed reservation update', async () => {
  const shared = evaluate('./reservation-payments.ts', {});
  const admin = { rpc:async (name,args) => {
    assert.equal(name,'apply_reservation_payment_outcome');
    assert.equal(args._company_id,companyId);
    return { error:{ message:'reservation update failed' } };
  } };
  await assert.rejects(shared.markReservationPaymentProviderOutcome(admin,
    { id: 'payment', company_id: companyId, reservation_id: 'reservation' }, 'refunded',
    { source: 'test', asaasStatus: 'REFUNDED' }), /reservation update failed/);
});

test('scheduled reconciliation follows existing charges without consulting active rules and isolates account caches', async () => {
  const metadata = { asaas_account_scope:'platform', asaas_account_id:'account-central', asaas_environment:'production' };
  const records = { reservation_payments: [
    { id:'payment-valid',company_id:companyId,status:'paid',asaas_payment_id:'pay_valid',metadata },
    { id:'payment-other-account',company_id:companyId,status:'paid',asaas_payment_id:'pay_other',
      metadata:{ ...metadata,asaas_account_id:'different-account' } },
  ] };
  const base = database(records); const tables = []; let credentialReads = 0; let handler;
  const admin = { from: table => { tables.push(table); return base.from(table); } };
  const shared = evaluate('./reservation-payments.ts', {});
  class AsaasApiError extends Error {}
  evaluate('../reconcile-reservation-payments/index.ts', {
    '../_shared/reservation-settlement-sync.ts': { synchronizeReservationSettlement: async () => null },
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => admin,isAuthorizedInternalJob: async () => true },
    '../_shared/reservation-asaas-config.ts': { getReservationAsaasCredentials: async (_admin,payment) => {
      credentialReads++;
      if (payment.metadata.asaas_account_id !== 'account-central') throw new Error('A cobrança pertence a outra conta');
      return { apiToken:'offline',environment:'production' };
    } },
    '../_shared/asaas.ts': { AsaasApiError,getAsaasPaymentStatus: async credentials => {
      assert.equal(credentials.environment,'production'); return 'RECEIVED';
    },getAsaasPayment: async () => ({ id:'pay_valid',status:'RECEIVED' }),getAsaasActiveChargebackStatus: () => null,
    getAsaasExternalPaymentOutcome: () => null,getAsaasRefundedValue: () => null,isAsaasPaidStatus: () => true },
    '../_shared/reservation-payments.ts': shared,
  }, { env:{ get:() => undefined },serve:fn => { handler = fn; } });
  const response = await handler(new Request('https://offline.invalid/reconcile', {
    method:'POST',body:JSON.stringify({ delay_ms:0 }),
  }));
  assert.equal(response.status,200);
  const result = await response.json();
  assert.equal(result.summary.checked,1);
  assert.equal(result.summary.failed,1);
  assert.equal(credentialReads,2,'cached credentials must not bypass a different account identity');
  assert.equal(tables.includes('reservation_payment_rules'),false,'archiving a rule must not stop existing charge reconciliation');
});

test('expiration and manual checks never cancel a single installment as if it were the entire booking',async () => {
  for (const endpoint of ['expire-reservation-payments','check-reservation-payment']) {
    const payment={ id:'payment',company_id:companyId,reservation_id:'reservation',payment_token:'token',
      status:'pending',asaas_payment_id:'pay_first',expires_at:new Date(Date.now()-60_000).toISOString(),
      base_amount:30,charged_amount:30,billing_type:'CREDIT_CARD',metadata:{},rule_snapshot:{} };
    const records={ reservation_payments:[payment],reservations:[{ id:'reservation',company_id:companyId,
      guest_name:'Guest',status:'pending_payment',party_size:2 }],companies:[{ id:companyId,name:'Company' }] };
    const admin=database(records); let handler;let cancellations=0;
    admin.rpc=async (name,args) => {
      assert.equal(name,'record_reservation_installment_snapshot');
      payment.metadata={ ...payment.metadata,asaas_installment_id:args._installment_id,needs_manual_installment_reconciliation:true };
      return { data:payment,error:null };
    };
    const shared=evaluate('./reservation-payments.ts',{});
    evaluate(`../${endpoint}/index.ts`,{
      '../_shared/reservation-settlement-sync.ts': { synchronizeReservationSettlement: async () => null },
      '../_shared/internal-auth.ts':{ createSupabaseAdminClient:() => admin,isAuthorizedInternalJob:async () => true },
      '../_shared/reservation-asaas-config.ts':{ getReservationAsaasCredentials:async () => 'offline' },
      '../_shared/asaas.ts':{
        getAsaasPayment:async () => ({ id:'pay_first',status:'PENDING',installment:'installment_1' }),
        getAsaasPaymentStatus:async () => 'PENDING',getAsaasActiveChargebackStatus:() => null,
        getAsaasExternalPaymentOutcome:() => null,isAsaasPaidStatus:() => false,
        deleteAsaasPayment:async () => { cancellations++; },deleteAsaasPaymentLink:async () => { cancellations++; },
      },
      '../_shared/reservation-payments.ts':shared,
    },{ env:{ get:() => undefined },serve:fn => { handler=fn; } });
    const response=await handler(new Request(`https://offline.invalid/${endpoint}`,{
      method:'POST',body:JSON.stringify({ payment_token:'token' }),
    }));
    assert.equal(response.status,200,endpoint);
    assert.equal(cancellations,0,endpoint);
    assert.equal(payment.status,'pending',endpoint);
    assert.equal(payment.metadata.needs_manual_installment_reconciliation,true,endpoint);
    const result=await response.json();
    if (endpoint==='expire-reservation-payments') assert.equal(result.summary.installment_manual_review,1);
    else assert.equal(result.needs_manual_installment_reconciliation,true);
  }
});
