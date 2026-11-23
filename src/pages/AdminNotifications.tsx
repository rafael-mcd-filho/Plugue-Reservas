import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertCircle,
  Ban,
  Bell,
  CheckCircle2,
  ChevronDown,
  Clock,
  Clock3,
  Copy,
  HelpCircle,
  Loader2,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  Trash2,
} from 'lucide-react';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import ListPagination from '@/components/admin/ListPagination';
import ListStateMessage from '@/components/admin/ListStateMessage';
import AdminNotificationComposer, {
  type NotificationChannel,
  type NotificationDraft,
} from '@/components/notifications/AdminNotificationComposer';
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
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useCompanies, type Company } from '@/hooks/useCompanies';
import {
  useAllPlatformWhatsAppNotices,
  useRetryPlatformWhatsAppNotice,
} from '@/hooks/usePlatformWhatsAppNotices';
import {
  useDeleteNotificationBatch,
  useNotificationRecipientStatuses,
  useNotifications,
} from '@/hooks/useSettings';
import { useUrlPage, useUrlParam } from '@/hooks/useUrlParam';
import {
  groupPanelNotifications,
  groupWhatsAppNotices,
  notificationPreviewText,
  RETRYABLE_NOTICE_STATUSES,
  type NotificationBatch,
  type PanelNotificationBatch,
  type WhatsAppNoticeBatch,
} from '@/lib/notification-batches';
import { formatPhone } from '@/lib/phone';
import {
  noticeImageUrl,
  type PlatformWhatsAppNotice,
  type PlatformWhatsAppNoticeStatus,
} from '@/lib/platform-whatsapp-notices';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

const typeConfig: Record<string, { label: string; className: string }> = {
  info: { label: 'Informação', className: 'bg-info-soft text-info border-info/30' },
  warning: { label: 'Aviso', className: 'bg-warning-soft text-amber-900 border-warning/30' },
  success: { label: 'Sucesso', className: 'bg-success-soft text-success border-success/30' },
  error: { label: 'Erro', className: 'bg-destructive-soft text-destructive border-destructive/30' },
};

const noticeStatus: Record<PlatformWhatsAppNoticeStatus, { label: string; icon: typeof Clock3; tone: string }> = {
  queued: { label: 'Na fila', icon: Clock3, tone: 'bg-info-soft text-info' },
  processing: { label: 'Enviando', icon: Loader2, tone: 'bg-info-soft text-info' },
  accepted: { label: 'Enviado', icon: CheckCircle2, tone: 'bg-success-soft text-success' },
  failed: { label: 'Falhou', icon: AlertCircle, tone: 'bg-destructive-soft text-destructive' },
  unknown: { label: 'Sem confirmação', icon: HelpCircle, tone: 'bg-warning-soft text-amber-900' },
  skipped: { label: 'Não enviado', icon: Ban, tone: 'bg-muted text-muted-foreground' },
};

const PERIODS: Record<string, { label: string; days: number | null }> = {
  todos: { label: 'Todo o período', days: null },
  '30': { label: 'Últimos 30 dias', days: 30 },
  '90': { label: 'Últimos 90 dias', days: 90 },
  '365': { label: 'Últimos 12 meses', days: 365 },
};

