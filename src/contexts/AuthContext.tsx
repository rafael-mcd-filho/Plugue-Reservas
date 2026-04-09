import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { trackAccessAudit } from '@/lib/accessAudit';
import { isStrongPassword, PASSWORD_REQUIREMENTS_TEXT } from '@/lib/validation';

type AppRole = 'superadmin' | 'admin' | 'operator';

interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  is_active: boolean;
}

interface Membership {
  role: AppRole;
  company_id: string | null;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  roles: AppRole[];
  loading: boolean;
  signIn: (email: string, password: string, options?: { slug?: string | null }) => Promise<{ error: any }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  refreshUserData: () => Promise<void>;
  hasRole: (role: AppRole) => boolean;
  hasAnyRole: (roles: AppRole[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const ACCESS_RESTRICTED_MESSAGE = 'Acesso restrito. Sua conta foi inativada. Entre em contato com o administrador.';

function isRestrictedAuthError(message: string | undefined) {
  const normalized = (message || '').toLowerCase();
  return normalized.includes('banned') || normalized.includes('restricted') || normalized.includes('suspended');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [loading, setLoading] = useState(true);
  const currentUserIdRef = useRef<string | null>(null);

  const fetchProfile = async (userId: string): Promise<Profile | null> => {
    const { data, error } = await supabase
      .from('profiles' as any)
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error loading profile:', error);
      return null;
    }

    return (data as unknown as Profile | null) ?? null;
  };

  const fetchMemberships = async (userId: string): Promise<Membership[]> => {
    const rpcResult = await (supabase as any).rpc('get_my_memberships');
    if (!rpcResult.error) {
      return ((rpcResult.data ?? []) as Membership[]);
    }

    console.warn('Error loading memberships via RPC, falling back to direct query:', rpcResult.error);

    const { data, error } = await supabase
      .from('user_roles' as any)
      .select('role, company_id')
      .eq('user_id', userId);

    if (error) {
      console.error('Error loading memberships via fallback query:', error);
      return [];
    }

    return ((data ?? []) as Membership[]);
  };

  const loadUserData = async (currentSession: Session | null, options?: { background?: boolean }) => {
    const background = options?.background ?? false;

    if (!background) {
      setLoading(true);
    }

    currentUserIdRef.current = currentSession?.user?.id ?? null;
    setSession(currentSession);
    setUser(currentSession?.user ?? null);

    try {
      if (currentSession?.user) {
        const userId = currentSession.user.id;
        const [profileData, memberships] = await Promise.all([
          fetchProfile(userId),
          fetchMemberships(userId),
        ]);

        const uniqueRoles = [...new Set(memberships.map(m => m.role))] as AppRole[];
        const fallbackCompanyId = profileData?.company_id
          ?? memberships.find(m => m.company_id)?.company_id
          ?? null;

        if (profileData && profileData.is_active === false) {
          await supabase.auth.signOut();
          setSession(null);
          setUser(null);
          setProfile(null);
          setRoles([]);
          return;
        }

        setRoles(uniqueRoles);

        if (profileData) {
          setProfile({ ...profileData, company_id: fallbackCompanyId });
        } else {
          setProfile({
            id: userId,
            full_name: currentSession.user.user_metadata?.full_name || currentSession.user.email || '',
            email: currentSession.user.email ?? null,
            phone: null,
            company_id: fallbackCompanyId,
            is_active: true,
          });
        }
      } else {
        setProfile(null);
        setRoles([]);
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    // Get initial session first
    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      loadUserData(initialSession);
    });

    // Then listen for changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        if (_event === 'SIGNED_OUT' || _event === 'PASSWORD_RECOVERY') {
          loadUserData(newSession);
          return;
        }

        if (_event === 'SIGNED_IN') {
          // Supabase v2 fires SIGNED_IN on token refresh too.
          // Only show loading spinner for genuine new sign-ins (user changed).
          const isSameUser = !!newSession?.user?.id && newSession.user.id === currentUserIdRef.current;
          loadUserData(newSession, { background: isSameUser });
          return;
        }

        if (_event === 'TOKEN_REFRESHED') {
          loadUserData(newSession, { background: true });
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string, options?: { slug?: string | null }) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      if (isRestrictedAuthError(error.message)) {
        return { error: { ...error, message: ACCESS_RESTRICTED_MESSAGE } };
      }
      return { error };
    }

    const profileData = data.user ? await fetchProfile(data.user.id) : null;
    if (profileData && profileData.is_active === false) {
      await supabase.auth.signOut();
      return { error: { message: ACCESS_RESTRICTED_MESSAGE } };
    }

    try {
      await trackAccessAudit({
        eventType: 'login',
        slug: options?.slug ?? null,
        path: options?.slug ? `/${options.slug}/admin` : '/login',
        metadata: { source: options?.slug ? 'public_company_page' : 'login_page' },
      });
    } catch (auditError) {
      console.warn('Failed to audit login:', auditError);
    }

    return { error: null };
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    if (!isStrongPassword(password)) {
      return { error: { message: PASSWORD_REQUIREMENTS_TEXT } };
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: window.location.origin,
      },
    });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setRoles([]);
  };

  const refreshUserData = async () => {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    await loadUserData(currentSession, { background: true });
  };

  const hasRole = (role: AppRole) => roles.includes(role);
  const hasAnyRole = (r: AppRole[]) => r.some(role => roles.includes(role));

  return (
    <AuthContext.Provider value={{ user, session, profile, roles, loading, signIn, signUp, signOut, refreshUserData, hasRole, hasAnyRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
