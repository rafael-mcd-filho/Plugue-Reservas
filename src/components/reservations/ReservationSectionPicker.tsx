import { Check, MapPin } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatPrepaymentAmount, type PublicReservationSectionOption } from '@/lib/asaas-prepayment-contracts';

export function getSectionPriceLabel(option: PublicReservationSectionOption, partySize: number) {
  if (option.base_amount == null) return 'Sem pagamento antecipado';
  const multiplier = option.amount_type === 'per_person' ? partySize : 1;
  if (option.pix_amount != null && option.credit_card_amount != null && option.pix_amount === option.credit_card_amount) {
    return `${formatPrepaymentAmount(option.pix_amount * multiplier)} no Pix ou cartão`;
  }
  const prices = [
    option.pix_amount == null ? null : `${formatPrepaymentAmount(option.pix_amount * multiplier)} no Pix`,
    option.credit_card_amount == null ? null : `${formatPrepaymentAmount(option.credit_card_amount * multiplier)} no cartão`,
  ].filter(Boolean);
  return prices.join(' · ') || formatPrepaymentAmount(option.base_amount * multiplier);
}

export default function ReservationSectionPicker({
  options, value, partySize, onChange,
}: {
  options: PublicReservationSectionOption[];
  value: string;
  partySize: number;
  onChange: (id: string) => void;
}) {
  return (
    <div className="space-y-3 border-t border-border/70 pt-4">
      <div className="space-y-1">
        <h2 id="reservation-section-label" className="flex items-center gap-2 text-base font-semibold">
          <MapPin className="h-4 w-4 text-primary" aria-hidden="true" /> Escolha seu ambiente
        </h2>
        <p className="text-sm text-muted-foreground">Você garante o ambiente. A equipe organiza sua mesa.</p>
      </div>
      <RadioGroup aria-labelledby="reservation-section-label" value={value} onValueChange={onChange} className="gap-2.5">
        {options.map((option) => {
          const selected = value === option.id;
          const inputId = `reservation-section-${option.id}`;
          return (
            <Label key={option.id} htmlFor={inputId} className={cn(
              'flex min-h-20 items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
              option.available ? 'cursor-pointer hover:border-primary/60' : 'cursor-not-allowed bg-muted/40 text-muted-foreground',
              selected ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-border',
            )}>
              <RadioGroupItem id={inputId} value={option.id} disabled={!option.available} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 space-y-1.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold leading-snug">{option.public_name || option.section_name}</span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                </span>
                {option.description && <span className="block text-sm font-normal leading-relaxed text-muted-foreground">{option.description}</span>}
                <span className={cn('block text-sm font-semibold leading-relaxed', option.available && 'text-primary')}>
                  {option.available ? getSectionPriceLabel(option, partySize) : 'Esgotado para este horário e grupo'}
                </span>
                {option.available && option.base_amount != null && <span className="block text-xs font-normal leading-relaxed text-muted-foreground">
                  {option.amount_type === 'per_person'
                    ? `Total para ${partySize} ${partySize === 1 ? 'pessoa' : 'pessoas'} · cobrança por pessoa`
                    : 'Valor total da reserva'}
                </span>}
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      {!options.some((option) => option.available) && (
        <p role="status" className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">Nenhum ambiente disponível. Escolha outro horário ou altere a quantidade de pessoas.</p>
      )}
    </div>
  );
}
