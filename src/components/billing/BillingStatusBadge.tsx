import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_PRESENTATION: Record<string, { label: string; className: string }> = {
  PENDING: {
    label: 'Em aberto',
    className: 'border-warning/25 bg-warning-soft text-amber-800',
  },
  OVERDUE: {
    label: 'Vencida',
    className: 'border-destructive/25 bg-destructive-soft text-destructive',
  },
  RECEIVED: {
    label: 'Paga',
    className: 'border-success/25 bg-success-soft text-success',
  },
  CONFIRMED: {
    label: 'Confirmada',
    className: 'border-success/25 bg-success-soft text-success',
  },
  RECEIVED_IN_CASH: {
    label: 'Recebida',
    className: 'border-success/25 bg-success-soft text-success',
  },
  REFUNDED: {
    label: 'Estornada',
    className: 'border-border bg-muted text-muted-foreground',
  },
  REFUND_REQUESTED: {
    label: 'Estorno solicitado',
    className: 'border-border bg-muted text-muted-foreground',
  },
  REFUND_IN_PROGRESS: {
    label: 'Estorno em andamento',
    className: 'border-warning/25 bg-warning-soft text-amber-800',
  },
  CHARGEBACK_REQUESTED: {
    label: 'Chargeback',
    className: 'border-destructive/25 bg-destructive-soft text-destructive',
  },
  CHARGEBACK_DISPUTE: {
    label: 'Em disputa',
    className: 'border-destructive/25 bg-destructive-soft text-destructive',
  },
  AWAITING_CHARGEBACK_REVERSAL: {
    label: 'Aguardando reversão',
    className: 'border-warning/25 bg-warning-soft text-amber-800',
  },
  DUNNING_REQUESTED: {
    label: 'Em recuperação',
    className: 'border-warning/25 bg-warning-soft text-amber-800',
  },
  DUNNING_RECEIVED: {
    label: 'Recuperada',
    className: 'border-success/25 bg-success-soft text-success',
  },
  AWAITING_RISK_ANALYSIS: {
    label: 'Em análise',
    className: 'border-primary/20 bg-primary-soft text-primary',
  },
  DELETED: {
    label: 'Cancelada',
    className: 'border-border bg-muted text-muted-foreground',
  },
};

function getBillingStatusPresentation(status: string | null | undefined) {
  const normalized = String(status || '').trim().toUpperCase();
  return STATUS_PRESENTATION[normalized] ?? {
    label: normalized ? normalized.replaceAll('_', ' ') : 'Desconhecida',
    className: 'border-border bg-muted text-muted-foreground',
  };
}

export default function BillingStatusBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const presentation = getBillingStatusPresentation(status);

  return (
    <Badge variant="outline" className={cn('whitespace-nowrap font-medium', presentation.className, className)}>
      {presentation.label}
    </Badge>
  );
}
