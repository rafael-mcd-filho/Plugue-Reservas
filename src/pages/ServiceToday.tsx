import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Armchair, CalendarCheck, CalendarDays, ClipboardList, Loader2, Search, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { useImpersonation } from '@/hooks/useImpersonation';
import { Skeleton } from '@/components/ui/skeleton';
import ServiceArrivals from '@/pages/service-today/ServiceArrivals';
import ServiceWaitlist from '@/pages/service-today/ServiceWaitlist';
import ServiceSalon from '@/components/service-today/ServiceSalon';
import { getServiceTodayClock, getServiceTodayTabs, type ServiceTodayContext, type ServiceTodayFreshness, type ServiceTodayTab } from '@/lib/service-today';

const TAB_LABELS: Record<ServiceTodayTab, string> = { arrivals: 'Chegadas', salon: 'Salão', waitlist: 'Fila' };
const TAB_ICONS = { arrivals: CalendarCheck, salon: Armchair, waitlist: ClipboardList };
const TAB_QUERY_VALUES: Record<ServiceTodayTab, string> = { arrivals: 'chegadas', salon: 'salao', waitlist: 'fila' };

export default function ServiceToday({ initialTab = 'arrivals' }: { initialTab?: ServiceTodayTab }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { companyId, companyTimeZone = 'America/Fortaleza', companyTimeZoneResolved } = useCompanySlug();
  const { user } = useAuth();
  const { impersonatedUserId } = useImpersonation();
  const { hasPermission, permissionsLoading } = useCompanyPermissions();
  const tabs = getServiceTodayTabs(hasPermission);
  const requestedTab = (Object.entries(TAB_QUERY_VALUES).find(([, value]) => value === searchParams.get('tab'))?.[0] as ServiceTodayTab | undefined) ?? initialTab;
  const activeTab = tabs.includes(requestedTab) ? requestedTab : tabs[0];
  const onTabChange = useCallback((value: ServiceTodayTab) => {
    setSearchParams(current => { const next = new URLSearchParams(current); next.set('tab', TAB_QUERY_VALUES[value]); return next; }, { replace: true });
  }, [setSearchParams]);
  if (permissionsLoading || companyTimeZoneResolved === false) return <div className="space-y-5" role="status" aria-label="Carregando Serviços de Hoje"><Skeleton className="h-8 w-52" /><Skeleton className="h-12 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (!tabs.length) return <Navigate to="/acesso-negado" replace />;
  // A new actor, company or set of permissions must never inherit open records,
  // draft dialogs or selections from the previous operational session.
  const canViewReservations = hasPermission('reservations_view');
  const canViewLeads = hasPermission('leads_view');
  const canViewEvents = hasPermission('events_view');
  const accessScope = [companyId, user?.id, impersonatedUserId, companyTimeZone, tabs.join(','), canViewReservations, canViewLeads, canViewEvents].join(':');
  return <ScopedServiceToday key={accessScope} companyId={companyId} timeZone={companyTimeZone} tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} accessScope={accessScope} canViewReservations={canViewReservations} canViewLeads={canViewLeads} canViewEvents={canViewEvents} />;
}

