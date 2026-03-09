import { cn } from '@/lib/utils';
import { ReservationStatus, TableStatus } from '@/types/restaurant';

const reservationStatusConfig: Record<ReservationStatus, { label: string; className: string }> = {
  confirmed: { label: 'Confirmada', className: 'bg-accent/15 text-accent border-accent/30' },
  pending: { label: 'Pendente', className: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/30' },
  cancelled: { label: 'Cancelada', className: 'bg-destructive/15 text-destructive border-destructive/30' },
  completed: { label: 'Concluída', className: 'bg-muted text-muted-foreground border-border' },
  'no-show': { label: 'Não compareceu', className: 'bg-destructive/10 text-destructive/80 border-destructive/20' },
};

const tableStatusConfig: Record<TableStatus, { label: string; className: string }> = {
  available: { label: 'Disponível', className: 'bg-accent/15 text-accent border-accent/30' },
  occupied: { label: 'Ocupada', className: 'bg-primary/15 text-primary border-primary/30' },
  reserved: { label: 'Reservada', className: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/30' },
  maintenance: { label: 'Manutenção', className: 'bg-muted text-muted-foreground border-border' },
};

export function ReservationStatusBadge({ status }: { status: ReservationStatus }) {
  const config = reservationStatusConfig[status];
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border', config.className)}>
      {config.label}
    </span>
  );
}

export function TableStatusBadge({ status }: { status: TableStatus }) {
  const config = tableStatusConfig[status];
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border', config.className)}>
      {config.label}
    </span>
  );
}
