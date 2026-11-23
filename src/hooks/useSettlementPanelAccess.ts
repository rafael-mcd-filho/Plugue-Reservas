import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getImpersonationSession, IMPERSONATION_EVENT } from '@/lib/impersonationSession';
import { getSettlementPanelAccess } from '@/lib/reservation-settlement-access';

export function useSettlementPanelAccess(companyId: string) {
  const { user, roles, loading } = useAuth();
  const [session, setSession] = useState(getImpersonationSession);
  useEffect(() => {
    const sync = () => setSession(getImpersonationSession());
    window.addEventListener(IMPERSONATION_EVENT, sync);
    window.addEventListener('storage', sync);
    sync();
    return () => {
      window.removeEventListener(IMPERSONATION_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return getSettlementPanelAccess({ companyId, roles, userId: user?.id, loading, session });
}
