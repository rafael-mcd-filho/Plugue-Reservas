import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { UtensilsCrossed, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { getEmailValidationMessage, normalizeEmail } from '@/lib/validation';

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
    return 'O sistema direciona voce automaticamente para o painel correto apos o login.';
  }

  const companyAdminMatch = path.match(/^\/([^/]+)\/admin(?:\/|$)/i);
  if (companyAdminMatch) {
    return 'Depois do login, voce sera direcionado para o painel da unidade.';
  }

  return 'Depois do login, voce sera direcionado automaticamente para a tela solicitada.';
}

export default function Login() {
  const { signIn, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const redirectTo = useMemo(
    () => getSafeRedirectPath((location.state as LoginLocationState | null)?.redirectTo),
    [location.state],
  );
  const helperMessage = useMemo(() => getRedirectMessage(redirectTo), [redirectTo]);

  useEffect(() => {
    if (authLoading || !user) return;
    navigate(redirectTo, { replace: true, state: { fromLogin: true } satisfies PostLoginNavigationState });
  }, [authLoading, navigate, redirectTo, user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('Preencha todos os campos');
      return;
    }

    const emailError = getEmailValidationMessage(email, 'um e-mail', true);
    if (emailError) {
      toast.error(emailError);
      return;
    }

    setLoading(true);
    const { error } = await signIn(normalizeEmail(email), password);
    setLoading(false);
    if (error) {
      const message = error.message === 'Invalid login credentials'
        ? 'Email ou senha incorretos'
        : error.message;
      toast.error(message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-none shadow-sm">
        <CardHeader className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="p-3 rounded-lg bg-primary/10">
              <UtensilsCrossed className="h-8 w-8 text-primary" />
            </div>
          </div>
          <div>
            <CardTitle className="text-2xl">
              Plug<span className="text-primary"> Guest</span>
            </CardTitle>
            <CardDescription className="mt-2">Entre na sua conta para continuar</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div>
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Entrando...
                </>
              ) : 'Entrar'}
            </Button>
          </form>
          <p className="text-sm text-center text-muted-foreground mt-6">
            {helperMessage}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
