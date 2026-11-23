import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Link2Off, Send, Settings2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ADMIN_SETTLEMENTS_KEY,
  fetchAllSettlementCompanies,
  fetchPendingWithdrawals,
  usePendingWithdrawalCount,
} from '@/hooks/useAdminSettlements';
import { useSuperadminBillingOverview } from '@/hooks/usePlatformBilling';
import { formatSettlementMoney, getAdminSettlementOverview } from '@/lib/reservation-settlements-api';
import { cn } from '@/lib/utils';
import AdminFinance, { type CompanyFilter } from './AdminFinance';
import AdminRepasses, { type QueueSegment } from './AdminRepasses';

type FinanceTab = 'resumo' | 'mensalidades' | 'repasses' | 'saldos';
const TABS: FinanceTab[] = ['resumo', 'mensalidades', 'repasses', 'saldos'];
const MENSALIDADE_FILTERS: CompanyFilter[] = ['all', 'overdue', 'enabled', 'disabled', 'configured', 'unconfigured', 'error'];
const QUEUE_SEGMENTS: QueueSegment[] = ['pending', 'processing', 'all'];

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function ago(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return formatDistanceToNowStrict(date, { addSuffix: true, locale: ptBR });
}

export default function AdminFinancialHub() {
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('aba') ?? 'resumo';
  const rawFilter = params.get('filtro') ?? 'all';
  const rawSegment = params.get('situacao') ?? 'pending';
  const tab = (TABS as string[]).includes(rawTab) ? (rawTab as FinanceTab) : 'resumo';
  const mensalidadeFilter = (MENSALIDADE_FILTERS as string[]).includes(rawFilter) ? (rawFilter as CompanyFilter) : 'all';
  const queueSegment = (QUEUE_SEGMENTS as string[]).includes(rawSegment) ? (rawSegment as QueueSegment) : 'pending';

  const billingQuery = useSuperadminBillingOverview();
  const pendingCountQuery = usePendingWithdrawalCount({ enabled: true });
  const overdueCount = billingQuery.data?.totals?.overdueCount ?? 0;
  const pendingCount = pendingCountQuery.data ?? 0;

  const openTab = (next: FinanceTab, options?: { filtro?: CompanyFilter; situacao?: QueueSegment }) => {
    const updated = new URLSearchParams();
    if (next !== 'resumo') updated.set('aba', next);
    if (options?.filtro && options.filtro !== 'all') updated.set('filtro', options.filtro);
    if (options?.situacao && options.situacao !== 'pending') updated.set('situacao', options.situacao);
    setParams(updated, { replace: true });
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader
        eyebrow="Gestão"
        title="Financeiro"
        description="Mensalidades são cobranças da plataforma às empresas. Repasses são valores das reservas que a plataforma deve às empresas."
        actions={(
          <Button asChild variant="outline" className="gap-2">
            <Link to="/configuracoes?aba=pagamentos">
              <Settings2 className="h-4 w-4" />
              Conexões do Asaas
            </Link>
          </Button>
        )}
      />

      <Tabs value={tab} onValueChange={(value) => openTab(value as FinanceTab)}>
        <TabsList aria-label="Seções do financeiro" className="h-auto flex-wrap">
          <TabsTrigger value="resumo">Resumo</TabsTrigger>
          <TabsTrigger value="mensalidades" className="gap-2">
            Mensalidades
            {overdueCount > 0 && (
              <span className="rounded-full bg-destructive-soft px-1.5 text-[11px] font-semibold text-destructive">
                {overdueCount} {overdueCount === 1 ? 'vencida' : 'vencidas'}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="repasses" className="gap-2">
            Repasses
            {pendingCount > 0 && (
              <span className="rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold text-amber-900">
                {pendingCount} {pendingCount === 1 ? 'pendente' : 'pendentes'}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="saldos">Saldos</TabsTrigger>
        </TabsList>

        <TabsContent value="resumo" className="mt-5">
          <FinanceSummary onOpen={openTab} />
        </TabsContent>
        <TabsContent value="mensalidades" className="mt-5">
          <AdminFinance key={mensalidadeFilter} initialFilter={mensalidadeFilter} />
        </TabsContent>
        <TabsContent value="repasses" className="mt-5">
          <AdminRepasses key={queueSegment} view="queue" initialSegment={queueSegment} />
        </TabsContent>
        <TabsContent value="saldos" className="mt-5">
          <AdminRepasses view="balances" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface PendingItem {
  id: string;
  tone: 'warning' | 'danger' | 'neutral' | 'info';
  icon: typeof Clock3;
  title: string;
  detail: string;
  value?: string;
  actionLabel: string;
  onAction: () => void;
}

function FinanceSummary({ onOpen }: {
  onOpen: (tab: FinanceTab, options?: { filtro?: CompanyFilter; situacao?: QueueSegment }) => void;
}) {
  const billingQuery = useSuperadminBillingOverview();
  const pendingQuery = useQuery({
    queryKey: [ADMIN_SETTLEMENTS_KEY, 'summary', 'pending'],
    queryFn: fetchPendingWithdrawals,
    retry: false,
  });
  const processingQuery = useQuery({
    queryKey: [ADMIN_SETTLEMENTS_KEY, 'summary', 'processing'],
    queryFn: () => getAdminSettlementOverview('processing', 0, 0, { limit: 100, companyLimit: 1 }),
    retry: false,
  });
  const balancesQuery = useQuery({
    queryKey: [ADMIN_SETTLEMENTS_KEY, 'summary', 'companies'],
    queryFn: fetchAllSettlementCompanies,
    retry: false,
  });

  const billing = billingQuery.data;
  const billingAvailable = billing?.available !== false;
  const totals = billing?.totals;
  const billingCompanies = billing?.companies ?? [];
  const enabledCount = billingCompanies.filter((company) => company.billingEnabled).length;
  const openTotal = totals?.openTotal ?? 0;
  const overdueTotal = totals?.overdueTotal ?? 0;
  const overdueShare = openTotal > 0 ? Math.min(100, (overdueTotal / openTotal) * 100) : 0;

  const pending = pendingQuery.data;
  const pendingSum = (pending?.withdrawals ?? []).reduce((sum, item) => sum + item.amount_cents, 0);
  const oldestPending = pending?.withdrawals[0];
  const processingRows = processingQuery.data?.withdrawals ?? [];
  const processingTotal = processingQuery.data?.total ?? 0;
  const processingSum = processingRows.reduce((sum, item) => sum + item.amount_cents, 0);
  const balances = balancesQuery.data ?? [];
  const companyBalance = balances.reduce((sum, row) => sum + row.available_cents + row.pending_cents, 0);
  const blockedBalance = balances.reduce((sum, row) => sum + (row.blocked_cents ?? 0), 0);

  const items: PendingItem[] = [];
  if (pending && pending.total > 0) {
    items.push({
      id: 'pending',
      tone: 'warning',
      icon: Clock3,
      title: `${pending.total} ${pending.total === 1 ? 'pedido de saque aguardando análise' : 'pedidos de saque aguardando análise'}`,
      detail: oldestPending
        ? `O mais antigo é de ${oldestPending.company_name ?? 'uma empresa'}, ${ago(oldestPending.created_at)}`
        : 'Confira a fila de repasses',
      value: pending.complete ? formatSettlementMoney(pendingSum) : undefined,
      actionLabel: 'Analisar',
      onAction: () => onOpen('repasses', { situacao: 'pending' }),
    });
  }
  if (processingTotal > 0) {
    items.push({
      id: 'processing',
      tone: 'info',
      icon: Send,
      title: `${processingTotal} ${processingTotal === 1 ? 'pagamento iniciado e não registrado' : 'pagamentos iniciados e não registrados'}`,
      detail: 'Depois de pagar pelo banco, registre o pagamento e anexe o comprovante',
      value: processingRows.length >= processingTotal ? formatSettlementMoney(processingSum) : undefined,
      actionLabel: 'Registrar',
      onAction: () => onOpen('repasses', { situacao: 'processing' }),
    });
  }
  for (const company of billingCompanies.filter((row) => row.overdueCount > 0).slice(0, 5)) {
    items.push({
      id: `overdue-${company.companyId}`,
      tone: 'danger',
      icon: AlertTriangle,
      title: `Mensalidade vencida: ${company.companyName}`,
      detail: `${company.overdueCount} ${company.overdueCount === 1 ? 'cobrança vencida' : 'cobranças vencidas'} · a mais antiga há ${company.oldestOverdueDays} ${company.oldestOverdueDays === 1 ? 'dia' : 'dias'}`,
      value: currency.format(company.overdueTotal),
      actionLabel: 'Ver mensalidades',
      onAction: () => onOpen('mensalidades', { filtro: 'overdue' }),
    });
  }
  const attentionCompanies = billingCompanies.filter((row) =>
    row.linkStatus === 'pending_validation' || row.linkStatus === 'error' || !!row.lastSyncError);
  if (attentionCompanies.length > 0) {
    items.push({
      id: 'link-attention',
      tone: 'danger',
      icon: AlertTriangle,
      title: `${attentionCompanies.length} ${attentionCompanies.length === 1 ? 'vínculo com o Asaas precisa' : 'vínculos com o Asaas precisam'} de atenção`,
      detail: attentionCompanies.slice(0, 3).map((row) => row.companyName).join(', '),
      actionLabel: 'Revisar',
      onAction: () => onOpen('mensalidades', { filtro: 'error' }),
    });
  }
  const unconfigured = totals?.unconfiguredCompanyCount ?? 0;
  if (unconfigured > 0) {
    items.push({
      id: 'unconfigured',
      tone: 'neutral',
      icon: Link2Off,
      title: `${unconfigured} ${unconfigured === 1 ? 'empresa sem vínculo' : 'empresas sem vínculo'} no Asaas`,
      detail: 'Sem vínculo, a empresa não recebe a cobrança da assinatura',
      actionLabel: 'Vincular',
      onAction: () => onOpen('mensalidades', { filtro: 'unconfigured' }),
    });
  }

  const pendingLoading = billingQuery.isPending || pendingQuery.isPending || processingQuery.isPending;
  const failed = [
    billingQuery.isError && 'mensalidades',
    pendingQuery.isError && 'pedidos pendentes',
    processingQuery.isError && 'pagamentos em andamento',
    balancesQuery.isError && 'saldos das empresas',
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      {failed.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive-soft/50 px-4 py-3 text-sm text-destructive">
          <span>Não foi possível carregar: {failed.join(', ')}. Esses valores não foram mostrados como zero.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (billingQuery.isError) void billingQuery.refetch();
              if (pendingQuery.isError) void pendingQuery.refetch();
              if (processingQuery.isError) void processingQuery.refetch();
              if (balancesQuery.isError) void balancesQuery.refetch();
            }}
          >
            Tentar novamente
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Mensalidades</CardTitle>
            <CardDescription>Cobranças da plataforma às empresas</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {billingQuery.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : billingQuery.isError || !billingAvailable ? (
              <p className="text-sm text-muted-foreground">
                {billingAvailable ? 'Valores indisponíveis no momento.' : 'O módulo de mensalidades ainda não está disponível neste ambiente.'}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm text-muted-foreground">Em aberto</span>
                  <span className="text-2xl font-semibold tabular-nums">{currency.format(openTotal)}</span>
                  <span className="text-sm text-muted-foreground">
                    {totals?.openCount ?? 0} {(totals?.openCount ?? 0) === 1 ? 'cobrança' : 'cobranças'}
                  </span>
                </div>
                <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-muted">
                  <span className="bg-primary" style={{ width: `${100 - overdueShare}%` }} />
                  <span className="bg-destructive" style={{ width: `${overdueShare}%` }} />
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-primary" />
                    A vencer: {currency.format(openTotal - overdueTotal)} ({Math.max(0, (totals?.openCount ?? 0) - (totals?.overdueCount ?? 0))})
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-destructive">
                    <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-destructive" />
                    Vencido: {currency.format(overdueTotal)} ({totals?.overdueCount ?? 0})
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">O valor vencido já está dentro do total em aberto.</p>
                <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                  Cobrança da assinatura ativa em <strong className="font-semibold">{enabledCount} de {totals?.companyCount ?? 0}</strong> empresas
                </p>
              </>
            )}
            <Button variant="link" className="h-auto gap-1 p-0 text-accent-foreground" onClick={() => onOpen('mensalidades')}>
              Ver mensalidades <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Repasses</CardTitle>
            <CardDescription>Valores das reservas devidos às empresas (todas as empresas)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pendingQuery.isPending ? (
              <Skeleton className="h-10 w-full" />
            ) : pendingQuery.isError ? (
              <p className="text-sm text-muted-foreground">Pedidos pendentes indisponíveis no momento.</p>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm text-muted-foreground">Aguardando análise</span>
                <span className="text-2xl font-semibold tabular-nums">
                  {pending?.complete ? formatSettlementMoney(pendingSum) : `${pending?.total ?? 0} pedidos`}
                </span>
                <span className={cn('text-sm', (pending?.total ?? 0) > 0 ? 'text-amber-800' : 'text-muted-foreground')}>
                  {(pending?.total ?? 0) === 0
                    ? 'nenhum pedido'
                    : `${pending?.total} ${pending?.total === 1 ? 'pedido' : 'pedidos'}${oldestPending ? ` · o mais antigo ${ago(oldestPending.created_at)}` : ''}`}
                </span>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">Em pagamento</p>
                {processingQuery.isPending ? <Skeleton className="mt-1 h-6 w-24" /> : processingQuery.isError ? (
                  <p className="mt-1 text-sm text-muted-foreground">Indisponível</p>
                ) : (
                  <>
                    <p className="mt-1 text-lg font-semibold tabular-nums">
                      {processingRows.length >= processingTotal ? formatSettlementMoney(processingSum) : `${processingTotal} pedidos`}
                    </p>
                    <p className="text-xs text-muted-foreground">{processingTotal} {processingTotal === 1 ? 'pedido' : 'pedidos'}</p>
                  </>
                )}
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">Saldo nas empresas</p>
                {balancesQuery.isPending ? <Skeleton className="mt-1 h-6 w-24" /> : balancesQuery.isError ? (
                  <p className="mt-1 text-sm text-muted-foreground">Indisponível</p>
                ) : (
                  <>
                    <p className="mt-1 text-lg font-semibold tabular-nums">{formatSettlementMoney(companyBalance)}</p>
                    <p className="text-xs text-muted-foreground">
                      disponível + a liberar{blockedBalance > 0 ? ` · ${formatSettlementMoney(blockedBalance)} em conferência` : ''}
                    </p>
                  </>
                )}
              </div>
            </div>
            <Button variant="link" className="h-auto gap-1 p-0 text-accent-foreground" onClick={() => onOpen('repasses', { situacao: 'pending' })}>
              Ver repasses pendentes <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="border-b border-border">
          <CardTitle className="text-base">O que precisa de você</CardTitle>
          <CardDescription>Pendências de mensalidades e repasses, da mais urgente para a menos urgente.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {pendingLoading ? (
            <div className="space-y-3 p-5">
              {[1, 2].map((item) => <Skeleton key={item} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="flex items-center gap-3 px-5 py-6 text-sm text-muted-foreground">
              <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-success" />
              {failed.length > 0 ? 'Nenhuma pendência entre os dados que carregaram.' : 'Nada pendente agora.'}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                        item.tone === 'warning' && 'bg-warning-soft text-amber-800',
                        item.tone === 'danger' && 'bg-destructive-soft text-destructive',
                        item.tone === 'info' && 'bg-info-soft text-info',
                        item.tone === 'neutral' && 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">{item.detail}</p>
                    </div>
                    {item.value && (
                      <span className={cn('text-sm font-semibold tabular-nums', item.tone === 'danger' && 'text-destructive')}>
                        {item.value}
                      </span>
                    )}
                    <Button size="sm" variant={item.tone === 'warning' ? 'default' : 'outline'} onClick={item.onAction}>
                      {item.actionLabel}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
