import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowRight, Eye, EyeOff, UtensilsCrossed, Loader2, CircleAlert } from 'lucide-react';
import { getEmailValidationMessage, normalizeEmail } from '@/lib/validation';
import { useSystemBranding } from '@/hooks/useSettings';
import { useFaviconOverride } from '@/lib/publicCompanyIcons';
import { DEFAULT_SYSTEM_NAME, normalizeSystemName } from '@/lib/branding';
import './Login.css';

interface LoginLocationState {
  redirectTo?: string;
}

export interface PostLoginNavigationState {
  fromLogin?: boolean;
}

function getSafeRedirectPath(value: unknown) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value === '/login' || value.startsWith('/login?')) return '/';
  return value;
}

function getRedirectMessage(path: string) {
  if (path === '/') {
    return 'Após entrar, você será direcionado ao seu painel.';
  }

  const companyAdminMatch = path.match(/^\/([^/]+)\/admin(?:\/|$)/i);
  if (companyAdminMatch) {
    return 'Após entrar, você será direcionado ao painel da unidade.';
  }

  return 'Após entrar, você voltará à página que estava acessando.';
}

export default function Login() {
  const { signIn, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState('');
  const [invalidField, setInvalidField] = useState<'email' | 'password' | null>(null);
  const submissionPending = useRef(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const redirectTo = useMemo(
    () => getSafeRedirectPath((location.state as LoginLocationState | null)?.redirectTo),
    [location.state],
  );
  const helperMessage = useMemo(() => getRedirectMessage(redirectTo), [redirectTo]);
  const { data: systemBranding, isLoading: systemBrandingLoading } = useSystemBranding();
  const systemLogo = systemBranding?.system_logo_url || '';
  const systemName = normalizeSystemName(systemBranding?.system_name);
  useFaviconOverride(systemBrandingLoading ? undefined : systemLogo || null);

  useEffect(() => {
    if (authLoading || !user) return;
    navigate(redirectTo, { replace: true, state: { fromLogin: true } satisfies PostLoginNavigationState });
  }, [authLoading, navigate, redirectTo, user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submissionPending.current) return;
    setFormError('');
    setInvalidField(null);
    if (!email || !password) {
      setFormError('Preencha o e-mail e a senha para entrar.');
      setInvalidField(!email ? 'email' : 'password');
      (!email ? emailInput : passwordInput).current?.focus();
      return;
    }

    const emailError = getEmailValidationMessage(email, 'um e-mail', true);
    if (emailError) {
      setFormError(emailError);
      setInvalidField('email');
      emailInput.current?.focus();
      return;
    }

    submissionPending.current = true;
    setLoading(true);
    try {
      const { error } = await signIn(normalizeEmail(email), password);
      if (error) {
        setFormError(error.message === 'Invalid login credentials'
          ? 'E-mail ou senha incorretos. Confira seus dados e tente novamente.'
          : error.message || 'Não foi possível entrar agora. Tente novamente.');
      }
    } catch {
      setFormError('Não foi possível entrar agora. Verifique sua conexão e tente novamente.');
    } finally {
      submissionPending.current = false;
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-shell">
        <section className="login-brand" aria-label={systemName}>
          <div className="login-brand-image" aria-hidden="true" />
          <div className="login-brand-identity">
            {systemLogo ? (
              <img src={systemLogo} alt={systemName} className="login-logo" />
            ) : (
              <div className="login-logo login-logo-fallback" aria-hidden="true">
                <UtensilsCrossed size={28} />
              </div>
            )}
            <span className="login-brand-name">
              {systemName === DEFAULT_SYSTEM_NAME ? <>Plug <span>Guest</span></> : systemName}
            </span>
          </div>
          <div className="login-brand-copy">
            <h2>Cada reserva,<br />uma boa experiência.</h2>
            <p>Mais cuidado com quem chega.<br />Mais leveza para quem recebe.</p>
          </div>
        </section>

        <section className="login-form-panel" aria-labelledby="login-title">
          <div className="login-form-content">
            <header className="login-form-header">
              <h1 id="login-title">Bem-vindo de volta.</h1>
              <p>Entre com seu e-mail e senha para continuar.</p>
            </header>
            <form onSubmit={handleSubmit} className="login-form" noValidate aria-busy={loading}>
              <div className="login-field">
                <Label htmlFor="email">E-mail</Label>
                <Input
                  id="email"
                  name="email"
                  ref={emailInput}
                  type="email"
                  placeholder="seu@email.com"
                  value={email}
                  onChange={e => {
                    setEmail(e.target.value);
                    if (invalidField === 'email') setInvalidField(null);
                  }}
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  className="login-input"
                  aria-invalid={invalidField === 'email'}
                  aria-describedby={formError ? 'login-error' : undefined}
                />
              </div>
              <div className="login-field">
                <Label htmlFor="password">Senha</Label>
                <div className="login-password">
                  <Input
                    id="password"
                    name="password"
                    ref={passwordInput}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Sua senha"
                    value={password}
                    onChange={e => {
                      setPassword(e.target.value);
                      if (invalidField === 'password') setInvalidField(null);
                    }}
                    autoComplete="current-password"
                    required
                    className="login-input"
                    aria-invalid={invalidField === 'password'}
                    aria-describedby={formError ? 'login-error' : undefined}
                  />
                  <button
                    type="button"
                    className="login-password-toggle"
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(value => !value)}
                  >
                    {showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
                  </button>
                </div>
              </div>
              {formError && (
                <div id="login-error" className="login-error" role="alert">
                  <CircleAlert size={18} aria-hidden="true" />
                  <p>{formError}</p>
                </div>
              )}
              <Button type="submit" className="login-submit" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                    Entrando...
                  </>
                ) : <><span>Entrar</span><ArrowRight size={18} aria-hidden="true" /></>}
              </Button>
            </form>
            <p className="login-helper">
              {helperMessage}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
