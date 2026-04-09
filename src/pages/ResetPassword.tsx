import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { getPasswordValidationMessage, PASSWORD_REQUIREMENTS_TEXT } from '@/lib/validation';

export default function ResetPassword() {
  const navigate = useNavigate();
  const { loading, session, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const hasRecoverySession = !!session;
  const passwordsDoNotMatch = confirmPassword.length > 0 && password !== confirmPassword;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const passwordError = getPasswordValidationMessage(password);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }

    if (password !== confirmPassword) {
      toast.error('As senhas informadas não coincidem.');
      return;
    }

    setSubmitting(true);

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      toast.success('Senha atualizada com sucesso.');
      await signOut();
      navigate('/login', { replace: true });
    } catch (error: any) {
      toast.error(error.message || 'Não foi possível atualizar a senha.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-none shadow-sm">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
            {hasRecoverySession ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </div>
          <div className="space-y-1">
            <CardTitle className="text-xl">
              {hasRecoverySession ? 'Definir nova senha' : 'Link indisponível'}
            </CardTitle>
            <CardDescription>
              {hasRecoverySession
                ? 'Crie uma senha forte para concluir o acesso.'
                : 'Este link expirou ou já foi utilizado. Solicite um novo link ao administrador.'}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {hasRecoverySession ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">Nova senha</Label>
                <Input
                  id="new-password"
                  name="new_password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  placeholder="Digite sua nova senha"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {PASSWORD_REQUIREMENTS_TEXT}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirmar senha</Label>
                <Input
                  id="confirm-password"
                  name="confirm_password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  placeholder="Repita a nova senha"
                  required
                />
                {passwordsDoNotMatch && (
                  <p className="text-xs text-destructive">As senhas precisam ser iguais.</p>
                )}
              </div>

              <Button type="submit" className="w-full" disabled={submitting || passwordsDoNotMatch}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Salvando...
                  </>
                ) : (
                  'Atualizar Senha'
                )}
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <Button asChild className="w-full">
                <Link to="/login">Ir Para o Login</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
