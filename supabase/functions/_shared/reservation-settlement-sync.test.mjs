import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function harness({ initialized = true, providerError = false, providerId = 'pay_1', rpcError = false } = {}) {
  const calls = [];
  const admin = {
    from(table) {
      assert.equal(table, 'reservation_payment_settlements');
      const filters = [];
      const query = {
        select: () => query, eq: (...filter) => { filters.push(filter); return query; },
        update: patch => { calls.push({ type: 'hold', patch }); return query; },
        then: resolve => Promise.resolve({ error: null }).then(resolve),
        async maybeSingle() {
          calls.push({ type: 'lookup', filters });
          return { data: initialized ? { payment_id: 'local-payment' } : null, error: null };
        },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ type: 'rpc', name, args });
      return { data: { synced: true }, error: rpcError && name === 'sync_reservation_payment_settlement' ? { message: 'ledger unavailable' } : null };
    },
  };
  const modules = {
    './asaas.ts': { getAsaasPayment: async (credential, id) => {
      calls.push({ type: 'provider', id });
      assert.equal(credential.environment, 'production');
      if (providerError) throw new Error('provider unavailable');
      return { id: providerId, status: 'RECEIVED', billingType: 'PIX', value: 2000, netValue: 1940,
        creditDate: '2026-11-08', refunds: [{ status: 'DONE', value: 100 }], customer: 'must-not-copy' };
    } },
    './reservation-asaas-config.ts': { getReservationAsaasCredentials: async () => ({ apiToken: 'secret-never-in-ledger', environment: 'production' }) },
  };
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL('./reservation-settlement-sync.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports,require){${compiled}\n})`, {})(exports, name => modules[name]);
  const payment = { id: 'local-payment', company_id: 'company-a', asaas_payment_id: 'pay_1', metadata: {
    asaas_account_scope: 'platform', asaas_environment: 'production', asaas_account_id: 'central',
  } };
  return { calls, payment, run: override => exports.synchronizeReservationSettlement(admin, override ?? payment, 'test') };
}

test('settlement synchronization excludes legacy, sandbox and unlinked charges', async () => {
  const h = harness();
  for (const payment of [
    { ...h.payment, metadata: {} },
    { ...h.payment, metadata: { ...h.payment.metadata, asaas_environment: 'sandbox' } },
    { ...h.payment, asaas_payment_id: null },
  ]) assert.equal(await h.run(payment), null);
  assert.equal(h.calls.length, 0);
});

test('historical charges without frozen terms are never initialized by reconciliation', async () => {
  const h = harness({ initialized: false });
  assert.equal(await h.run(), null);
  assert.equal(h.calls.filter(call => call.type === 'provider' || call.type === 'rpc').length, 0);
  assert.deepEqual(h.calls[0].filters, [['payment_id', 'local-payment'], ['company_id', 'company-a']]);
});

test('financial snapshot is fetched from the bound account and keeps provider cost separate from merchant entitlement', async () => {
  const h = harness();
  await h.run();
  const call = h.calls.find(call => call.type === 'rpc');
  assert.equal(call.name, 'sync_reservation_payment_settlement');
  assert.equal(call.args._payment_id, 'local-payment');
  assert.equal(call.args._provider_snapshot.value, 2000);
  assert.equal(call.args._provider_snapshot.netValue, 1940);
  assert.equal(call.args._provider_snapshot.creditDate, '2026-11-08');
  assert.equal(call.args._provider_snapshot.refunds[0].value, 100);
  assert.ok(!JSON.stringify(call).includes('secret-never-in-ledger'));
  assert.ok(!JSON.stringify(call).includes('must-not-copy'));
});

