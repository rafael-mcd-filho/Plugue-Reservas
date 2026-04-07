import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

type AppRole = 'superadmin' | 'admin' | 'operator';
type EffectiveCompanyRole = 'admin' | 'operator';

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
}

const IMPERSONATION_STORAGE_KEY = 'superadmin-impersonation-session';
const IMPERSONATION_EVENT = 'superadmin-impersonation-change';
const IMPERSONATION_PENDING_GRACE_MS = 15000;
let cachedSessionRaw: string | null | undefined;
let cachedSessionValue: ImpersonationSession | null = null;

function isBrowser() {
  return typeof window !== 'undefined';
}

function readStoredSession(): ImpersonationSession | null {
  if (!isBrowser()) return null;

  const raw = window.sessionStorage.getItem(IMPERSONATION_STORAGE_KEY);
  if (raw === cachedSessionRaw) {
    return cachedSessionValue;
  }

  cachedSessionRaw = raw;

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ImpersonationSession>;
    if (
      typeof parsed.actorUserId !== 'string'
      || typeof parsed.companyId !== 'string'
      || typeof parsed.companySlug !== 'string'
      || typeof parsed.companyName !== 'string'
      || typeof parsed.userId !== 'string'
      || typeof parsed.userName !== 'string'
      || typeof parsed.userEmail !== 'string'
      || (parsed.effectiveRole !== 'admin' && parsed.effectiveRole !== 'operator')
      || (parsed.status !== 'pending' && parsed.status !== 'active')
      || typeof parsed.startedAt !== 'string'
    ) {
      window.sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
      cachedSessionRaw = null;
      cachedSessionValue = null;
      return null;
    }

    cachedSessionValue = parsed as ImpersonationSession;
    return cachedSessionValue;
  } catch {
    window.sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
    cachedSessionRaw = null;
    cachedSessionValue = null;
    return null;
  }
}

function emitImpersonationChange() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(IMPERSONATION_EVENT));
}

function persistImpersonationSession(session: ImpersonationSession | null, emit = true) {
  if (!isBrowser()) return;

  if (!session) {
    cachedSessionRaw = null;
    cachedSessionValue = null;
    window.sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
  } else {
    const serialized = JSON.stringify(session);
    cachedSessionRaw = serialized;
    cachedSessionValue = session;
    window.sessionStorage.setItem(IMPERSONATION_STORAGE_KEY, serialized);
  }

  if (emit) {
    emitImpersonationChange();
  }
}

function isImpersonationPath(pathname: string, session: ImpersonationSession) {
  const basePath = `/${session.companySlug}/admin`;
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export function startImpersonationSession(session: ImpersonationSession) {
  if (!isBrowser()) return;
  persistImpersonationSession(session, true);
}

export function clearImpersonationSession() {
  if (!isBrowser()) return;
  persistImpersonationSession(null, true);
}

export function getImpersonationSession() {
  return readStoredSession();
}

export function useImpersonation() {
  const location = useLocation();
  const { slug } = useParams<{ slug?: string }>();
  const { user, roles, loading } = useAuth();
  const [session, setSession] = useState<ImpersonationSession | null>(() => readStoredSession());

  useEffect(() => {
    if (!isBrowser()) return;

    const syncSession = () => {
      setSession(readStoredSession());
    };

    window.addEventListener(IMPERSONATION_EVENT, syncSession);
    window.addEventListener('storage', syncSession);

    syncSession();

    return () => {
      window.removeEventListener(IMPERSONATION_EVENT, syncSession);
      window.removeEventListener('storage', syncSession);
    };
  }, []);

  useEffect(() => {
    if (!isBrowser()) return;
    if (!session) return;
    if (loading) return;

    const isSuperadmin = roles.includes('superadmin');
    const pathMatchesSession = isImpersonationPath(location.pathname, session);

    if (!user || !isSuperadmin || session.actorUserId !== user.id) {
      persistImpersonationSession(null, true);
      setSession(null);
      return;
    }

    if (session.status === 'pending') {
      if (pathMatchesSession) {
        const nextSession: ImpersonationSession = {
          ...session,
          status: 'active',
        };
        if (nextSession.status !== session.status) {
          persistImpersonationSession(nextSession, true);
          setSession(nextSession);
        }
        return;
      }

      const startedAtMs = Date.parse(session.startedAt);
      if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs > IMPERSONATION_PENDING_GRACE_MS) {
        persistImpersonationSession(null, true);
        setSession(null);
      }
      return;
    }

    if (!pathMatchesSession) {
      persistImpersonationSession(null, true);
      setSession(null);
    }
  }, [loading, location.pathname, roles, session, user]);

  const isSuperadmin = roles.includes('superadmin');
  const isImpersonatingCompany = isSuperadmin && !!slug && !!session && session.companySlug === slug;
  const effectiveRoles = useMemo<AppRole[]>(
    () => (isImpersonatingCompany && session ? [session.effectiveRole] : roles),
    [isImpersonatingCompany, roles, session],
  );

  const auditMetadata = useMemo(
    () => (isImpersonatingCompany && session
      ? {
          impersonated_by_superadmin: true,
          effective_role: session.effectiveRole,
          impersonated_slug: session.companySlug,
          impersonated_user_id: session.userId,
          impersonated_user_email: session.userEmail,
          scope_company_id: session.companyId,
        }
      : {}),
    [isImpersonatingCompany, session],
  );

  return {
    isSuperadmin,
    isImpersonatingCompany,
    impersonationSession: isImpersonatingCompany ? session : null,
    effectiveRole: isImpersonatingCompany && session ? session.effectiveRole : null,
    effectiveRoles,
    impersonatedSlug: isImpersonatingCompany && session ? session.companySlug : null,
    impersonatedCompanyId: isImpersonatingCompany && session ? session.companyId : null,
    impersonatedCompanyName: isImpersonatingCompany && session ? session.companyName : null,
    impersonatedUserId: isImpersonatingCompany && session ? session.userId : null,
    impersonatedUserName: isImpersonatingCompany && session ? session.userName : null,
    impersonatedUserEmail: isImpersonatingCompany && session ? session.userEmail : null,
    scopeCompanyId: isImpersonatingCompany && session ? session.companyId : null,
    auditMetadata,
    stopImpersonation: clearImpersonationSession,
  };
}