function formatDateTime(value: string) {
  return format(new Date(value), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
}

function companyIdsOf(batch: NotificationBatch) {
  const ids: Array<string | null> = batch.rows.map((row) => row.company_id);
  return [...new Set(ids.filter((id): id is string => !!id))];
}

function recipientsLabel(batch: NotificationBatch, companies: Company[]) {
  const ids = companyIdsOf(batch);
  if (ids.length === 1) {
    return companies.find((company) => company.id === ids[0])?.name
      ?? (batch.channel === 'whatsapp' ? batch.rows[0]?.company_name : undefined)
      ?? '1 empresa';
  }
  if (companies.length > 1 && ids.length >= companies.length) return `Todas · ${ids.length} empresas`;
  return `${ids.length} empresas`;
}

function batchTitle(batch: NotificationBatch) {
  if (batch.channel === 'panel') return batch.title;
  const firstLine = batch.caption.split('\n')[0].trim();
  return firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine || 'Aviso com imagem';
}

function batchPreview(batch: NotificationBatch) {
  if (batch.channel === 'panel') return notificationPreviewText(batch.message);
  const lines = batch.caption.split('\n');
  return lines.slice(1).join(' ').trim();
}

function batchProgress(batch: NotificationBatch) {
  if (batch.channel === 'panel') {
    const pct = batch.recipientCount > 0 ? Math.round((batch.readCount / batch.recipientCount) * 100) : 0;
    return {
      pct,
      primary: batch.recipientCount > 0
        ? `${batch.readCount} de ${batch.recipientCount} ${batch.recipientCount === 1 ? 'usuário leu' : 'usuários leram'}`
        : 'Sem usuários ativos',
      secondary: `${batch.companiesWithReads} de ${batch.rows.length} ${batch.rows.length === 1 ? 'empresa com leitura' : 'empresas com leitura'}`,
      warn: false,
    };
  }
  const total = batch.rows.length;
  const { accepted, failed, unknown, skipped, queued, processing } = batch.counts;
  const parts = [
    failed && `${failed} ${failed === 1 ? 'falhou' : 'falharam'}`,
    unknown && `${unknown} sem confirmação`,
    skipped && `${skipped} não ${skipped === 1 ? 'enviado' : 'enviados'}`,
    (queued + processing) && `${queued + processing} na fila`,
  ].filter(Boolean);
  return {
    pct: total > 0 ? Math.round((accepted / total) * 100) : 0,
    primary: `${accepted} de ${total} ${total === 1 ? 'contato com envio aceito' : 'contatos com envio aceito'}`,
    secondary: parts.join(' · '),
    warn: failed + unknown + skipped > 0,
  };
}

export default function AdminNotifications() {
  const [channel, setChannel] = useUrlParam('canal', 'todos');
  const [period, setPeriod] = useUrlParam('periodo', 'todos');
  const [companyFilter, setCompanyFilter] = useUrlParam('empresa', 'todas');
  const [typeFilter, setTypeFilter] = useUrlParam('tipo', 'todos');
  const [page, setPage] = useUrlPage();
  const [, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<NotificationDraft | null>(null);

  const companyQuery = useCompanies();
  const companies = companyQuery.data ?? [];
  const panelQuery = useNotifications();
  const whatsappQuery = useAllPlatformWhatsAppNotices({ enabled: true });

  const panelBatches = useMemo(() => groupPanelNotifications(panelQuery.data ?? []), [panelQuery.data]);
  const whatsappBatches = useMemo(() => groupWhatsAppNotices(whatsappQuery.data?.rows ?? []), [whatsappQuery.data]);
  const allBatches = useMemo(() => {
    const merged: NotificationBatch[] = [
      ...(channel === 'whatsapp' ? [] : panelBatches),
      ...(channel === 'painel' ? [] : whatsappBatches),
    ];
    return merged.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [channel, panelBatches, whatsappBatches]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    const days = PERIODS[period]?.days ?? null;
    const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
    return allBatches.filter((batch) => {
      if (since && Date.parse(batch.createdAt) < since) return false;
      if (companyFilter !== 'todas' && !companyIdsOf(batch).includes(companyFilter)) return false;
      if (channel === 'painel' && typeFilter !== 'todos' && batch.channel === 'panel' && batch.type !== typeFilter) return false;
      if (query) {
        const haystack = `${batchTitle(batch)} ${batchPreview(batch)}`.toLocaleLowerCase('pt-BR');
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [allBatches, channel, companyFilter, period, search, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = allBatches.find((batch) => batch.key === selectedKey) ?? null;

  const relevant = [
    channel !== 'whatsapp' ? panelQuery : null,
    channel !== 'painel' ? whatsappQuery : null,
  ].filter(Boolean) as Array<typeof panelQuery | typeof whatsappQuery>;
  const loading = relevant.some((query) => query.isPending);
  const failedLabels = [
    channel !== 'whatsapp' && panelQuery.isError ? 'avisos do painel' : null,
    channel !== 'painel' && whatsappQuery.isError ? 'avisos por WhatsApp' : null,
  ].filter(Boolean) as string[];
  const allFailed = relevant.length > 0 && relevant.every((query) => query.isError);
  const hasFilters = !!search.trim() || period !== 'todos' || companyFilter !== 'todas' || typeFilter !== 'todos';

  const resetPage = { reset: ['pagina'] };
  const clearFilters = () => {
    setSearch('');
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      ['periodo', 'empresa', 'tipo', 'pagina'].forEach((key) => updated.delete(key));
      return updated;
    }, { replace: true });
  };
  const retryFailed = () => {
    if (panelQuery.isError) void panelQuery.refetch();
    if (whatsappQuery.isError) void whatsappQuery.refetch();
  };
  const openComposer = (nextDraft: NotificationDraft | null) => {
    setDraft(nextDraft);
    setComposerOpen(true);
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader
        eyebrow="Gestão"
        title="Avisos"
        description="Cada linha é um envio, para uma ou para todas as empresas. Clique para ver o resultado de cada empresa."
        actions={(
          <Button className="gap-2" onClick={() => openComposer(null)}>
            <Send aria-hidden="true" className="h-4 w-4" />
            Novo aviso
          </Button>
        )}
      />

      <Card className="flex flex-wrap items-center gap-2 p-3 shadow-sm">
        <div role="group" aria-label="Canal" className="flex rounded-lg bg-muted p-1">
          {[
            { id: 'todos', label: 'Todos', icon: null },
            { id: 'painel', label: 'Painel', icon: Bell },
            { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={channel === item.id}
              onClick={() => setChannel(item.id, { reset: ['pagina', 'tipo'] })}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm',
                channel === item.id ? 'bg-card font-semibold shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground',
              )}
            >
              {item.icon && <item.icon aria-hidden="true" className="h-3.5 w-3.5" />}
              {item.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            placeholder="Buscar no título ou no texto"
            aria-label="Buscar no título ou no texto"
            className="pl-9"
          />
        </div>
        {channel === 'painel' && (
          <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value, resetPage)}>
            <SelectTrigger className="w-40" aria-label="Tipo"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os tipos</SelectItem>
              {Object.entries(typeConfig).map(([value, config]) => (
                <SelectItem key={value} value={value}>{config.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={companyFilter} onValueChange={(value) => setCompanyFilter(value, resetPage)}>
          <SelectTrigger className="w-52" aria-label="Empresa"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas as empresas</SelectItem>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={period} onValueChange={(value) => setPeriod(value, resetPage)}>
          <SelectTrigger className="w-44" aria-label="Período"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(PERIODS).map(([value, config]) => (
              <SelectItem key={value} value={value}>{config.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Card>

      {failedLabels.length > 0 && !allFailed && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive-soft/50 px-4 py-3 text-sm text-destructive">
          <span>Não foi possível carregar os {failedLabels.join(' e os ')}. A lista mostra só o que carregou.</span>
          <Button variant="outline" size="sm" onClick={retryFailed}>Tentar novamente</Button>
        </div>
      )}
      {whatsappQuery.data?.truncated && channel !== 'painel' && (
        <p className="text-xs text-muted-foreground">
          Mostrando os {whatsappQuery.data.rows.length} envios por WhatsApp mais recentes de {whatsappQuery.data.total}.
        </p>
      )}

      <Card className="overflow-hidden shadow-sm">
        {loading ? (
          <div className="space-y-3 p-5">
            {[1, 2, 3].map((item) => <Skeleton key={item} className="h-16 w-full" />)}
          </div>
        ) : allFailed ? (
          <ListStateMessage
            variant="error"
            title="Não foi possível carregar os avisos"
            description="A lista não foi exibida como vazia porque a consulta falhou."
            actionLabel="Tentar novamente"
            onAction={retryFailed}
          />
        ) : allBatches.length === 0 ? (
          <ListStateMessage
            variant="empty"
            title="Nenhum aviso enviado ainda"
            actionLabel="Enviar o primeiro aviso"
            onAction={() => openComposer(null)}
          />
        ) : filtered.length === 0 ? (
          <ListStateMessage
            variant="no-results"
            title="Nenhum envio para esses filtros"
            description="O histórico existe; mude a busca, a empresa ou o período."
            actionLabel={hasFilters ? 'Limpar filtros' : undefined}
            onAction={clearFilters}
          />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {pageItems.map((batch) => {
                const progress = batchProgress(batch);
                const type = batch.channel === 'panel' ? (typeConfig[batch.type] ?? typeConfig.info) : null;
                return (
                  <li key={`${batch.channel}-${batch.key}`}>
                    <button
                      type="button"
                      onClick={() => setSelectedKey(batch.key)}
                      className="flex w-full flex-col gap-1.5 px-4 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
                    >
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <ChannelBadge channel={batch.channel} />
                        {type && (
                          <span className={cn('rounded-full border px-2 py-0.5 font-medium', type.className)}>{type.label}</span>
                        )}
                        <span className="ml-auto text-muted-foreground">{formatDateTime(batch.createdAt)}</span>
                      </span>
                      <span className="text-sm font-semibold">{batchTitle(batch)}</span>
                      {batchPreview(batch) && (
                        <span className="truncate text-sm text-muted-foreground">{batchPreview(batch)}</span>
                      )}
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="font-medium">{recipientsLabel(batch, companies)}</span>
                        <Progress value={progress.pct} aria-label="Andamento do envio" className="h-1.5 w-28" />
                        <span>{progress.primary}</span>
                        {progress.secondary && (
                          <span className={progress.warn ? 'text-destructive' : 'text-muted-foreground'}>{progress.secondary}</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <ListPagination
              page={currentPage}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
              itemLabel={['envio', 'envios']}
              className="border-t border-border"
            />
          </>
        )}
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelectedKey(null); }}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-lg">
          {selected?.channel === 'panel' && (
            <PanelBatchDetail
              batch={selected}
              companies={companies}
              onDuplicate={() => {
                const ids = companyIdsOf(selected);
                openComposer({
                  channel: 'panel',
                  title: selected.title,
                  message: selected.message,
                  type: selected.type,
                  imageUrl: selected.imageUrl,
                  companyIds: ids.length >= companies.length ? undefined : ids,
                });
                setSelectedKey(null);
              }}
              onRemoved={() => setSelectedKey(null)}
            />
          )}
          {selected?.channel === 'whatsapp' && (
            <WhatsAppBatchDetail
              batch={selected}
              onDuplicate={() => {
                let url = '';
                try { url = noticeImageUrl(selected.imagePath); } catch { url = ''; }
                openComposer({
                  channel: 'whatsapp',
                  caption: selected.caption,
                  image: url ? { path: selected.imagePath, url } : null,
                  companyIds: companyIdsOf(selected),
                });
                setSelectedKey(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <AdminNotificationComposer
        open={composerOpen}
        onOpenChange={(open) => { setComposerOpen(open); if (!open) setDraft(null); }}
        companies={companies}
        companiesLoading={companyQuery.isLoading}
        companiesError={companyQuery.isError}
        onRetryCompanies={() => void companyQuery.refetch()}
        initialDraft={draft}
        onCreated={(created: NotificationChannel) => {
          setChannel(created === 'whatsapp' ? 'whatsapp' : 'painel', { reset: ['pagina', 'tipo'] });
        }}
      />
    </div>
  );
}

function ChannelBadge({ channel }: { channel: NotificationBatch['channel'] }) {
  return channel === 'panel' ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 font-medium text-accent-foreground">
      <Bell aria-hidden="true" className="h-3 w-3" /> Painel
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 font-medium text-success">
      <MessageCircle aria-hidden="true" className="h-3 w-3" /> WhatsApp
    </span>
  );
}

function RecipientSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Buscar empresa"
        aria-label="Buscar empresa entre os destinatários"
        className="h-8 pl-8 text-sm"
      />
    </div>
  );
}

function PanelBatchDetail({ batch, companies, onDuplicate, onRemoved }: {
  batch: PanelNotificationBatch;
  companies: Company[];
  onDuplicate: () => void;
  onRemoved: () => void;
}) {
  const [query, setQuery] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const removeBatch = useDeleteNotificationBatch();
  const type = typeConfig[batch.type] ?? typeConfig.info;
  const progress = batchProgress(batch);
  const rows = batch.rows
    .map((row) => ({ row, name: companies.find((company) => company.id === row.company_id)?.name ?? 'Empresa removida' }))
    .filter(({ name }) => name.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR')))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  return (
    <>
      <SheetHeader className="space-y-2 border-b border-border px-6 py-5 pr-12 text-left">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <ChannelBadge channel="panel" />
          <span className={cn('rounded-full border px-2 py-0.5 font-medium', type.className)}>{type.label}</span>
          <span className="text-muted-foreground">{formatDateTime(batch.createdAt)}</span>
        </div>
        <SheetTitle>{batch.title}</SheetTitle>
        <SheetDescription>{progress.primary} · {progress.secondary}</SheetDescription>
      </SheetHeader>

      <section className="space-y-2 border-b border-border px-6 py-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Como a empresa recebe</h3>
        <div className="overflow-hidden rounded-lg border bg-muted/20">
          {batch.imageUrl && <img src={batch.imageUrl} alt="" className="max-h-48 w-full object-contain" />}
          <div
            className="space-y-2 p-4 text-sm leading-relaxed [&_p]:my-1"
            dangerouslySetInnerHTML={{ __html: batch.message }}
          />
        </div>
      </section>

      <section className="flex-1 space-y-3 px-6 py-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Destinatários ({batch.rows.length})
          </h3>
          <span className="text-xs text-muted-foreground">{progress.pct}% de leitura</span>
        </div>
        {batch.rows.length > 5 && <RecipientSearch value={query} onChange={setQuery} />}
        <ul className="divide-y divide-border">
          {rows.map(({ row, name }) => <PanelRecipientRow key={row.id} notificationId={row.id} name={name} read={row.read_count ?? 0} total={row.recipient_count ?? 0} />)}
        </ul>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma empresa com esse nome.</p>}
      </section>

      <div className="sticky bottom-0 space-y-2 border-t border-border bg-background px-6 py-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="gap-2" onClick={onDuplicate}>
            <Copy aria-hidden="true" className="h-4 w-4" />
            Duplicar como rascunho
          </Button>
          <Button
            variant="ghost"
            className="ml-auto gap-2 text-destructive hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            Retirar do painel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Retirar apaga este aviso do painel de todas as empresas deste envio.</p>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!removeBatch.isPending) setConfirmOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retirar este aviso do painel?</AlertDialogTitle>
            <AlertDialogDescription>
              “{batch.title}” deixa de aparecer para {batch.rows.length} {batch.rows.length === 1 ? 'empresa' : 'empresas'}, inclusive para quem ainda não leu. Isso não pode ser desfeito.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBatch.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removeBatch.isPending}
              onClick={(event) => {
                event.preventDefault();
                removeBatch.mutate(
                  { ids: batch.ids, title: batch.title, companyIds: companyIdsOf(batch) },
                  { onSuccess: () => { setConfirmOpen(false); onRemoved(); } },
                );
              }}
            >
              {removeBatch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Retirar do painel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PanelRecipientRow({ notificationId, name, read, total }: { notificationId: string; name: string; read: number; total: number }) {
  const [open, setOpen] = useState(false);
  const recipients = useNotificationRecipientStatuses(open ? notificationId : null);
  const status = total === 0
    ? { label: 'Sem usuários ativos', className: 'bg-muted text-muted-foreground' }
    : read === total
      ? { label: `Todos leram (${total})`, className: 'bg-success-soft text-success' }
      : { label: `${read} de ${total} leram`, className: 'bg-warning-soft text-amber-900' };

  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', status.className)}>{status.label}</span>
        {total > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-expanded={open}
            aria-label={`${open ? 'Ocultar' : 'Ver'} usuários de ${name}`}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2">
          {recipients.isPending ? (
            <p className="text-xs text-muted-foreground">Carregando usuários…</p>
          ) : recipients.isError ? (
            <p className="text-xs text-destructive">Não foi possível carregar os usuários.</p>
          ) : (
            <ul className="space-y-1.5">
              {(recipients.data ?? []).map((recipient, index) => (
                <li key={`${recipient.user_id ?? 'removido'}-${index}`} className="flex items-center gap-2 text-xs">
                  {recipient.read_at
                    ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-success" />
                    : <Clock aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate">{recipient.full_name}</span>
                  <span className={recipient.read_at ? 'text-success' : 'text-muted-foreground'}>
                    {recipient.read_at ? format(new Date(recipient.read_at), 'dd/MM HH:mm') : 'Pendente'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function WhatsAppBatchDetail({ batch, onDuplicate }: { batch: WhatsAppNoticeBatch; onDuplicate: () => void }) {
  const [query, setQuery] = useState('');
  const [retryingAll, setRetryingAll] = useState(false);
  const retry = useRetryPlatformWhatsAppNotice();
  const progress = batchProgress(batch);
  let imageUrl = '';
  try { imageUrl = noticeImageUrl(batch.imagePath); } catch { imageUrl = ''; }
  const rows = batch.rows
    .filter((row) => row.company_name.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR')))
    .sort((a, b) => a.company_name.localeCompare(b.company_name, 'pt-BR'));

  async function retryOne(notice: PlatformWhatsAppNotice, quiet = false) {
    try {
      const result = await retry.mutateAsync({ notice_id: notice.id });
      const updated = result.rows.find((row) => row.id === notice.id);
      if (!updated) { if (!quiet) toast.error('Atualize o histórico para conferir a tentativa.'); return false; }
      if (updated.status === 'queued' || updated.status === 'processing') { if (!quiet) toast.success('Nova tentativa adicionada à fila.'); return true; }
      if (updated.status === 'accepted') { if (!quiet) toast.success('Este aviso já foi enviado.'); return true; }
      if (!quiet) {
        if (updated.status === 'failed') toast.error(updated.error_message || 'Não foi possível enviar o aviso.');
        else toast.info(updated.error_message || 'O aviso não foi reenviado. Confira o histórico.');
      }
      return false;
    } catch (error) {
      if (!quiet) toast.error(error instanceof Error ? error.message : 'Não foi possível tentar novamente.');
      return false;
    }
  }

  async function retryAll() {
    setRetryingAll(true);
    let queued = 0;
    for (const notice of batch.retryable) {
      if (await retryOne(notice, true)) queued += 1;
    }
    setRetryingAll(false);
    const notQueued = batch.retryable.length - queued;
    if (notQueued === 0) toast.success(`${queued} ${queued === 1 ? 'nova tentativa adicionada' : 'novas tentativas adicionadas'} à fila.`);
    else toast.info(`${queued} na fila e ${notQueued} sem nova tentativa. Confira cada empresa.`);
  }

  return (
    <>
      <SheetHeader className="space-y-2 border-b border-border px-6 py-5 pr-12 text-left">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <ChannelBadge channel="whatsapp" />
          <span className="text-muted-foreground">{formatDateTime(batch.createdAt)} · instância RWSL</span>
        </div>
        <SheetTitle>{batchTitle(batch)}</SheetTitle>
        <SheetDescription>{progress.primary}{progress.secondary ? ` · ${progress.secondary}` : ''}</SheetDescription>
      </SheetHeader>

      <section className="space-y-2 border-b border-border px-6 py-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Como a empresa recebe</h3>
        <div className="overflow-hidden rounded-lg border bg-success-soft/20">
          {imageUrl && <img src={imageUrl} alt="Imagem do aviso" className="max-h-56 w-full object-contain" />}
          <p className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed">{batch.caption}</p>
        </div>
      </section>

      <section className="flex-1 space-y-3 px-6 py-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Destinatários ({batch.rows.length})
        </h3>
        {batch.rows.length > 5 && <RecipientSearch value={query} onChange={setQuery} />}
        <ul className="divide-y divide-border">
          {rows.map((notice) => {
            const status = noticeStatus[notice.status];
            const Icon = status.icon;
            return (
              <li key={notice.id} className="space-y-1 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{notice.company_name}</p>
                    <p className="text-xs text-muted-foreground">{notice.recipient_phone ? formatPhone(notice.recipient_phone) : 'Sem contato válido'}</p>
                  </div>
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', status.tone)}>
                    <Icon aria-hidden="true" className={cn('h-3.5 w-3.5', notice.status === 'processing' && 'animate-spin motion-reduce:animate-none')} />
                    {status.label}
                  </span>
                  {RETRYABLE_NOTICE_STATUSES.includes(notice.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={retry.isPending || retryingAll}
                      onClick={() => void retryOne(notice)}
                      aria-label={`Tentar novamente para ${notice.company_name}`}
                    >
                      <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                      Tentar de novo
                    </Button>
                  )}
                </div>
                {notice.error_message && <p className="text-xs text-muted-foreground">{notice.error_message}</p>}
                {notice.status === 'unknown' && (
                  <p className="text-xs text-amber-900">Confira na RWSL antes de enviar outro aviso para este contato.</p>
                )}
              </li>
            );
          })}
        </ul>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma empresa com esse nome.</p>}
        <p className="text-xs text-muted-foreground">“Enviado” quer dizer que a instância aceitou a mensagem. O WhatsApp não confirma leitura.</p>
      </section>

      <div className="sticky bottom-0 space-y-2 border-t border-border bg-background px-6 py-4">
        <div className="flex flex-wrap gap-2">
          {batch.retryable.length > 0 && (
            <Button className="gap-2" disabled={retryingAll || retry.isPending} onClick={() => void retryAll()}>
              {retryingAll ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
              Tentar de novo as falhas ({batch.retryable.length})
            </Button>
          )}
          <Button variant="outline" className="gap-2" onClick={onDuplicate}>
            <Copy aria-hidden="true" className="h-4 w-4" />
            Duplicar como rascunho
          </Button>
        </div>
        {batch.counts.unknown > 0 && (
          <p className="text-xs text-muted-foreground">Envios sem confirmação não entram na repetição.</p>
        )}
      </div>
    </>
  );
}
