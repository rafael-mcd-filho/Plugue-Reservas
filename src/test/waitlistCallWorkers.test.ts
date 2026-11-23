// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), authorize: vi.fn(), evolutionSend: vi.fn(), officialSend: vi.fn(), getOfficialConfig: vi.fn(), channel: vi.fn(), checkStatus: vi.fn() }));
vi.mock('../../supabase/functions/_shared/internal-auth.ts', () => ({
  createSupabaseAdminClient: mocks.admin, isAuthorizedInternalJob: mocks.authorize, assertUserCanAccessCompany: vi.fn(),
}));
vi.mock('../../supabase/functions/_shared/whatsapp-circuit.ts', () => ({
  checkWhatsAppCircuit: vi.fn(async () => ({ open: false })), recordWhatsAppFailure: vi.fn(async () => ({ open: false })), recordWhatsAppSuccess: vi.fn(async () => undefined),
}));
vi.mock('../../supabase/functions/_shared/whatsapp.ts', async (original) => ({
  ...await original<Record<string, unknown>>(), sendWhatsAppText: mocks.evolutionSend, sleep: vi.fn(async () => undefined),
}));
vi.mock('../../supabase/functions/_shared/pluguechat.ts', async (original) => ({
  ...await original<Record<string, unknown>>(), sendPlugueChatMessage: mocks.officialSend,
  getPlugueChatCompanyConfig: mocks.getOfficialConfig, getCompanyChannel: mocks.channel, checkPlugueChatMessageStatus: mocks.checkStatus,
}));

type Row = Record<string, unknown>;
type Handler = (request: Request) => Promise<Response>;
type Filter = { op: string; column: string; value: unknown };
type Query = { table: string; filters: Filter[]; values?: Row; selected: boolean };
const fixedNow = Date.parse('2026-11-22T21:00:00Z');
const validCalledAt = new Date(fixedNow - 30000).toISOString();
let evolutionHandler: Handler;
let officialHandler: Handler;
let getWaitlistCallEligibility: (database: unknown, item: Row, channel: string, now?: number) => Promise<{ eligible: boolean; reason?: string }>;
let isEvolutionCallFailureRetryable: (error: { code?: string; provider_status?: number | null }) => boolean;
let isPlugueChatCallFailureRetryable: (result: { provider_status?: string | null; error?: string }) => boolean;
let tables: Record<string, Row[]>;
let calls: Query[];
let featureEnabled: boolean;
let failLookup: string | null;
let onReserveSlot: (() => void) | null;
let onFeatureCheck: (() => void) | null;
let onCallLogWrite: ((parameters: Row) => void) | null;
let rpcCalls: Array<{ name: string; parameters: Row }>;

function queueItem(overrides: Row = {}): Row {
  return {
    id: 'queue-a', company_id: 'company-a', waitlist_id: 'entry-a', waitlist_called_at: validCalledAt,
    reservation_id: null, type: 'waitlist_called', message: 'Sua mesa está pronta.', phone: '+5562999990000',
    template_id: 'approved-template', parameters: { nome: 'Ana' }, status: 'pending', attempts: 0, max_attempts: 3,
    expires_at: new Date(fixedNow + 3600000).toISOString(), scheduled_for: new Date(fixedNow - 1000).toISOString(),
    created_at: new Date(fixedNow - 60000).toISOString(), priority: 10, provider_message_id: null, provider_status: null,
    ...overrides,
  };
}

function matches(row: Row, filters: Filter[]) {
  return filters.every(({ op, column, value }) => {
    const field = row[column];
    if (op === 'eq' || op === 'is') return (field ?? null) === value;
    if (op === 'neq') return field !== value;
    if (op === 'not-is') return (field ?? null) !== value;
    if (op === 'in') return (value as unknown[]).includes(field);
    const comparison = typeof field === 'number' && typeof value === 'number'
      ? field - value
      : typeof field === 'string' && typeof value === 'string' ? field.localeCompare(value) : NaN;
    if (op === 'lt') return comparison < 0;
    if (op === 'lte') return comparison <= 0;
    if (op === 'gt') return comparison > 0;
    if (op === 'gte') return comparison >= 0;
    return true;
  });
}

