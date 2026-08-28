import {
  Activity,
  ArrowRight,
  Grid3X3,
  Repeat2,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface DashboardDemandSnapshot {
  createdReservations: number;
  scheduledCreated: number;
  sameDayReservations: number;
  waitlistCreated: number;
  averageLeadDays: number;
  dominantEntryLabel?: string;
  dominantEntryPercentage?: number;
}

export interface DashboardAttendanceSnapshot {
  realizationRate: number;
  losses: number;
  noShows: number;
  cancellations: number;
  pending: number;
}

export interface DashboardCapacitySnapshot {
  hasCapacity: boolean;
  occupancyRate: number;
  pressureDays: number;
  idleSeats: number;
}

export interface DashboardWaitlistSnapshot {
  entries: number;
  conversionRate: number;
  averageWaitMinutes: number;
  dropped: number;
}

export interface DashboardRecurrenceSnapshot {
  totalVisits: number;
  firstVisits: number;
  returnVisits: number;
  returnRate: number;
}

export interface DashboardReportOverviewProps {
  slug: string;
  search: string;
  canViewRecurrence: boolean;
  demand: DashboardDemandSnapshot;
  attendance: DashboardAttendanceSnapshot;
  capacity: DashboardCapacitySnapshot;
  waitlist: DashboardWaitlistSnapshot;
  recurrence?: DashboardRecurrenceSnapshot | null;
  recurrenceStatus?: 'loading' | 'ready' | 'empty' | 'error';
}

type ReportAccent = 'primary' | 'danger' | 'info' | 'success';

interface ReportStat {
  label: string;
  value: string;
}

interface ReportCardProps {
  accent: ReportAccent;
  href: string;
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}

const integerFormatter = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 1,
});

const accentStyles: Record<ReportAccent, { icon: string; value: string }> = {
  primary: {
    icon: 'bg-primary/10 text-primary',
    value: 'text-primary',
  },
  danger: {
    icon: 'bg-destructive/10 text-destructive',
    value: 'text-destructive',
  },
  info: {
    icon: 'bg-info/10 text-info',
    value: 'text-info',
  },
  success: {
    icon: 'bg-success/10 text-success',
    value: 'text-success',
  },
};

const formatInteger = (value: number) => integerFormatter.format(value);

const formatDecimal = (value: number) => decimalFormatter.format(value);

const formatPercentage = (value: number) => `${formatDecimal(value)}%`;

const formatDays = (value: number) => `${formatDecimal(value)} ${value === 1 ? 'dia' : 'dias'}`;

const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

const withSearch = (path: string, search: string) => {
  if (!search) return path;
  return `${path}${search.startsWith('?') ? search : `?${search}`}`;
};

function ReportCard({ accent, children, href, icon: Icon, title }: ReportCardProps) {
  const styles = accentStyles[accent];

  return (
    <Link
      to={href}
      aria-label={`Abrir relatório ${title}`}
      className={cn(
        'group flex h-full min-w-0 touch-manipulation flex-col gap-2.5 rounded-2xl bg-card p-3.5',
        'shadow-sm transition-[box-shadow,transform] duration-200',
        'hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', styles.icon)}>
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <h3 className="truncate text-[13px] font-semibold leading-tight text-foreground">{title}</h3>
        </div>
        <ArrowRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transform-none motion-reduce:transition-none"
          aria-hidden="true"
        />
      </div>

      {children}
    </Link>
  );
}

