import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';

export interface OpeningHourRow {
  day: string;
  open: string;
  close: string;
  closed?: boolean;
}

interface OpeningHoursCardProps {
  hours: OpeningHourRow[];
  onChange: (index: number, field: 'open' | 'close' | 'closed', value: string | boolean) => void;
  onApplyToOpenDays: (index: number) => void;
}

// O cadastro guarda o dia abreviado ("Seg"); na tela aparece o nome inteiro.
const FULL_DAY_NAMES: Record<string, string> = {
  Seg: 'Segunda',
  Ter: 'Terça',
  Qua: 'Quarta',
  Qui: 'Quinta',
  Sex: 'Sexta',
  'Sáb': 'Sábado',
  Sab: 'Sábado',
  Dom: 'Domingo',
};

function DayHoursEditor({
  row,
  dayName,
  onChange,
  onApplyToOpenDays,
}: {
  row: OpeningHourRow;
  dayName: string;
  onChange: (field: 'open' | 'close', value: string) => void;
  onApplyToOpenDays: () => void;
}) {
  const [open, setOpen] = useState(false);
  const idPrefix = `opening-hours-${row.day}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Editar horário de ${dayName}: ${row.open} às ${row.close}`}
          className="inline-flex h-9 items-center rounded-full bg-muted/70 px-4 text-sm font-semibold tabular-nums text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-primary-soft data-[state=open]:text-primary"
        >
          {row.open} às {row.close}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <p className="text-sm font-semibold text-foreground">{dayName}</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-open`} className="text-xs">Abre</Label>
            <Input
              id={`${idPrefix}-open`}
              type="time"
              value={row.open}
              onChange={(event) => onChange('open', event.target.value)}
              className="h-10 rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-close`} className="text-xs">Fecha</Label>
            <Input
              id={`${idPrefix}-close`}
              type="time"
              value={row.close}
              onChange={(event) => onChange('close', event.target.value)}
              className="h-10 rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none"
            />
          </div>
        </div>
        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2"
            onClick={() => {
              onApplyToOpenDays();
              setOpen(false);
            }}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            Usar nos dias abertos
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>Pronto</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Um dia por linha: abre ou fecha na chave e o horário fica num botão que abre a edição. */
export default function OpeningHoursCard({ hours, onChange, onApplyToOpenDays }: OpeningHoursCardProps) {
  return (
    <section
      aria-labelledby="opening-hours-heading"
      className="overflow-hidden rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(0,0,0,0.06)] px-5 py-4">
        <div>
          <h2 id="opening-hours-heading" className="text-base font-semibold text-foreground">Horário de funcionamento</h2>
          <p className="text-xs text-muted-foreground">Aparece na página pública. Toque no horário para mudar.</p>
        </div>
      </div>
      <ul>
        {hours.map((row, index) => {
          const dayName = FULL_DAY_NAMES[row.day] ?? row.day;
          const isOpen = !row.closed;
          return (
            <li
              key={row.day}
              className="grid grid-cols-[minmax(84px,110px)_44px_minmax(0,1fr)] items-center gap-3 border-b border-[rgba(0,0,0,0.06)] px-5 py-3 last:border-b-0 sm:gap-4"
            >
              <span className="text-sm font-medium text-foreground">{dayName}</span>
              <Switch
                checked={isOpen}
                onCheckedChange={(checked) => onChange(index, 'closed', !checked)}
                aria-label={`${dayName}: ${isOpen ? 'aberto' : 'fechado'}`}
              />
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                {isOpen ? (
                  <DayHoursEditor
                    row={row}
                    dayName={dayName}
                    onChange={(field, value) => onChange(index, field, value)}
                    onApplyToOpenDays={() => onApplyToOpenDays(index)}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">Fechado</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
