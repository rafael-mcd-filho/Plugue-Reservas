import type { ImpersonationSession } from '@/lib/impersonationSession';

export function getSettlementPanelAccess(input: {
  companyId: string;
  roles: string[];
  userId?: string;
  loading?: boolean;
  session: ImpersonationSession | null;
}) {
  const { companyId, roles, userId, loading, session } = input;
  if (loading) return { canRead: false, canWrite: false, isLoading: true };
  if (roles.includes('support') || session?.supportSessionId) return { canRead: false, canWrite: false, isLoading: false };
  if (session) {
    // Superadmin impersonation changes the UI's effective role, not the
    // authenticated JWT. The API still validates and records the real actor.
    const validSuperadmin = roles.includes('superadmin') && !!userId
      && session.actorUserId === userId && session.companyId === companyId
      && session.effectiveRole === 'admin';
    if (validSuperadmin && session.status === 'pending') return { canRead: false, canWrite: false, isLoading: true };
    return { canRead: validSuperadmin && session.status === 'active',
      canWrite: validSuperadmin && session.status === 'active', isLoading: false };
  }
  const administrator = roles.includes('admin') || roles.includes('superadmin');
  return { canRead: administrator, canWrite: administrator, isLoading: false };
}
