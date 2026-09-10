// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAdmin: vi.fn(),
  authorize: vi.fn(),
  channels: vi.fn(),
  enqueueOfficial: vi.fn(),
  claimUnofficial: vi.fn(),
  enqueueUnofficial: vi.fn(),
  finalizeUnofficial: vi.fn(),
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

const token = '7c32fb56386b4bc0ba62e76f19c03b67';
const origin = 'https://plugguest.com.br';
const slug = 'beco-magico-goiania';
const reviewUrl = `${origin}/${slug}/avaliacao/${token}`;
let handler: (request: Request) => Promise<Response>;
let rows: Record<string, Array<Record<string, unknown>>>;
let updates: Array<{ table: string; values: Record<string, unknown> }>;
let appUrl: string | undefined;
let databaseErrors: Record<string, { message: string; code: string }>;
let tableCalls: string[];
let batchFilters: Array<{ table: string; column: string; values: unknown[] }>;

function createDatabaseStub() {
  return {
    from(table: string) {
      tableCalls.push(table);
      let selectedRows = [...(rows[table] ?? [])];
      const query = {
        select: vi.fn(() => query),
        in: vi.fn((column: string, values: unknown[]) => {
          batchFilters.push({ table, column, values });
          return query;
        }),
        eq: vi.fn(() => query),
        neq: vi.fn(() => query),
        not: vi.fn(() => query),
        is: vi.fn(() => query),
        update: vi.fn((values: Record<string, unknown>) => {
          updates.push({ table, values });
          selectedRows = [];
          return query;
        }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: selectedRows, error: databaseErrors[table] ?? null }).then(resolve);
        },
      };
      return query;
    },
  };
}

async function runJob() {
  const response = await handler(new Request('https://local.invalid/send-post-visit', { method: 'POST' }));
  expect(response.status).toBe(200);
  return response.json();
}

function setOfficialMode(mode: boolean | null | undefined) {
  rows.pluguechat_automation_templates[0].post_visit_include_review_link = mode;
}

type ReviewConfigState = 'enabled' | 'disabled' | 'unavailable' | 'missing';

function setReviewConfig(state: ReviewConfigState) {
  rows.company_nps_configs = state === 'missing'
    ? []
    : [{ company_id: 'company-1', enabled: state !== 'disabled' }];
  if (state === 'unavailable') {
    databaseErrors.company_nps_configs = { code: '57014', message: 'Synthetic query timeout' };
  }
}

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    serve: (callback: typeof handler) => { handler = callback; },
    env: { get: (key: string) => key === 'APP_URL' ? appUrl : undefined },
  });
  // The Edge runtime is mocked; do not pull Deno-only types into the frontend.
  const entrypoint = '../../supabase/functions/send-post-visit/index.ts';
  await import(entrypoint);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T11:10:00Z'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden in dispatch tests'));
  appUrl = origin;
  updates = [];
  databaseErrors = {};
  tableCalls = [];
  batchFilters = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rows = {
    reservations: [{
      id: 'reservation-1', company_id: 'company-1', guest_name: 'Ana Maria',
      guest_phone: '81900000000', date: '2026-09-09', time: '19:00:00', party_size: 2,
      status: 'completed',
    }],
    automation_settings: [{ company_id: 'company-1', enabled: true, message_template: 'Obrigado, {nome}! {link_avaliacao}' }],
    pluguechat_automation_templates: [{
      company_id: 'company-1', enabled: true, template_id: 'post-visit-template',
      template_name: 'Pós-visita', post_visit_include_review_link: true,
    }],
    reservation_reviews: [{ reservation_id: 'reservation-1', review_token: token }],
    companies: [{ id: 'company-1', slug }],
    company_nps_configs: [{ company_id: 'company-1', enabled: true }],
  };
  mocks.createAdmin.mockReturnValue(createDatabaseStub());
  mocks.authorize.mockResolvedValue(true);
  mocks.channels.mockResolvedValue(new Map([['company-1', 'pluguechat_official']]));
  mocks.enqueueOfficial.mockResolvedValue('inserted');
  mocks.claimUnofficial.mockResolvedValue(true);
  mocks.enqueueUnofficial.mockResolvedValue('inserted');
  mocks.finalizeUnofficial.mockResolvedValue(undefined);
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

