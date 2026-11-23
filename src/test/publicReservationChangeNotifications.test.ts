// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  belongsToCurrentReservationChange,
  getReservationChangeMessageEligibility,
  reservationChangeDispatchKey,
  reservationChangeRevision,
} from '../../supabase/functions/_shared/reservation-change-notifications.ts';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), authorize: vi.fn() }));
vi.mock('../../supabase/functions/_shared/internal-auth.ts', () => ({
  createSupabaseAdminClient: mocks.admin,
  isAuthorizedInternalJob: mocks.authorize,
}));

type Row = Record<string, unknown>;
type Handler = (request: Request) => Promise<Response>;
type Filter = { op: string; column: string; value: unknown };
const fixedNow = Date.parse('2026-11-22T15:00:00Z');
const revision = '2026-11-22T14:59:55.123456Z';
const olderRevision = '2026-11-22T14:59:55.123455Z';
let handler: Handler;
let tables: Record<string, Row[]>;
let claimedKeys: Set<string>;
let rpcCalls: Array<{ name: string; parameters: Row }>;
let lookupError: { code: string; message: string } | null;

function matches(row: Row, filters: Filter[]) {
  return filters.every(({ op, column, value }) => {
    const field = row[column];
    if (op === 'eq') return field === value;
    if (op === 'neq') return field !== value;
    if (op === 'in') return (value as unknown[]).includes(field);
    if (op === 'not-is') return (field ?? null) !== value;
    return true;
  });
}

