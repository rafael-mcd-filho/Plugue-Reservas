import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
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
  detail?: ReactNode;
  icon: LucideIcon;
  tone?: ReportMetricTone;
  className?: string;
}

export default function ReportMetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'neutral',
  className,
}: ReportMetricCardProps) {
  return (
    <Card className={cn('min-w-0 border-border/80 shadow-sm', className)}>
      <CardContent className="flex h-full min-h-28 flex-col justify-between gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
          <span className={cn('rounded-lg p-2', TONE_CLASSES[tone])}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        </div>
        <div className="min-w-0">
          <p className="break-words text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
          {detail && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
