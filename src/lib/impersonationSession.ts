export type EffectiveCompanyRole = 'admin' | 'operator';

export interface ImpersonationSession {
  actorUserId: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  userId: string;
  userName: string;
  userEmail: string;
  effectiveRole: EffectiveCompanyRole;
  status: 'pending' | 'active';
  startedAt: string;
  supportSessionId?: string;
  expiresAt?: string;
}

export const IMPERSONATION_STORAGE_KEY = 'superadmin-impersonation-session';
export const IMPERSONATION_EVENT = 'superadmin-impersonation-change';
export const SUPPORT_IMPERSONATION_HEADER = 'x-support-impersonation';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getImpersonationSession(): ImpersonationSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(IMPERSONATION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ImpersonationSession>;
    if (
      ['actorUserId', 'companyId', 'companySlug', 'companyName', 'userId', 'userName', 'userEmail', 'startedAt']
        .some((key) => typeof value[key as keyof ImpersonationSession] !== 'string')
      || !['admin', 'operator'].includes(value.effectiveRole ?? '')
      || !['pending', 'active'].includes(value.status ?? '')
      || (value.supportSessionId !== undefined && (!UUID_PATTERN.test(value.supportSessionId) || !Number.isFinite(Date.parse(value.expiresAt ?? ''))))
    ) {
      window.sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
      return null;
    }
    return value as ImpersonationSession;
  } catch {
    window.sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
    return null;
  }
}

export function startImpersonationSession(session: ImpersonationSession) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(IMPERSONATION_STORAGE_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event(IMPERSONATION_EVENT));
}

export function clearImpersonationSession() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
  window.dispatchEvent(new Event(IMPERSONATION_EVENT));
}

function getTokenUserId(authorization: string | null): string | null {
  try {
    const token = authorization?.replace(/^Bearer\s+/i, '');
    const part = token?.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

// This header selects a server-validated delegation. It never changes the JWT
// or constitutes authorization on its own, and never reaches external URLs.
export function createSupportAwareFetch(supabaseUrl: string, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): typeof fetch {
  const base = new URL(supabaseUrl);
  return async (input, init) => {
    const session = getImpersonationSession();
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), base);
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.delete(SUPPORT_IMPERSONATION_HEADER);
    const sourceUserId = getTokenUserId(headers.get('Authorization'));
    const isSupabaseDataRequest = url.origin === base.origin
      && /^\/(rest|functions|storage)\/v1\//.test(url.pathname);
    const isIdentityBootstrap = url.pathname === '/rest/v1/rpc/get_my_memberships'
      || (url.pathname === '/rest/v1/profiles' && url.searchParams.get('id') === 'eq.' + sourceUserId);
    if (
      isSupabaseDataRequest && !isIdentityBootstrap
      && session?.supportSessionId && sourceUserId === session.actorUserId
      && Date.parse(session.expiresAt ?? '') > Date.now()
    ) {
      headers.set(SUPPORT_IMPERSONATION_HEADER, session.supportSessionId);
    }
    return fetchImpl(input, { ...init, headers });
  };
}
