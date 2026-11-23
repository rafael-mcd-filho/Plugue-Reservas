import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, CreditCard, Loader2, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { manageCentralReservationAsaasConfig } from '@/lib/reservation-asaas-config-api';

export default function CentralReservationAsaasCard() {
  const configQuery = useQuery({
    queryKey: ['central-reservation-asaas-config'],
    queryFn: () => manageCentralReservationAsaasConfig({ action: 'get' }),
  });
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('production');
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!configQuery.data || initialized) return;
    setEmail(configQuery.data.webhook_email ?? '');
    setEnvironment(configQuery.data.environment);
    setInitialized(true);
  }, [configQuery.data, initialized]);

  const mutation = useMutation({
    mutationFn: (action: 'save' | 'test') => manageCentralReservationAsaasConfig({
      action, environment, webhook_email: email.trim(), ...(token.trim() ? { api_token: token.trim() } : {}),
    }),
    onSuccess: async (result, action) => {
      if (action === 'save') setToken('');
      if (result.candidate_token_valid) toast.success(result.message);
      else if (result.status === 'configured') {
        toast.success(action === 'save' ? 'Conta central salva e webhook configurado.' : 'Conta central e webhook validados.');
      } else toast.warning(result.last_error || 'A configuração precisa de atenção.');
      await configQuery.refetch();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Não foi possível configurar a conta central.'),
  });
  const config = configQuery.data;
  const busy = mutation.isPending || configQuery.isLoading;
  return (
    <Card className="overflow-hidden border-primary/15 shadow-sm">
      <div className="h-1 bg-primary" />
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-5 w-5 text-primary" />Asaas — pagamentos das reservas</CardTitle>
            <CardDescription className="mt-1 max-w-2xl">
              Uma conta recebe os pagamentos antecipados de todas as empresas. Cada cobrança mantém a empresa e a reserva identificadas para conciliação.
            </CardDescription>
          </div>
          <Badge variant={config?.status === 'configured' ? 'default' : 'secondary'}>
            {configQuery.isLoading ? 'Carregando' : config?.status === 'configured' ? 'Token e webhook configurados' : 'Configuração pendente'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {configQuery.isError && (
          <Alert variant="destructive"><AlertTitle>Não foi possível consultar a configuração</AlertTitle><AlertDescription>
            {configQuery.error instanceof Error ? configQuery.error.message : 'Tente novamente.'}
            <Button type="button" variant="outline" size="sm" className="ml-3" onClick={() => configQuery.refetch()}>Tentar novamente</Button>
          </AlertDescription></Alert>
        )}
        {config && (
          <>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_200px]">
              <div className="space-y-2">
                <Label htmlFor="central-reservation-asaas-token">Token da sua conta Asaas</Label>
                <Input id="central-reservation-asaas-token" type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={config.has_api_token ? `Token salvo, final ${config.token_last_four ?? '••••'}` : 'Cole seu token Asaas'} disabled={busy} />
                <p className="text-xs text-muted-foreground">O token fica criptografado e é administrado apenas pelo superadmin. As empresas não têm acesso à credencial.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="central-reservation-asaas-environment">Ambiente</Label>
                <Select value={environment} onValueChange={(value) => setEnvironment(value as 'sandbox' | 'production')} disabled={busy}>
                  <SelectTrigger id="central-reservation-asaas-environment"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="production">Produção</SelectItem><SelectItem value="sandbox">Sandbox</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="central-reservation-asaas-email">E-mail para avisos do Asaas</Label>
              <Input id="central-reservation-asaas-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="financeiro@suaempresa.com.br" disabled={busy} />
              <p className="text-xs text-muted-foreground">Ao salvar, o sistema instala ou atualiza um único webhook para pagamentos, cancelamentos, estornos e chargebacks.</p>
            </div>
            {config.last_error && <Alert variant="destructive"><AlertTitle>A integração precisa de atenção</AlertTitle><AlertDescription>{config.last_error}</AlertDescription></Alert>}
            {config.status === 'configured' && (
              <div className="rounded-lg border border-success/30 bg-success-soft p-3 text-sm">
                <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4 shrink-0" />Conta central conectada</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">Conta: {config.account_id} · {config.environment === 'production' ? 'Produção' : 'Sandbox'}</p>
                <p className="mt-1 text-xs text-muted-foreground">Última validação: {config.last_validated_at ? new Date(config.last_validated_at).toLocaleString('pt-BR') : 'Pendente'}</p>
              </div>
            )}
            <details className="rounded-lg border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium">Detalhes do webhook</summary>
              <dl className="mt-3 space-y-2 text-xs">
                <div><dt className="font-medium">URL</dt><dd className="mt-1 break-all text-muted-foreground">{config.webhook_url}</dd></div>
                <div><dt className="font-medium">Identificador no Asaas</dt><dd className="mt-1 break-all text-muted-foreground">{config.webhook_id ?? 'Ainda não configurado'}</dd></div>
                <div><dt className="font-medium">E-mail para avisos</dt><dd className="mt-1 break-all text-muted-foreground">{config.webhook_email ?? 'Ainda não configurado'}</dd></div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">O token de autenticação do webhook é gerenciado automaticamente pelo sistema.</p>
            </details>
            <p className="text-xs text-muted-foreground">Os painéis das empresas exibem suas próprias cobranças e valores brutos. O saldo da conta Asaas é compartilhado; repasses às empresas são controlados separadamente.</p>
            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={() => mutation.mutate('save')} disabled={busy || !email.trim() || (!token.trim() && !config.has_api_token)} className="gap-2">
                {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Salvar e configurar webhook
              </Button>
              <Button type="button" variant="outline" onClick={() => mutation.mutate('test')} disabled={busy || (!token.trim() && !config.has_api_token)} className="gap-2">
                <RefreshCw className="h-4 w-4" />Testar integração
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
