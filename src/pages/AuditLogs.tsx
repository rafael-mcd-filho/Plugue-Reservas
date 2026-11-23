import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Download, Loader2, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import ListPagination from '@/components/admin/ListPagination';
import ListStateMessage from '@/components/admin/ListStateMessage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuditLogPage, fetchAuditLogPage, type AuditLogFilters } from '@/hooks/useAuditLogPage';
import { useCompanies } from '@/hooks/useCompanies';
import type { AuditLog } from '@/hooks/useSettings';
import { useUrlPage, useUrlParam } from '@/hooks/useUrlParam';
import { useUsers } from '@/hooks/useUsers';
import {
  AUDIT_CATEGORIES,
  AUDIT_ENTITY_LABELS,
  auditCategoryOf,
  auditCompanyIds,
  describeAuditLog,
  readableAuditDetails,
  type AuditCategory,
} from '@/lib/audit-log-catalog';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;
const PERIODS: Record<string, { label: string; days: number | null }> = {
  '7': { label: 'Últimos 7 dias', days: 7 },
  '30': { label: 'Últimos 30 dias', days: 30 },
  '90': { label: 'Últimos 90 dias', days: 90 },
  todos: { label: 'Todo o histórico', days: null },
};
const CATEGORY_IDS = [...AUDIT_CATEGORIES.map((category) => category.id), 'outros'] as const;