test('provider failure, binding mismatch and ledger failure propagate instead of claiming financial synchronization', async () => {
  await assert.rejects(harness({ providerError: true }).run(), /provider unavailable/);
  const mismatch = harness({ providerId: 'pay_other' });
  await assert.rejects(mismatch.run(), /divergente/);
  assert.equal(mismatch.calls.some(call => call.name === 'sync_reservation_payment_settlement'), false);
  assert.ok(mismatch.calls.some(call => call.type === 'hold'));
  assert.ok(mismatch.calls.some(call => call.name === 'refresh_reservation_payment_settlement'));
  await assert.rejects(harness({ rpcError: true }).run(), /ledger unavailable/);
});

function reconciliationHarness({ timestampWriteFails = false } = {}) {
  const calls = [], projections = [
    { payment_id: 'provider-unavailable', company_id: 'company-a' },
    { payment_id: 'confirmed-provider', company_id: 'company-a' },
    { payment_id: 'waiting-provider', company_id: 'company-a' },
  ];
  let handler;
  const admin = {
    from(table) {
      const filters = [];
      let patch = null;
      const query = {
        select: () => query, or: () => query, order: () => query, limit: () => query,
        eq: (key, value) => { filters.push([key, value]); return query; },
        update: value => { patch = value; return query; },
        async maybeSingle() {
          const id = filters.find(([key]) => key === 'id')?.[1];
          assert.equal(table, 'reservation_payments');
          assert.ok(filters.some(([key, value]) => key === 'company_id' && value === 'company-a'));
          return { data: { id, company_id: 'company-a', asaas_payment_id: id === 'waiting-provider' ? null : `pay_${id}` }, error: null };
        },
        then(resolve) {
          assert.equal(table, 'reservation_payment_settlements');
          if (patch) {
            calls.push({ kind: 'timestamp', patch, filters });
            return Promise.resolve({ error: timestampWriteFails ? { message: 'timestamp persistence failed' } : null }).then(resolve);
          }
          return Promise.resolve({ data: projections, error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name) {
      calls.push({ kind: 'rpc', name });
      assert.equal(name, 'release_due_reservation_settlements');
      return { error: null };
    },
  };
  const dependencies = {
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => admin, isAuthorizedInternalJob: async () => true },
    '../_shared/reservation-payments.ts': { corsHeaders: {}, readJson: request => request.json(), jsonResponse: (body, status = 200) => new Response(JSON.stringify(body), { status }) },
    '../_shared/reservation-settlement-sync.ts': { synchronizeReservationSettlement: async (_admin, payment, source) => {
      calls.push({ kind: 'provider', id: payment.id, source });
      if (payment.id === 'provider-unavailable') throw new Error('provider offline');
    } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL('../reconcile-reservation-settlements/index.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports,require,Deno){${compiled}\n})`, { Request, Response, console: { error() {} } })({}, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, { serve: callback => { handler = callback; } });
  return { calls, run: () => handler(new Request('https://offline.invalid/reconcile', { method: 'POST', body: '{}' })) };
}

test('financial reconciliation preserves failed projections, timestamps every checked row and continues other payments', async () => {
  const h = reconciliationHarness(), response = await h.run();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).summary, { checked: 1, waiting: 1, failed: 1 });
  const timestamps = h.calls.filter(call => call.kind === 'timestamp');
  assert.equal(timestamps.length, 3);
  for (const call of timestamps) {
    assert.deepEqual(Object.keys(call.patch), ['last_checked_at']);
    assert.equal(Number.isFinite(Date.parse(call.patch.last_checked_at)), true);
    assert.ok(call.filters.some(([key, value]) => key === 'company_id' && value === 'company-a'));
  }
  assert.equal(h.calls.filter(call => call.kind === 'provider').length, 2);
  assert.equal(h.calls.filter(call => call.kind === 'rpc').length, 1);
});

test('financial reconciliation fails closed before releasing funds when a check timestamp cannot be persisted', async () => {
  const h = reconciliationHarness({ timestampWriteFails: true }), response = await h.run();
  assert.equal(response.status, 500);
  assert.equal(h.calls.filter(call => call.kind === 'timestamp').length, 1);
  assert.equal(h.calls.some(call => call.kind === 'rpc'), false);
});
