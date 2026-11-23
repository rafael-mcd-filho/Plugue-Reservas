// Offline request boundaries. No credentials, network, database or message providers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./waitlist-call-notification-api.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`, { Request, Response, URL, Headers, Error, console })(exports);
const { createWaitlistCallNotificationHandler } = exports;
const companyId = '11111111-1111-4111-8111-111111111111';
const waitlistId = '22222222-2222-4222-8222-222222222222';
const queueId = '33333333-3333-4333-8333-333333333333';
const calledAt = '2026-11-22T18:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const calls = [];
  const wakes = [];
  const tasks = [];
  const snapshot = { company_id: companyId, automation_enabled: true, channel: 'evolution', failures: [{ waitlist_id: waitlistId, called_at: calledAt, can_retry: true }], ...options.snapshot };
  const database = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (options.rpcError) return { data: null, error: { message: 'private provider/database detail' } };
      if (name === 'get_waitlist_call_notification_state') return { data: snapshot, error: null };
      assert.equal(name, 'retry_waitlist_call_notification');
      return { data: { result: 'queued', channel: snapshot.channel, queue_id: queueId, ...options.retry }, error: null };
    },
  };
  const handler = createWaitlistCallNotificationHandler({
    authorize: async (_request, id) => { calls.push({ authorize: id }); if (options.authError) throw new Error(options.authError); return database; },
    wakeQueue: async (db, id, channel, queue) => { assert.equal(db, database); wakes.push({ companyId: id, channel, queueId: queue }); },
    schedule: task => tasks.push(task),
  });
  const request = (body, method = 'POST') => handler(new Request('https://local.example.invalid/functions/v1/waitlist-call-notification', { method, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }));
  return { request, calls, wakes, tasks, snapshot };
}

test('list authorizes before reading only the scoped state and never wakes a sender', async () => {
  const h = harness();
  const response = await h.request({ action: 'list', company_id: companyId });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), h.snapshot);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(plain(h.calls), [{ authorize: companyId }, { name: 'get_waitlist_call_notification_state', args: { _company_id: companyId } }]);
  assert.equal(h.wakes.length, 0);
});

test('disabled automation suppresses stale failure rows even if a bad snapshot includes them', async () => {
  const h = harness({ snapshot: { automation_enabled: false } });
  const data = await (await h.request({ action: 'list', company_id: companyId })).json();
  assert.equal(data.automation_enabled, false);
  assert.deepEqual(data.failures, []);
  assert.equal(h.wakes.length, 0);
});

for (const channel of ['evolution', 'pluguechat_official']) {
  test(`retry ${channel} uses only the existing queue ID, preserving the exact call timestamp`, async () => {
    const h = harness({ snapshot: { channel } });
    const response = await h.request({ action: 'retry', company_id: companyId, waitlist_id: waitlistId, expected_called_at: calledAt });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.retry_queued, true);
    assert.equal(data.company_id, companyId);
    assert.deepEqual(plain(h.calls[1]), { name: 'retry_waitlist_call_notification', args: { _company_id: companyId, _waitlist_id: waitlistId, _called_at: calledAt } });
    assert.deepEqual(h.wakes, [{ companyId, channel, queueId }]);
    assert.equal(h.tasks.length, 1);
    await Promise.all(h.tasks);
  });
}

for (const result of ['disabled', 'not_retryable', 'expired', 'not_called', 'not_found', 'cooldown']) {
  test(`retry outcome ${result} never wakes a provider worker`, async () => {
    const h = harness({ retry: { result } });
    const response = await h.request({ action: 'retry', company_id: companyId, waitlist_id: waitlistId, expected_called_at: calledAt });
    const data = await response.json();
    assert.equal(data.retry_queued, false);
    assert.equal(data.result, result);
    assert.equal(h.wakes.length, 0);
  });
}

for (const authError of ['Nao autorizado', 'Sem permissao para esta empresa', 'Sem permissao para esta acao']) {
  test(`denied actor: ${authError}`, async () => {
    const h = harness({ authError });
    const response = await h.request({ action: 'retry', company_id: companyId, waitlist_id: waitlistId, expected_called_at: calledAt });
    assert.equal(response.status, authError === 'Nao autorizado' ? 401 : 403);
    assert.equal(h.calls.length, 1);
    assert.equal(h.wakes.length, 0);
  });
}

test('rejects malformed action, scope, entry and date before authorization or writes', async () => {
  for (const body of [null, '{', { action: 'send', company_id: companyId }, { action: 'list', company_id: 'anything' }, { action: 'retry', company_id: companyId, waitlist_id: waitlistId }, { action: 'retry', company_id: companyId, waitlist_id: 'invalid', expected_called_at: calledAt }, { action: 'retry', company_id: companyId, waitlist_id: waitlistId, expected_called_at: 'yesterday' }]) {
    const h = harness();
    assert.equal((await h.request(body)).status, 400);
    assert.equal(h.calls.length, 0);
    assert.equal(h.wakes.length, 0);
  }
});

test('requires a scoped, fully recognized state instead of exposing another company or raw errors', async () => {
  for (const options of [{ snapshot: { company_id: queueId } }, { snapshot: { failures: [{ waitlist_id: 'bad', called_at: calledAt, can_retry: true }] } }, { rpcError: true }]) {
    const h = harness(options);
    const response = await h.request({ action: 'list', company_id: companyId });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private|provider\/database/);
  }
});

test('OPTIONS and unsupported methods never authenticate or mutate', async () => {
  const h = harness();
  assert.equal((await h.request(undefined, 'OPTIONS')).status, 204);
  assert.equal((await h.request(undefined, 'GET')).status, 405);
  assert.equal(h.calls.length, 0);
  assert.equal(h.wakes.length, 0);
});