function initials(name: string | null | undefined) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') : '?';
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export default function AuditLogs() {
  const [period, setPeriod] = useUrlParam('periodo', '30');
  const [category, setCategory] = useUrlParam('categoria', 'todas');
  const [companyId, setCompanyId] = useUrlParam('empresa', 'todas');
  const [actorId, setActorId] = useUrlParam('autor', 'todos');
  const [searchParam, setSearchParam] = useUrlParam('busca', '');
  const [page, setPage] = useUrlPage();
  const [, setParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParam);
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchInput.trim() !== searchParam) setSearchParam(searchInput.trim(), { reset: ['pagina'] });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchParam, setSearchParam]);

  const companiesQuery = useCompanies();
  const companies = companiesQuery.data ?? [];
  const usersQuery = useUsers();
  const authors = useMemo(
    () => (usersQuery.data ?? [])
      .filter((user) => user.roles.includes('superadmin') || user.roles.includes('support'))
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email, 'pt-BR')),
    [usersQuery.data],
  );
  const companyName = (id: string) => companies.find((company) => company.id === id)?.name ?? null;

  const filters: AuditLogFilters = {
    page,
    pageSize: PAGE_SIZE,
    days: PERIODS[period]?.days ?? 30,
    category: (CATEGORY_IDS as readonly string[]).includes(category) ? (category as AuditCategory | 'outros') : null,
    companyId: companyId === 'todas' ? null : companyId,
    actorId: actorId === 'todos' ? null : actorId,
    search: searchParam,
  };
  const logsQuery = useAuditLogPage(filters);
  const logs = logsQuery.data?.logs ?? [];
  const total = logsQuery.data?.total ?? 0;
  const hasFilters = period !== 'todos' || category !== 'todas' || companyId !== 'todas' || actorId !== 'todos' || !!searchParam;

  const resetPage = { reset: ['pagina'] };
  const clearFilters = () => {
    setSearchInput('');
    setParams(new URLSearchParams({ periodo: 'todos' }), { replace: true });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const result = await fetchAuditLogPage({ ...filters, page: 1, pageSize: 1000 });
      const header = ['Quando', 'Quem', 'E-mail', 'Acontecimento', 'Categoria', 'Empresas', 'IP', 'Ação técnica'];
      const lines = result.logs.map((log) => [
        format(new Date(log.created_at), 'dd/MM/yyyy HH:mm:ss'),
        log.actor_name ?? '',
        log.actor_email ?? '',
        describeAuditLog(log, companyName),
        auditCategoryOf(log.action)?.label ?? 'Outros',
        auditCompanyIds(log).map((id) => companyName(id) ?? id).join('; '),
        log.ip_address ?? '',
        log.action,
      ].map(csvCell).join(','));
      const blob = new Blob([`${String.fromCharCode(0xfeff)}${[header.map(csvCell).join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `auditoria-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      if (result.total > result.logs.length) toast.info(`Exportados os ${result.logs.length} registros mais recentes de ${result.total}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível exportar.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader
        eyebrow="Plataforma"
        title="Auditoria"
        description="O que o superadmin, o suporte e as rotinas fizeram no sistema. Os filtros valem para todo o histórico."
        actions={(
          <Button variant="outline" className="gap-2" onClick={() => void exportCsv()} disabled={exporting || total === 0}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Exportar CSV
          </Button>
        )}
      />

      <Card className="space-y-3 p-3 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <Select value={period} onValueChange={(value) => setPeriod(value, resetPage)}>
            <SelectTrigger className="w-44" aria-label="Período"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(PERIODS).map(([value, config]) => <SelectItem key={value} value={value}>{config.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={companyId} onValueChange={(value) => setCompanyId(value, resetPage)}>
            <SelectTrigger className="w-52" aria-label="Empresa"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas as empresas</SelectItem>
              {companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={actorId} onValueChange={(value) => setActorId(value, resetPage)}>
            <SelectTrigger className="w-52" aria-label="Autor"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os autores</SelectItem>
              {authors.map((user) => <SelectItem key={user.id} value={user.id}>{user.full_name || user.email}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="relative min-w-56 flex-1">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Buscar por autor, e-mail ou ação"
              aria-label="Buscar por autor, e-mail ou ação"
              className="pl-9"
            />
          </div>
        </div>
        <div role="group" aria-label="Categoria" className="flex flex-wrap gap-1.5">
          {[{ id: 'todas', label: 'Todas', dotClassName: 'bg-muted-foreground/40' }, ...AUDIT_CATEGORIES, { id: 'outros', label: 'Outras', dotClassName: 'bg-muted-foreground/40' }].map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id, resetPage)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
                category === item.id
                  ? 'border-primary bg-primary-soft font-semibold text-accent-foreground'
                  : 'border-border bg-card font-medium hover:bg-muted/50',
              )}
            >
              <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', item.dotClassName)} />
              {item.label}
            </button>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden shadow-sm">
        {logsQuery.isPending ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-12 w-full" />)}</div>
        ) : logsQuery.isError ? (
          <ListStateMessage
            variant="error"
            title="Não foi possível consultar a auditoria"
            description="Nenhum registro foi apagado. A lista não foi exibida como vazia porque a consulta falhou."
            actionLabel="Tentar novamente"
            onAction={() => void logsQuery.refetch()}
          />
        ) : logs.length === 0 ? (
          hasFilters ? (
            <ListStateMessage
              variant="no-results"
              title="Nenhum registro para esses filtros"
              description="O histórico existe; mude o período, a empresa ou a categoria."
              actionLabel="Ver todo o histórico"
              onAction={clearFilters}
            />
          ) : (
            <ListStateMessage variant="empty" title="Ainda não há ações registradas" />
          )
        ) : (
          <>
            <div className={cn('overflow-x-auto', logsQuery.isFetching && 'opacity-70')}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-36">Quando</TableHead>
                    <TableHead>Quem</TableHead>
                    <TableHead>Acontecimento</TableHead>
                    <TableHead>Empresa</TableHead>
                    <TableHead className="w-20 text-right"><span className="sr-only">Detalhes</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => {
                    const categoryInfo = auditCategoryOf(log.action);
                    const companyIds = auditCompanyIds(log);
                    return (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                          {format(new Date(log.created_at), 'dd/MM/yyyy')}
                          <span className="block text-xs">{format(new Date(log.created_at), 'HH:mm:ss')}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-[160px] items-center gap-2.5">
                            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-accent-foreground">
                              {initials(log.actor_name || log.actor_email)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{log.actor_name || 'Usuário sem perfil'}</p>
                              <p className="truncate text-xs text-muted-foreground">{log.actor_email || '—'}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="min-w-[260px]">
                          <p className="text-sm">{describeAuditLog(log, companyName)}</p>
                          <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', categoryInfo?.dotClassName ?? 'bg-muted-foreground/40')} />
                            {categoryInfo?.label ?? 'Outras'}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm">
                          {companyIds.length === 0 ? '—'
                            : companyIds.length === 1 ? (companyName(companyIds[0]) ?? 'Empresa removida')
                              : `${companyIds.length} empresas`}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" onClick={() => setSelected(log)}>Ver</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <ListPagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
              itemLabel={['registro', 'registros']}
              disabled={logsQuery.isFetching}
              className="border-t border-border"
            />
          </>
        )}
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && <AuditLogDetail log={selected} companyName={companyName} onNavigate={() => setSelected(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AuditLogDetail({ log, companyName, onNavigate }: {
  log: AuditLog;
  companyName: (id: string) => string | null;
  onNavigate: () => void;
}) {
  const categoryInfo = auditCategoryOf(log.action);
  const companyIds = auditCompanyIds(log);
  const details = readableAuditDetails(log.details);

  return (
    <div className="space-y-5">
      <SheetHeader className="space-y-2 pr-8 text-left">
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', categoryInfo?.dotClassName ?? 'bg-muted-foreground/40')} />
          {categoryInfo?.label ?? 'Outras'}
        </p>
        <SheetTitle className="leading-snug">{describeAuditLog(log, companyName)}</SheetTitle>
        <SheetDescription>
          {format(new Date(log.created_at), "dd/MM/yyyy 'às' HH:mm:ss", { locale: ptBR })} · {log.actor_name || 'Usuário sem perfil'}
          {log.actor_email ? ` (${log.actor_email})` : ''}
        </SheetDescription>
      </SheetHeader>

      {companyIds.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {companyIds.length === 1 ? 'Empresa' : `Empresas (${companyIds.length})`}
          </h3>
          <ul className="space-y-1.5 text-sm">
            {companyIds.slice(0, 20).map((id) => (
              <li key={id} className="flex items-center justify-between gap-2">
                <span>{companyName(id) ?? 'Empresa removida'}</span>
                <Link to={`/logs?empresa=${id}&periodo=todos`} onClick={onNavigate} className="text-xs font-medium text-accent-foreground hover:underline">
                  Ver ações desta empresa
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {details.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Detalhes</h3>
          <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            {details.map((item) => (
              <div key={item.label} className="contents">
                <dt className="text-muted-foreground">{item.label}</dt>
                <dd className="break-words">{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <details className="rounded-lg border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground">
          Dados técnicos (IP, IDs e conteúdo bruto)
        </summary>
        <div className="space-y-2 border-t px-4 py-3 text-xs">
          <p><span className="text-muted-foreground">Ação técnica:</span> <span className="font-mono">{log.action}</span></p>
          <p><span className="text-muted-foreground">Entidade:</span> {log.entity_type ? (AUDIT_ENTITY_LABELS[log.entity_type] ?? log.entity_type) : '—'} <span className="break-all font-mono">{log.entity_id ?? ''}</span></p>
          <p><span className="text-muted-foreground">IP:</span> <span className="font-mono">{log.ip_address || '—'}</span></p>
          <p><span className="text-muted-foreground">Autor (ID):</span> <span className="break-all font-mono">{log.actor_user_id || log.user_id || '—'}</span></p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 leading-5">
            {JSON.stringify(log.details ?? {}, null, 2)}
          </pre>
        </div>
      </details>
    </div>
  );
}
