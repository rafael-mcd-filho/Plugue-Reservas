import type { ReactNode } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { BarChart3, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface ReportShellProps {
  title: string;
  description: string;
  icon?: LucideIcon;
  eyebrow?: string;
  filters?: ReactNode;
  actions?: ReactNode;
  updatedAt?: string | Date | null;
  isRefreshing?: boolean;
  ariaBusy?: boolean;
  children: ReactNode;
  className?: string;
}

function formatUpdatedAt(value: string | Date): string | null {
  const parsed = value instanceof Date ? value : parseISO(value);
  if (!isValid(parsed)) return null;
  return format(parsed, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
}

export default function ReportShell({
  title,
  description,
  icon: Icon = BarChart3,
  eyebrow = 'Relatórios',
  filters,
  actions,
  updatedAt,
  isRefreshing = false,
  ariaBusy = false,
  children,
  className,
}: ReportShellProps) {
  const updatedLabel = updatedAt ? formatUpdatedAt(updatedAt) : null;

  return (
    <div
      className={cn('min-w-0 space-y-4 overflow-x-hidden pb-8', className)}
      aria-busy={ariaBusy || undefined}
    >
      <header className="flex min-w-0 flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{eyebrow}</span>
            </div>
            <h1 className="text-balance text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
            <p className="mt-0.5 max-w-3xl text-pretty text-xs leading-relaxed text-muted-foreground sm:text-sm">{description}</p>
          </div>

          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            {(updatedLabel || isRefreshing) && (
              <Badge
                variant="outline"
                className="h-7 max-w-full bg-background px-2.5 font-normal text-muted-foreground"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {isRefreshing ? 'Atualizando…' : `Atualizado em ${updatedLabel}`}
              </Badge>
            )}
            {actions}
          </div>
      </header>

      {filters}
      {children}
    </div>
  );
}
