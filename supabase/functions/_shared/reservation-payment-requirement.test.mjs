// Offline boundaries only: no database, provider or credentials are contacted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, modules, deno = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, crypto: globalThis.crypto, console,
  })(exports, (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  }, { env: { get: () => undefined }, ...deno });
  return exports;
}
const payments = load('./reservation-payments.ts', {});
const requirements = load('./reservation-payment-requirement.ts', {});
const date = '2026-12-01';
const companyId = 'company-one';
const reservation = {
  id: 'reservation-one', guest_name: 'Cliente', guest_phone: '+5511999999999',
  date, time: '19:00', party_size: 3, public_tracking_code: 'tracking-one',
};
const rule = {
  id: 'private-rule-id', amount_type: 'per_person', base_amount: 25,
  pix_enabled: true, pix_amount: 23, payment_deadline_minutes: 12,
  customer_notice: 'Internal test notice', cancellation_policy: 'Internal test policy',
};
const config = { status: 'configured', provider_account_id: 'private-wallet', api_environment: 'sandbox' };

function harness(options = {}) {
  const state = { feature: true, rule, config, ...options };
  const writes = [];
  const reads = [];
  let configReads = 0;
  let handler;
  const admin = {
    async rpc(name, args) {
      reads.push({ name, args });
      if (name === 'company_feature_enabled') return { data: state.feature, error: null };
      assert.equal(name, 'create_public_reservation');
      writes.push({ table: 'reservations', operation: 'rpc', status: args._status });
      return { data: { ...reservation, ...args._reservation }, error: null };
    },
    from(table) {
      let operation = 'select';
      let patch;
      let selected;
      const filters = [];
      const builder = {
        select: value => { selected = value; return builder; }, eq: (...args) => { filters.push(['eq', ...args]); return builder; },
        is: (...args) => { filters.push(['is', ...args]); return builder; },
        lte: (...args) => { filters.push(['lte', ...args]); return builder; },
        gte: (...args) => { filters.push(['gte', ...args]); return builder; },
        order: () => builder, limit: () => builder, maybeSingle: () => builder, single: () => builder,
        insert: value => { operation = 'insert'; patch = value; return builder; },
        update: value => { operation = 'update'; patch = value; return builder; },
        then(resolve) {
          reads.push({ table, operation, selected, filters });
          if (operation !== 'select') writes.push({ table, operation, patch });
          let data = null;
          if (table === 'reservation_payment_rules') data = state.rule;
          if (table === 'reservation_payments') data = { id: 'payment-one', ...patch };
          return Promise.resolve({ data, error: table === 'reservation_payment_rules' ? state.ruleError ?? null : null }).then(resolve);
        },
      };
      return builder;
    },
  };
  load('../create-reservation-payment/index.ts', {
    '../_shared/phone.ts': { normalizePhoneE164: value => value },
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => admin },
    '../_shared/reservation-asaas-config.ts': { getGlobalReservationAsaasConfig: async () => { configReads += 1; return state.config; } },
    '../_shared/reservation-payments.ts': payments,
    '../_shared/reservation-payment-requirement.ts': requirements,
  }, { serve: fn => { handler = fn; } });
  const request = body => handler(new Request('https://offline.invalid', { method: 'POST', body: JSON.stringify(body) }));
  return { state, reads, writes, configReads: () => configReads, request,
    preview: extra => request({ action: 'preview', company_id: companyId, date, ...extra }) };
}

test('CTA preview uses company/date only and returns a versioned boolean without rule data or writes', async () => {
  const context = harness({ config: null });
  const response = await context.preview();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schema: 'reservation-payment-requirement', version: 1, company_id: companyId, date, requires_payment: true,
  });
  assert.equal(context.configReads(), 0);
  assert.equal(context.writes.length, 0);
  const selection = context.reads.find(row => row.table === 'reservation_payment_rules');
  assert.equal(selection.selected, 'id');
  assert.ok(selection.filters.some(([op, key, value]) => op === 'eq' && key === 'company_id' && value === companyId));
  assert.ok(selection.filters.some(([op, key, value]) => op === 'lte' && key === 'date_start' && value === date));
  assert.ok(selection.filters.some(([op, key, value]) => op === 'gte' && key === 'date_end' && value === date));
});

test('feature-disabled and no-rule previews return false without creating a reservation', async () => {
  for (const [options, reason] of [[{ feature: false }, 'feature_disabled'], [{ rule: null }, 'no_rule']]) {
    const context = harness(options);
    const response = await context.preview({ complete_without_payment: true });
    assert.deepEqual(await response.json(), {
      schema: 'reservation-payment-requirement', version: 1, company_id: companyId, date, requires_payment: false, reason,
    });
    assert.equal(context.configReads(), 0);
    assert.equal(context.writes.length, 0);
  }
});

test('invalid and impossible preview dates fail before database reads', async () => {
  for (const invalidDate of ['', '2026-2-01', '2026-02-30', '2026-13-01', null, '2026-12-01T00:00:00Z']) {
    const context = harness();
    const response = await context.preview({ date: invalidDate });
    assert.equal(response.status, 400);
    assert.equal(context.reads.length, 0);
    assert.equal(context.writes.length, 0);
  }
  assert.equal(requirements.isPaymentRequirementDate('2028-02-29'), true);
});

test('a failed rule read stays an error instead of claiming no payment', async () => {
  const context = harness({ rule: null, ruleError: { message: 'Fictitious lookup failure' } });
  assert.equal((await context.preview()).status, 500);
  assert.equal(context.configReads(), 0);
  assert.equal(context.writes.length, 0);
});

test('creation still checks payment readiness and preserves authoritative amounts', async () => {
  const unavailable = harness({ config: null });
  assert.equal((await unavailable.request({ company_id: companyId, reservation })).status, 409);
  assert.equal(unavailable.writes.length, 0);
  const context = harness();
  assert.equal((await context.request({ company_id: companyId, reservation })).status, 200);
  const created = context.writes.find(row => row.table === 'reservation_payments');
  assert.equal(created.patch.base_amount, 75);
  assert.equal(created.patch.rule_snapshot.pix_amount_total, 69);
});

test('legacy dry-run and non-payment completion retain their existing contracts', async () => {
  const context = harness();
  const response = await context.request({ company_id: companyId, reservation, dry_run: true });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.dry_run, true);
  assert.equal(body.requires_payment, true);
  assert.equal(body.schema, undefined);
  assert.equal(context.writes.length, 0);
  const free = harness({ feature: false });
  assert.equal((await free.request({ company_id: companyId, reservation, complete_without_payment: true })).status, 200);
  assert.deepEqual(free.writes, [{ table: 'reservations', operation: 'rpc', status: 'confirmed' }]);
});
