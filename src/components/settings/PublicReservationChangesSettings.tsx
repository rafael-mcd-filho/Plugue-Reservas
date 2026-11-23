import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { MAX_PUBLIC_RESERVATION_CHANGE_MIN_NOTICE_MINUTES } from '@/lib/public-reservation-change-settings';

interface PublicReservationChangesSettingsProps {
  available: boolean;
  enabled: boolean;
  minNoticeMinutes: string;
  onEnabledChange: (enabled: boolean) => void;
  onMinNoticeMinutesChange: (minutes: string) => void;
}

/** Campo "Remarcação pelo cliente" das Regras gerais: chave, explicação e a antecedência mínima. */
export function PublicReservationChangesSettings({
  available,
  enabled,
  minNoticeMinutes,
  onEnabledChange,
  onMinNoticeMinutesChange,
}: PublicReservationChangesSettingsProps) {
  return (
    <section aria-labelledby="public-reservation-changes-heading" className="space-y-1.5">
      <h3 id="public-reservation-changes-heading" className="text-sm font-medium text-foreground">Remarcação pelo cliente</h3>
      <div className="flex min-h-10 items-center gap-3">
        <Switch
          id="company-settings-public-reservation-changes"
          aria-label="Permitir remarcação pelo cliente"
          checked={enabled}
          disabled={!available}
          onCheckedChange={onEnabledChange}
          aria-describedby="public-reservation-changes-description"
        />
        <span className="text-sm text-foreground">{enabled ? 'Ligada' : 'Desligada'}</span>
      </div>
      <p id="public-reservation-changes-description" className="text-xs leading-snug text-muted-foreground">
        O cliente muda pessoas, data e horário pelo link da reserva, se a reserva não tiver pagamento. Com pagamento ou fora do prazo, continua pelo WhatsApp.
      </p>
      {available ? (
        <div className="space-y-1.5 pt-2">
          <Label htmlFor="company-settings-public-reservation-change-notice" className="text-xs font-medium">
            Antecedência mínima para alterar
          </Label>
          <div className="flex h-10 w-40 overflow-hidden rounded-lg border border-[rgba(0,0,0,0.14)] bg-white focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 has-[:disabled]:opacity-60">
            <input
              id="company-settings-public-reservation-change-notice"
              name="public_reservation_change_min_notice_minutes"
              type="number"
              min={0}
              max={MAX_PUBLIC_RESERVATION_CHANGE_MIN_NOTICE_MINUTES}
              step={1}
              inputMode="numeric"
              value={minNoticeMinutes}
              onChange={(event) => onMinNoticeMinutesChange(event.target.value)}
              disabled={!enabled}
              aria-describedby="public-reservation-change-notice-description"
              className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none disabled:cursor-not-allowed"
            />
            <span className="flex items-center border-l border-[rgba(0,0,0,0.08)] bg-muted/40 px-3 text-sm text-muted-foreground">min</span>
          </div>
          <p id="public-reservation-change-notice-description" className="text-xs leading-snug text-muted-foreground">
            Vale para o horário atual e o novo. Ex.: 120 = 2 horas. Use 0 para permitir até o início da reserva.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Remarcação indisponível no momento. O atendimento continua pelo WhatsApp.</p>
      )}
    </section>
  );
}
