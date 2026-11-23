// Offline tests: provider and database boundaries are fakes; no real charges.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const central = {
  id: true, api_token_encrypted: 'ciphertext', api_environment: 'production',
  provider_account_id: 'wallet-central', webhook_auth_token: 'w'.repeat(64),
  webhook_id: 'hook-central', webhook_email: 'finance@example.test',
  status: 'configured', revision: 'revision-1',
};
const platformPayment = { company_id: 'company-a', metadata: {
  asaas_account_scope: 'platform', asaas_account_id: 'wallet-central', asaas_environment: 'production',
} };
function load(file, dependencies, deno = { env: { get: () => 'https://offline.invalid' } }) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, crypto: globalThis.crypto, console,
  })(exports, (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, deno);
  return exports;
}
function db({ config = central, legacyToken = 'legacy-private-token', historic = false, leaseClaim = true } = {}) {
  const writes = [];
  let current = config ? { ...config } : null;
  return {
    writes,
    get current() { return current; },
    async rpc(name, args) {
      if (name === 'claim_central_reservation_asaas_config') {
        if (leaseClaim) current.provisioning_lease_id = args._lease_id;
        return { data: leaseClaim, error: null };
      }
      assert.equal(name, 'release_central_reservation_asaas_config');
      if (current.provisioning_lease_id === args._lease_id) current.provisioning_lease_id = null;
      return { data: true, error: null };
    },
    from(table) {
      let action = 'select';
      let patch;
      const filters = [];
      const builder = {
        select: () => builder,
        eq: (...filter) => { filters.push(filter); return builder; },
        contains: (...filter) => { filters.push(filter); return builder; },
        limit: () => builder,
        update: (value) => { action = 'update'; patch = value; return builder; },
        insert: (value) => { action = 'insert'; patch = value; return builder; },
        maybeSingle: () => builder,
        then(resolve, reject) {
          if (action !== 'select') writes.push({ table, action, patch, filters });
          if (table === 'platform_reservation_asaas_config') {
            if (action === 'update') current = { ...current, ...patch };
            return Promise.resolve({ data: current, error: null }).then(resolve, reject);
          }
          if (table === 'company_asaas_configs') {
            assert.ok(filters.some(([key, value]) => key === 'company_id' && value === 'company-a'));
            return Promise.resolve({ data: { api_token: legacyToken }, error: null }).then(resolve, reject);
          }
          if (table === 'reservation_payments') return Promise.resolve({ data: historic ? [{ id: 'charge' }] : [], error: null }).then(resolve, reject);
          if (table === 'audit_logs') return Promise.resolve({ error: null }).then(resolve, reject);
          throw new Error(`Unexpected table ${table}`);
        },
      };
      return builder;
    },
  };
}
function helpers({ provider = async () => ({}), decrypt = async () => 'central-private-token' } = {}) {
  return load('./reservation-asaas-config.ts', {
    './asaas.ts': { asaasRequest: provider },
    './platform-billing.ts': { decryptPlatformAsaasToken: decrypt },
  });
}

test('central payments use the central encrypted credential and explicit environment', async () => {
  const credentials = await helpers().getReservationAsaasCredentials(db(), platformPayment);
  assert.equal(credentials.apiToken, 'central-private-token');
  assert.equal(credentials.environment, 'production');
});

test('legacy payments continue using their own company account after central rollout', async () => {
  assert.equal(await helpers().getReservationAsaasCredentials(db(), { company_id: 'company-a' }), 'legacy-private-token');
});

test('account or environment mismatch fails closed', async () => {
  for (const metadata of [
    { ...platformPayment.metadata, asaas_account_id: 'other-wallet' },
    { ...platformPayment.metadata, asaas_environment: 'sandbox' },
    { asaas_account_scope: 'platform' },
  ]) {
    await assert.rejects(helpers().getReservationAsaasCredentials(db(), { ...platformPayment, metadata }), /outra conta ou ambiente/);
  }
});

test('safe config inspection does not decrypt and public output contains no secrets', async () => {
  let decrypted = false;
  const api = helpers({ decrypt: async () => { decrypted = true; throw new Error('must not decrypt'); } });
  const config = await api.getGlobalReservationAsaasConfig(db(), { decryptToken: false });
  const output = JSON.stringify(api.publicGlobalReservationAsaasConfig(config));
  assert.equal(decrypted, false);
  assert.ok(!output.includes('ciphertext'));
  assert.ok(!output.includes(central.webhook_auth_token));
});

