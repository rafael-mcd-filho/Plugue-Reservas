import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSupportAwareFetch, getImpersonationSession, startImpersonationSession,
  IMPERSONATION_STORAGE_KEY, SUPPORT_IMPERSONATION_HEADER, type ImpersonationSession,
} from './impersonationSession';

const actorId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000009';
const storedSession: ImpersonationSession = {
  actorUserId: actorId, companyId: 'company-one', companySlug: 'company-one', companyName: 'Empresa A',
  userId: 'target-one', userName: 'Ana', userEmail: 'ana@example.test', effectiveRole: 'operator',
  status: 'active', startedAt: new Date().toISOString(), supportSessionId: sessionId,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
const token = (sub = actorId) => 'header.' + btoa(JSON.stringify({ sub })) + '.signature';

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

async function request(path: string, options?: { sub?: string; method?: string; forgedHeader?: boolean }) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const awareFetch = createSupportAwareFetch('https://local-supabase.test', fetchMock);
  await awareFetch(path.startsWith('https://') ? path : 'https://local-supabase.test' + path, {
    method: options?.method ?? 'GET',
    headers: { Authorization: 'Bearer ' + token(options?.sub), ...(options?.forgedHeader ? { [SUPPORT_IMPERSONATION_HEADER]: 'forged' } : {}) },
  });
  return new Headers(fetchMock.mock.calls[0][1]?.headers);
}

describe('support delegation transport', () => {
  it.each(['/rest/v1/reservations', '/rest/v1/rpc/get_support_impersonation_context', '/functions/v1/manage-user', '/storage/v1/object/company/image'])('attaches the delegation only to authenticated Supabase data requests: %s', async (path) => {
    startImpersonationSession(storedSession);
    const headers = await request(path);
    expect(headers.get(SUPPORT_IMPERSONATION_HEADER)).toBe(sessionId);
    expect(headers.get('Authorization')).toBe('Bearer ' + token());
  });

  it.each(['/auth/v1/user', '/rest/v1/rpc/get_my_memberships', '/rest/v1/profiles?id=eq.' + actorId, 'https://external.test/functions/v1/manage-user'])('does not send the session to auth/bootstrap/external endpoints: %s', async (path) => {
    startImpersonationSession(storedSession);
    expect((await request(path, { forgedHeader: true })).has(SUPPORT_IMPERSONATION_HEADER)).toBe(false);
  });

  it('never reuses a delegation after changing the authenticated account', async () => {
    startImpersonationSession(storedSession);
    expect((await request('/rest/v1/reservations', { sub: 'someone-else' })).has(SUPPORT_IMPERSONATION_HEADER)).toBe(false);
  });

  it('drops expired or malformed delegations before issuing requests', async () => {
    startImpersonationSession({ ...storedSession, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await request('/rest/v1/reservations')).has(SUPPORT_IMPERSONATION_HEADER)).toBe(false);
    sessionStorage.setItem(IMPERSONATION_STORAGE_KEY, JSON.stringify({ ...storedSession, supportSessionId: 'invalid' }));
    expect(getImpersonationSession()).toBeNull();
    expect(sessionStorage.getItem(IMPERSONATION_STORAGE_KEY)).toBeNull();
  });

  it('keeps the existing superadmin session free of delegation headers', async () => {
    startImpersonationSession({ ...storedSession, supportSessionId: undefined, expiresAt: undefined });
    expect((await request('/rest/v1/reservations', { forgedHeader: true })).has(SUPPORT_IMPERSONATION_HEADER)).toBe(false);
  });
});
