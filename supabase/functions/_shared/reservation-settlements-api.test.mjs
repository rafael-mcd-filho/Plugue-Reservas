// Offline authorization and provider-free payout boundary regressions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const withdrawalId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const receiptId = '66666666-6666-4666-8666-666666666666';
const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%%EOF');
const destination = { kind: 'pix', holder_name: 'Empresa A', holder_document: '12345678909', pix_key_type: 'email', pix_key: 'financeiro@example.test' };

function load(file, dependencies, deno = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, Headers, Blob, Uint8Array, atob, crypto: globalThis.crypto, console,
  })(exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, deno);
  return exports;
}

function context({ role = 'admin', companyId = companyA, support = false, impersonation = null, database = {} } = {}) {
  return { supabaseAdmin: database, actorUser: { id: actorId }, user: { id: actorId },
    actorRoleRows: [{ role, company_id: companyId }], isSupport: support, impersonation };
}
function helpers(auth = context()) {
  return load('./reservation-settlements-api.ts', { './internal-auth.ts': { getRequestAuthContext: async () => auth } });
}
function harness({ role = 'admin', support = false, impersonation = null, authenticated = true, rowCompany = companyA,
  status = 'requested', hasReceipt = true, rpcError = null, handledBy = actorId } = {}) {
  const calls = [];
  const uploads = [];
  const row = { id: withdrawalId, company_id: rowCompany, status, amount_cents: 50000,
    handled_by: handledBy,
    created_at: '2026-11-01T12:00:00.000Z', receipt_path: `${rowCompany}/${withdrawalId}/${receiptId}.pdf` };
  const summary = { company_id: companyA, available_cents: 180000, provider_cost_cents: 6000, terms: null,
    ledger: [], withdrawals: [], destination: null };
  const database = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: name === 'get_reservation_settlement_summary' ? summary : { ...row, ...args }, error: rpcError ? (typeof rpcError === 'string' ? { message: rpcError } : rpcError) : null };
    },
    from(table) {
      const filters = [];
      const builder = {
        select: () => builder, eq: (key, value) => { filters.push([key, value]); return builder; },
        order: () => builder, range: () => builder, in: () => builder,
        maybeSingle: () => builder,
        then(resolve, reject) {
          calls.push({ table, filters });
          const rows = table === 'reservation_withdrawals' ? [row]
            : table === 'reservation_settlement_ledger' ? [{ id: 'entry', company_id: companyA, provider_cost_delta_cents: 6000, available_delta_cents: 180000, metadata: { internal: true } }]
            : table === 'companies' ? [{ id: companyA, name: 'Empresa A' }] : [];
          const filtered = rows.filter(item => filters.every(([key, value]) => item[key] === value));
          const data = filters.some(([key]) => key === 'id') ? filtered[0] ?? null : filtered;
          return Promise.resolve({ data, error: null, count: filtered.length }).then(resolve, reject);
        },
      };
      return builder;
    },
    storage: { from(bucket) {
      assert.equal(bucket, 'reservation-payout-receipts');
      return {
        async upload(path, bytes, options) { uploads.push({ path, bytes, options }); return { data: { path }, error: null }; },
        async download(path) { calls.push({ download: path }); return hasReceipt ? { data: new Blob([pdfBytes], { type: 'application/pdf' }), error: null } : { data: null, error: { message: 'missing' } }; },
        async createSignedUrl(path, expiresIn) { calls.push({ signed: path, expiresIn }); return { data: { signedUrl: 'https://private.invalid/signed' }, error: null }; },
      };
    } },
  };
  const api = helpers(authenticated ? context({ role, support, impersonation, database }) : null);
  let handler;
  load('../manage-reservation-settlements/index.ts', {
    '../_shared/reservation-settlements-api.ts': api,
    '../_shared/reservation-payments.ts': { corsHeaders: {}, jsonResponse: (body, status = 200) => new Response(JSON.stringify(body), { status }) },
  }, { serve: fn => { handler = fn; } });
  return { calls, uploads, row, request: body => handler(new Request('https://offline.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })) };
}

test('withdrawal amounts retain exact cents and reject rounding, exponent, missing, zero and negative inputs', () => {
  const api = helpers();
  assert.equal(api.parseWithdrawalCents('1800.01'), 180001);
  assert.equal(api.parseWithdrawalCents('1.2'), 120);
  for (const amount of [null, undefined, 0, -1, '', '0.00', '-1', '1e3', '1,20', '1.001', Infinity, NaN, {}, true, '999999999999999999999']) {
    assert.throws(() => api.parseWithdrawalCents(amount), /valor|Valor/);
  }
});

test('destination validation normalizes only supported Pix and bank fields', () => {
  const api = helpers();
  const saved = api.validatePayoutDestination({ ...destination, company_id: companyB, malicious: true });
  assert.equal(saved.company_id, undefined);
  assert.equal(saved.malicious, undefined);
  assert.equal(saved.pix_key, destination.pix_key);
  for (const invalid of [{ ...destination, kind: 'cash' }, { ...destination, pix_key: 'invalid' }, { ...destination, holder_document: '' }, { ...destination, pix_key_type: 'random', pix_key: '../file' }]) {
    assert.throws(() => api.validatePayoutDestination(invalid));
  }
});

test('financial timestamps require an explicit timezone and a real calendar date', () => {
  const api = helpers();
  assert.equal(api.requireIsoDate('2028-02-29T09:30:00-03:00', 'Data'), '2028-02-29T12:30:00.000Z');
  for (const invalid of ['2026-02-29T12:00:00Z', '2026-02-31T12:00:00Z', '2026-04-31T12:00:00Z',
    '2026-11-08T12:00:00', '2026-11-08', '2026-11-08T24:00:00Z', '2026-11-08T12:00:00+14:30', '2026-11-08T12:00:00+15:00']) {
    assert.throws(() => api.requireIsoDate(invalid, 'Data'), /inválida/);
  }
});

test('real actor authorization denies operator, other tenant, support and impersonation', async () => {
  const req = new Request('https://offline.invalid');
  for (const auth of [context({ role: 'operator' }), context({ companyId: companyB }), context({ support: true }), context({ impersonation: { companyId: companyA } })]) {
    await assert.rejects(helpers(auth).assertSettlementAccess(req, companyA), error => error.status === 403);
  }
  await assert.rejects(helpers(null).assertSettlementAccess(req, companyA), error => error.status === 401);
  assert.equal((await helpers(context({ role: 'superadmin' })).assertSettlementAccess(req, companyB, true)).isSuperadmin, true);
});

test('cross-tenant requests and support cannot reserve funds or read bank data', async () => {
  for (const setup of [{}, { role: 'operator' }, { support: true }, { impersonation: { companyId: companyA } }]) {
    const api = harness(setup);
    const response = await api.request({ action: 'overview', company_id: setup.role || setup.support || setup.impersonation ? companyA : companyB });
    assert.equal(response.status, 403);
    assert.equal(api.calls.length, 0);
  }
});

test('only a real superadmin may alter terms or process a payout', async () => {
  const api = harness();
  for (const action of ['save_terms', 'transition_withdrawal', 'upload_receipt', 'admin_overview']) {
    assert.equal((await api.request({ action, company_id: companyA })).status, 403);
  }
  assert.equal(api.calls.length, 0);
});

test('method fee terms validate each rate and retain the real administrator identity', async () => {
  const api = harness({ role: 'superadmin' });
  const input = { action: 'save_terms', company_id: companyA, pix_fee_bps: 0, credit_card_fee_bps: 10000,
    release_policy: 'after_reservation', hold_days: 0, effective_at: null, enabled: true, actor_id: 'attacker' };
  assert.equal((await api.request(input)).status, 200);
  const call = api.calls.find(call => call.name === 'save_reservation_settlement_method_terms');
  assert.equal(call.args._pix_fee_bps, 0);
  assert.equal(call.args._credit_card_fee_bps, 10000);
  assert.equal(call.args._actor_id, actorId);
  assert.equal(call.args._fee_bps, undefined);
  for (const invalid of [{ pix_fee_bps: null }, { credit_card_fee_bps: undefined }, { pix_fee_bps: -1 },
    { credit_card_fee_bps: 10001 }, { pix_fee_bps: 1.5 }, { credit_card_fee_bps: '200' }]) {
    const bad = harness({ role: 'superadmin' });
    assert.equal((await bad.request({ ...input, ...invalid })).status, 400);
    assert.equal(bad.calls.length, 0, 'malformed method rates cannot reach an RPC');
  }
  const legacy = harness({ role: 'superadmin' });
  const { pix_fee_bps, credit_card_fee_bps, ...rest } = input;
  assert.equal((await legacy.request({ ...rest, fee_bps: 800 })).status, 200);
  assert.equal(legacy.calls.find(call => call.name === 'save_reservation_settlement_terms').args._fee_bps, 800);
});

test('request uses server-checked tenant and actor, exact cents and caller idempotency key', async () => {
  const api = harness();
  const response = await api.request({ action: 'request_withdrawal', company_id: companyA, amount: '500.01', idempotency_key: requestId, actor_id: 'attacker' });
  assert.equal(response.status, 200);
  const call = api.calls.find(call => call.name === 'request_reservation_withdrawal');
  assert.equal(call.args._amount_cents, 50001);
  assert.equal(call.args._company_id, companyA);
  assert.equal(call.args._actor_id, actorId);
  assert.equal(call.args._idempotency_key, requestId);
});

test('invalid withdrawal amount fails before touching the ledger', async () => {
  const api = harness();
  const response = await api.request({ action: 'request_withdrawal', company_id: companyA, amount: '0', idempotency_key: requestId });
  assert.equal(response.status, 400);
  assert.equal(api.calls.length, 0);
});

test('company overview never leaks platform processor costs or internal ledger metadata', async () => {
  const api = harness();
  const response = await api.request({ action: 'overview', company_id: companyA });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider_cost_cents, undefined);
  assert.equal(body.ledger[0].provider_cost_delta_cents, undefined);
  assert.equal(body.ledger[0].metadata, undefined);
  assert.equal(body.ledger[0].available_delta_cents, 180000);
});

test('receipt upload is private, immutable, scoped and validates actual file content', async () => {
  const api = harness({ role: 'superadmin', status: 'processing' });
  const input = { action: 'upload_receipt', withdrawal_id: withdrawalId, mime_type: 'application/pdf', content_base64: Buffer.from(pdfBytes).toString('base64') };
  assert.equal((await api.request({ ...input, content_base64: Buffer.from('<script>invalid</script>').toString('base64') })).status, 400);
  assert.equal(api.uploads.length, 0);
  const response = await api.request(input);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.receipt_path.startsWith(`${companyA}/${withdrawalId}/`));
  assert.equal(api.uploads[0].options.upsert, false);
  assert.equal(api.uploads[0].options.contentType, 'application/pdf');
});

