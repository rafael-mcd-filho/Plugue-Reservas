import { useState } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarIcon } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface DateRangePickerProps {
  value: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
  placeholder?: string;
  className?: string;
  align?: 'start' | 'center' | 'end';
  numberOfMonths?: number;
}

function formatRangeLabel(range: DateRange | undefined, placeholder: string) {
  if (!range?.from) return placeholder;
  if (!range.to) return format(range.from, 'dd/MM/yyyy', { locale: ptBR });
  return `${format(range.from, 'dd/MM/yyyy', { locale: ptBR })} – ${format(range.to, 'dd/MM/yyyy', { locale: ptBR })}`;
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = 'Selecionar período',
  className,
  align = 'start',
  numberOfMonths,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);

  const resolvedMonths = numberOfMonths ?? (typeof window !== 'undefined' && window.innerWidth < 640 ? 1 : 2);

  function handleOpenChange(next: boolean) {
    if (next && value?.from && value?.to) {
      onChange(undefined);
    }
    setOpen(next);
  }

  function handleSelect(range: DateRange | undefined) {
    onChange(range);
    if (range?.from && range?.to) {
      setOpen(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-9 justify-between gap-2 text-left font-normal',
            !value?.from && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{formatRangeLabel(value, placeholder)}</span>
          <CalendarIcon className="h-4 w-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        <Calendar
          mode="range"
          selected={value}
          onSelect={handleSelect}
          numberOfMonths={resolvedMonths}
          initialFocus
          locale={ptBR}
          className="pointer-events-auto p-3"
        />
      </PopoverContent>
    </Popover>
  );
}