function databaseStub() {
  return {
    rpc: vi.fn(async (name: string, parameters: Row) => {
      rpcCalls.push({ name, parameters });
      if (name === 'claim_whatsapp_dispatch') {
        const key = String(parameters._delivery_key);
        if (claimedKeys.has(key)) return { data: false, error: null };
        claimedKeys.add(key);
        return { data: true, error: null };
      }
      if (name === 'finalize_whatsapp_dispatch') return { data: null, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    }),
    from(table: string) {
      const filters: Filter[] = [];
      let inserted: Row | null = null;
      let columns = '*';
      const result = (single = false) => {
        if (table === 'reservations' && lookupError) return { data: null, error: lookupError };
        const source = tables[table] ?? (tables[table] = []);
        if (inserted) {
          const existing = inserted.idempotency_key && source.some((row) => row.idempotency_key === inserted!.idempotency_key);
          if (existing) return { data: null, error: { code: '23505', message: 'duplicate idempotency key' } };
          source.push({ id: `inserted-${source.length}`, status: 'pending', created_at: new Date().toISOString(), ...inserted });
          inserted = null;
        }
        const rows = source.filter((row) => matches(row, filters)).map((row) => {
          if (columns === '*') return { ...row };
          return Object.fromEntries(columns.split(',').map((column) => column.trim()).map((column) => [column, row[column]]));
        });
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const filter = (op: string, column: string, value: unknown) => { filters.push({ op, column, value }); return query; };
      const query = {
        select: (value: string) => { columns = value; return query; },
        insert: (value: Row) => { inserted = { ...value }; return query; },
        eq: (column: string, value: unknown) => filter('eq', column, value),
        neq: (column: string, value: unknown) => filter('neq', column, value),
        in: (column: string, value: unknown) => filter('in', column, value),
        not: (column: string, op: string, value: unknown) => filter(`not-${op}`, column, value),
        maybeSingle: async () => result(true),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  };
}

beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: (value: Handler) => { handler = value; }, env: { get: vi.fn() } });
  const entry = '../../supabase/functions/send-reminders/index.ts';
  await import(entry);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixedNow);
  lookupError = null;
  claimedKeys = new Set();
  rpcCalls = [];
  tables = {
    companies: [{ id: 'company-a', whatsapp_automation_channel: 'evolution' }],
    reservations: [],
    automation_settings: ['reminder_1h', 'reminder_24h'].map((type) => ({
      company_id: 'company-a', type, enabled: true,
      message_template: 'Olá {nome}, reserva em {data} às {hora} para {pessoas} pessoas.',
    })),
    pluguechat_automation_templates: ['reminder_1h', 'reminder_24h'].map((type) => ({
      company_id: 'company-a', type, enabled: true, template_id: 'template-a', template_name: 'Lembrete',
    })),
    whatsapp_message_queue: [], whatsapp_message_logs: [],
    pluguechat_message_queue: [], pluguechat_message_logs: [],
  };
  mocks.admin.mockReturnValue(databaseStub());
  mocks.authorize.mockResolvedValue(true);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

async function runScheduler() {
  const response = await handler(new Request('https://offline.invalid/send-reminders', { method: 'POST' }));
  expect(response.status).toBe(200);
  return response.json();
}

describe('public reservation change notification identity', () => {
  it('distinguishes changes one microsecond apart while accepting equivalent timezone notation', () => {
    expect(reservationChangeRevision(revision)).not.toBe(reservationChangeRevision(olderRevision));
    expect(reservationChangeRevision(revision)).toBe(reservationChangeRevision('2026-11-22T11:59:55.123456-03:00'));
    expect(reservationChangeDispatchKey('reservation:a:reminder', revision))
      .toBe(reservationChangeDispatchKey('reservation:a:reminder', '2026-11-22T11:59:55.123456-03:00'));
    expect(reservationChangeDispatchKey('reservation:a:reminder', revision))
      .not.toBe(reservationChangeDispatchKey('reservation:a:reminder', olderRevision));
  });

  it('retains legacy dispatch keys and historical records for reservations never changed', () => {
    expect(reservationChangeDispatchKey('reservation:a:reminder', null)).toBe('reservation:a:reminder');
    expect(belongsToCurrentReservationChange({}, { created_at: '2025-01-01T00:00:00Z' }, 'log')).toBe(true);
    expect(belongsToCurrentReservationChange({ last_public_change_at: null }, {}, 'queue')).toBe(true);
  });

  it('uses the queue snapshot rather than insertion time to identify stale messages', () => {
    const reservation = { last_public_change_at: revision };
    expect(belongsToCurrentReservationChange(reservation, {
      reservation_change_revision: olderRevision, created_at: '2026-11-22T15:00:00Z',
    }, 'queue')).toBe(false);
    expect(belongsToCurrentReservationChange(reservation, {
      reservation_change_revision: revision, created_at: '2026-11-22T15:00:00Z',
    }, 'queue')).toBe(true);
    expect(belongsToCurrentReservationChange(reservation, { created_at: '2026-11-22T15:00:00Z' }, 'queue')).toBe(false);
  });

  it('requires the explicit visit revision even when a log is inserted after the customer change', () => {
    expect(belongsToCurrentReservationChange({ last_public_change_at: revision }, {
      created_at: '2026-11-22T15:00:00Z', reservation_change_revision: olderRevision,
    }, 'log')).toBe(false);
    expect(belongsToCurrentReservationChange({ last_public_change_at: revision }, {
      created_at: '2026-11-22T15:00:00Z', reservation_change_revision: revision,
    }, 'log')).toBe(true);
    expect(belongsToCurrentReservationChange({ last_public_change_at: revision }, { created_at: revision }, 'log')).toBe(false);
    expect(belongsToCurrentReservationChange({ last_public_change_at: revision }, {}, 'log')).toBe(false);
  });

  it('fails closed on an unavailable reservation lookup, including a revised queue against an old schema', async () => {
    lookupError = { code: '08006', message: 'connection unavailable' };
    const item = { company_id: 'company-a', reservation_id: 'reservation-a', type: 'reminder_1h', reservation_change_revision: revision };
    expect(await getReservationChangeMessageEligibility(databaseStub(), item)).toEqual({ eligible: false, reason: 'lookup_failed' });
    lookupError = { code: '42703', message: 'last_public_change_at does not exist' };
    expect(await getReservationChangeMessageEligibility(databaseStub(), item)).toEqual({ eligible: false, reason: 'lookup_failed' });
    expect(await getReservationChangeMessageEligibility(databaseStub(), { ...item, reservation_change_revision: null }))
      .toEqual({ eligible: true });
  });

  it('does not require reservation lookup for unrelated notifications', async () => {
    lookupError = { code: '08006', message: 'connection unavailable' };
    expect(await getReservationChangeMessageEligibility(databaseStub(), {
      company_id: 'company-a', reservation_id: 'reservation-a', type: 'post_visit',
    })).toEqual({ eligible: true });
    expect(await getReservationChangeMessageEligibility(databaseStub(), {
      company_id: 'company-a', type: 'broadcast',
    })).toEqual({ eligible: true });
  });
});

describe.each(['evolution', 'pluguechat_official'] as const)('%s reminder scheduler after customer change', (channel) => {
  const queueTable = channel === 'evolution' ? 'whatsapp_message_queue' : 'pluguechat_message_queue';
  const logTable = channel === 'evolution' ? 'whatsapp_message_logs' : 'pluguechat_message_logs';

  function prepare(type: string, changedAt: string | null = revision) {
    tables.companies[0].whatsapp_automation_channel = channel;
    tables.reservations = [{
      id: 'reservation-a', company_id: 'company-a', guest_name: 'Ana Ribeiro', guest_phone: '+5562999990000',
      party_size: 6, date: type === 'reminder_1h' ? '2026-11-22' : '2026-11-23', time: '15:00:00',
      status: 'confirmed', created_at: '2026-11-21T12:00:00Z', last_public_change_at: changedAt,
    }];
  }

  it.each(['reminder_1h', 'reminder_24h'])('queues %s with the new visit snapshot despite old log and a stale queue inserted later', async (type) => {
    prepare(type);
    tables[logTable] = [{ reservation_id: 'reservation-a', type, status: 'sent', created_at: olderRevision }];
    tables[queueTable] = [{
      id: 'old-queue', reservation_id: 'reservation-a', type, status: 'pending',
      reservation_change_revision: olderRevision, created_at: '2026-11-22T15:00:00Z',
    }];

    expect(await runScheduler()).toMatchObject({ queued: 1, total: 1 });
    expect(tables[queueTable]).toHaveLength(2);
    const queued = tables[queueTable][1];
    expect(queued).toMatchObject({ reservation_id: 'reservation-a', type, reservation_change_revision: revision });
    if (channel === 'evolution') {
      expect(queued.message).toBe(`Olá Ana, reserva em ${type === 'reminder_1h' ? '22' : '23'}/11/2026 às 15:00 para 6 pessoas.`);
      expect(rpcCalls.find((call) => call.name === 'claim_whatsapp_dispatch')?.parameters._delivery_key).toContain(':change:');
    } else {
      expect(queued.parameters).toMatchObject({ nome: 'Ana', hora: '15:00', pessoas: '6' });
      if (type === 'reminder_24h') expect(queued.parameters).toHaveProperty('data', '23/11/2026');
      expect(queued.idempotency_key).toContain(':change:');
    }

    expect(await runScheduler()).toMatchObject({ queued: 0, skipped: 1 });
    expect(tables[queueTable]).toHaveLength(2);
  });

  it.each(['queue', 'log'])('does not duplicate the current revision already recorded in the %s', async (kind) => {
    prepare('reminder_1h');
    const table = kind === 'queue' ? queueTable : logTable;
    tables[table] = [{
      reservation_id: 'reservation-a', type: 'reminder_1h', status: 'sent',
      reservation_change_revision: revision, created_at: revision,
    }];
    expect(await runScheduler()).toMatchObject({ queued: 0, skipped: 1 });
    expect(tables[queueTable]).toHaveLength(kind === 'queue' ? 1 : 0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('keeps a reservation without customer changes on its existing reminder contract', async () => {
    prepare('reminder_1h', null);
    expect(await runScheduler()).toMatchObject({ queued: 1 });
    const queued = tables[queueTable][0];
    expect(queued).not.toHaveProperty('reservation_change_revision');
    const key = channel === 'evolution'
      ? rpcCalls.find((call) => call.name === 'claim_whatsapp_dispatch')?.parameters._delivery_key
      : queued.idempotency_key;
    expect(key).not.toContain(':change:');
    expect(await runScheduler()).toMatchObject({ queued: 0, skipped: 1 });
    expect(tables[queueTable]).toHaveLength(1);
  });

  it('does not let late reconciliation of an old delivery suppress the new visit reminder', async () => {
    prepare('reminder_1h');
    // Old delivery was accepted before the change, but its provider status was
    // reconciled and its previously missing log first persisted afterwards.
    tables[logTable] = [{
      reservation_id: 'reservation-a', type: 'reminder_1h', status: 'sent',
      reservation_change_revision: olderRevision, created_at: new Date(fixedNow).toISOString(),
    }];
    expect(await runScheduler()).toMatchObject({ queued: 1, total: 1 });
    expect(tables[queueTable][0]).toMatchObject({ reservation_change_revision: revision });
    expect(await runScheduler()).toMatchObject({ queued: 0, skipped: 1 });
    expect(tables[queueTable]).toHaveLength(1);
  });

  it('gives a later customer change its own reminder and dispatch key even within one millisecond', async () => {
    prepare('reminder_1h', olderRevision);
    expect(await runScheduler()).toMatchObject({ queued: 1 });
    const first = { ...tables[queueTable][0] };
    tables.reservations[0].last_public_change_at = revision;
    tables.reservations[0].party_size = 8;
    expect(await runScheduler()).toMatchObject({ queued: 1 });
    expect(tables[queueTable]).toHaveLength(2);
    const second = tables[queueTable][1];
    expect(second.reservation_change_revision).toBe(revision);
    if (channel === 'evolution') {
      expect(second.message).toContain('8 pessoas');
      const claims = rpcCalls.filter((call) => call.name === 'claim_whatsapp_dispatch');
      expect(claims[0].parameters._delivery_key).not.toBe(claims[1].parameters._delivery_key);
    } else {
      expect(second.parameters).toHaveProperty('pessoas', '8');
      expect(first.idempotency_key).not.toBe(second.idempotency_key);
    }
  });
});