test('receipt upload is not accepted before payout processing starts', async () => {
  const api = harness({ role: 'superadmin' });
  const response = await api.request({ action: 'upload_receipt', withdrawal_id: withdrawalId, mime_type: 'application/pdf', content_base64: Buffer.from(pdfBytes).toString('base64') });
  assert.equal(response.status, 409);
  assert.equal(api.uploads.length, 0);
});

test('another administrator cannot attach a proof or complete the claimed payout', async () => {
  const api = harness({ role: 'superadmin', status: 'processing', handledBy: requestId });
  assert.equal((await api.request({ action: 'upload_receipt', withdrawal_id: withdrawalId, mime_type: 'application/pdf', content_base64: Buffer.from(pdfBytes).toString('base64') })).status, 409);
  assert.equal((await api.request({ action: 'transition_withdrawal', withdrawal_id: withdrawalId, status: 'paid' })).status, 409);
  assert.equal(api.uploads.length, 0);
  assert.equal(api.calls.some(call => call.name === 'transition_reservation_withdrawal'), false);
});

test('completing payout requires a real uploaded proof bound to this company and request', async () => {
  const input = { action: 'transition_withdrawal', withdrawal_id: withdrawalId, status: 'paid', receipt_path: `${companyA}/${withdrawalId}/${receiptId}.pdf`, bank_reference: 'E2E-transfer-123', paid_at: '2026-11-02T12:00:00.000Z' };
  const missing = harness({ role: 'superadmin', status: 'processing', hasReceipt: false });
  assert.equal((await missing.request(input)).status, 400);
  assert.equal(missing.calls.some(call => call.name === 'transition_reservation_withdrawal'), false);
  const wrong = harness({ role: 'superadmin', status: 'processing' });
  assert.equal((await wrong.request({ ...input, receipt_path: `${companyB}/${withdrawalId}/${receiptId}.pdf` })).status, 400);
  assert.equal(wrong.calls.some(call => call.download), false);
  const valid = harness({ role: 'superadmin', status: 'processing' });
  assert.equal((await valid.request(input)).status, 200);
  const transition = valid.calls.find(call => call.name === 'transition_reservation_withdrawal');
  assert.equal(transition.args._receipt_path, input.receipt_path);
  assert.equal(transition.args._bank_reference, input.bank_reference);
  assert.equal(transition.args._actor_id, actorId);
});

test('other-company receipt is never signed and paid receipt URL is short-lived', async () => {
  const wrong = harness({ rowCompany: companyB, status: 'paid' });
  assert.equal((await wrong.request({ action: 'download_receipt', company_id: companyA, withdrawal_id: withdrawalId })).status, 404);
  assert.equal(wrong.calls.some(call => call.signed), false);
  const valid = harness({ status: 'paid' });
  assert.equal((await valid.request({ action: 'download_receipt', company_id: companyA, withdrawal_id: withdrawalId })).status, 200);
  assert.equal(valid.calls.find(call => call.signed).expiresIn, 60);
});

test('reusing a bank transfer reference is a conflict without leaking database details', async () => {
  const api = harness({ role: 'superadmin', status: 'processing', rpcError: { code: '23505', message: 'duplicate key value violates unique constraint "reservation_withdrawals_paid_reference"' } });
  const response = await api.request({ action: 'transition_withdrawal', withdrawal_id: withdrawalId, status: 'paid', receipt_path: `${companyA}/${withdrawalId}/${receiptId}.pdf`, bank_reference: 'E2E-transfer-123', paid_at: '2026-11-02T12:00:00.000Z' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'Esta transferência já foi registrada em outro saque.');
});
