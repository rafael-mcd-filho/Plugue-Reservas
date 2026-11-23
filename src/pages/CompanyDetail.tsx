import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  Link2Off,
  Loader2,
  Pause,
  Phone,
  Play,
  Trash2,
  Wallet,
} from 'lucide-react';
import ListStateMessage from '@/components/admin/ListStateMessage';
import CompanyFeaturesTab from '@/components/company-detail/CompanyFeaturesTab';
import CompanyFinanceTab from '@/components/company-detail/CompanyFinanceTab';
import CompanyHistoryList from '@/components/company-detail/CompanyHistoryList';
import CompanyRegistrationTab from '@/components/company-detail/CompanyRegistrationTab';
import CompanyUsersTab from '@/components/company-detail/CompanyUsersTab';
import { buildCompanyHistory } from '@/components/company-detail/companyHistory';
import { useCompanyHistory, useCompanySettlement } from '@/components/company-detail/useCompanyDetailData';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  useCancelCompanyDeletion,
  useCompanies,
  useRequestCompanyDeletion,
  useUpdateCompany,
  type Company,
} from '@/hooks/useCompanies';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useLastPanelAccess } from '@/hooks/useLastPanelAccess';
import { useSuperadminBillingOverview } from '@/hooks/usePlatformBilling';
import { useUrlParam } from '@/hooks/useUrlParam';
import { useUsers } from '@/hooks/useUsers';
import { COMPANY_FEATURE_DEFINITIONS } from '@/lib/companyFeatures';
import { formatSettlementMoney } from '@/lib/reservation-settlements-api';
import { cn } from '@/lib/utils';

type DetailTab = 'visao' | 'cadastro' | 'recursos' | 'financeiro' | 'usuarios' | 'historico';
const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'cadastro', label: 'Cadastro' },
  { id: 'recursos', label: 'Recursos' },
  { id: 'financeiro', label: 'Financeiro' },
  { id: 'usuarios', label: 'Usuários' },
  { id: 'historico', label: 'Histórico' },
];
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function formatDate(value: string | null | undefined, pattern = 'dd/MM/yyyy') {
  if (!value) return '—';
  try { return format(parseISO(value), pattern, { locale: ptBR }); } catch { return '—'; }
}

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const companiesQuery = useCompanies();
  const company = companiesQuery.data?.find((item) => item.id === id) ?? null;

  if (companiesQuery.isPending) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-96 max-w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (companiesQuery.isError) {
    return (
      <Card className="shadow-sm">
        <ListStateMessage
          variant="error"
          title="Não foi possível carregar a empresa"
          actionLabel="Tentar novamente"
          onAction={() => void companiesQuery.refetch()}
        />
      </Card>
    );
  }
  if (!company) {
    return (
      <Card className="shadow-sm">
        <ListStateMessage variant="no-results" title="Empresa não encontrada" description="Ela pode ter sido excluída." />
        <div className="flex justify-center pb-8">
          <Button asChild variant="outline"><Link to="/empresas">Voltar para Empresas</Link></Button>
        </div>
      </Card>
    );
  }
  return <CompanyDetailContent key={company.id} company={company} companies={companiesQuery.data ?? []} />;
}

