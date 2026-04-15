import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { KeyRound, Loader2, Save, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import {
  getEmailValidationMessage,
  getPasswordValidationMessage,
  normalizeEmail,
  PASSWORD_REQUIREMENTS_TEXT,
} from '@/lib/validation';
import { useImpersonation } from '@/hooks/useImpersonation';

export default function Profile() {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug?: string }>();
  const { profile, loading, refreshUserData, signOut } = useAuth();
  const { stopImpersonation } = useImpersonation();
  const [profileForm, setProfileForm] = useState({ full_name: '', email: '' });
  const [passwordForm, setPasswordForm] = useState({ password: '', confirmPassword: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!profile) return;

    setProfileForm({
      full_name: profile.full_name || '',
      email: profile.email || '',
    });
  }, [profile]);

  const handleRequireFreshLogin = async (message: string) => {
    stopImpersonation();
    toast.success(message);
    await signOut();
    navigate('/login', { replace: true });
  };

  const handleProfileSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const fullName = profileForm.full_name.trim();
    if (!fullName) {
      toast.error('Informe seu nome.');
      return;
    }

    const emailError = getEmailValidationMessage(profileForm.email, 'um e-mail', true);
    if (emailError) {
      toast.error(emailError);
      return;
    }

    setSavingProfile(true);

    try {
      const normalizedEmail = normalizeEmail(profileForm.email);
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'update_my_account',
          full_name: fullName,
          email: normalizedEmail,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      if (data?.requires_reauth) {
        await handleRequireFreshLogin('Dados atualizados. Entre novamente com seu e-mail atual.');
        return;
      }

      await refreshUserData();
      toast.success('Perfil atualizado.');
    } catch (submitError: any) {
      toast.error(submitError.message || 'Não foi possível atualizar seu perfil.');
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const passwordError = getPasswordValidationMessage(passwordForm.password);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }

    if (passwordForm.password !== passwordForm.confirmPassword) {
      toast.error('As senhas precisam ser iguais.');
      return;
    }

    setSavingPassword(true);

    try {
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'update_my_account',
          password: passwordForm.password,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      if (data?.requires_reauth) {
        setPasswordForm({ password: '', confirmPassword: '' });
        await handleRequireFreshLogin('Senha atualizada. Entre novamente com a nova senha.');
        return;
      }

      setPasswordForm({ password: '', confirmPassword: '' });
      toast.success('Senha atualizada.');
    } catch (submitError: any) {
      toast.error(submitError.message || 'Não foi possível atualizar sua senha.');
    } finally {
      setSavingPassword(false);
    }
  };

  if (loading && !profile) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Meu Perfil</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atualize seu nome, e-mail de login e senha.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserRound className="h-4 w-4 text-primary" />
              Dados da conta
            </CardTitle>
            <CardDescription>
              Se voce alterar o e-mail de login, a sessao atual sera encerrada para voce entrar novamente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleProfileSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="profile-full-name">Nome completo</Label>
                <Input
                  id="profile-full-name"
                  name="full_name"
                  value={profileForm.full_name}
                  onChange={(event) => setProfileForm((current) => ({ ...current, full_name: event.target.value }))}
                  autoComplete="name"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="profile-email">E-mail de login</Label>
                <Input
                  id="profile-email"
                  name="email"
                  type="email"
                  value={profileForm.email}
                  onChange={(event) => setProfileForm((current) => ({ ...current, email: event.target.value }))}
                  autoComplete="email"
                  inputMode="email"
                  spellCheck={false}
                  required
                />
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="submit" className="w-full sm:w-auto" disabled={savingProfile}>
                  {savingProfile ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <Save className="mr-2 h-4 w-4" />
                      Salvar dados
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-primary" />
              Senha
            </CardTitle>
            <CardDescription>
              Ao alterar sua senha, a sessao atual sera encerrada para novo login.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="profile-password">Nova senha</Label>
                <Input
                  id="profile-password"
                  name="new_password"
                  type="password"
                  value={passwordForm.password}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, password: event.target.value }))}
                  autoComplete="new-password"
                  required
                />
                <p className="text-xs text-muted-foreground">{PASSWORD_REQUIREMENTS_TEXT}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="profile-password-confirm">Confirmar senha</Label>
                <Input
                  id="profile-password-confirm"
                  name="confirm_password"
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                  autoComplete="new-password"
                  required
                />
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="submit" className="w-full sm:w-auto" disabled={savingPassword}>
                  {savingPassword ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Alterar senha
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Sessao atual</CardTitle>
          <CardDescription>
            {slug
              ? 'Voce esta acessando o perfil dentro do painel da unidade.'
              : 'Voce esta acessando o perfil no painel global.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
          <p><span className="font-medium text-foreground">Nome:</span> {profile?.full_name || '-'}</p>
          <p className="break-all"><span className="font-medium text-foreground">E-mail:</span> {profile?.email || '-'}</p>
        </CardContent>
      </Card>
    </div>
  );
}
