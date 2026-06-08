import {
  RESERVATION_OPERATIONAL_FILTER_OPTIONS,
  type ReservationOperationalFilter,
} from '@/lib/reservation-operational-filter';
import { cn } from '@/lib/utils';

interface ReservationOperationalFilterControlProps {
  className?: string;
  onChange: (value: ReservationOperationalFilter) => void;
  value: ReservationOperationalFilter;
}

export default function ReservationOperationalFilterControl({
  className,
  onChange,
  value,
}: ReservationOperationalFilterControlProps) {
  return (
    <div
      className={cn('inline-flex rounded-xl border border-border bg-card p-1', className)}
      role="group"
      aria-label="Filtrar reservas operacionais"
    >
      {RESERVATION_OPERATIONAL_FILTER_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'flex-1 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors sm:flex-none sm:px-4',
            value === option.value && 'bg-primary text-primary-foreground shadow-sm',
            value !== option.value && 'hover:text-foreground',
          )}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