function CompanyDetailContent({ company, companies }: { company: Company; companies: Company[] }) {
  const navigate = useNavigate();
  const [rawTab, setTab] = useUrlParam('aba', 'visao');
  const tab = TABS.some((item) => item.id === rawTab) ? (rawTab as DetailTab) : 'visao';
  const [dirtyTabs, setDirtyTabs] = useState<{ cadastro: boolean; recursos: boolean }>({ cadastro: false, recursos: false });
  const [pauseOpen, setPauseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [historyFilter, setHistoryFilter] = useState<'tudo' | 'acesso' | 'alteracao'>('tudo');

  const updateCompany = useUpdateCompany();
  const requestDeletion = useRequestCompanyDeletion();
  const cancelDeletion = useCancelCompanyDeletion();
  const featuresQuery = useCompanyFeatureFlags(company.id);
  const billingQuery = useSuperadminBillingOverview();
  const settlementQuery = useCompanySettlement(company.id);
  const usersQuery = useUsers();
  const historyQuery = useCompanyHistory(company.id);

  const companyUsers = useMemo(
    () => (usersQuery.data ?? [])
      .filter((user) => user.company_id === company.id || user.support_company_ids?.includes(company.id))
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email, 'pt-BR')),
    [company.id, usersQuery.data],
  );
  const lastAccessQuery = useLastPanelAccess(companyUsers.map((user) => user.id), company.id);
  const latestAccess = Object.values(lastAccessQuery.data ?? {})
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  const companyName = useCallback((companyId: string) => companies.find((item) => item.id === companyId)?.name ?? null, [companies]);
  const history = useMemo(
    () => historyQuery.data
      ? buildCompanyHistory(historyQuery.data.access, historyQuery.data.audit, usersQuery.data ?? [], companyName)
      : [],
    [companyName, historyQuery.data, usersQuery.data],
  );

  const billing = billingQuery.data?.companies?.find((row) => row.companyId === company.id) ?? null;
  const billingAvailable = billingQuery.data?.available !== false;
  const settlement = settlementQuery.data;
  const pendingWithdrawals = (settlement?.withdrawals ?? []).filter((item) => item.status === 'requested' || item.status === 'under_review');
  const features = featuresQuery.data?.features;
  const activeFeatures = features ? COMPANY_FEATURE_DEFINITIONS.filter((feature) => features[feature.key]) : [];
  const disabledFeatures = features ? COMPANY_FEATURE_DEFINITIONS.filter((feature) => !features[feature.key]) : [];
  const anyDirty = dirtyTabs.cadastro || dirtyTabs.recursos;
  const isPaused = company.status === 'paused';
  const deletionPending = !!company.deletion_requested_at;
  const publicUrl = `${window.location.origin}/${company.slug}`;

  const setCadastroDirty = useCallback((dirty: boolean) => setDirtyTabs((current) => (current.cadastro === dirty ? current : { ...current, cadastro: dirty })), []);
  const setRecursosDirty = useCallback((dirty: boolean) => setDirtyTabs((current) => (current.recursos === dirty ? current : { ...current, recursos: dirty })), []);

  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success('Link copiado.');
    } catch {
      toast.error('Não foi possível copiar. Copie pelo endereço: ' + publicUrl);
    }
  };

  const pendencies: Array<{ id: string; tone: 'danger' | 'warning' | 'neutral'; icon: typeof AlertTriangle; title: string; detail: string; action?: { label: string; onClick: () => void } }> = [];
  if (deletionPending) {
    pendencies.push({
      id: 'deletion', tone: 'danger', icon: Trash2,
      title: 'Exclusão em andamento',
      detail: `Pedida em ${formatDate(company.deletion_requested_at, "dd/MM/yyyy 'às' HH:mm")}. Pode ser cancelada durante a carência.`,
      action: { label: 'Cancelar exclusão', onClick: () => cancelDeletion.mutate(company.id) },
    });
  }
  if (isPaused) {
    pendencies.push({
      id: 'paused', tone: 'warning', icon: Pause,
      title: 'Empresa pausada',
      detail: 'Reative quando a empresa voltar a operar.',
      action: deletionPending ? undefined : { label: 'Reativar', onClick: () => setPauseOpen(true) },
    });
  }
  if (!company.responsible_phone_e164 && !company.responsible_phone) {
    pendencies.push({
      id: 'phone', tone: 'warning', icon: Phone,
      title: 'Telefone do responsável não cadastrado',
      detail: 'Sem ele, a empresa não recebe os avisos da plataforma pelo WhatsApp.',
      action: { label: 'Cadastrar', onClick: () => setTab('cadastro') },
    });
  }
  if (billing && billing.overdueCount > 0) {
    pendencies.push({
      id: 'overdue', tone: 'danger', icon: AlertTriangle,
      title: `Mensalidade vencida: ${currency.format(billing.overdueTotal)}`,
      detail: `${billing.overdueCount} ${billing.overdueCount === 1 ? 'cobrança vencida' : 'cobranças vencidas'} · a mais antiga há ${billing.oldestOverdueDays} ${billing.oldestOverdueDays === 1 ? 'dia' : 'dias'}`,
      action: { label: 'Ver financeiro', onClick: () => setTab('financeiro') },
    });
  }
  if (billing && (billing.linkStatus === 'pending_validation' || billing.linkStatus === 'error' || !!billing.lastSyncError)) {
    pendencies.push({
      id: 'link', tone: 'danger', icon: AlertTriangle,
      title: 'Vínculo com o Asaas precisa de atenção',
      detail: billing.lastSyncError || 'Revalide o cliente do Asaas desta empresa.',
      action: { label: 'Revisar', onClick: () => setTab('financeiro') },
    });
  }
  if (billingAvailable && billingQuery.isSuccess && !billing?.configured) {
    pendencies.push({
      id: 'unlinked', tone: 'neutral', icon: Link2Off,
      title: 'Sem vínculo no Asaas',
      detail: 'Sem vínculo, a empresa não recebe a cobrança da assinatura.',
      action: { label: 'Vincular', onClick: () => setTab('financeiro') },
    });
  }
  if (pendingWithdrawals.length > 0) {
    pendencies.push({
      id: 'withdrawals', tone: 'warning', icon: Wallet,
      title: `${pendingWithdrawals.length} ${pendingWithdrawals.length === 1 ? 'saque aguardando análise' : 'saques aguardando análise'}`,
      detail: 'A análise é feita na fila de repasses.',
      action: { label: 'Analisar', onClick: () => navigate('/financeiro?aba=repasses') },
    });
  }

  const filteredHistory = history.filter((item) => historyFilter === 'tudo' || item.kind === historyFilter);
  const deleteValid = (deleteText === company.name || deleteText === company.slug) && deleteReason.trim().length > 0;
  const pendenciesLoading = billingQuery.isPending || settlementQuery.isPending;
  const pendenciesUnavailable = billingQuery.isError || settlementQuery.isError || !billingAvailable;

  return (
    <div className="space-y-5">
      <Link to="/empresas" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Empresas
      </Link>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted">
            {company.logo_url
              ? <img src={company.logo_url} alt="" className="h-full w-full object-contain" />
              : <span className="text-sm font-semibold text-muted-foreground">{company.name.slice(0, 2).toUpperCase()}</span>}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{company.name}</h1>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
                  deletionPending
                    ? 'border-destructive/25 bg-destructive-soft text-destructive'
                    : isPaused
                      ? 'border-primary/25 bg-primary-soft text-accent-foreground'
                      : 'border-success/25 bg-success-soft text-success',
                )}
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                {deletionPending ? 'Exclusão em andamento' : isPaused ? 'Pausada' : 'Ativa'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <a href={`/${company.slug}`} target="_blank" rel="noreferrer" className="font-medium text-accent-foreground hover:underline">
                /{company.slug}
              </a>
              <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => void copyLink()}>
                <Copy aria-hidden="true" className="h-3 w-3" /> Copiar link
              </Button>
              <span aria-hidden="true">·</span>
              <span>Cadastrada em {formatDate(company.created_at)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="gap-2" disabled={deletionPending || updateCompany.isPending} onClick={() => setPauseOpen(true)}>
            {isPaused ? <Play aria-hidden="true" className="h-4 w-4" /> : <Pause aria-hidden="true" className="h-4 w-4" />}
            {isPaused ? 'Reativar empresa' : 'Pausar empresa'}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="gap-2 border-destructive/30 text-destructive hover:bg-destructive-soft hover:text-destructive"
            disabled={deletionPending}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            Excluir empresa
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value)}>
        <TabsList aria-label="Seções da empresa" className="h-auto flex-wrap">
          {TABS.map((item) => {
            const dirty = (item.id === 'cadastro' && dirtyTabs.cadastro) || (item.id === 'recursos' && dirtyTabs.recursos);
            const attention = item.id === 'cadastro' && !company.responsible_phone_e164 && !company.responsible_phone;
            return (
              <TabsTrigger key={item.id} value={item.id} className="gap-2">
                {item.label}
                {dirty
                  ? <span aria-label="alterações não salvas" className="h-1.5 w-1.5 rounded-full bg-primary" />
                  : attention && <span aria-label="precisa de atenção" className="h-1.5 w-1.5 rounded-full bg-warning" />}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="visao" className="mt-5 space-y-4">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="border-b py-4">
              <CardTitle className="text-base">O que precisa de atenção</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {pendenciesUnavailable && (
                <p role="status" className="border-b px-5 py-3 text-sm text-muted-foreground">Não foi possível conferir todas as pendências financeiras. Consulte a aba Financeiro para tentar novamente.</p>
              )}
              {pendencies.length === 0 ? (
                <p className="px-5 py-5 text-sm text-muted-foreground">{pendenciesLoading ? 'Consultando pendências…' : pendenciesUnavailable ? 'Nenhuma pendência entre os dados disponíveis.' : 'Nada pendente nesta empresa.'}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {pendencies.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                            item.tone === 'danger' && 'bg-destructive-soft text-destructive',
                            item.tone === 'warning' && 'bg-warning-soft text-amber-800',
                            item.tone === 'neutral' && 'bg-muted text-muted-foreground',
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1 basis-64">
                          <p className="text-sm font-medium">{item.title}</p>
                          <p className="text-xs text-muted-foreground">{item.detail}</p>
                        </div>
                        {item.action && (
                          <Button size="sm" variant={item.tone === 'neutral' ? 'outline' : 'default'} onClick={item.action.onClick}>
                            {item.action.label}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="Cobrança da assinatura"
              value={billingQuery.isPending ? null : billingQuery.isError || !billingAvailable ? 'Indisponível' : !billing?.configured ? 'Sem vínculo' : billing.billingEnabled ? (billing.overdueCount > 0 ? 'Ativa · em atraso' : 'Ativa · em dia') : 'Desligada'}
              detail={billingQuery.isError || !billingAvailable ? 'Consulte a aba Financeiro para tentar novamente' : billing?.configured ? `${currency.format(billing.openTotal)} em aberto${billing.nextDueDate ? ` · vence ${formatDate(billing.nextDueDate)}` : ''}` : 'Configure na aba Financeiro'}
              onClick={() => setTab('financeiro')}
            />
            <SummaryCard
              label="Repasses"
              value={settlementQuery.isPending ? null : settlementQuery.isError ? 'Indisponível' : settlement ? `${formatSettlementMoney(settlement.available_cents)} disponível` : 'Indisponível'}
              detail={settlementQuery.isError ? 'Consulte a aba Financeiro para tentar novamente' : settlementQuery.isPending ? 'Consultando pedidos de saque…' : pendingWithdrawals.length > 0 ? `${pendingWithdrawals.length} saque(s) aguardando análise` : 'Nenhum saque pendente'}
              onClick={() => setTab('financeiro')}
            />
            <SummaryCard
              label="Recursos"
              value={featuresQuery.isPending ? null : featuresQuery.isError || !features ? 'Indisponível' : `${activeFeatures.length} de ${COMPANY_FEATURE_DEFINITIONS.length} ativos`}
              detail={featuresQuery.isPending ? 'Consultando recursos…' : featuresQuery.isError || !features ? 'Consulte a aba Recursos para tentar novamente' : disabledFeatures.length ? `Desligado: ${disabledFeatures.map((feature) => feature.shortLabel).join(', ')}` : 'Todos ligados'}
              onClick={() => setTab('recursos')}
            />
            <SummaryCard
              label="Usuários"
              value={usersQuery.isPending ? null : usersQuery.isError ? 'Indisponível' : `${companyUsers.length} ${companyUsers.length === 1 ? 'pessoa' : 'pessoas'}`}
              detail={usersQuery.isError || lastAccessQuery.isError ? 'Último acesso indisponível' : usersQuery.isPending || lastAccessQuery.isPending && companyUsers.length > 0 ? 'Consultando acessos…' : latestAccess ? `Último acesso ao painel ${formatDistanceToNowStrict(new Date(latestAccess), { addSuffix: true, locale: ptBR })}` : 'Sem acesso registrado'}
              onClick={() => setTab('usuarios')}
            />
          </div>

          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b py-4">
              <CardTitle className="text-base">Atividade recente</CardTitle>
              <Button variant="link" className="h-auto p-0 text-accent-foreground" onClick={() => setTab('historico')}>
                Ver histórico completo →
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {historyQuery.isPending ? (
                <div className="space-y-2 p-5">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-8 w-full" />)}</div>
              ) : historyQuery.isError ? (
                <p className="px-5 py-5 text-sm text-destructive">Não foi possível carregar a atividade.</p>
              ) : history.length === 0 ? (
                <p className="px-5 py-5 text-sm text-muted-foreground">Nenhuma atividade registrada.</p>
              ) : (
                <CompanyHistoryList items={history.slice(0, 5)} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cadastro" forceMount className="mt-5 data-[state=inactive]:hidden">
          <CompanyRegistrationTab
            company={company}
            logoEditable={!!features?.custom_public_page}
            onDirtyChange={setCadastroDirty}
          />
        </TabsContent>

        <TabsContent value="recursos" forceMount className="mt-5 data-[state=inactive]:hidden">
          <CompanyFeaturesTab companyId={company.id} onDirtyChange={setRecursosDirty} />
        </TabsContent>

        <TabsContent value="financeiro" className="mt-5">
          <CompanyFinanceTab company={company} />
        </TabsContent>

        <TabsContent value="usuarios" className="mt-5">
          <CompanyUsersTab
            companyId={company.id}
            users={companyUsers}
            isPending={usersQuery.isPending}
            isError={usersQuery.isError}
            onRetry={() => void usersQuery.refetch()}
          />
        </TabsContent>

        <TabsContent value="historico" className="mt-5">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 border-b py-3">
              <div role="group" aria-label="Tipo de registro" className="flex rounded-lg bg-muted p-1">
                {([['tudo', 'Tudo'], ['acesso', 'Acessos'], ['alteracao', 'Alterações']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={historyFilter === value}
                    onClick={() => setHistoryFilter(value)}
                    className={historyFilter === value
                      ? 'rounded-md bg-card px-3 py-1.5 text-sm font-semibold shadow-sm'
                      : 'rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Link to={`/logs?empresa=${company.id}&periodo=todos`} className="text-sm font-semibold text-accent-foreground hover:underline">
                Abrir na Auditoria →
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {historyQuery.isPending ? (
                <div className="space-y-2 p-5">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-8 w-full" />)}</div>
              ) : historyQuery.isError ? (
                <ListStateMessage variant="error" title="Não foi possível carregar o histórico" actionLabel="Tentar novamente" onAction={() => void historyQuery.refetch()} />
              ) : filteredHistory.length === 0 ? (
                <ListStateMessage variant={history.length ? 'no-results' : 'empty'} title={history.length ? 'Nada desse tipo no período carregado' : 'Nenhuma atividade registrada'} />
              ) : (
                <>
                  <CompanyHistoryList items={filteredHistory} />
                  <p className="border-t px-5 py-3 text-xs text-muted-foreground">
                    Mostrando os 300 acessos mais recentes, agrupados por sessão, e as 40 ações mais recentes. O histórico completo de ações está na Auditoria.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={pauseOpen} onOpenChange={(open) => { if (!updateCompany.isPending) setPauseOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isPaused ? 'Reativar esta empresa?' : 'Pausar esta empresa?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {isPaused
                ? `${company.name} volta a ficar ativa.`
                : `${company.name} fica pausada até ser reativada. Dá para reativar a qualquer momento.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateCompany.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={updateCompany.isPending}
              onClick={(event) => {
                event.preventDefault();
                updateCompany.mutate(
                  { id: company.id, status: isPaused ? 'active' : 'paused' },
                  { onSuccess: () => setPauseOpen(false) },
                );
              }}
            >
              {updateCompany.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isPaused ? 'Reativar' : 'Pausar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!requestDeletion.isPending) { setDeleteOpen(open); if (!open) { setDeleteText(''); setDeleteReason(''); } } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Solicitar exclusão permanente</DialogTitle>
            <DialogDescription>
              "{company.name}" entra em um período de carência de 24h, cancelável. Depois disso, um processo
              assíncrono remove os dados em lotes e desprovisiona a instância de WhatsApp e os arquivos no Storage.
              Cobranças e integrações no Asaas <strong>não</strong> são tocadas automaticamente. A ação é irreversível
              após a carência.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="detail-delete-confirmation">
                Digite o nome ou o identificador (slug) da empresa para confirmar
              </label>
              <Input id="detail-delete-confirmation" value={deleteText} onChange={(event) => setDeleteText(event.target.value)} placeholder={company.name} autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="detail-delete-reason">Motivo da exclusão</label>
              <Textarea id="detail-delete-reason" value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="Ex.: encerramento de contrato, solicitação do cliente..." rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={requestDeletion.isPending} onClick={() => setDeleteOpen(false)}>Cancelar</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!deleteValid || requestDeletion.isPending}
              onClick={() => {
                requestDeletion.mutate(
                  { companyId: company.id, confirmationText: deleteText, reason: deleteReason },
                  { onSuccess: () => { setDeleteOpen(false); setDeleteText(''); setDeleteReason(''); } },
                );
              }}
            >
              {requestDeletion.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Solicitando...</> : 'Solicitar exclusão'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({ label, value, detail, onClick }: { label: string; value: string | null; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/40"
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      {value === null ? <Skeleton className="h-6 w-28" /> : <span className="text-lg font-semibold">{value}</span>}
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}
