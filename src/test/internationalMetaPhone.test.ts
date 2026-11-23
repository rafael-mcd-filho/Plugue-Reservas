// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../supabase/functions/_shared/internal-auth.ts', () => ({
  assertUserCanAccessCompany: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  isAuthorizedInternalJob: vi.fn(),
}));

let buildUserDataPayload: (params: { phone?: string | null }) => Promise<{ ph: string | null }>;
beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: vi.fn(), env: { get: vi.fn() } });
  const entrypoint = '../../supabase/functions/process-meta-event-queue/index.ts';
  const module = await import(entrypoint);
  buildUserDataPayload = module.buildUserDataPayload;
});
afterAll(() => vi.unstubAllGlobals());

describe('Meta international phone hashing (offline)', () => {
  it.each([
    ['+1 407 264 1934', '14072641934'],
    ['(11) 99876-5432', '5511998765432'],
    ['(11) 8888-7777', '551188887777'],
    ['+351 912 345 678', '351912345678'],
  ])('hashes the complete international digits for %s', async (phone, digits) => {
    const payload = await buildUserDataPayload({ phone });
    expect(payload.ph).toBe(createHash('sha256').update(digits).digest('hex'));
  });

  it('omits invalid phone rather than hashing a guessed country code', async () => {
    expect((await buildUserDataPayload({ phone: '+9991234567' })).ph).toBeNull();
  });
});
