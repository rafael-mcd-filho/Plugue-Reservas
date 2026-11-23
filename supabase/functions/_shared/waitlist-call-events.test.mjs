// Offline event regressions: disabled automations, persisted call identity and original deadline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../reservation-events/index.ts', import.meta.url), 'utf8')
  + '\nexports.testOnly = { enqueuePlugueChatWaitlist, sendWaitlistAutomation, getWaitlistCallDeadline };';
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const eligibilityCompiled = ts.transpileModule(readFileSync(new URL('./waitlist-call-eligibility.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const eligibility = {};
vm.runInNewContext(`(function(exports) { ${eligibilityCompiled}\n})`, { Error, Date, console })(eligibility);

function harness(options = {}) {
  const writes = [];
  const sends = [];
  const finals = [];
  const templates = options.template === undefined ? { enabled: true, template_id: 'approved-template', template_name: 'Chamada' } : options.template;
  const automation = options.automation === undefined ? { enabled: true, message_template: '{nome}, sua mesa está pronta.' } : options.automation;
  const result = options.sendResult ?? { ok: true, provider_status_text: 'SENT' };
  const call = { id: 'waitlist-a', company_id: 'company-a', guest_name: 'Cliente de teste', guest_phone: '+5562999990000', party_size: 3, position: 1, status: 'called', called_at: new Date(Date.now() - 60000).toISOString() };
  const db = {
    rpc: async () => ({ data: null, error: null }),
    from(table) {
      let insert;
      const row = () => {
        if (insert) { writes.push({ table, payload: plain(insert) }); return { data: null, error: null }; }
        if (table === 'automation_settings') return { data: automation?.enabled ? automation : null, error: null };
        if (table === 'pluguechat_automation_templates') return { data: templates, error: null };
        if (table === 'company_whatsapp_instances') return { data: options.instance === undefined ? { instance_name: 'instance-a', status: 'connected' } : options.instance, error: null };
        if (table === 'system_settings') return { data: options.evolutionMissing ? [] : [{ key: 'evolution_api_url', value: 'https://offline.invalid' }, { key: 'evolution_api_token', value: 'test-only' }], error: null };
        if (table === 'whatsapp_message_logs' || table === 'whatsapp_message_queue') return { data: [], error: null };
        throw new Error(`Unexpected table ${table}`);
      };
      const query = { select: () => query, eq: () => query, in: () => query, limit: () => query, insert: payload => { insert = payload; return query; }, maybeSingle: async () => row(), then: (resolve, reject) => Promise.resolve(row()).then(resolve, reject) };
      return query;
    },
  };
  const failure = code => ({ ok: false, error: { code, title: code, message: code } });
  const modules = {
    '../_shared/phone.ts': { normalizeStoredPhoneE164: value => value },
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => db, getRequestAuthContext: async () => null, assertUserCanAccessCompany: async () => undefined },
    '../_shared/names.ts': { getFirstName: value => value.split(' ')[0] },
    '../_shared/waitlist-call-eligibility.ts': {
      getWaitlistCallEligibility: async () => ({ eligible: options.eligible !== false }),
      isEvolutionCallFailureRetryable: eligibility.isEvolutionCallFailureRetryable,
    },
    '../_shared/whatsapp.ts': {
      buildEvolutionNotConfiguredFailure: () => failure('evolution_not_configured'), buildInstanceNotConfiguredFailure: () => failure('instance_not_configured'), buildInstanceDisconnectedFailure: () => failure('instance_disconnected'),
      buildReservationDispatchKey: (type, id) => `reservation:${id}:${type}`, buildWaitlistDispatchKey: (type, id) => `waitlist:${id}:${type}`,
      claimWhatsAppDispatch: async () => true, finalizeWhatsAppDispatch: async (_db, payload) => finals.push(plain(payload)),
      enqueueWhatsAppMessageOnce: async (_db, payload) => { writes.push({ table: 'whatsapp_message_queue', payload: plain(payload) }); return 'inserted'; },
      formatPhoneForWhatsApp: value => value, getWhatsAppAcceptedLogStatus: () => 'sent', serializeWhatsAppFailure: error => JSON.stringify(error),
      sendWhatsAppText: async (...args) => { sends.push(args); return result; },
    },
    '../_shared/pluguechat.ts': {
      buildReservationParameters: () => ({}), buildWaitlistParameters: () => ({ nome: 'Cliente', tempo_limite_minutos: '5' }), getCompanyChannel: async () => 'evolution',
      enqueuePlugueChatMessage: async (_db, payload) => { writes.push({ table: 'pluguechat_message_queue', payload: plain(payload) }); return 'inserted'; },
    },
  };
  const exports = {};
  vm.runInNewContext(`(function(exports,require,Deno) { ${compiled}\n})`, { Error, Date, console })(exports, name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; }, { env: { get: () => undefined }, serve: () => undefined });
  return { ...exports.testOnly, db, call, writes, sends, finals };
}

for (const channel of ['evolution', 'pluguechat_official']) {
  test(`${channel}: disabled calling automation produces no notification attempt or persisted failure`, async () => {
    const h = harness({ automation: null, template: { enabled: false, template_id: 'approved-template' } });
    const output = {};
    await (channel === 'evolution' ? h.sendWaitlistAutomation : h.enqueuePlugueChatWaitlist)(h.db, 'waitlist_called', h.call, null, output);
    assert.equal(output.whatsapp, 'skipped_disabled');
    assert.equal(h.sends.length, 0);
    assert.equal(h.writes.length, 0);
  });

  for (const changes of [{ status: 'waiting' }, { called_at: null }, { called_at: new Date(Date.now() - 6 * 60000).toISOString() }]) {
    test(`${channel}: inactive or expired call never sends: ${JSON.stringify(changes)}`, async () => {
      const h = harness();
      const output = {};
      await (channel === 'evolution' ? h.sendWaitlistAutomation : h.enqueuePlugueChatWaitlist)(h.db, 'waitlist_called', { ...h.call, ...changes }, null, output);
      assert.equal(output.whatsapp, 'skipped_waitlist_call_inactive');
      assert.equal(h.sends.length, 0);
      assert.equal(h.writes.length, 0);
    });
  }
}

test('official channel persists the queue with the original called_at and five-minute expiry', async () => {
  const h = harness();
  const output = {};
  await h.enqueuePlugueChatWaitlist(h.db, 'waitlist_called', h.call, null, output);
  const [write] = h.writes;
  assert.equal(output.whatsapp, 'pluguechat_queued');
  assert.equal(write.payload.waitlist_id, h.call.id);
  assert.equal(write.payload.waitlist_called_at, h.call.called_at);
  assert.equal(Date.parse(write.payload.expires_at), Date.parse(h.call.called_at) + 5 * 60000);
  assert.equal(write.payload.idempotency_key, `pluguechat:waitlist:${h.call.id}:waitlist_called`);
  assert.equal(h.sends.length, 0);
});

test('official active automation with no approved template persists a preflight failure without sending', async () => {
  const h = harness({ template: { enabled: true, template_id: '' } });
  const output = {};
  await h.enqueuePlugueChatWaitlist(h.db, 'waitlist_called', h.call, null, output);
  const [write] = h.writes;
  assert.equal(output.whatsapp, 'pluguechat_template_not_configured');
  assert.equal(write.payload.status, 'failed');
  assert.equal(write.payload.error_details, 'Template da chamada não configurado.');
  assert.equal(write.payload.waitlist_called_at, h.call.called_at);
  assert.equal(h.sends.length, 0);
});

for (const option of [{ evolutionMissing: true }, { instance: null }, { instance: { instance_name: 'instance-a', status: 'disconnected' } }, { sendResult: { ok: false, error: { code: 'provider_request_failed', provider_status: 429, message: 'rate limited' } } }]) {
  test(`Evolution failed call keeps its identity and original expiry in the existing retry queue: ${JSON.stringify(option)}`, async () => {
    const h = harness(option);
    await h.sendWaitlistAutomation(h.db, 'waitlist_called', h.call, null, {});
    const write = h.writes.find(item => item.table === 'whatsapp_message_queue');
    assert.ok(write);
    assert.equal(write.payload.waitlist_id, h.call.id);
    assert.equal(write.payload.waitlist_called_at, h.call.called_at);
    assert.equal(Date.parse(write.payload.expires_at), Date.parse(h.call.called_at) + 5 * 60000);
    assert.equal(write.payload.type, 'waitlist_called');
    assert.equal(h.finals.at(-1).deliveryKey, `waitlist:${h.call.id}:waitlist_called`);
  });
}

test('Evolution accepted call never creates a second retry queue message', async () => {
  const h = harness();
  const output = {};
  await h.sendWaitlistAutomation(h.db, 'waitlist_called', h.call, null, output);
  assert.equal(output.whatsapp, 'sent');
  assert.equal(h.sends.length, 1);
  assert.equal(h.writes.some(item => item.table === 'whatsapp_message_queue'), false);
  assert.equal(h.finals.at(-1).status, 'accepted');
});

for (const error of [{ code: 'unknown_error', message: 'timeout' }, { code: 'provider_request_failed', provider_status: 500, message: 'server error' }, { code: 'provider_invalid_response', provider_status: 502, message: 'invalid response' }]) {
  test(`Evolution ambiguous result is persisted as failed without automatic retry: ${error.code}/${error.provider_status}`, async () => {
    const h = harness({ sendResult: { ok: false, error } });
    await h.sendWaitlistAutomation(h.db, 'waitlist_called', h.call, null, {});
    const queued = h.writes.find(item => item.table === 'whatsapp_message_queue');
    assert.ok(queued);
    assert.equal(queued.payload.status, 'failed');
    assert.equal(queued.payload.waitlist_id, h.call.id);
    assert.equal(h.finals.at(-1).status, 'failed');
    assert.equal(h.sends.length, 1);
  });
}

test('Evolution rechecks current call eligibility before provider send', async () => {
  const h = harness({ eligible: false });
  const output = {};
  await h.sendWaitlistAutomation(h.db, 'waitlist_called', h.call, null, output);
  assert.equal(output.whatsapp, 'skipped_waitlist_call_inactive');
  assert.equal(h.sends.length, 0);
  assert.equal(h.writes.length, 0);
});