describe('post-visit job — channel-specific review contract', () => {
  it('enqueues only the review token for PlugueChat with evaluation', async () => {
    expect(await runJob()).toMatchObject({ queued: 1, skipped_missing_review: 0 });
    expect(mocks.enqueueOfficial).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      template_id: 'post-visit-template', parameters: { nome: 'Ana', data: '09/09/2026', link_avaliacao: token },
      idempotency_key: 'pluguechat:reservation:reservation-1:post_visit',
    }));
    expect(updates).toEqual([{ table: 'reservation_reviews', values: expect.objectContaining({ sent_channel: 'pluguechat' }) }]);
    expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
  });

  it('does not require APP_URL or company slug for the official template prefix', async () => {
    appUrl = undefined;
    rows.companies = [];
    expect(await runJob()).toMatchObject({ queued: 1 });
    expect(mocks.enqueueOfficial.mock.calls[0][1].parameters.link_avaliacao).toBe(token);
  });

  it.each([true, false])('sends name/date only without evaluation (existing review: %s)', async (hasReview) => {
    setOfficialMode(false);
    if (!hasReview) rows.reservation_reviews = [];
    expect(await runJob()).toMatchObject({ queued: 1, skipped_missing_review: 0 });
    expect(mocks.enqueueOfficial.mock.calls[0][1].parameters).toEqual({ nome: 'Ana', data: '09/09/2026' });
    expect(updates).toEqual([]);
  });

  it('does not enqueue an empty required review parameter or mark an invitation as sent', async () => {
    rows.reservation_reviews = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runJob()).toMatchObject({ queued: 0, skipped: 1, skipped_missing_review: 1 });
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('review availability diagnostics'), expect.objectContaining({
      skipped_missing_review: 1,
    }));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('reservation-1');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('81900000000');
  });

  it('continues the batch after a review token is missing for one customer', async () => {
    rows.reservations.push({ ...rows.reservations[0], id: 'reservation-2' });
    rows.reservation_reviews = [{ reservation_id: 'reservation-2', review_token: token }];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runJob()).toMatchObject({ queued: 1, skipped: 1, skipped_missing_review: 1 });
    expect(mocks.enqueueOfficial).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueOfficial.mock.calls[0][1].reservation_id).toBe('reservation-2');
  });

  it.each([null, undefined])('keeps legacy parameter presence for unreviewed mode %s', async (mode) => {
    rows.pluguechat_automation_templates[0].post_visit_include_review_link = mode;
    rows.reservation_reviews = [];
    expect(await runJob()).toMatchObject({ queued: 1 });
    expect(mocks.enqueueOfficial.mock.calls[0][1].parameters).toEqual({ nome: 'Ana', data: '09/09/2026', link_avaliacao: '' });
    expect(updates).toEqual([]);
  });

  it('does not mark a duplicate official enqueue as a new review invitation', async () => {
    mocks.enqueueOfficial.mockResolvedValue('duplicate');
    expect(await runJob()).toMatchObject({ queued: 0, skipped: 1 });
    expect(updates).toEqual([]);
  });

  it('does not resend an already queued official message', async () => {
    rows.pluguechat_message_queue = [{ reservation_id: 'reservation-1' }];
    expect(await runJob()).toMatchObject({ queued: 0, skipped: 1 });
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('keeps the full review URL in the non-official message', async () => {
    mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution']]));
    expect(await runJob()).toMatchObject({ queued: 1 });
    expect(mocks.enqueueUnofficial).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      message: `Obrigado, Ana! ${reviewUrl}`,
    }));
    expect(updates).toEqual([{ table: 'reservation_reviews', values: expect.objectContaining({ sent_channel: 'whatsapp' }) }]);
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
  });

  it('does not append or record an evaluation when the non-official text does not use it', async () => {
    mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution']]));
    rows.automation_settings[0].message_template = 'Obrigado, {nome}, pela visita em {data}.';
    expect(await runJob()).toMatchObject({ queued: 1 });
    expect(mocks.enqueueUnofficial.mock.calls[0][1].message).toBe('Obrigado, Ana, pela visita em 09/09/2026.');
    expect(updates).toEqual([]);
  });

  it('does not send an incomplete invitation if the full non-official URL cannot be built', async () => {
    mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution']]));
    appUrl = undefined;
    expect(await runJob()).toMatchObject({ queued: 0, skipped: 1, skipped_missing_review: 1 });
    expect(mocks.claimUnofficial).not.toHaveBeenCalled();
    expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('does not mark a duplicate non-official enqueue as a new invitation', async () => {
    mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution']]));
    mocks.enqueueUnofficial.mockResolvedValue('duplicate');
    expect(await runJob()).toMatchObject({ queued: 0 });
    expect(updates).toEqual([]);
  });

  it('rejects unauthorized requests before reading or enqueuing anything', async () => {
    mocks.authorize.mockResolvedValue(false);
    const response = await handler(new Request('https://local.invalid/send-post-visit', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
  });

  it('keeps the existing daily dispatch window', async () => {
    vi.setSystemTime(new Date('2026-09-10T13:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runJob()).toMatchObject({ skipped: true, reason: 'outside_post_visit_window' });
    expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
    expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
  });

  it.each(
    ([true, false, null, undefined] as const).flatMap((mode) => (
      ['enabled', 'disabled', 'unavailable', 'missing'] as const
    ).map((state) => ({ mode, state }))),
  )('respects company review availability for official mode=$mode, config=$state', async ({ mode, state }) => {
    setOfficialMode(mode);
    setReviewConfig(state);
    const isLegacy = mode == null;
    const canSend = mode !== true || state === 'enabled';
    const configUnknown = state === 'unavailable';
    const result = await runJob();

    expect(result).toMatchObject({
      queued: canSend ? 1 : 0,
      skipped: canSend ? 0 : 1,
      skipped_review_disabled: !canSend && !configUnknown ? 1 : 0,
      skipped_review_config_unavailable: !canSend && configUnknown ? 1 : 0,
      legacy_templates_preserved: isLegacy ? 1 : 0,
      review_config_unavailable: configUnknown,
    });
    if (canSend) {
      expect(mocks.enqueueOfficial).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueOfficial.mock.calls[0][1].parameters).toEqual(mode === false
        ? { nome: 'Ana', data: '09/09/2026' }
        : { nome: 'Ana', data: '09/09/2026', link_avaliacao: isLegacy ? reviewUrl : token });
      expect(updates).toHaveLength(mode === false ? 0 : 1);
    } else {
      expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
      expect(console.warn).toHaveBeenCalled();
    }
    expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'disabled', 'unavailable', 'missing'] as const)(
    'does not require review availability for non-official name/date text: %s',
    async (state) => {
      mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution']]));
      rows.automation_settings[0].message_template = 'Obrigado, {nome}, pela visita em {data}.';
      setReviewConfig(state);
      expect(await runJob()).toMatchObject({
        queued: 1,
        skipped: 0,
        review_config_unavailable: state === 'unavailable',
      });
      expect(mocks.enqueueUnofficial.mock.calls[0][1].message).toBe('Obrigado, Ana, pela visita em 09/09/2026.');
      expect(updates).toEqual([]);
    },
  );

  it.each(['disabled', 'unavailable', 'missing'] as const)(
    'does not send an existing review token through the non-official API when reviews are %s',
    async (state) => {
      mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution']]));
      setReviewConfig(state);
      expect(await runJob()).toMatchObject({
        queued: 0,
        skipped: 1,
        skipped_review_disabled: state === 'unavailable' ? 0 : 1,
        skipped_review_config_unavailable: state === 'unavailable' ? 1 : 0,
        review_config_unavailable: state === 'unavailable',
      });
      expect(mocks.claimUnofficial).not.toHaveBeenCalled();
      expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    },
  );

  it.each(['ftp://example.com', 'javascript:alert(1)', 'not-a-url'])(
    'does not send an invalid non-official review URL using origin %s',
    async (invalidUrl) => {
      mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution']]));
      appUrl = invalidUrl;
      expect(await runJob()).toMatchObject({ queued: 0, skipped_missing_review: 1 });
      expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    },
  );

  it.each(['evolution', 'pluguechat_official'] as const)(
    'does not enqueue an invalid token through %s when the review variable is required',
    async (channel) => {
      mocks.channels.mockResolvedValue(new Map([['company-1', channel]]));
      rows.reservation_reviews[0].review_token = 'invalid-token';
      expect(await runJob()).toMatchObject({ queued: 0, skipped_missing_review: 1 });
      expect(mocks.enqueueOfficial).not.toHaveBeenCalled();
      expect(mocks.enqueueUnofficial).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    },
  );

  it.each(['disabled', 'unavailable'] as const)(
    'preserves a legacy template alongside a new name/date-only message when reviews are %s',
    async (state) => {
      setOfficialMode(null);
      setReviewConfig(state);
      rows.reservations.push({ ...rows.reservations[0], id: 'reservation-2', company_id: 'company-2' });
      rows.pluguechat_automation_templates.push({
        company_id: 'company-2', enabled: true, template_id: 'name-date-only',
        post_visit_include_review_link: false,
      });
      mocks.channels.mockResolvedValue(new Map([
        ['company-1', 'pluguechat_official'],
        ['company-2', 'pluguechat_official'],
      ]));

      expect(await runJob()).toMatchObject({
        queued: 2,
        skipped: 0,
        legacy_templates_preserved: 1,
      });
      expect(mocks.enqueueOfficial).toHaveBeenCalledTimes(2);
      expect(mocks.enqueueOfficial.mock.calls[0][1]).toMatchObject({
        reservation_id: 'reservation-1',
        parameters: { nome: 'Ana', data: '09/09/2026', link_avaliacao: reviewUrl },
      });
      expect(mocks.enqueueOfficial.mock.calls[1][1]).toMatchObject({
        reservation_id: 'reservation-2',
        parameters: { nome: 'Ana', data: '09/09/2026' },
      });
      expect(updates).toHaveLength(1);
    },
  );

  it.each(
    ([null, undefined] as const).flatMap((mode) => (
      ['token', 'origin', 'slug'] as const
    ).map((missing) => ({ mode, missing }))),
  )('preserves the legacy empty parameter when missing $missing (mode=$mode)', async ({ mode, missing }) => {
    setOfficialMode(mode);
    setReviewConfig('disabled');
    if (missing === 'token') rows.reservation_reviews = [];
    if (missing === 'origin') appUrl = undefined;
    if (missing === 'slug') rows.companies = [];
    expect(await runJob()).toMatchObject({ queued: 1, skipped: 0, legacy_templates_preserved: 1 });
    expect(mocks.enqueueOfficial.mock.calls[0][1].parameters).toEqual({
      nome: 'Ana', data: '09/09/2026', link_avaliacao: '',
    });
    // Keep the historical sent_at behavior for legacy; do not rewrite history at rollout.
    expect(updates).toHaveLength(missing === 'token' ? 0 : 1);
  });

  it('continues the non-official batch after a review-dependent message is unavailable', async () => {
    setReviewConfig('disabled');
    rows.reservations.push({ ...rows.reservations[0], id: 'reservation-2', company_id: 'company-2' });
    rows.automation_settings.push({
      company_id: 'company-2', enabled: true, message_template: 'Obrigado, {nome}, pela visita em {data}.',
    });
    mocks.channels.mockResolvedValue(new Map([['company-1', 'evolution'], ['company-2', 'evolution']]));
    expect(await runJob()).toMatchObject({ queued: 1, skipped: 1, skipped_review_disabled: 1 });
    expect(mocks.enqueueUnofficial).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueUnofficial.mock.calls[0][1].reservation_id).toBe('reservation-2');
    expect(updates).toEqual([]);
  });

  it('fetches review configuration once for all companies and never logs customer details', async () => {
    setReviewConfig('unavailable');
    rows.reservations.push({ ...rows.reservations[0], id: 'reservation-2', company_id: 'company-2' });
    rows.pluguechat_automation_templates.push({
      company_id: 'company-2', enabled: true, template_id: 'another-template',
      post_visit_include_review_link: true,
    });
    mocks.channels.mockResolvedValue(new Map([
      ['company-1', 'pluguechat_official'], ['company-2', 'pluguechat_official'],
    ]));

    expect(await runJob()).toMatchObject({ queued: 0, skipped: 2, skipped_review_config_unavailable: 2 });
    expect(tableCalls.filter((table) => table === 'company_nps_configs')).toHaveLength(1);
    expect(batchFilters.filter((filter) => filter.table === 'company_nps_configs')).toEqual([
      { table: 'company_nps_configs', column: 'company_id', values: ['company-1', 'company-2'] },
    ]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const warnings = JSON.stringify(vi.mocked(console.warn).mock.calls);
    for (const privateValue of ['company-1', 'reservation-1', '81900000000', 'Ana', token]) {
      expect(warnings).not.toContain(privateValue);
    }
  });
});
