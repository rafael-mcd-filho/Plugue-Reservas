// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), authorize: vi.fn(), send: vi.fn() }));
vi.mock('../../supabase/functions/_shared/internal-auth.ts', () => ({
  createSupabaseAdminClient: mocks.admin, isAuthorizedInternalJob: mocks.authorize,
  assertUserCanAccessCompany: vi.fn(),
}));
vi.mock('../../supabase/functions/_shared/whatsapp-circuit.ts', () => ({
  checkWhatsAppCircuit: vi.fn(async () => ({ open: false })),
  recordWhatsAppFailure: vi.fn(async () => ({ open: false })), recordWhatsAppSuccess: vi.fn(),
}));
vi.mock('../../supabase/functions/_shared/whatsapp.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), sendWhatsAppText: mocks.send,
}));

let handler: (request: Request) => Promise<Response>;
let queuePhone: string;
let logPhone: string;
let updates: Array<Record<string, unknown>>;
let searchedPhones: unknown[];
const message = {
  id: 'queue-1', company_id: 'company-1', reservation_id: null,
  type: 'birthday_message', message: 'Parabens!', attempts: 0, max_attempts: 3,
};

function databaseStub() {
  return {
    rpc: vi.fn(async () => ({ data: { can_send: true }, error: null })),
    from(table: string) {
      let selected = false;
      let updated: Record<string, unknown> | null = null;
      let phoneFilter: unknown[] | undefined;
      const result = () => {
        let data: unknown = [];
        if (table === 'system_settings') data = [
          { key: 'evolution_api_url', value: 'https://offline.invalid' },
          { key: 'evolution_api_token', value: 'offline' },
        ];
        if (table === 'company_whatsapp_instances') data = [{ company_id: 'company-1', instance_name: 'instance' }];
        if (table === 'companies') data = [{ id: 'company-1' }];
        if (table === 'whatsapp_message_queue' && selected) {
          const row = { ...message, phone: queuePhone };
          data = updated ? row : [row];
        }
        if (table === 'whatsapp_message_logs') {
          data = !phoneFilter || phoneFilter.includes(logPhone) ? [{ id: 'log-1', phone: logPhone }] : [];
        }
        return { data, error: null };
      };
      const query = {
        select: vi.fn(() => { selected = true; return query; }),
        update: vi.fn((value: Record<string, unknown>) => { updated = value; updates.push(value); return query; }),
        insert: vi.fn(() => query), eq: vi.fn(() => query), neq: vi.fn(() => query), is: vi.fn(() => query),
        lt: vi.fn(() => query), lte: vi.fn(() => query), gt: vi.fn(() => query),
        gte: vi.fn(() => query), order: vi.fn(() => query), limit: vi.fn(() => query),
        in: vi.fn((column: string, values: unknown[]) => {
          if (table === 'whatsapp_message_logs' && column === 'phone') {
            phoneFilter = values; searchedPhones = values;
          }
          return query;
        }),
        maybeSingle: vi.fn(async () => result()),
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(result()).then(resolve); },
      };
      return query;
    },
  };
}

beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: (callback: typeof handler) => { handler = callback; } });
  const entrypoint = '../../supabase/functions/process-message-queue/index.ts';
  await import(entrypoint);
});
beforeEach(() => {
  queuePhone = '1188887777'; logPhone = '+551188887777'; updates = []; searchedPhones = [];
  mocks.admin.mockReturnValue(databaseStub()); mocks.authorize.mockResolvedValue(true);
  mocks.send.mockResolvedValue({ ok: true, data: {}, raw: null, provider_status_text: 'SENT' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline only'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.clearAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

async function runWorker() {
  const response = await handler(new Request('https://offline.invalid/process-message-queue', { method: 'POST' }));
  expect(response.status).toBe(200);
  return response.json();
}

describe('Evolution queue canonical deduplication', () => {
  it.each(['+551188887777', '551188887777', '1188887777', '(11) 8888-7777'])('does not resend an accepted legacy BR recipient stored as %s', async (storedLogPhone) => {
    logPhone = storedLogPhone;
    expect(await runWorker()).toMatchObject({ processed: 1, sent: 0, failed: 0 });
    expect(searchedPhones).toContain(storedLogPhone);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(updates).toContainEqual(expect.objectContaining({ status: 'sent', error_details: expect.stringContaining('Mensagem ja aceita') }));
  });

  it('does not suppress a Russian destination when only the Brazilian national spelling was accepted', async () => {
    queuePhone = '+79991234567'; logPhone = '79991234567';
    expect(await runWorker()).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(mocks.send).toHaveBeenCalledWith('https://offline.invalid', 'offline', 'instance', '+79991234567', 'Parabens!');
  });
});