function ReportHeadline({
  accent,
  detail,
  label,
  value,
}: {
  accent: ReportAccent;
  detail: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <p className={cn('text-[26px] font-bold leading-none tabular-nums', accentStyles[accent].value)}>{value}</p>
        <p className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">{label}</p>
      </div>
      <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

function ReportStats({ label, stats }: { label: string; stats: ReportStat[] }) {
  return (
    <dl
      aria-label={label}
      className={cn(
        'mt-auto grid gap-x-2 border-t border-border/60 pt-2.5',
        stats.length >= 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3',
      )}
    >
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0">
          <dt className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {stat.label}
          </dt>
          <dd className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DashboardReportOverview({
  slug,
  search,
  canViewRecurrence,
  demand,
  attendance,
  capacity,
  waitlist,
  recurrence,
  recurrenceStatus = recurrence ? 'ready' : 'empty',
}: DashboardReportOverviewProps) {
  const reportsPath = `/${slug}/admin/relatorios`;
  const sameDayShare = share(demand.sameDayReservations, demand.scheduledCreated);
  const noShowShare = share(attendance.noShows, attendance.noShows + attendance.cancellations);

  return (
    <section aria-labelledby="dashboard-report-overview-title" className="space-y-3">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Relatórios</p>
          <h2 id="dashboard-report-overview-title" className="mt-0.5 text-base font-semibold text-foreground">
            Aprofunde a análise
          </h2>
        </div>
        <p className="max-w-xl text-xs leading-5 text-muted-foreground sm:text-right">
          Abra cada leitura completa sem sobrecarregar a visão operacional.
        </p>
      </div>

      <div
        className={cn(
          'grid grid-cols-1 gap-3 sm:grid-cols-2',
          canViewRecurrence ? 'xl:grid-cols-4' : 'xl:grid-cols-3',
        )}
      >
        <ReportCard
          accent="primary"
          href={withSearch(`${reportsPath}/demanda-conversao`, search)}
          icon={Activity}
          title="Demanda & conversão"
        >
          <ReportHeadline
            accent="primary"
            value={formatInteger(demand.createdReservations)}
            label="reservas criadas"
            detail={
              demand.scheduledCreated > 0 ? (
                <>
                  <span className="font-semibold text-foreground">{formatPercentage(sameDayShare)}</span> entram em cima
                  da hora, no mesmo dia da visita
                </>
              ) : (
                'Sem reservas agendadas para medir antecedência'
              )
            }
          />
          <ReportStats
            label="Indicadores de demanda"
            stats={[
              { label: 'Antecedência', value: formatDays(demand.averageLeadDays) },
              {
                label: demand.dominantEntryLabel ?? 'Entrada',
                value:
                  demand.dominantEntryPercentage === undefined
                    ? '—'
                    : formatPercentage(demand.dominantEntryPercentage),
              },
              { label: 'Via fila', value: formatInteger(demand.waitlistCreated) },
            ]}
          />
        </ReportCard>

        <ReportCard
          accent="danger"
          href={withSearch(`${reportsPath}/comparecimento-perdas`, search)}
          icon={ShieldAlert}
          title="Comparecimento & perdas"
        >
          <ReportHeadline
            accent="danger"
            value={formatPercentage(attendance.realizationRate)}
            label="taxa de realização"
            detail={
              attendance.losses > 0 ? (
                <>
                  <span className="font-semibold text-destructive">{formatInteger(attendance.losses)} perdas</span>, e{' '}
                  {formatPercentage(noShowShare)} delas viraram no-show
                </>
              ) : (
                'Nenhuma perda registrada no período'
              )
            }
          />
          <ReportStats
            label="Composição das perdas"
            stats={[
              { label: 'No-show', value: formatInteger(attendance.noShows) },
              { label: 'Cancelad.', value: formatInteger(attendance.cancellations) },
              { label: 'Sem baixa', value: formatInteger(attendance.pending) },
            ]}
          />
        </ReportCard>

        <ReportCard
          accent="info"
          href={withSearch(`${reportsPath}/ocupacao-capacidade`, search)}
          icon={Grid3X3}
          title="Ocupação & capacidade"
        >
          <ReportHeadline
            accent="info"
            value={capacity.hasCapacity ? formatPercentage(capacity.occupancyRate) : '—'}
            label={capacity.hasCapacity ? 'ocupação média' : 'capacidade não configurada'}
            detail={
              capacity.hasCapacity ? (
                <>
                  <span className="font-semibold text-foreground">
                    {formatInteger(capacity.idleSeats)} lugares ociosos
                  </span>{' '}
                  · {formatInteger(capacity.pressureDays)} dias sob pressão
                </>
              ) : (
                'Defina a capacidade dos horários para medir ocupação'
              )
            }
          />
          <ReportStats
            label="Pulso da fila de espera"
            stats={[
              { label: 'Fila', value: formatInteger(waitlist.entries) },
              { label: 'Conv.', value: formatPercentage(waitlist.conversionRate) },
              { label: 'Espera', value: `${formatDecimal(waitlist.averageWaitMinutes)} min` },
              { label: 'Saíram', value: formatInteger(waitlist.dropped) },
            ]}
          />
        </ReportCard>

        {canViewRecurrence && (
          <ReportCard
            accent="success"
            href={withSearch(`${reportsPath}/recorrencia`, search)}
            icon={Repeat2}
            title="Recorrência"
          >
            {recurrenceStatus === 'ready' && recurrence ? (
              <>
                <ReportHeadline
                  accent="success"
                  value={formatPercentage(recurrence.returnRate)}
                  label="das visitas são retorno"
                  detail={
                    <>
                      <span className="font-semibold text-foreground">
                        {formatInteger(recurrence.firstVisits)} primeiras visitas
                      </span>{' '}
                      para conquistar no período
                    </>
                  }
                />
                <ReportStats
                  label="Composição das visitas"
                  stats={[
                    { label: 'Visitas', value: formatInteger(recurrence.totalVisits) },
                    { label: 'Novos', value: formatInteger(recurrence.firstVisits) },
                    { label: 'Retornos', value: formatInteger(recurrence.returnVisits) },
                  ]}
                />
              </>
            ) : recurrenceStatus === 'loading' ? (
              <div className="space-y-3" role="status" aria-label="Carregando resumo de recorrência">
                <span className="sr-only">Carregando resumo de recorrência…</span>
                <div className="h-7 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" aria-hidden="true" />
                <div className="h-10 animate-pulse rounded bg-muted/70 motion-reduce:animate-none" aria-hidden="true" />
                <div className="h-10 animate-pulse rounded bg-muted/70 motion-reduce:animate-none" aria-hidden="true" />
              </div>
            ) : recurrenceStatus === 'error' ? (
              <p className="text-[13px] font-medium leading-5 text-destructive" role="status">
                Não foi possível carregar o resumo de recorrência agora.
              </p>
            ) : (
              <p className="text-[13px] font-medium leading-5 text-foreground">
                Sem visitas identificadas para medir recorrência no período.
              </p>
            )}
          </ReportCard>
        )}
      </div>
    </section>
  );
}

export default DashboardReportOverview;
