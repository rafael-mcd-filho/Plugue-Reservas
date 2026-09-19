import { Table2 } from 'lucide-react';
import { getReservationStatusLabel, normalizeReservationStatus, type ReservationStatusInput } from '@/lib/reservation-status';
import type { ReservationTableBadgeInfo, ReservationTableBadgeTone } from '@/lib/reservation-table-badge';
import { cn } from '@/lib/utils';
import type { ReservationStatus, TableStatus } from '@/types/restaurant';

const reservationStatusConfig: Record<ReservationStatus, { className: string }> = {
  pending_payment: { className: 'bg-warning-soft text-warning border-warning/20' },
  confirmed: { className: 'bg-primary-soft text-primary border-primary/20' },
  checked_in: { className: 'bg-info-soft text-info border-info/20' },
  cancelled: { className: 'bg-destructive-soft text-destructive border-destructive/20' },
  'no-show': { className: 'bg-destructive-soft text-destructive border-destructive/20' },
  payment_expired: { className: 'bg-muted text-muted-foreground border-border' },
  payment_cancelled: { className: 'bg-destructive-soft text-destructive border-destructive/20' },
  paid_after_expiration: { className: 'bg-warning-soft text-warning border-warning/20' },
};

const tableStatusConfig: Record<TableStatus, { label: string; className: string }> = {
  available: { label: 'Disponivel', className: 'bg-success-soft text-success border-success/20' },
  occupied: { label: 'Ocupada', className: 'bg-info-soft text-info border-info/20' },
  reserved: { label: 'Reservada', className: 'bg-primary-soft text-primary border-primary/20' },
  maintenance: { label: 'Manutencao', className: 'bg-muted text-muted-foreground border-border' },
};

export function ReservationStatusBadge({ status }: { status: ReservationStatusInput }) {
  const normalizedStatus = normalizeReservationStatus(status);
  const config = reservationStatusConfig[normalizedStatus];

  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', config.className)}>
      {getReservationStatusLabel(normalizedStatus)}
    </span>
  );
}

const reservationTableToneConfig: Record<ReservationTableBadgeTone, string> = {
  assigned: 'bg-muted text-muted-foreground border-border',
  unassigned: 'bg-amber-50 text-amber-800 border-amber-200',
};

// 'badge' acompanha os demais badges arredondados das listas de reservas;
// 'chip' acompanha os chips quadrados da tela do operador.
const reservationTableVariantConfig = {
  badge: 'rounded-full border px-2.5 py-0.5 text-xs font-medium',
  chip: 'rounded-md border px-1.5 py-0.5 text-[11px] font-semibold sm:text-xs',
} as const;

export function ReservationTableBadge({
  badge,
  variant = 'badge',
}: {
  badge: ReservationTableBadgeInfo;
  variant?: keyof typeof reservationTableVariantConfig;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        reservationTableVariantConfig[variant],
        reservationTableToneConfig[badge.tone],
      )}
      title={badge.tone === 'unassigned' ? 'Reserva sem mesa atribuída' : badge.label}
    >
      <Table2 className="h-3 w-3" />
      {badge.label}
    </span>
  );
}

export function TableStatusBadge({ status }: { status: TableStatus }) {
  const config = tableStatusConfig[status];
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', config.className)}>
      {config.label}
    </span>
  );
}
