import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, CircleDollarSign, Eye, EyeOff, Loader2, RefreshCw, Save, ShieldCheck, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  usePlatformAsaasConfig,
  usePlatformBillingModuleStatus,
  useSavePlatformAsaasConfig,
  useSetPlatformBillingEnabled,
  useTestPlatformAsaasConfig,
} from '@/hooks/usePlatformBilling';
import type { PlatformBillingEnvironment } from '@/lib/platform-billing-contracts';

/** Conexão do Asaas usada só para consultar as mensalidades da plataforma. */
export default function PlatformBillingAsaasCard() {
  const moduleStatusQuery = usePlatformBillingModuleStatus();
  const asaasConfigQuery = usePlatformAsaasConfig();
  const saveAsaasConfig = useSavePlatformAsaasConfig();
  const setPlatformBillingEnabled = useSetPlatformBillingEnabled();
  const testAsaasConfig = useTestPlatformAsaasConfig();

  const [asaasToken, setAsaasToken] = useState('');
  const [showAsaasToken, setShowAsaasToken] = useState(false);
  const [asaasEnvironment, setAsaasEnvironment] = useState<PlatformBillingEnvironment>('sandbox');
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [asaasFormInitialized, setAsaasFormInitialized] = useState(false);
  const [asaasTestResult, setAsaasTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [replaceCredentialDialogOpen, setReplaceCredentialDialogOpen] = useState(false);
  const hasStoredAsaasCredential = !!asaasConfigQuery.data?.maskedToken;

  useEffect(() => {
    const config = asaasConfigQuery.data;
    if (!config?.available || asaasFormInitialized) return;
    setAsaasEnvironment(config.environment);
    setAsaasFormInitialized(true);
  }, [asaasConfigQuery.data, asaasFormInitialized]);

  useEffect(() => {
    const config = asaasConfigQuery.data;
    if (!config?.available) return;
    setBillingEnabled(config.enabled);
  }, [asaasConfigQuery.data]);

  const handleSaveAsaas = async () => {
    const config = asaasConfigQuery.data;
    if (!asaasToken.trim()) {
      setAsaasTestResult({ ok: false, message: 'Informe o token do Asaas para cadastrar ou substituir a credencial.' });
      return;
    }

    setAsaasTestResult(null);
    try {
      const replacingCredential = !!config?.maskedToken;
      const savedConfig = await saveAsaasConfig.mutateAsync({
        token: asaasToken.trim(),
        environment: asaasEnvironment,
      });
      setAsaasToken('');
      setShowAsaasToken(false);
      setBillingEnabled(savedConfig.enabled);
      if (replacingCredential) {
        toast.warning('Credencial substituída. O Financeiro foi desativado e os vínculos precisam ser revalidados antes da nova ativação.');
      } else {
        toast.success('Configuração financeira salva.');
      }
    } catch (error: any) {
      const message = error?.message || 'Não foi possível salvar a configuração do Asaas.';
      setAsaasTestResult({ ok: false, message });
      toast.error(message);
    }
  };

  const handleBillingEnabledChange = async (enabled: boolean) => {
    const previousValue = billingEnabled;
    setBillingEnabled(enabled);
    try {
      const nextConfig = await setPlatformBillingEnabled.mutateAsync(enabled);
      setBillingEnabled(nextConfig.enabled);
      if (enabled && !nextConfig.enabled) {
        toast.warning('O Financeiro permaneceu desativado. Revalide os vínculos antes de tentar novamente.');
      } else {
        toast.success(enabled ? 'Cobrança da assinatura liberada para as empresas ativadas.' : 'Cobrança da assinatura desligada para todas as empresas.');
      }
    } catch (error: any) {
      setBillingEnabled(previousValue);
      toast.error(error?.message || 'Não foi possível alterar o status do Financeiro.');
    }
  };

  const handleTestAsaas = async () => {
    const config = asaasConfigQuery.data;
    if (!asaasToken.trim() && !config?.maskedToken) {
      setAsaasTestResult({ ok: false, message: 'Informe o token do Asaas antes de testar.' });
      return;
    }
    if (!asaasToken.trim() && config?.environment !== asaasEnvironment) {
      setAsaasTestResult({ ok: false, message: 'Informe o token correspondente ao novo ambiente antes de testar.' });
      return;
    }

    setAsaasTestResult(null);
    try {
      const result = await testAsaasConfig.mutateAsync({
        token: asaasToken.trim() || undefined,
        environment: asaasEnvironment,
      });
      setAsaasTestResult({
        ok: result.valid,
        message: result.valid
          ? `Conexão validada no ambiente ${result.environment === 'production' ? 'Produção' : 'Sandbox'}.`
          : 'O Asaas não confirmou este token.',
      });
    } catch (error: any) {
      setAsaasTestResult({
        ok: false,
        message: error?.message || 'Não foi possível validar o token do Asaas.',
      });
    }
  };

  if (
    (moduleStatusQuery.isFetching && !moduleStatusQuery.data?.available)
    || (asaasConfigQuery.isFetching && !asaasConfigQuery.data)
  ) {
    return (
      <Card className="shadow-sm"><CardContent className="space-y-4 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></CardContent></Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden border-primary/15 shadow-sm">
        <div className="h-1 bg-primary" />
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CircleDollarSign className="h-5 w-5 text-primary" />
                Asaas — mensalidades da plataforma
              </CardTitle>
              <CardDescription className="mt-1 max-w-2xl">
                Conexão global usada somente para consultar as cobranças da Plug Guest. O fluxo de pagamentos das reservas permanece separado.
              </CardDescription>
            </div>
            {asaasConfigQuery.isError ? (
              <Badge variant="outline" className="w-fit gap-1.5 border-destructive/25 bg-destructive-soft text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                Consulta indisponível
              </Badge>
            ) : asaasConfigQuery.data?.configured ? (
              <Badge variant="outline" className="w-fit gap-1.5 border-success/25 bg-success-soft text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Conectado
              </Badge>
            ) : hasStoredAsaasCredential ? (
              <Badge variant="outline" className="w-fit gap-1.5 border-destructive/25 bg-destructive-soft text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                Credencial requer validação
              </Badge>
            ) : (
              <Badge variant="outline" className="w-fit gap-1.5 border-warning/25 bg-warning-soft text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5" />
                Não configurado
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {!moduleStatusQuery.data?.available ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              A estrutura do Financeiro ainda não está disponível neste ambiente. Aplique as migrations e publique as funções antes de cadastrar o token.
            </div>
          ) : asaasConfigQuery.isError ? (
            <div className="flex max-w-3xl flex-col items-start gap-3 rounded-lg border border-destructive/25 bg-destructive-soft/40 p-4">
              <div>
                <p className="text-sm font-semibold text-destructive">Não foi possível carregar a credencial financeira</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Os controles ficaram bloqueados para evitar substituir uma credencial existente sem confirmação.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void asaasConfigQuery.refetch()} className="gap-2">
                <RefreshCw className="h-3.5 w-3.5" />
                Tentar novamente
              </Button>
            </div>
          ) : (
            <>
              <div className="grid max-w-3xl gap-4 md:grid-cols-[1fr_220px]">
                <div>
                  <Label htmlFor="platform-asaas-token">
                    {hasStoredAsaasCredential ? 'Novo token (para substituir)' : 'Token global do Asaas'}
                  </Label>
                  <div className="relative mt-1.5">
                    <Input
                      id="platform-asaas-token"
                      type={showAsaasToken ? 'text' : 'password'}
                      value={asaasToken}
                      onChange={(event) => setAsaasToken(event.target.value)}
                      placeholder={asaasConfigQuery.data?.maskedToken || '$aact_...'}
                      autoComplete="new-password"
                      className="pr-10 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAsaasToken((current) => !current)}
                      aria-label={showAsaasToken ? 'Ocultar token' : 'Mostrar token'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {showAsaasToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    O token é enviado diretamente ao backend e nunca volta completo para o navegador. Para trocar de ambiente, informe o token correspondente.
                  </p>
                </div>

                <div>
                  <Label htmlFor="platform-asaas-environment">Ambiente</Label>
                  <Select value={asaasEnvironment} onValueChange={(value) => setAsaasEnvironment(value as PlatformBillingEnvironment)}>
                    <SelectTrigger id="platform-asaas-environment" className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sandbox">Sandbox</SelectItem>
                      <SelectItem value="production">Produção</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex max-w-3xl items-start justify-between gap-4 rounded-lg border border-border bg-muted/20 p-4">
                <div>
                  <Label htmlFor="platform-billing-enabled" className="cursor-pointer font-semibold">Liberar a cobrança da assinatura para as empresas</Label>
                  <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                    Quando ativo, empresas vinculadas passam a visualizar faturas, badge de atraso e o aviso após três dias completos.
                  </p>
                </div>
                <Switch
                  id="platform-billing-enabled"
                  checked={billingEnabled}
                  onCheckedChange={handleBillingEnabledChange}
                  disabled={!asaasConfigQuery.data?.configured || setPlatformBillingEnabled.isPending || saveAsaasConfig.isPending || testAsaasConfig.isPending}
                />
              </div>

              {asaasEnvironment === 'production' && (
                <div className="flex max-w-3xl items-start gap-2.5 rounded-lg border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-amber-900">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>Ambiente de produção selecionado. O módulo continuará somente leitura: não cria, altera ou cancela cobranças.</p>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() => {
                    if (hasStoredAsaasCredential) {
                      setReplaceCredentialDialogOpen(true);
                    } else {
                      void handleSaveAsaas();
                    }
                  }}
                  disabled={saveAsaasConfig.isPending || testAsaasConfig.isPending || setPlatformBillingEnabled.isPending || !asaasToken.trim()}
                  className="gap-2"
                >
                  {saveAsaasConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {hasStoredAsaasCredential ? 'Substituir credencial' : 'Salvar configuração'}
                </Button>
                <Button variant="outline" onClick={handleTestAsaas} disabled={testAsaasConfig.isPending || saveAsaasConfig.isPending || setPlatformBillingEnabled.isPending} className="gap-2">
                  {testAsaasConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
                  Testar conexão
                </Button>
              </div>

              {asaasTestResult && (
                <div className={`max-w-3xl rounded-lg border p-3 text-sm ${asaasTestResult.ok ? 'border-success/30 bg-success-soft text-success' : 'border-destructive/30 bg-destructive-soft text-destructive'}`}>
                  {asaasTestResult.message}
                </div>
              )}

              {asaasConfigQuery.data?.lastTestedAt && (
                <p className="text-xs text-muted-foreground">
                  Última validação: {new Date(asaasConfigQuery.data.lastTestedAt).toLocaleString('pt-BR')}.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={replaceCredentialDialogOpen} onOpenChange={setReplaceCredentialDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Substituir a credencial global do Asaas?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 leading-relaxed">
              <span className="block">
                Esta ação não cria, altera ou exclui nada no Asaas.
              </span>
              <span className="block">
                No Plug Guest, o Financeiro será desativado e deixará de aparecer temporariamente para os clientes. O cache local de faturas será limpo e todos os Customer IDs precisarão ser revalidados antes de habilitar o módulo novamente.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saveAsaasConfig.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleSaveAsaas()}
              disabled={saveAsaasConfig.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {saveAsaasConfig.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Substituir e desativar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