function databaseStub() {
  return {
    rpc: vi.fn(async (name: string, parameters: Row = {}) => {
      rpcCalls.push({ name, parameters });
      if (name === 'company_feature_enabled') { onFeatureCheck?.(); return { data: featureEnabled, error: null }; }
      if (name === 'reserve_whatsapp_delivery_slot') { onReserveSlot?.(); return { data: { can_send: true }, error: null }; }
      if (name === 'write_waitlist_call_notification_log') {
        onCallLogWrite?.(parameters);
        const row = tables.pluguechat_message_queue.find((candidate) => candidate.id === parameters._queue_id);
        if (!row || row.status !== parameters._status || row.waitlist_called_at !== parameters._called_at
          || row.last_attempt_at !== parameters._last_attempt_at || (row.provider_message_id ?? null) !== parameters._provider_message_id) return { data: false, error: null };
        const log = { queue_id: row.id, company_id: row.company_id, waitlist_id: row.waitlist_id, status: row.status, provider_message_id: row.provider_message_id ?? null };
        const previous = tables.pluguechat_message_logs.find((candidate) => candidate.queue_id === row.id);
        if (previous) Object.assign(previous, log);
        else tables.pluguechat_message_logs.push(log);
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
    from(table: string) {
      const call: Query = { table, filters: [], selected: false };
      calls.push(call);
      let inserted: Row | null = null;
      let upserted: Row | null = null;
      let maximum = Infinity;
      const result = (single = false) => {
        if (table === failLookup) return { data: null, error: new Error('lookup unavailable') };
        const source = tables[table] ?? (tables[table] = []);
        const rows = source.filter((row) => matches(row, call.filters)).slice(0, maximum);
        if (inserted) source.push({ ...inserted });
        if (upserted) {
          const existing = source.find((row) => row.queue_id === upserted!.queue_id);
          if (existing) Object.assign(existing, upserted);
          else source.push({ ...upserted });
        }
        if (call.values) rows.forEach((row) => Object.assign(row, call.values));
        const data = rows.map((row) => ({ ...row }));
        return { data: single ? data[0] ?? null : data, error: null };
      };
      const filter = (op: string, column: string, value: unknown) => { call.filters.push({ op, column, value }); return query; };
      const query = {
        select: () => { call.selected = true; return query; },
        update: (values: Row) => { call.values = values; return query; },
        insert: (values: Row) => { inserted = values; return query; },
        upsert: (values: Row) => { upserted = values; return query; },
        eq: (column: string, value: unknown) => filter('eq', column, value),
        neq: (column: string, value: unknown) => filter('neq', column, value),
        is: (column: string, value: unknown) => filter('is', column, value),
        not: (column: string, op: string, value: unknown) => filter(`not-${op}`, column, value),
        in: (column: string, value: unknown) => filter('in', column, value),
        lt: (column: string, value: unknown) => filter('lt', column, value),
        lte: (column: string, value: unknown) => filter('lte', column, value),
        gt: (column: string, value: unknown) => filter('gt', column, value),
        gte: (column: string, value: unknown) => filter('gte', column, value),
        order: () => query,
        limit: (value: number) => { maximum = value; return query; },
        maybeSingle: async () => result(true),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  };
}

beforeAll(async () => {
  const eligibilityEntry = '../../supabase/functions/_shared/waitlist-call-eligibility.ts';
  ({ getWaitlistCallEligibility, isEvolutionCallFailureRetryable, isPlugueChatCallFailureRetryable } = await import(eligibilityEntry));
  vi.stubGlobal('Deno', { serve: (handler: Handler) => { evolutionHandler = handler; }, env: { get: vi.fn() } });
  const evolutionEntry = '../../supabase/functions/process-message-queue/index.ts';
  await import(evolutionEntry);
  vi.stubGlobal('Deno', { serve: (handler: Handler) => { officialHandler = handler; }, env: { get: vi.fn() } });
  const officialEntry = '../../supabase/functions/process-pluguechat-message-queue/index.ts';
  await import(officialEntry);
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(fixedNow);
  featureEnabled = true; failLookup = null; onReserveSlot = null; onFeatureCheck = null; onCallLogWrite = null; calls = []; rpcCalls = [];
  tables = {
    system_settings: [{ key: 'evolution_api_url', value: 'https://offline.invalid' }, { key: 'evolution_api_token', value: 'offline-test-token' }],
    companies: [{ id: 'company-a', whatsapp_automation_channel: 'evolution', deletion_requested_at: null }],
    company_whatsapp_instances: [{ company_id: 'company-a', instance_name: 'instance-a', status: 'connected' }],
    automation_settings: [{ company_id: 'company-a', type: 'waitlist_called', enabled: true }],
    pluguechat_automation_templates: [{ company_id: 'company-a', type: 'waitlist_called', enabled: true }],
    waitlist: [{ id: 'entry-a', company_id: 'company-a', status: 'called', called_at: validCalledAt }],
    whatsapp_message_queue: [queueItem()], pluguechat_message_queue: [queueItem()],
    whatsapp_message_logs: [], pluguechat_message_logs: [],
  };
  mocks.admin.mockReturnValue(databaseStub()); mocks.authorize.mockResolvedValue(true);
  mocks.channel.mockImplementation(async (_database, companyId) => tables.companies.find((row) => row.id === companyId)?.whatsapp_automation_channel);
  mocks.getOfficialConfig.mockResolvedValue({ apiUrl: 'https://official.invalid', apiToken: 'offline-test-token', fromNumber: '+5562000000000' });
  mocks.evolutionSend.mockResolvedValue({ ok: true, data: {}, raw: null, provider_status_text: 'SENT' });
  mocks.officialSend.mockResolvedValue({ ok: true, provider_message_id: 'provider-a', provider_status: 'SENT', provider_status_url: null, raw: null });
  mocks.checkStatus.mockResolvedValue({ ok: true, provider_message_id: 'provider-a', provider_status: 'SENT', delivery_state: 'sent', raw: null });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden'));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => vi.unstubAllGlobals());

async function run(channel: 'evolution' | 'pluguechat_official', body: Row = { company_id: 'company-a', queue_id: 'queue-a' }) {
  tables.companies[0].whatsapp_automation_channel = channel;
  const handler = channel === 'evolution' ? evolutionHandler : officialHandler;
  const response = await handler(new Request('https://offline.invalid/worker', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
  expect(response.status).toBe(200);
  return response.json();
}

describe.each(['evolution', 'pluguechat_official'] as const)('%s waitlist-call worker', (channel) => {
  const queueTable = channel === 'evolution' ? 'whatsapp_message_queue' : 'pluguechat_message_queue';
  const automationTable = channel === 'evolution' ? 'automation_settings' : 'pluguechat_automation_templates';
  const send = () => channel === 'evolution' ? mocks.evolutionSend : mocks.officialSend;

  it('sends an enabled, current call once and preserves the original call timestamp', async () => {
    await run(channel);
    expect(send()).toHaveBeenCalledOnce();
    expect(tables[queueTable][0].status).toBe('sent');
    if (channel === 'pluguechat_official') {
      expect(tables.pluguechat_message_logs).toContainEqual(expect.objectContaining({ queue_id: 'queue-a', status: 'sent', provider_message_id: 'provider-a' }));
    }
    expect(tables.waitlist[0].called_at).toBe(validCalledAt);
    expect(calls.filter((call) => call.table === 'waitlist' && call.values)).toHaveLength(0);
    await run(channel);
    expect(send()).toHaveBeenCalledOnce();
  });

  it.each(['disabled automation', 'disabled integration', 'seated client', 'changed call', 'expired call', 'missing call tracking'] as const)('does not send a %s', async (scenario) => {
    if (scenario === 'disabled automation') tables[automationTable][0].enabled = false;
    if (scenario === 'disabled integration') featureEnabled = false;
    if (scenario === 'seated client') tables.waitlist[0].status = 'seated';
    if (scenario === 'changed call') tables.waitlist[0].called_at = new Date(fixedNow).toISOString();
    if (scenario === 'expired call') tables[queueTable][0].waitlist_called_at = new Date(fixedNow - 300000).toISOString();
    if (scenario === 'missing call tracking') tables[queueTable][0].waitlist_called_at = null;
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
    expect(['expired', 'cancelled']).toContain(tables[queueTable][0].status);
  });

  it('defers an unavailable eligibility lookup without sending or treating it as a confirmed provider failure', async () => {
    failLookup = 'waitlist';
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
    expect(tables[queueTable][0].status).toBe('pending');
    expect(tables[queueTable][0].scheduled_for).toBe(new Date(fixedNow + 30000).toISOString());
  });

  it('limits a targeted run to the requested queue entry and company, including status reconciliation', async () => {
    tables[queueTable].push(queueItem({ id: 'queue-unrelated', message: 'Outro aviso', status: 'provider_queued', provider_message_id: 'provider-unrelated' }));
    tables[queueTable].push(queueItem({ id: 'queue-other-company', company_id: 'company-b' }));
    await run(channel);
    expect(send()).toHaveBeenCalledOnce();
    expect(tables[queueTable].find((row) => row.id === 'queue-unrelated')?.status).toBe('provider_queued');
    expect(tables[queueTable].find((row) => row.id === 'queue-other-company')?.status).toBe('pending');
    expect(mocks.checkStatus).not.toHaveBeenCalled();
  });

  it('rejects a queue-specific request without its company scope', async () => {
    const handler = channel === 'evolution' ? evolutionHandler : officialHandler;
    const response = await handler(new Request('https://offline.invalid/worker', { method: 'POST', body: JSON.stringify({ queue_id: 'queue-a' }) }));
    expect(response.status).toBe(400);
    expect(send()).not.toHaveBeenCalled();
  });

  it('rechecks activation immediately before contacting the provider', async () => {
    if (channel === 'evolution') onReserveSlot = () => { tables[automationTable][0].enabled = false; };
    else mocks.getOfficialConfig.mockImplementation(async () => {
      tables[automationTable][0].enabled = false;
      return { apiUrl: 'https://official.invalid', apiToken: 'offline', fromNumber: '+5562000000000' };
    });
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
  });

  it('does not exceed the individual retry budget even for an inconsistent pending row', async () => {
    tables[queueTable][0].attempts = 3;
    tables[queueTable][0].max_attempts = 3;
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
    expect(tables[queueTable][0].status).toBe('failed');
  });
});

describe('ambiguous and known worker outcomes', () => {
  it.each([null, 500, 502])('does not automatically resend an Evolution call after ambiguous status %s', async (providerStatus) => {
    mocks.evolutionSend.mockResolvedValue({ ok: false, error: { code: 'provider_request_failed', title: 'Falha', message: 'Sem confirmação', provider_status: providerStatus } });
    await run('evolution');
    expect(tables.whatsapp_message_queue[0].status).toBe('failed');
    await run('evolution');
    expect(mocks.evolutionSend).toHaveBeenCalledOnce();
  });

  it('does not automatically resend an Evolution call after an interrupted send', async () => {
    mocks.evolutionSend.mockRejectedValue(new Error('connection interrupted'));
    await run('evolution');
    expect(tables.whatsapp_message_queue[0].status).toBe('failed');
    await run('evolution');
    expect(mocks.evolutionSend).toHaveBeenCalledOnce();
  });

  it('allows a known rejected Evolution request to remain pending within its retry limit', async () => {
    mocks.evolutionSend.mockResolvedValue({ ok: false, error: { code: 'provider_request_failed', title: 'Recusada', message: 'Limite', provider_status: 429 } });
    await run('evolution');
    expect(tables.whatsapp_message_queue[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('does not resend a PlugueChat request accepted without a message ID', async () => {
    mocks.officialSend.mockResolvedValue({ ok: true, provider_message_id: null, provider_status: 'QUEUED', raw: null });
    await run('pluguechat_official');
    expect(tables.pluguechat_message_queue[0]).toMatchObject({ status: 'failed', provider_status: 'QUEUED' });
    await run('pluguechat_official');
    expect(mocks.officialSend).toHaveBeenCalledOnce();
  });

  it('does not automatically resend a PlugueChat timeout', async () => {
    mocks.officialSend.mockResolvedValue({ ok: false, error: 'request timed out', provider_message_id: null, provider_status: null });
    await run('pluguechat_official');
    expect(tables.pluguechat_message_queue[0].status).toBe('failed');
    await run('pluguechat_official');
    expect(mocks.officialSend).toHaveBeenCalledOnce();
  });

  it('keeps a rejected PlugueChat request pending while attempts remain', async () => {
    mocks.officialSend.mockResolvedValue({ ok: false, error: 'HTTP 429: Too many requests', provider_status: null });
    await run('pluguechat_official');
    expect(tables.pluguechat_message_queue[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('honors the individual PlugueChat retry budget instead of a fixed three-attempt cutoff', async () => {
    tables.pluguechat_message_queue[0].attempts = 3;
    tables.pluguechat_message_queue[0].max_attempts = 4;
    await run('pluguechat_official');
    expect(mocks.officialSend).toHaveBeenCalledOnce();
    expect(tables.pluguechat_message_queue[0]).toMatchObject({ status: 'sent', attempts: 4 });
  });

  it('does not blindly reclaim a stalled Evolution call for another send', async () => {
    tables.whatsapp_message_queue[0].status = 'processing';
    tables.whatsapp_message_queue[0].last_attempt_at = new Date(fixedNow - 181000).toISOString();
    await run('evolution');
    expect(tables.whatsapp_message_queue[0].status).toBe('failed');
    expect(mocks.evolutionSend).not.toHaveBeenCalled();
  });
});

describe('waitlist call eligibility and retry evidence', () => {
  it.each(['evolution', 'pluguechat_official'] as const)('rejects a call when its company switched away from %s', async (expectedChannel) => {
    tables.companies[0].whatsapp_automation_channel = expectedChannel === 'evolution' ? 'pluguechat_official' : 'evolution';
    expect(await getWaitlistCallEligibility(databaseStub() as never, queueItem() as never, expectedChannel)).toMatchObject({ eligible: false, reason: 'channel_changed' });
  });

  it('does not apply waitlist-call restrictions to unrelated automations', async () => {
    expect(await getWaitlistCallEligibility(databaseStub() as never, queueItem({ type: 'birthday_message', waitlist_id: null }) as never, 'evolution')).toEqual({ eligible: true });
    expect(calls).toHaveLength(0);
  });

  it('rechecks the deadline after asynchronous eligibility reads finish', async () => {
    onFeatureCheck = () => vi.setSystemTime(fixedNow + 5 * 60000);
    expect(await getWaitlistCallEligibility(databaseStub(), queueItem(), 'evolution')).toEqual({ eligible: false, reason: 'call_expired' });
  });

  it.each(['EXPIRED', 'MISSING_MESSAGE_ID'])('never treats %s as safe retry even if the older error text was a known rejection', (provider_status) => {
    expect(isPlugueChatCallFailureRetryable({ provider_status, error: 'HTTP 429: older rejection' })).toBe(false);
  });

  it.each(['Configuração PlugueChat não encontrada ou incompleta.', 'Template da chamada não configurado.', 'Telefone internacional invalido para envio.'])('permits a corrected preflight issue without assuming provider acceptance: %s', (error) => {
    expect(isPlugueChatCallFailureRetryable({ error })).toBe(true);
  });

  it.each([400, 401, 403, 404, 405, 410, 413, 415, 422, 429])('permits retry only after a known HTTP %s rejection', (provider_status) => {
    expect(isEvolutionCallFailureRetryable({ code: 'provider_request_failed', provider_status })).toBe(true);
    expect(isPlugueChatCallFailureRetryable({ error: `HTTP ${provider_status}: rejected` })).toBe(true);
  });

  it.each([null, 200, 202, 500, 502, 503, 504])('does not infer safe retry from ambiguous HTTP %s', (provider_status) => {
    expect(isEvolutionCallFailureRetryable({ code: 'provider_request_failed', provider_status })).toBe(false);
    expect(isPlugueChatCallFailureRetryable({ error: `HTTP ${provider_status}: unknown` })).toBe(false);
  });
});

describe('PlugueChat call reconciliation races', () => {
  const replacements = [
    { label: 'manual retry returned to pending', status: 'pending', provider_message_id: null, last_attempt_at: new Date(fixedNow).toISOString() },
    { label: 'a newer send is processing', status: 'processing', provider_message_id: null, last_attempt_at: new Date(fixedNow).toISOString() },
    { label: 'a newer provider message is queued', status: 'provider_queued', provider_message_id: 'provider-new', last_attempt_at: new Date(fixedNow).toISOString() },
  ];
  const responses = [
    { label: 'sent', result: { ok: true, provider_message_id: 'provider-old', provider_status: 'SENT', delivery_state: 'sent', raw: null } },
    { label: 'failed', result: { ok: true, provider_message_id: 'provider-old', provider_status: 'FAILED', delivery_state: 'failed', failure_reason: 'old rejection', raw: null } },
    { label: 'still queued', result: { ok: true, provider_message_id: 'provider-old', provider_status: 'QUEUED', delivery_state: 'pending', raw: null } },
    { label: 'status lookup failure', result: { ok: false, error: 'old lookup failed', raw: null } },
  ];

  it.each(replacements.flatMap((replacement) => responses.map((response) => ({ replacement, response, label: `${replacement.label}: ${response.label}` }))))('does not let an old result overwrite $label', async ({ replacement, response }) => {
    const original = queueItem({ status: 'provider_queued', provider_message_id: 'provider-old', provider_status: 'QUEUED', last_attempt_at: new Date(fixedNow - 10000).toISOString() });
    tables.pluguechat_message_queue = [{ ...original }];
    const { label: _label, ...changed } = replacement;
    mocks.checkStatus.mockImplementation(async () => {
      Object.assign(tables.pluguechat_message_queue[0], changed);
      return response.result;
    });
    await run('pluguechat_official');
    expect(mocks.checkStatus).toHaveBeenCalledOnce();
    expect(mocks.officialSend).not.toHaveBeenCalled();
    expect(tables.pluguechat_message_queue[0]).toEqual({ ...original, ...changed });
    expect(tables.pluguechat_message_logs).toHaveLength(0);
  });

  it.each(replacements)('does not overwrite $label if the older lookup loses its channel configuration', async (replacement) => {
    const original = queueItem({ status: 'provider_queued', provider_message_id: 'provider-old', provider_status: 'QUEUED', last_attempt_at: new Date(fixedNow - 10000).toISOString() });
    tables.pluguechat_message_queue = [{ ...original }];
    const { label: _label, ...changed } = replacement;
    mocks.getOfficialConfig.mockImplementation(async () => {
      Object.assign(tables.pluguechat_message_queue[0], changed);
      return null;
    });
    await run('pluguechat_official');
    expect(mocks.officialSend).not.toHaveBeenCalled();
    expect(mocks.checkStatus).not.toHaveBeenCalled();
    expect(tables.pluguechat_message_queue[0]).toEqual({ ...original, ...changed });
    expect(tables.pluguechat_message_logs).toHaveLength(0);
  });

  it('does not finalize a different call generation that reused the same queue row', async () => {
    const original = queueItem({ status: 'provider_queued', provider_message_id: 'provider-old', provider_status: 'QUEUED', last_attempt_at: new Date(fixedNow - 10000).toISOString() });
    tables.pluguechat_message_queue = [{ ...original }];
    mocks.checkStatus.mockImplementation(async () => {
      tables.pluguechat_message_queue[0].waitlist_called_at = new Date(fixedNow).toISOString();
      return { ok: true, provider_message_id: 'provider-old', provider_status: 'SENT', delivery_state: 'sent', raw: null };
    });
    await run('pluguechat_official');
    expect(tables.pluguechat_message_queue[0]).toEqual({ ...original, waitlist_called_at: new Date(fixedNow).toISOString() });
    expect(tables.pluguechat_message_logs).toHaveLength(0);
  });

  it('does not let an older failure log overwrite a newer accepted log after the queue CAS succeeded', async () => {
    const original = queueItem({ status: 'provider_queued', provider_message_id: 'provider-old', provider_status: 'QUEUED', last_attempt_at: new Date(fixedNow - 10000).toISOString() });
    tables.pluguechat_message_queue = [{ ...original }];
    mocks.checkStatus.mockResolvedValue({ ok: true, provider_message_id: 'provider-old', provider_status: 'FAILED', delivery_state: 'failed', failure_reason: 'old rejection', raw: null });
    const newerLog = { queue_id: 'queue-a', company_id: 'company-a', waitlist_id: 'entry-a', status: 'sent', provider_message_id: 'provider-new' };
    onCallLogWrite = (parameters) => {
      expect(parameters).toEqual({ _queue_id: 'queue-a', _called_at: validCalledAt, _last_attempt_at: new Date(fixedNow).toISOString(), _status: 'failed', _provider_message_id: 'provider-old' });
      // The old result already won its queue CAS. Another authorized attempt
      // completes before its log RPC acquires the queue row lock.
      expect(tables.pluguechat_message_queue[0].status).toBe('failed');
      Object.assign(tables.pluguechat_message_queue[0], { status: 'sent', provider_message_id: 'provider-new', last_attempt_at: new Date(fixedNow + 1000).toISOString() });
      tables.pluguechat_message_logs = [{ ...newerLog }];
    };
    await run('pluguechat_official');
    expect(rpcCalls.filter((call) => call.name === 'write_waitlist_call_notification_log')).toHaveLength(1);
    expect(tables.pluguechat_message_queue[0]).toMatchObject({ status: 'sent', provider_message_id: 'provider-new' });
    expect(tables.pluguechat_message_logs).toEqual([newerLog]);
    expect(calls.filter((call) => call.table === 'pluguechat_message_logs')).toHaveLength(0);
  });
});

describe.each(['evolution', 'pluguechat_official'] as const)('%s reservation change message guard', (channel) => {
  const queueTable = channel === 'evolution' ? 'whatsapp_message_queue' : 'pluguechat_message_queue';
  const send = () => channel === 'evolution' ? mocks.evolutionSend : mocks.officialSend;
  const currentRevision = '2026-11-22T20:59:55.123456Z';
  const olderRevision = '2026-11-22T20:59:55.123455Z';

  function prepareReminder(revision: string | null = currentRevision, changedAt: string | null = currentRevision) {
    tables.reservations = [{ id: 'reservation-a', company_id: 'company-a', last_public_change_at: changedAt }];
    tables[queueTable] = [queueItem({
      waitlist_id: null, waitlist_called_at: null,
      reservation_id: 'reservation-a', type: 'reminder_1h', message: 'Hoje às 21h para 6 pessoas.',
      parameters: { nome: 'Ana', hora: '21:00', pessoas: '6' },
      reservation_change_revision: revision,
      // A scheduler that began before a change can insert its old snapshot later.
      created_at: new Date(fixedNow - 1000).toISOString(),
    })];
  }

  it.each([null, olderRevision])('does not send a stale payload enqueued after the change with revision %s', async (revision) => {
    prepareReminder(revision);
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
    expect(['expired', 'cancelled']).toContain(tables[queueTable][0].status);
    expect(tables[queueTable][0].attempts).toBe(0);
    expect(tables.whatsapp_message_logs).toHaveLength(0);
    expect(tables.pluguechat_message_logs).toHaveLength(0);
  });

  it('sends the exact current revision, including a semantically equivalent timezone offset', async () => {
    prepareReminder('2026-11-22T17:59:55.123456-03:00');
    await run(channel);
    expect(send()).toHaveBeenCalledOnce();
    expect(tables[queueTable][0].status).toBe('sent');
    const logs = tables[channel === 'evolution' ? 'whatsapp_message_logs' : 'pluguechat_message_logs'];
    expect(logs).toContainEqual(expect.objectContaining({
      reservation_id: 'reservation-a', reservation_change_revision: '2026-11-22T17:59:55.123456-03:00',
    }));
    await run(channel);
    expect(send()).toHaveBeenCalledOnce();
  });

  it('keeps existing dispatch behavior for a reservation never changed by the customer', async () => {
    prepareReminder(null, null);
    await run(channel);
    expect(send()).toHaveBeenCalledOnce();
    expect(tables[queueTable][0].status).toBe('sent');
  });

  it('defers a reservation lookup failure without spending an attempt or sending', async () => {
    prepareReminder();
    failLookup = 'reservations';
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
    expect(tables[queueTable][0]).toMatchObject({
      status: 'pending', attempts: 0,
      scheduled_for: new Date(fixedNow + 30000).toISOString(),
    });
    expect(tables.whatsapp_message_logs).toHaveLength(0);
    expect(tables.pluguechat_message_logs).toHaveLength(0);
  });

  it('checks the latest revision after waiting for cadence or loading provider configuration', async () => {
    prepareReminder();
    const change = () => { tables.reservations[0].last_public_change_at = '2026-11-22T20:59:55.123457Z'; };
    if (channel === 'evolution') onReserveSlot = change;
    else mocks.getOfficialConfig.mockImplementation(async () => {
      change();
      return { apiUrl: 'https://official.invalid', apiToken: 'offline', fromNumber: '+5562000000000' };
    });
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
    expect(['expired', 'cancelled']).toContain(tables[queueTable][0].status);
  });

  it.each(['missing reservation', 'other company'])('does not send for a %s', async (scenario) => {
    prepareReminder();
    if (scenario === 'missing reservation') tables.reservations = [];
    else tables.reservations[0].company_id = 'company-b';
    await run(channel);
    expect(send()).not.toHaveBeenCalled();
    expect(['expired', 'cancelled']).toContain(tables[queueTable][0].status);
  });

  it('does not let an old accepted log suppress the current reminder', async () => {
    prepareReminder();
    tables.whatsapp_message_logs = [{
      id: 'old-log', company_id: 'company-a', reservation_id: 'reservation-a', type: 'reminder_1h',
      phone: '+5562999990000', status: 'sent', created_at: new Date(fixedNow - 10000).toISOString(),
    }];
    await run(channel);
    expect(send()).toHaveBeenCalledOnce();
    expect(tables[queueTable][0].status).toBe('sent');
  });
});

describe('late provider reconciliation after customer reservation change', () => {
  it('keeps the original visit revision on a delayed PlugueChat log without resending', async () => {
    tables.reservations = [{ id: 'reservation-a', company_id: 'company-a', last_public_change_at: '2026-11-22T20:59:55.123456Z' }];
    tables.pluguechat_message_queue = [queueItem({
      waitlist_id: null, waitlist_called_at: null,
      reservation_id: 'reservation-a', type: 'reminder_1h',
      reservation_change_revision: '2026-11-22T20:59:55.123455Z',
      status: 'sent', provider_message_id: 'provider-old', provider_status: null,
      created_at: '2026-11-22T20:59:54Z',
    })];
    await run('pluguechat_official');
    expect(mocks.officialSend).not.toHaveBeenCalled();
    expect(mocks.checkStatus).toHaveBeenCalledOnce();
    expect(tables.pluguechat_message_logs).toContainEqual(expect.objectContaining({
      reservation_id: 'reservation-a', reservation_change_revision: '2026-11-22T20:59:55.123455Z',
    }));
  });
});
