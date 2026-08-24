import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import { cn } from '@/lib/utils';

type ReportMetricTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE_CLASSES: Record<ReportMetricTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning-foreground',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-info-soft text-info',
  neutral: 'bg-muted text-muted-foreground',
};

interface ReportMetricCardProps {
  label: string;
  value: ReactNode;
  /** Short supporting line under the value. */
  detail?: ReactNode;
  /** Period-over-period variation, rendered above the detail. */
  comparison?: ReactNode;
  /** Plain-language explanation of how the metric is calculated. */
  explanation?: string;
  icon: LucideIcon;
  tone?: ReportMetricTone;
  className?: string;
}

export default function ReportMetricCard({
  label,
  value,
  detail,
  comparison,
  explanation,
  icon: Icon,
  tone = 'neutral',
  className,
}: ReportMetricCardProps) {
  return (
    <Card className={cn('min-w-0 border-border shadow-sm', className)}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
              <span className="min-w-0">{label}</span>
              {explanation && (
                <InfoTooltip
                  content={explanation}
                  ariaLabel={`Como é calculado: ${label}`}
                  className="shrink-0 normal-case tracking-normal"
                  interaction="popover"
                />
              )}
            </div>
            <p className="mt-1.5 break-words text-2xl font-semibold tabular-nums tracking-tight text-foreground">
              {value}
            </p>
          </div>
          <span className={cn('shrink-0 rounded-lg p-2.5', TONE_CLASSES[tone])}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        </div>
        {comparison && <div className="mt-2 text-xs font-medium text-foreground/80">{comparison}</div>}
        {detail && <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{detail}</div>}
      </CardContent>
    </Card>
  );
}
