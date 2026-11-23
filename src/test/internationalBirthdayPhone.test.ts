// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAdmin: vi.fn(), authorize: vi.fn(), channels: vi.fn(),
  enqueueOfficial: vi.fn(), claimUnofficial: vi.fn(),
  enqueueUnofficial: vi.fn(), finalizeUnofficial: vi.fn(),
}));

vi.mock('../../supabase/functions/_shared/internal-auth.ts', () => ({
  createSupabaseAdminClient: mocks.createAdmin,
  isAuthorizedInternalJob: mocks.authorize,
}));
vi.mock('../../supabase/functions/_shared/pluguechat.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCompanyChannels: mocks.channels,
  enqueuePlugueChatMessage: mocks.enqueueOfficial,
}));
vi.mock('../../supabase/functions/_shared/whatsapp.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimWhatsAppDispatch: mocks.claimUnofficial,
  enqueueWhatsAppMessageOnce: mocks.enqueueUnofficial,
  finalizeWhatsAppDispatch: mocks.finalizeUnofficial,
}));

let handler: (request: Request) => Promise<Response>;
let rows: Record<string, Array<Record<string, unknown>>>;
let selections: Array<{ table: string; columns: string }>;

function databaseStub() {
  return {
    from(table: string) {
      const query = {
        select: vi.fn((columns: string) => { selections.push({ table, columns }); return query; }),
        in: vi.fn(() => query), eq: vi.fn(() => query), neq: vi.fn(() => query),
        not: vi.fn(() => query), gte: vi.fn(() => query),
        then(resolve: (result: unknown) => unknown) {
          return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

async function runJob() {
  const response = await handler(new Request('https://local.invalid/send-birthday-messages', { method: 'POST' }));
  expect(response.status).toBe(200);
  return response.json();
}

function birthdayContact(phone: string, extra: Record<string, unknown> = {}) {
  return { company_id: 'company-1', guest_name: 'Maria Lima', guest_phone: phone, guest_birthdate: '1990-10-23', ...extra };
}

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    serve: (callback: typeof handler) => { handler = callback; },
    env: { get: vi.fn() },
  });
  const entrypoint = '../../supabase/functions/send-birthday-messages/index.ts';
  await import(entrypoint);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T13:00:00Z'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden in birthday phone tests'));
  selections = [];
  rows = {
    reservations: [birthdayContact('+14072641934')],
    automation_settings: [{ company_id: 'company-1', enabled: true, message_template: 'Parabéns, {nome}!' }],
    pluguechat_automation_templates: [{ company_id: 'company-1', template_id: 'birthday-template', template_name: 'Aniversário' }],
  };
  mocks.createAdmin.mockReturnValue(databaseStub());
  mocks.authorize.mockResolvedValue(true);
  mocks.channels.mockResolvedValue(new Map([['company-1', 'pluguechat_official']]));
  mocks.enqueueOfficial.mockImplementation(async (_database, payload) => {
    if (!payload.phone) throw new Error('Empty birthday phone must not be enqueued');
    return 'inserted';
  });
  mocks.claimUnofficial.mockResolvedValue(true);
  mocks.enqueueUnofficial.mockImplementation(async (_database, payload) => {
    if (!payload.phone) throw new Error('Empty birthday phone must not be enqueued');
    return 'inserted';
  });
  mocks.finalizeUnofficial.mockResolvedValue(undefined);
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

describe('birthday automation international phone contract', () => {
  it.each(['pluguechat_official', 'evolution'])('skips invalid legacy phones and completes remaining %s contacts', async (channel) => {
    mocks.channels.mockResolvedValue(new Map([['company-1', channel]]));
    rows.reservations = [birthdayContact('invalid'), birthdayContact('+14072641934')];

    expect(await runJob()).toMatchObject({ queued: 1, total: 1 });
    const enqueue = channel === 'pluguechat_official' ? mocks.enqueueOfficial : mocks.enqueueUnofficial;
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].phone).toBe('+14072641934');
  });

  it.each([
    ['11999998888', '+5511999998888', '5511999998888'],
    ['1188887777', '+551188887777', '551188887777'],
    ['+14072641934', '+14072641934', '14072641934'],
  ])('keeps the PlugueChat birthday key in canonical digits for %s', async (raw, e164, digits) => {
    rows.reservations = [birthdayContact(raw)];
    expect(await runJob()).toMatchObject({ queued: 1 });
    expect(mocks.enqueueOfficial.mock.calls[0][1]).toMatchObject({
      phone: e164,
      idempotency_key: `pluguechat:birthday:company-1:2026-10-23:${digits}`,
    });
  });

  it('deduplicates matching legacy national BR and explicit international contacts across sources', async () => {
    rows.reservations = [birthdayContact('11999998888')];
    rows.reservation_companions = [{
      company_id: 'company-1', name: 'Maria Lima', phone: '+5511999998888', birthdate: '1990-10-23',
    }];
    expect(await runJob()).toMatchObject({ queued: 1, total: 1 });
    expect(mocks.enqueueOfficial).toHaveBeenCalledTimes(1);
  });

  it('keeps Russian international and Brazilian national numbers separate despite identical raw digits', async () => {
    rows.reservations = [birthdayContact('+79991234567'), birthdayContact('79991234567')];
    expect(await runJob()).toMatchObject({ queued: 2, total: 2 });
    expect(mocks.enqueueOfficial.mock.calls.map(([, payload]) => payload.phone)).toEqual(['+79991234567', '+5579991234567']);
  });

  it('prefers canonical sidecars in already queued rows without querying nonexistent metadata in logs', async () => {
    rows.pluguechat_message_queue = [{
      company_id: 'company-1', phone: '4072641934', phone_e164: '+14072641934',
    }];
    expect(await runJob()).toMatchObject({ queued: 0, skipped: 1 });
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
    expect(selections.filter(({ table }) => table.endsWith('_message_logs'))).toEqual([
      { table: 'whatsapp_message_logs', columns: 'phone, company_id' },
      { table: 'pluguechat_message_logs', columns: 'phone, company_id' },
    ]);
  });

  it.each(['pluguechat_official', 'evolution'])('honors legacy sent BR log entries for %s', async (channel) => {
    mocks.channels.mockResolvedValue(new Map([['company-1', channel]]));
    rows.reservations = [birthdayContact('+5511999998888')];
    rows[channel === 'pluguechat_official' ? 'pluguechat_message_logs' : 'whatsapp_message_logs'] = [
      { company_id: 'company-1', phone: '5511999998888' },
    ];
    expect(await runJob()).toMatchObject({ queued: 0, skipped: 1 });
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
    expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
  });

  it.each(['pluguechat_official', 'evolution'])('honors already sent legacy eight-digit BR contacts for %s', async (channel) => {
    mocks.channels.mockResolvedValue(new Map([['company-1', channel]]));
    rows.reservations = [birthdayContact('1188887777')];
    rows[channel === 'pluguechat_official' ? 'pluguechat_message_logs' : 'whatsapp_message_logs'] = [
      { company_id: 'company-1', phone: '+551188887777' },
    ];
    expect(await runJob()).toMatchObject({ queued: 0, skipped: 1 });
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
    expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
  });

  it('authorizes before looking up contacts', async () => {
    mocks.authorize.mockResolvedValue(false);
    const response = await handler(new Request('https://local.invalid/send-birthday-messages', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(selections).toHaveLength(0);
  });
});
