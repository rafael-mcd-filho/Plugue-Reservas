import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import type { AppRole } from '@/lib/companyPermissions';
import {
  clearImpersonationSession, getImpersonationSession, startImpersonationSession,
  IMPERSONATION_EVENT, type ImpersonationSession,
} from '@/lib/impersonationSession';

export { clearImpersonationSession, getImpersonationSession, startImpersonationSession };
export type { ImpersonationSession };

export interface SupportImpersonationContext extends Omit<ImpersonationSession, 'status' | 'startedAt'> {
  id: string;
  expiresAt: string;
}

const IMPERSONATION_PENDING_GRACE_MS = 15000;

export function useImpersonation() {
  const location = useLocation();
  const { slug } = useParams<{ slug?: string }>();
  const { user, roles, loading } = useAuth();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<ImpersonationSession | null>(() => getImpersonationSession());
  const isSuperadmin = roles.includes('superadmin');
  const isSupport = roles.includes('support') && !isSuperadmin;
  const isSupportSession = isSupport && !!session?.supportSessionId && session.actorUserId === user?.id;
  const contextQuery = useQuery({
    queryKey: ['support-impersonation-context', user?.id, session?.supportSessionId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_support_impersonation_context');
      if (error) throw error;
      const context = data as SupportImpersonationContext | null;
      if (!context || context.actorUserId !== user?.id || context.companyId !== session?.companyId
        || context.userId !== session?.userId || context.id !== session?.supportSessionId
        || !['admin', 'operator'].includes(context.effectiveRole)
        || !Number.isFinite(Date.parse(context.expiresAt))
        || Date.parse(context.expiresAt) <= Date.now()) {
        throw new Error('A impersonação expirou ou o acesso foi removido.');
      }
      return context;
    },
    enabled: !loading && isSupportSession,
    staleTime: 5000,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    const syncSession = () => setSession(getImpersonationSession());
    window.addEventListener(IMPERSONATION_EVENT, syncSession);
    window.addEventListener('storage', syncSession);
    syncSession();
    return () => {
      window.removeEventListener(IMPERSONATION_EVENT, syncSession);
      window.removeEventListener('storage', syncSession);
    };
  }, []);

  useEffect(() => {
    if (!session || loading) return;
    const basePath = '/' + session.companySlug + '/admin';
    const pathMatches = location.pathname === basePath || location.pathname.startsWith(basePath + '/');
    const allowedActor = isSuperadmin ? !session.supportSessionId : isSupportSession;
    const expired = !!session.supportSessionId && Date.parse(session.expiresAt ?? '') <= Date.now();
    if (!user || !allowedActor || session.actorUserId !== user.id || expired || (isSupportSession && contextQuery.error)) {
      clearImpersonationSession();
      if (session.supportSessionId) queryClient.clear();
      return;
    }
    if (session.status === 'pending') {
      if (pathMatches) {
        startImpersonationSession({ ...session, status: 'active' });
      } else if (!Number.isFinite(Date.parse(session.startedAt)) || Date.now() - Date.parse(session.startedAt) > IMPERSONATION_PENDING_GRACE_MS) {
        clearImpersonationSession();
      }
    } else if (!pathMatches) {
      if (session.supportSessionId) {
        void (supabase as any).rpc('stop_support_impersonation', { _session_id: session.supportSessionId });
        queryClient.clear();
      }
      clearImpersonationSession();
    }
  }, [contextQuery.error, isSuperadmin, isSupportSession, loading, location.pathname, queryClient, session, user]);

  useEffect(() => {
    if (!session?.supportSessionId) return;
    const delay = Date.parse(session.expiresAt ?? '') - Date.now();
    const timeout = window.setTimeout(() => {
      clearImpersonationSession();
      queryClient.clear();
    }, Math.max(0, delay));
    return () => window.clearTimeout(timeout);
  }, [queryClient, session?.expiresAt, session?.supportSessionId]);

  const activeSession = useMemo(() => isSupportSession && contextQuery.data
    ? { ...session!, ...contextQuery.data }
    : session, [isSupportSession, contextQuery.data, session]);
  const isImpersonatingCompany = !!slug && !!activeSession && activeSession.companySlug === slug
    && (isSuperadmin || (isSupportSession && !!contextQuery.data && !contextQuery.error));
  const effectiveRoles = useMemo<AppRole[]>(
    () => isImpersonatingCompany && activeSession ? [activeSession.effectiveRole] : roles,
    [activeSession, isImpersonatingCompany, roles],
  );
  const auditMetadata = useMemo(() => isImpersonatingCompany && activeSession ? {
    impersonated_by_superadmin: isSuperadmin,
    impersonated_by_support: isSupport,
    effective_role: activeSession.effectiveRole,
    impersonated_slug: activeSession.companySlug,
    impersonated_user_id: activeSession.userId,
    impersonated_user_email: activeSession.userEmail,
    scope_company_id: activeSession.companyId,
    ...(session?.supportSessionId ? { impersonation_session_id: session.supportSessionId } : {}),
  } : {}, [activeSession, isImpersonatingCompany, isSuperadmin, isSupport, session?.supportSessionId]);

  const stopImpersonation = async () => {
    const stored = getImpersonationSession();
    try {
      if (stored?.supportSessionId) {
        await (supabase as any).rpc('stop_support_impersonation', { _session_id: stored.supportSessionId });
      }
    } finally {
      await queryClient.cancelQueries();
      clearImpersonationSession();
      queryClient.clear();
    }
  };

  return {
    isSuperadmin,
    isSupport,
    isImpersonatingCompany,
    impersonationLoading: isSupportSession && contextQuery.isPending,
    impersonationSession: isImpersonatingCompany ? activeSession : null,
    effectiveRole: isImpersonatingCompany && activeSession ? activeSession.effectiveRole : null,
    effectiveRoles,
    impersonatedSlug: isImpersonatingCompany ? activeSession?.companySlug ?? null : null,
    impersonatedCompanyId: isImpersonatingCompany ? activeSession?.companyId ?? null : null,
    impersonatedCompanyName: isImpersonatingCompany ? activeSession?.companyName ?? null : null,
    impersonatedUserId: isImpersonatingCompany ? activeSession?.userId ?? null : null,
    impersonatedUserName: isImpersonatingCompany ? activeSession?.userName ?? null : null,
    impersonatedUserEmail: isImpersonatingCompany ? activeSession?.userEmail ?? null : null,
    scopeCompanyId: isImpersonatingCompany ? activeSession?.companyId ?? null : null,
    auditMetadata,
    stopImpersonation,
  };
}
