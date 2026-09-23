import { Children, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from 'lucide-react';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import { formatKpiDelta } from '@/lib/kpi-delta';
import { cn } from '@/lib/utils';

interface ReportKpiStripProps {
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}

// Faixa de indicadores: um cartao unico dividido por linhas de 1px, em vez de
// varios cartoes soltos que quebram em larguras diferentes. A ultima celula
// estica quando a contagem deixaria um vao na grade.
export function ReportKpiStrip({ children, className, 'aria-label': ariaLabel }: ReportKpiStripProps) {
  const count = Children.count(children);

  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-sm',
        count >= 5 ? 'md:grid-cols-3 xl:grid-cols-5' : 'xl:grid-cols-4',
        count % 2 === 1 && '[&>*:last-child]:col-span-2',
        count === 5 && 'md:[&>*:last-child]:col-span-2',
        'xl:[&>*:last-child]:col-span-1',
        className,
      )}
    >
      {children}
    </section>
  );
}

interface ReportKpiDeltaProps {
  current: number;
  previous: number;
  percentagePoints?: boolean;
  // No-show e cancelamento sobem para o lado errado.
  higherIsBetter?: boolean;
  comparisonLabel?: string;
}

export function ReportKpiDelta({
  current,
  previous,
  percentagePoints,
  higherIsBetter,
  comparisonLabel = 'período anterior',
}: ReportKpiDeltaProps) {
  const delta = formatKpiDelta({ current, previous, percentagePoints, higherIsBetter });
  const Icon = delta.direction === 'up' ? ArrowUpRight : delta.direction === 'down' ? ArrowDownRight : Minus;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-xs font-medium',
        delta.favorable === true && 'text-success',
        delta.favorable === false && 'text-destructive',
        delta.favorable === null && 'text-muted-foreground',
      )}
      title={`${delta.description} (${comparisonLabel})`}
    >
      {delta.direction !== 'unknown' && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      <span aria-hidden="true">{delta.label}</span>
      <span className="sr-only">{delta.description}, comparado com {comparisonLabel}</span>
    </span>
  );
}

interface ReportKpiTileProps {
  label: string;
  value: ReactNode;
  /** Linha curta de contexto sob o número. */
  detail?: ReactNode;
  /** Variação do período, renderizada ao lado do número. */
  comparison?: ReactNode;
  /** Como a métrica é calculada, em linguagem simples. */
  explanation?: string;
  icon: LucideIcon;
  className?: string;
}

export function ReportKpiTile({
  label,
  value,
  detail,
  comparison,
  explanation,
  icon: Icon,
  className,
}: ReportKpiTileProps) {
  return (
    <div className={cn('min-w-0 bg-card px-3.5 py-3 transition-colors hover:bg-muted/20', className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary/60" aria-hidden="true" />
        <span className="truncate">{label}</span>
        {explanation && (
          <InfoTooltip
            content={explanation}
            ariaLabel={`Como é calculado: ${label}`}
            className="ml-auto shrink-0"
            interaction="popover"
          />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {/* Figuras proporcionais: tabular-nums deixa o número grande espaçado demais. */}
        <p className="break-words text-2xl font-semibold tracking-tight text-foreground">{value}</p>
        {comparison}
      </div>
      {detail && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function ReportKpiStripSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border',
        count >= 5 ? 'md:grid-cols-3 xl:grid-cols-5' : 'xl:grid-cols-4',
      )}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className={cn(
            'space-y-2 bg-card px-3.5 py-3',
            count % 2 === 1 && index === count - 1 && 'col-span-2 xl:col-span-1',
            count === 5 && index === count - 1 && 'md:col-span-2',
          )}
        >
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-7 w-20 animate-pulse rounded bg-muted" />
          <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
