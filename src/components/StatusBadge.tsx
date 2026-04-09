import { getReservationStatusLabel, normalizeReservationStatus, type ReservationStatusInput } from '@/lib/reservation-status';
import { cn } from '@/lib/utils';
import type { ReservationStatus, TableStatus } from '@/types/restaurant';

const reservationStatusConfig: Record<ReservationStatus, { className: string }> = {
  confirmed: { className: 'bg-primary-soft text-primary border-primary/20' },
  checked_in: { className: 'bg-info-soft text-info border-info/20' },
  cancelled: { className: 'bg-destructive-soft text-destructive border-destructive/20' },
  'no-show': { className: 'bg-destructive-soft text-destructive border-destructive/20' },
};

const reservationSourceConfig: Record<string, { label: string; className: string }> = {
  reservation: { label: 'Agendada', className: 'bg-primary-soft text-primary border-primary/20' },
  waitlist: { label: 'Fila convertida', className: 'bg-success-soft text-success border-success/20' },
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

export function ReservationSourceBadge({ source }: { source: string | null | undefined }) {
  const config = reservationSourceConfig[source === 'waitlist' ? 'waitlist' : 'reservation'];
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', config.className)}>
      {config.label}
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