test('webhook provisioning updates the same destination instead of creating duplicates', async () => {
  const requests = [];
  const api = helpers({ provider: async (credential, path, init) => {
    requests.push({ credential, path, init });
    if (path === '/webhooks?limit=100') return { data: [
      { id:'legacy-hook',url:'https://offline.invalid/functions/v1/asaas-webhook' },
      { id: 'existing-hook', url: 'https://offline.invalid/functions/v1/asaas-webhook?scope=platform' },
    ] };
    return { id: 'existing-hook' };
  } });
  await api.provisionCentralReservationWebhook('token', central);
  assert.equal(requests[1].path, '/webhooks/existing-hook');
  assert.equal(requests[1].init.method, 'PUT');
  assert.equal(requests[1].init.json.authToken, central.webhook_auth_token);
  assert.equal(requests[1].init.json.sendType, 'SEQUENTIALLY');
  assert.equal(requests[1].init.json.url,'https://offline.invalid/functions/v1/asaas-webhook?scope=platform');
  for (const event of ['PAYMENT_RECEIVED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_DISPUTE']) {
    assert.ok(requests[1].init.json.events.includes(event));
  }
});

test('central provisioning never replaces the token of an existing unscoped legacy webhook',async()=>{
  const requests=[];
  const api=helpers({provider:async(_credentials,path,init)=>{
    requests.push({path,init});
    if(path==='/webhooks?limit=100')return{data:[{id:'legacy-global',url:'https://offline.invalid/functions/v1/asaas-webhook'}]};
    return{id:'new-central'};
  }});
  await api.provisionCentralReservationWebhook('token',central);
  assert.equal(requests[1].path,'/webhooks');
  assert.equal(requests[1].init.method,'POST');
  assert.equal(requests[1].init.json.url,'https://offline.invalid/functions/v1/asaas-webhook?scope=platform');
  assert.equal(requests.some(request=>request.path==='/webhooks/legacy-global'),false);
});

// Provider contract checked against https://docs.asaas.com/docs/webhook-para-cobrancas
// on 2026-11-08. Cash receipts emit PAYMENT_RECEIVED; RECEIVED_IN_CASH is a
// billingType, not a PAYMENT_RECEIVED_IN_CASH webhook event.
const supportedReservationEvents = [
  'PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_REFUND_DENIED',
  'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
];

for (const existingWebhook of [false, true]) {
  test(`webhook ${existingWebhook ? 'update' : 'creation'} submits only supported Asaas events`, async () => {
    const url = 'https://offline.invalid/functions/v1/asaas-webhook?scope=platform';
    let submitted = false;
    const api = helpers({ provider: async (_credentials, path, init) => {
      if (path === '/webhooks?limit=100') {
        return { data: existingWebhook ? [{ id: 'hook-central', url }] : [] };
      }
      assert.equal(init.method, existingWebhook ? 'PUT' : 'POST');
      for (const event of init.json.events) {
        assert.ok(supportedReservationEvents.includes(event), `Asaas rejects unsupported event ${event}`);
      }
      assert.deepEqual([...init.json.events].sort(), [...supportedReservationEvents].sort());
      submitted = true;
      return { id: 'hook-central' };
    } });
    await api.provisionCentralReservationWebhook('token', central);
    assert.equal(submitted, true);
  });
}

test('webhook inspection accepts the documented event contract returned by Asaas', async () => {
  const api = helpers({ provider: async () => ({
    id: 'hook-central', url: 'https://offline.invalid/functions/v1/asaas-webhook?scope=platform',
    enabled: true, interrupted: false, sendType: 'SEQUENTIALLY', events: supportedReservationEvents,
  }) });
  assert.equal((await api.inspectCentralReservationWebhook('token', central)).id, 'hook-central');
});

test('wallet identity must identify exactly one account', async () => {
  assert.equal(await helpers({ provider: async () => ({ data: [{ id: 'wallet-123' }] }) }).getReservationAsaasAccountId('token'), 'wallet-123');
  await assert.rejects(helpers({ provider: async () => ({ data: [] }) }).getReservationAsaasAccountId('token'), /WalletId/);
  await assert.rejects(helpers({ provider: async () => ({ data: [{ id: 'one' }, { id: 'two' }] }) }).getReservationAsaasAccountId('token'), /WalletId/);
});

