import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CircleDollarSign,
  Clock3,
  Eye,
  Info,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  WalletCards,
} from 'lucide-react';
import { toast } from 'sonner';
import AsaasCustomerLookupDialog from '@/components/billing/AsaasCustomerLookupDialog';
import CompanyDialog from '@/components/company/CompanyDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  usePlatformAsaasConfig,
  usePlatformBillingModuleStatus,
  useSuperadminBillingOverview,
  useSetCompanyBillingEnabled,
  useSyncAllCompanyBilling,
} from '@/hooks/usePlatformBilling';
import type { PlatformBillingCompanyOverview } from '@/lib/platform-billing-contracts';
import {
  toCompanyBillingTarget,
  type CompanyBillingTarget,
} from '@/lib/company-billing-dialog';

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

type CompanyFilter = 'all' | 'overdue' | 'enabled' | 'disabled' | 'configured' | 'unconfigured' | 'error';

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  try {
    return format(parseISO(value), 'dd/MM/yyyy', { locale: ptBR });
  } catch {
    return '—';
  }
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return 'Nunca';
  try {
    return format(parseISO(value), "dd/MM 'às' HH:mm", { locale: ptBR });
  } catch {
    return 'Nunca';
  }
}

export default function AdminFinance() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CompanyFilter>('all');
  const [customerLookupOpen, setCustomerLookupOpen] = useState(false);
  const [billingTarget, setBillingTarget] = useState<CompanyBillingTarget | null>(null);
  const moduleQuery = usePlatformBillingModuleStatus();
  const configQuery = usePlatformAsaasConfig();
  const overviewQuery = useSuperadminBillingOverview();
  const syncAll = useSyncAllCompanyBilling();

  const moduleStatus = moduleQuery.data;
  const config = configQuery.data;
  const overview = overviewQuery.data;
  const totals = overview?.totals;
  const companies = overview?.companies;
  const pendingValidationCount = (companies ?? []).filter((company) => company.linkStatus === 'pending_validation').length;
  const disabledLinkCount = (companies ?? []).filter((company) => company.linkStatus === 'disabled').length;
  const enabledCompanyCount = (companies ?? []).filter((company) => company.billingEnabled).length;
  const attentionCount = pendingValidationCount + (totals?.errorCompanyCount ?? 0) + disabledLinkCount;
  const isLoading = (moduleQuery.isFetching && !moduleStatus?.available)
    || (configQuery.isFetching && !config?.available)
    || (overviewQuery.isFetching && !overview?.available);
  const structureUnavailable = moduleStatus?.available === false
    || config?.available === false
    || overview?.available === false;
  const hasDataFailure = moduleQuery.isError
    || configQuery.isError
    || overviewQuery.isError
    || structureUnavailable;

  const visibleCompanies = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR');
    return (companies ?? []).filter((company) => {
      const matchesSearch = !normalizedSearch || [
        company.companyName,
        company.customerName,
        company.customerDocument,
        company.customerId,
      ].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(normalizedSearch));

      if (!matchesSearch) return false;
      if (filter === 'overdue') return company.overdueCount > 0;
      if (filter === 'enabled') return company.billingEnabled;
      if (filter === 'disabled') return company.configured && !company.billingEnabled;
      if (filter === 'configured') return company.configured;
      if (filter === 'unconfigured') return !company.configured;
      if (filter === 'error') {
        return company.linkStatus === 'pending_validation'
          || company.linkStatus === 'disabled'
          || company.linkStatus === 'error'
          || !!company.lastSyncError;
      }
      return true;
    });
  }, [companies, filter, search]);

  const handleSyncAll = async () => {
    try {
      const result = await syncAll.mutateAsync();
      const synced = Number(result?.synced ?? 0);
      const failed = Number(result?.failed ?? 0);
      if (result.skipped) {
        toast.warning('A sincronização não foi iniciada porque o Financeiro está desativado.');
      } else if (result.stoppedEarly) {
        toast.error(
          `Sincronização interrompida: ${synced} ${synced === 1 ? 'empresa concluída' : 'empresas concluídas'}, ${failed} com erro e ${result.remainingCount} ${result.remainingCount === 1 ? 'empresa ainda não processada' : 'empresas ainda não processadas'}. Revise o token do Asaas.`,
        );
      } else if (failed > 0) {
        toast.warning(`${synced} ${synced === 1 ? 'empresa sincronizada' : 'empresas sincronizadas'} e ${failed} com erro.`);
      } else {
        toast.success(`${synced} ${synced === 1 ? 'empresa sincronizada' : 'empresas sincronizadas'}.`);
      }
    } catch (error: any) {
      toast.error(error?.message || 'Não foi possível sincronizar as empresas.');
    }
  };

  if (isLoading) return <AdminFinanceSkeleton />;

  if (hasDataFailure) {
    return (
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            <CircleDollarSign className="h-3.5 w-3.5" />
            Cobranças da plataforma
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe vínculos, mensalidades em aberto e sincronização com o Asaas.
          </p>
        </div>

        <Card className="border-destructive/20 shadow-sm">
          <CardContent className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 rounded-xl bg-destructive-soft p-3 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h2 className="font-semibold">
              {structureUnavailable ? 'Financeiro ainda não está disponível neste ambiente' : 'Não foi possível carregar os dados financeiros'}
            </h2>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
              {structureUnavailable
                ? 'Aplique a estrutura de banco e publique as funções financeiras antes de configurar o módulo.'
                : 'A leitura falhou, por isso os indicadores não foram exibidos como zero. Nenhuma informação financeira foi alterada.'}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button
                variant="outline"
                onClick={() => void Promise.all([
                  moduleQuery.refetch(),
                  configQuery.refetch(),
                  overviewQuery.refetch(),
                ])}
                className="gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                Tentar novamente
              </Button>
              <Button asChild variant="outline" className="gap-2">
                <Link to="/integracoes">
                  <Settings2 className="h-4 w-4" />
                  Abrir integração
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            <CircleDollarSign className="h-3.5 w-3.5" />
            Cobranças da plataforma
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe vínculos, mensalidades em aberto e sincronização com o Asaas.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCustomerLookupOpen(true)}
            disabled={!config?.configured}
            className="gap-2"
            title={config?.configured ? 'Pesquisar clientes no Asaas' : 'Configure o token global do Asaas primeiro'}
          >
            <Search className="h-4 w-4" />
            Localizar Customer ID
          </Button>
          <Button asChild variant="outline" className="gap-2">
            <Link to="/integracoes">
              <Settings2 className="h-4 w-4" />
              Configurar Asaas
            </Link>
          </Button>
          <Button
            onClick={handleSyncAll}
            disabled={!moduleStatus?.enabled || !config?.configured || syncAll.isPending}
            className="gap-2"
          >
            {syncAll.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sincronizar empresas
          </Button>
        </div>
      </div>

      {(!moduleStatus?.available || !config?.configured || !moduleStatus.enabled) && (
        <Card className="overflow-hidden border-primary/20 shadow-sm">
          <div className="h-1 bg-primary" />
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border border-primary/15 bg-primary-soft p-2 text-primary">
                <Settings2 className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold">
                  {!moduleStatus?.available
                    ? 'Estrutura financeira aguardando implantação'
                    : !config?.configured
                      ? 'Conecte o Asaas para iniciar'
                      : 'Financeiro global desativado'}
                </p>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  {!moduleStatus?.available
                    ? 'A página está pronta, mas as tabelas e funções financeiras ainda não estão disponíveis neste ambiente.'
                    : !config?.configured
                      ? 'Cadastre e valide o token global. Nenhuma cobrança será criada ou alterada pelo Plug Guest.'
                      : 'Os clientes ainda não veem o módulo. O superadmin pode revisar vínculos e abrir uma prévia por empresa antes da ativação.'}
                </p>
              </div>
            </div>
            <Button asChild variant="outline" className="shrink-0 gap-2">
              <Link to="/integracoes">
                Abrir integração
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo financeiro global">
        <MetricCard
          icon={Building2}
          label="Empresas vinculadas"
          value={`${totals?.configuredCompanyCount ?? 0}`}
          detail={`${enabledCompanyCount} ${enabledCompanyCount === 1 ? 'ativa' : 'ativas'} de ${totals?.companyCount ?? 0} ${(totals?.companyCount ?? 0) === 1 ? 'empresa' : 'empresas'}`}
        />
        <MetricCard
          icon={Clock3}
          label="Total em aberto"
          value={currencyFormatter.format(totals?.openTotal ?? 0)}
          detail={`${totals?.openCount ?? 0} ${(totals?.openCount ?? 0) === 1 ? 'cobrança' : 'cobranças'}`}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Total vencido"
          value={currencyFormatter.format(totals?.overdueTotal ?? 0)}
          detail={`${totals?.overdueCount ?? 0} ${(totals?.overdueCount ?? 0) === 1 ? 'cobrança vencida' : 'cobranças vencidas'}`}
          danger={(totals?.overdueCount ?? 0) > 0}
        />
        <MetricCard
          icon={Settings2}
          label="Sem vínculo"
          value={`${totals?.unconfiguredCompanyCount ?? 0}`}
          detail={attentionCount > 0
            ? `${pendingValidationCount} para revalidar · ${totals?.errorCompanyCount ?? 0} com erro${disabledLinkCount > 0 ? ` · ${disabledLinkCount} ${disabledLinkCount === 1 ? 'vínculo desativado' : 'vínculos desativados'}` : ''}`
            : 'Todos os vínculos configurados'}
          warning={(totals?.unconfiguredCompanyCount ?? 0) > 0 || attentionCount > 0}
        />
      </section>

      <div className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.045] px-4 py-3.5">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold">O que significa “Ativar Financeiro”?</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A aba Financeiro passa a aparecer para os administradores da empresa, e as faturas são sincronizadas automaticamente a cada quatro horas. Essa configuração não cria cobranças no Asaas nem suspende a conta automaticamente.
          </p>
        </div>
      </div>

      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="border-b border-border bg-muted/15">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <WalletCards className="h-4 w-4 text-primary" />
                Empresas e faturas
              </CardTitle>
              <CardDescription className="mt-1">
                A sincronização considera apenas cobranças com o marcador [PLUGUEGUEST].
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative sm:w-72">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar empresa ou cliente Asaas"
                  className="pl-9"
                />
              </div>
              <Select value={filter} onValueChange={(value) => setFilter(value as CompanyFilter)}>
                <SelectTrigger className="sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as empresas</SelectItem>
                  <SelectItem value="overdue">Com fatura vencida</SelectItem>
                  <SelectItem value="enabled">Financeiro ativo</SelectItem>
                  <SelectItem value="disabled">Financeiro desativado</SelectItem>
                  <SelectItem value="configured">Vinculadas</SelectItem>
                  <SelectItem value="unconfigured">Não vinculadas</SelectItem>
                  <SelectItem value="error">Revalidar ou com erro</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {visibleCompanies.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
              <Search className="mb-3 h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm font-medium">Nenhuma empresa encontrada</p>
              <p className="mt-1 text-xs text-muted-foreground">Altere a busca ou o filtro para visualizar outros registros.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Empresa</TableHead>
                    <TableHead>Ativar Financeiro</TableHead>
                    <TableHead>Vínculo Asaas</TableHead>
                    <TableHead>Próximo vencimento</TableHead>
                    <TableHead>Em aberto</TableHead>
                    <TableHead>Vencido</TableHead>
                    <TableHead>Última sincronização</TableHead>
                    <TableHead className="w-44 text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleCompanies.map((company) => (
                    <CompanyOverviewRow
                      key={company.companyId}
                      company={company}
                      configReady={!!config?.configured}
                      globalEnabled={!!moduleStatus?.enabled}
                      onConfigure={() => setBillingTarget(toCompanyBillingTarget(company))}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AsaasCustomerLookupDialog
        open={customerLookupOpen}
        onOpenChange={setCustomerLookupOpen}
        companies={companies ?? []}
      />

      <CompanyDialog
        open={billingTarget !== null}
        company={null}
        billingTarget={billingTarget}
        onOpenChange={(open) => {
          if (!open) setBillingTarget(null);
        }}
      />
    </div>
  );
}

function CompanyOverviewRow({
  company,
  configReady,
  globalEnabled,
  onConfigure,
}: {
  company: PlatformBillingCompanyOverview;
  configReady: boolean;
  globalEnabled: boolean;
  onConfigure: () => void;
}) {
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const setCompanyEnabled = useSetCompanyBillingEnabled();
  const hasError = company.linkStatus === 'error' || !!company.lastSyncError;
  const canToggle = configReady
    && company.configured
    && (company.linkStatus === 'active' || company.billingEnabled);
  const linkPresentation = company.linkStatus === 'pending_validation'
    ? { label: 'Revalidar', className: 'border-warning/25 bg-warning-soft text-amber-800' }
    : company.linkStatus === 'disabled'
      ? { label: 'Desativado', className: 'border-border bg-muted text-muted-foreground' }
      : hasError
        ? { label: 'Com erro', className: 'border-destructive/25 bg-destructive-soft text-destructive' }
        : { label: 'Vinculado', className: 'border-success/25 bg-success-soft text-success' };
  const syncPresentation = company.linkStatus === 'pending_validation'
    ? { label: 'Aguardando revalidação', className: 'text-sm text-amber-800' }
    : company.linkStatus === 'disabled'
      ? { label: 'Vínculo desativado', className: 'text-sm text-muted-foreground' }
      : hasError
        ? { label: 'Falha na última tentativa', className: 'text-sm text-destructive' }
        : { label: formatDateTime(company.lastSyncedAt), className: 'text-sm text-muted-foreground' };

  const handleConfirmToggle = async () => {
    if (pendingEnabled === null) return;
    try {
      await setCompanyEnabled.mutateAsync({
        companyId: company.companyId,
        enabled: pendingEnabled,
        expectedBillingRevision: company.billingRevision,
      });
      toast.success(
        pendingEnabled
          ? `Financeiro ativado para ${company.companyName}.`
          : `Financeiro desativado para ${company.companyName}.`,
      );
      setPendingEnabled(null);
    } catch (error: any) {
      toast.error(error?.message || 'Não foi possível alterar o status do Financeiro desta empresa.');
    }
  };

  return (
    <>
      <TableRow>
      <TableCell>
        <p className="font-medium">{company.companyName}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{company.companyStatus === 'paused' ? 'Empresa pausada' : 'Empresa ativa'}</p>
      </TableCell>
      <TableCell>
        <div className="flex min-w-36 items-center gap-2">
          <Switch
            checked={company.billingEnabled}
            onCheckedChange={setPendingEnabled}
            disabled={!canToggle || setCompanyEnabled.isPending}
            aria-label={`${company.billingEnabled ? 'Desativar' : 'Ativar'} Financeiro para ${company.companyName}`}
          />
          <span className={company.billingEnabled ? 'text-xs font-semibold text-success' : 'text-xs font-medium text-muted-foreground'}>
            {company.billingEnabled ? 'Ativo' : 'Desativado'}
          </span>
        </div>
        <p className="mt-1 max-w-40 text-[11px] leading-snug text-muted-foreground">
          {company.billingEnabled
            ? globalEnabled
              ? 'Aba para admins + sincronização automática'
              : 'Aguardando ativação global'
            : company.configured
              ? 'Somente prévia do superadmin'
              : 'Vincule um cliente primeiro'}
        </p>
      </TableCell>
      <TableCell>
        {company.configured ? (
          <div className="space-y-1">
            <Badge variant="outline" className={linkPresentation.className}>
              {linkPresentation.label}
            </Badge>
            <p className="max-w-48 truncate text-xs text-muted-foreground" title={company.customerId || undefined}>
              {company.customerName || company.customerId}
            </p>
          </div>
        ) : (
          <Badge variant="outline" className="border-border bg-muted text-muted-foreground">Não vinculado</Badge>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {company.nextDueDate ? (
          <div>
            <p className="font-medium tabular-nums">{formatDate(company.nextDueDate)}</p>
            <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{currencyFormatter.format(company.nextDueAmount)}</p>
          </div>
        ) : '—'}
      </TableCell>
      <TableCell>
        <p className="font-medium tabular-nums">{currencyFormatter.format(company.openTotal)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {company.openCount} {company.openCount === 1 ? 'cobrança' : 'cobranças'}
        </p>
      </TableCell>
      <TableCell>
        <p className={company.overdueCount > 0 ? 'font-semibold tabular-nums text-destructive' : 'font-medium tabular-nums'}>
          {currencyFormatter.format(company.overdueTotal)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {company.overdueCount > 0
            ? `${company.overdueCount} ${company.overdueCount === 1 ? 'vencida' : 'vencidas'} · ${company.oldestOverdueDays}d`
            : 'Em dia'}
        </p>
      </TableCell>
      <TableCell>
        <p className={syncPresentation.className}>
          {syncPresentation.label}
        </p>
        {company.lastSyncedAt && company.linkStatus === 'active' && !hasError && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {company.lastMatchedCount} {company.lastMatchedCount === 1 ? 'importada' : 'importadas'}
            {company.lastIgnoredCount > 0
              ? ` · ${company.lastIgnoredCount} ${company.lastIgnoredCount === 1 ? 'ignorada' : 'ignoradas'}`
              : ''}
          </p>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link to={`/financeiro/empresa/${company.companyId}`}>
              <Eye className="h-3.5 w-3.5" />
              Prévia
            </Link>
          </Button>
          <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onConfigure}>
            Configurar
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
      </TableRow>
      <AlertDialog
        open={pendingEnabled !== null}
        onOpenChange={(open) => {
          if (!open && !setCompanyEnabled.isPending) setPendingEnabled(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingEnabled ? 'Ativar Financeiro para esta empresa?' : 'Desativar Financeiro desta empresa?'}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                {pendingEnabled
                  ? globalEnabled
                    ? `A aba Financeiro passará a aparecer para os administradores de ${company.companyName}, e as faturas serão sincronizadas automaticamente a cada quatro horas. Essa ativação não cria cobranças no Asaas nem suspende a conta automaticamente.`
                    : `O Financeiro ficará ativo para ${company.companyName}, mas a aba para os administradores e a sincronização automática só funcionarão quando o Financeiro global for ativado. Essa ativação não cria cobranças no Asaas nem suspende a conta automaticamente.`
                  : `A aba Financeiro deixará de aparecer para os administradores de ${company.companyName}, e a empresa sairá da sincronização automática.`}
              </span>
              <span className="block font-medium text-foreground/80">
                A cópia local das faturas será preservada. O superadmin continuará com acesso à prévia e à sincronização manual.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setCompanyEnabled.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmToggle();
              }}
              disabled={setCompanyEnabled.isPending}
            >
              {setCompanyEnabled.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pendingEnabled ? 'Ativar Financeiro' : 'Desativar Financeiro'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  danger = false,
  warning = false,
}: {
  icon: typeof Building2;
  label: string;
  value: string;
  detail: string;
  danger?: boolean;
  warning?: boolean;
}) {
  const iconClassName = danger
    ? 'bg-destructive-soft text-destructive'
    : warning
      ? 'bg-warning-soft text-amber-800'
      : 'bg-primary-soft text-primary';

  return (
    <Card className={danger ? 'border-destructive/25 shadow-sm' : 'shadow-sm'}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className={danger ? 'mt-2 truncate text-xl font-semibold tabular-nums text-destructive' : 'mt-2 truncate text-xl font-semibold tabular-nums'}>{value}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
          </div>
          <div className={`rounded-lg p-2 ${iconClassName}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminFinanceSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-10 w-48" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-lg" />)}
      </div>
      <Skeleton className="h-96 rounded-lg" />
    </div>
  );
}
