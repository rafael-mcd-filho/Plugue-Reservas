// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesCanonicalPhone } from '../../supabase/functions/_shared/phone.ts';

vi.mock('../../supabase/functions/_shared/internal-auth.ts', () => ({
  createSupabaseAdminClient: vi.fn(),
  isAuthorizedInternalJob: vi.fn(),
}));

interface QueryCall {
  table: string;
  selected?: string;
  values?: Record<string, unknown>;
  filters: Array<{ operator: 'eq' | 'in' | 'or'; column?: string; value: unknown }>;
}

const russianPhone = '+79991234567';
const brazilianPhone = '+5579991234567';
let updateBroadcastRecipient: (database: unknown, item: Record<string, unknown>, status: string) => Promise<void>;
let calls: QueryCall[];
let candidates: Array<Record<string, unknown>>;

function databaseStub() {
  return {
    from(table: string) {
      const call: QueryCall = { table, filters: [] };
      calls.push(call);
      const builder = {
        select: vi.fn((columns: string) => { call.selected = columns; return builder; }),
        update: vi.fn((values: Record<string, unknown>) => { call.values = values; return builder; }),
        eq: vi.fn((column: string, value: unknown) => {
          call.filters.push({ operator: 'eq', column, value });
          return builder;
        }),
        in: vi.fn((column: string, value: unknown) => {
          call.filters.push({ operator: 'in', column, value });
          return builder;
        }),
        or: vi.fn((value: string) => {
          call.filters.push({ operator: 'or', value });
          return builder;
        }),
        then(resolve: (result: unknown) => unknown) {
          return Promise.resolve({ data: call.values ? null : candidates, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const queueItem = {
  id: 'queue-ru',
  company_id: 'company-1',
  type: 'broadcast',
  phone: '79991234567',
  phone_e164: russianPhone,
  idempotency_key: 'pluguechat:broadcast:broadcast-1:79991234567',
  provider_message_id: 'provider-1',
};

beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: vi.fn(), env: { get: vi.fn() } });
  const entrypoint = '../../supabase/functions/process-pluguechat-message-queue/index.ts';
  ({ updateBroadcastRecipient } = await import(entrypoint));
});

beforeEach(() => {
  calls = [];
  candidates = [
    { id: 'recipient-br', phone: '79991234567' },
    { id: 'recipient-ru', phone: '79991234567', phone_e164: russianPhone },
  ];
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden in phone queue tests'));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

describe('international queue identity', () => {
  it('distinguishes a Russian full number from an identical Brazilian national input', () => {
    expect(matchesCanonicalPhone({ phone: '79991234567' }, russianPhone)).toBe(false);
    expect(matchesCanonicalPhone({ phone: '79991234567' }, brazilianPhone)).toBe(true);
    expect(matchesCanonicalPhone({ phone: '79991234567', phone_e164: russianPhone }, russianPhone)).toBe(true);
    expect(matchesCanonicalPhone({ phone: russianPhone }, russianPhone)).toBe(true);
    expect(matchesCanonicalPhone({ phone: 'invalid' }, russianPhone)).toBe(false);
    expect(matchesCanonicalPhone({ phone: russianPhone }, '')).toBe(false);
  });

  it('updates only the canonical Russian recipient within its company and broadcast', async () => {
    await updateBroadcastRecipient(databaseStub(), queueItem, 'sent');

    expect(calls).toHaveLength(2);
    expect(calls[0].selected).toBe('id, phone, phone_e164');
    for (const call of calls) {
      expect(call.table).toBe('pluguechat_broadcast_recipients');
      expect(call.filters).toContainEqual({ operator: 'eq', column: 'broadcast_id', value: 'broadcast-1' });
      expect(call.filters).toContainEqual({ operator: 'eq', column: 'company_id', value: 'company-1' });
    }
    expect(calls[1].filters).toContainEqual({ operator: 'in', column: 'id', value: ['recipient-ru'] });
    expect(calls[1].values).toMatchObject({ queue_id: 'queue-ru', status: 'sent', provider_message_id: 'provider-1' });
  });

  it('does not mutate a Brazilian recipient returned by a matching digits variant', async () => {
    candidates = [{ id: 'recipient-br', phone: '79991234567' }];
    await updateBroadcastRecipient(databaseStub(), queueItem, 'sent');
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toBeUndefined();
  });

  it('accepts canonical raw international input when the sidecar has not been filled', async () => {
    candidates = [{ id: 'recipient-ru', phone: russianPhone }];
    await updateBroadcastRecipient(databaseStub(), { ...queueItem, phone: russianPhone, phone_e164: null }, 'failed');
    expect(calls[1].filters).toContainEqual({ operator: 'in', column: 'id', value: ['recipient-ru'] });
    expect(calls[1].values?.status).toBe('failed');
  });

  it('reconciles a legacy eight-digit BR recipient using its full DDI identity', async () => {
    candidates = [
      { id: 'legacy-national', phone: '(11) 8888-7777' },
      { id: 'foreign', phone: '+1188887777' },
    ];
    await updateBroadcastRecipient(databaseStub(), {
      ...queueItem, phone: '1188887777', phone_e164: null,
    }, 'sent');
    expect(calls[0].filters).toContainEqual({
      operator: 'or',
      value: 'phone_e164.eq.+551188887777,phone.in.("+551188887777","551188887777","1188887777","(11) 8888-7777")',
    });
    expect(calls[1].filters).toContainEqual({ operator: 'in', column: 'id', value: ['legacy-national'] });
  });

  it.each([
    { type: 'birthday_message' },
    { idempotency_key: null },
    { idempotency_key: 'unrelated-key' },
    { phone: 'invalid', phone_e164: null },
  ])('avoids recipient queries for ineligible queue items %o', async (overrides) => {
    await updateBroadcastRecipient(databaseStub(), { ...queueItem, ...overrides }, 'sent');
    expect(calls).toHaveLength(0);
  });
});