function handlerHarness({ authorized = true, accountId = 'wallet-central', historic = false, validateError = null, leaseClaim = true } = {}) {
  const database = db({ historic, leaseClaim });
  const calls = [];
  const shared = helpers();
  let handler;
  load('../manage-reservation-asaas-config/index.ts', {
    '../_shared/internal-auth.ts': { assertSuperadmin: async () => {
      if (!authorized) throw new Error('Sem permissao');
      return { supabaseAdmin: database, user: { id: 'superadmin-user' } };
    } },
    '../_shared/asaas.ts': {
      validateAsaasPaymentLinksAccess: async () => { if (validateError) throw new Error(validateError); },
      ensureAsaasAccountSite: async () => true,
    },
    '../_shared/platform-billing.ts': {
      encryptPlatformAsaasToken: async (token) => `encrypted:${token}`,
      safePlatformBillingError: (error) => error.message,
    },
    '../_shared/reservation-asaas-config.ts': {
      ...shared,
      getReservationAsaasAccountId: async () => accountId,
      inspectCentralReservationWebhook: async () => { calls.push('inspect'); },
      provisionCentralReservationWebhook: async () => { calls.push('provision'); return { id: 'managed-hook' }; },
    },
    '../_shared/reservation-payments.ts': {
      corsHeaders: {}, readJson: (req) => req.json(),
      jsonResponse: (body, status = 200) => new Response(JSON.stringify(body), { status }),
    },
  }, { serve: (fn) => { handler = fn; }, env: { get: (key) => key === 'SUPABASE_URL' ? 'https://offline.invalid' : undefined } });
  return { database, calls, request: (body) => handler(new Request('https://offline.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })) };
}

test('company admin cannot access or replace the central configuration', async () => {
  const context = handlerHarness({ authorized: false });
  const response = await context.request({ action: 'save', api_token: 'attacker-token' });
  assert.equal(response.status, 403);
  assert.equal(context.database.writes.length, 0);
  assert.equal(context.calls.length, 0);
});

test('save encrypts the credential and provisions one central webhook without exposing secrets', async () => {
  const context = handlerHarness();
  const response = await context.request({ action: 'save', api_token: 'replacement-secret', webhook_email: 'finance@example.test', environment: 'production' });
  const output = await response.text();
  assert.equal(response.status, 200);
  assert.equal(context.database.current.api_token_encrypted, 'encrypted:replacement-secret');
  assert.deepEqual(context.calls, ['provision']);
  assert.ok(!output.includes('replacement-secret'));
  assert.ok(!output.includes(central.webhook_auth_token));
});

test('changing account with historical central charges is rejected before webhook or credential mutation', async () => {
  const context = handlerHarness({ accountId: 'another-account', historic: true });
  const response = await context.request({ action: 'save', api_token: 'new-account-token', webhook_email: 'finance@example.test' });
  assert.equal(response.status, 409);
  assert.equal(context.database.writes.length, 0);
  assert.equal(context.calls.length, 0);
});

test('a failed candidate validation preserves the saved credential and redacts echoed secrets', async () => {
  const context = handlerHarness({ validateError: 'Rejected test-secret-token' });
  const response = await context.request({ action: 'save', api_token: 'test-secret-token', webhook_email: 'finance@example.test' });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('test-secret-token'));
  assert.equal(context.database.writes.length, 0);
});

test('candidate testing is read-only and does not claim webhook installed', async () => {
  const context = handlerHarness();
  const response = await context.request({ action: 'test', api_token: 'candidate-token' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).candidate_token_valid, true);
  assert.equal(context.calls.length, 0);
  assert.equal(context.database.writes.length, 0);
});

test('a failed validation of the saved token marks the integration unavailable for new charges and redacts the saved token', async () => {
  const context = handlerHarness({ validateError: 'Rejected central-private-token' });
  const response = await context.request({ action: 'test' });
  assert.equal(response.status, 500);
  assert.equal(context.database.current.status, 'error');
  assert.ok(!context.database.current.last_error.includes('central-private-token'));
  assert.ok(!(await response.text()).includes('central-private-token'));
});

test('a simultaneous configuration save is rejected before provisioning another webhook', async () => {
  const context = handlerHarness({ leaseClaim: false });
  const response = await context.request({ action: 'save', api_token: 'replacement-secret', webhook_email: 'finance@example.test' });
  assert.equal(response.status, 409);
  assert.equal(context.calls.length, 0);
  assert.equal(context.database.writes.length, 0);
});