function ScopedServiceToday({ companyId, timeZone, tabs, activeTab, onTabChange, accessScope, canViewReservations, canViewLeads, canViewEvents }: {
  companyId: string; timeZone: string; tabs: ServiceTodayTab[]; activeTab: ServiceTodayTab; onTabChange: (tab: ServiceTodayTab) => void; accessScope: string; canViewReservations: boolean; canViewLeads: boolean; canViewEvents: boolean;
}) {
  const [clock, setClock] = useState(() => getServiceTodayClock(timeZone));
  useEffect(() => {
    const timer = setInterval(() => setClock(getServiceTodayClock(timeZone)), 30_000);
    return () => clearInterval(timer);
  }, [timeZone]);
  const [search, setSearch] = useState('');
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const freshnessScope = `${clock.date}:${activeTab}`;
  const [reportedFreshness, setReportedFreshness] = useState<{ scope: string; value: ServiceTodayFreshness } | null>(null);
  const freshness = reportedFreshness?.scope === freshnessScope ? reportedFreshness.value : null;
  const onFreshnessChange = useCallback((value: ServiceTodayFreshness) => {
    setReportedFreshness(current => current?.scope === freshnessScope && current.value.updatedAt === value.updatedAt && current.value.fetching === value.fetching && current.value.hasError === value.hasError ? current : { scope: freshnessScope, value });
  }, [freshnessScope]);
  useEffect(() => { setSelectedTableId(null); }, [clock.date]);
  const canOpenSalon = tabs.includes('salon');
  const onOpenSalon = useCallback((tableId?: string) => {
    if (!canOpenSalon) return;
    setSelectedTableId(tableId ?? null);
    setReportedFreshness(null);
    onTabChange('salon');
  }, [canOpenSalon, onTabChange]);
  const context = useMemo<ServiceTodayContext>(() => ({
    date: clock.date, timeZone, search, section: 'all', period: 'all', canViewReservations, canViewLeads, canViewEvents, onFreshnessChange,
    onOpenSalon: canOpenSalon ? onOpenSalon : undefined,
  }), [clock.date, timeZone, search, canViewReservations, canViewLeads, canViewEvents, onFreshnessChange, canOpenSalon, onOpenSalon]);
  const todayLabel = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${clock.date}T12:00:00Z`));
  const shortTodayLabel = `${clock.date.slice(8, 10)}/${clock.date.slice(5, 7)}`;
  const childScope = `${accessScope}:${clock.date}`;
  const updating = freshness?.fetching === true;
  const updatedTime = freshness?.updatedAt ? new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(freshness.updatedAt) : '--:--:--';
  const updatedLabel = freshness?.updatedAt ? `Última atualização: ${new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(freshness.updatedAt)}` : 'Última atualização ainda não confirmada';

  return <div className="space-y-5">
    <div className="flex flex-col gap-2 border-b border-border pb-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-x-4 sm:gap-y-2 sm:pb-0">
    <h1 className="sr-only">Serviços de Hoje</h1>
    <div role="tablist" aria-label="Visões dos Serviços de Hoje" className="grid w-full gap-1 sm:flex sm:w-auto sm:gap-7" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map(value => {
        const Icon = TAB_ICONS[value];
        return <button key={value} type="button" role="tab" id={`service-tab-${value}`} aria-selected={activeTab === value} aria-controls={`service-panel-${value}`} tabIndex={activeTab === value ? 0 : -1}
          className={`flex min-h-11 items-center justify-center gap-2 border-b-2 px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:justify-start sm:px-1 ${activeTab === value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => { if (value !== activeTab) setReportedFreshness(null); onTabChange(value); setSelectedTableId(null); }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = tabs.indexOf(value);
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            if (next !== activeTab) setReportedFreshness(null); onTabChange(next); setSelectedTableId(null); document.getElementById(`service-tab-${next}`)?.focus();
          }}><Icon className="h-4 w-4" aria-hidden="true" />{TAB_LABELS[value]}</button>;
      })}
    </div>
    <div className="flex w-full items-center justify-between gap-2 sm:mb-2 sm:ml-auto sm:w-auto sm:justify-end sm:gap-3">
      <div className="order-2 flex h-8 w-[138px] shrink-0 items-center justify-end gap-1.5 text-[10px] text-muted-foreground sm:order-1 sm:w-[164px]" aria-label={updatedLabel} title={updatedLabel}>
        <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center" aria-label={updating ? 'Atualizando dados' : undefined}>{updating && <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin motion-reduce:animate-none" />}</span>
        <span className="whitespace-nowrap tabular-nums">Atualizado às {updatedTime}</span>
      </div>
      <div className="order-1 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[11px] text-muted-foreground sm:order-2 sm:gap-2 sm:px-3 sm:text-xs" aria-label={`Hoje, ${todayLabel}, data da unidade`} title={`Hoje, ${todayLabel}`}><CalendarDays className="h-3.5 w-3.5 sm:h-4 sm:w-4" aria-hidden="true" /><span className="whitespace-nowrap sm:hidden">Hoje, {shortTodayLabel}</span><span className="hidden whitespace-nowrap sm:inline">Hoje, {todayLabel}</span></div>
    </div>
    </div>
    <div className="flex flex-wrap gap-2">
      <label className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-3 sm:w-auto sm:min-w-64 sm:flex-1">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><input aria-label="Buscar no serviço" value={search} onChange={event => setSearch(event.target.value)} placeholder={activeTab === 'salon' ? 'Buscar cliente ou mesa' : 'Buscar cliente, telefone ou código'} maxLength={200} className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-0" />
        {search && <button type="button" onClick={() => setSearch('')} aria-label="Limpar busca" className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><X className="h-4 w-4" /></button>}
      </label>
    </div>
    <section key={`${childScope}:${activeTab}`} id={`service-panel-${activeTab}`} role="tabpanel" aria-labelledby={`service-tab-${activeTab}`} tabIndex={0} className="min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {activeTab === 'arrivals' && <ServiceArrivals serviceContext={context} />}
      {activeTab === 'waitlist' && <ServiceWaitlist serviceContext={context} />}
      {activeTab === 'salon' && <ServiceSalon companyId={companyId} context={context} selectedTableId={selectedTableId} onSelectedTableChange={setSelectedTableId} />}
    </section>
  </div>;
}
