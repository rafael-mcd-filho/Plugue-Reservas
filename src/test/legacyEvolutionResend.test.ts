// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), send: vi.fn() }));
vi.mock('../../supabase/functions/_shared/internal-auth.ts', () => ({ assertUserCanAccessCompany: mocks.authorize }));
vi.mock('../../supabase/functions/_shared/whatsapp.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), sendWhatsAppText: mocks.send,
}));

let handler: (request: Request) => Promise<Response>;
let originalLog: { phone: string; message: string } | null;
let calls: Array<{ table: string; selected?: string; filters: Array<[string, unknown]> }>;

function databaseStub() {
  return {
    from(table: string) {
      const call = { table, selected: '', filters: [] as Array<[string, unknown]> };
      calls.push(call);
      const result = () => ({
        error: null,
        data: table === 'system_settings' ? [
          { key: 'evolution_api_url', value: 'https://offline.invalid' },
          { key: 'evolution_api_token', value: 'offline' },
        ] : table === 'company_whatsapp_instances'
          ? { instance_name: 'instance', status: 'connected' }
          : originalLog,
      });
      const query = {
        select: vi.fn((columns: string) => { call.selected = columns; return query; }),
        eq: vi.fn((column: string, value: unknown) => { call.filters.push([column, value]); return query; }),
        in: vi.fn(() => query), update: vi.fn(() => query),
        maybeSingle: vi.fn(async () => result()),
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(result()).then(resolve); },
      };
      return query;
    },
  };
}

async function request(body: Record<string, unknown>) {
  return handler(new Request('https://offline.invalid/evolution-api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_id: 'company-1', ...body }),
  }));
}

beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: (callback: typeof handler) => { handler = callback; } });
  const entrypoint = '../../supabase/functions/evolution-api/index.ts';
  await import(entrypoint);
});
beforeEach(() => {
  calls = [];
  originalLog = { phone: '1188887777', message: 'Mensagem original' };
  mocks.authorize.mockResolvedValue({ supabaseAdmin: databaseStub(), isSuperadmin: false, impersonation: null });
  mocks.send.mockResolvedValue({ ok: true, data: {}, raw: null, provider_status_text: 'SENT' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline only'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

describe('Evolution legacy resend boundary', () => {
  it('uses the original scoped log destination and content for an authorized resend', async () => {
    const response = await request({
      action: 'resend_message', log_id: 'log-1', phone: '+14072641934', message: 'Request override',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mocks.send).toHaveBeenCalledWith('https://offline.invalid', 'offline', 'instance', '+551188887777', 'Mensagem original');
    expect(calls.find((call) => call.selected === 'phone, message')).toMatchObject({
      table: 'whatsapp_message_logs', filters: [['id', 'log-1'], ['company_id', 'company-1']],
    });
  });

  it('does not send when the original log is absent from the authorized company', async () => {
    originalLog = null;
    expect((await request({ action: 'resend_message', log_id: 'foreign-log', phone: '1188887777', message: 'Teste' })).status).toBe(404);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('requires a log ID for legacy resend', async () => {
    expect((await request({ action: 'resend_message', phone: '1188887777', message: 'Teste' })).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('continues requiring strict validity for new manually supplied destinations', async () => {
    const response = await request({ action: 'send_message', phone: '1188887777', message: 'Teste' });
    expect(await response.json()).toMatchObject({ ok: false, error_code: 'invalid_payload' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('accepts a valid international destination for a new manual message', async () => {
    const response = await request({ action: 'send_message', phone: '+1 407 264 1934', message: 'Teste' });
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mocks.send).toHaveBeenCalledWith('https://offline.invalid', 'offline', 'instance', '+14072641934', 'Teste');
  });
});
