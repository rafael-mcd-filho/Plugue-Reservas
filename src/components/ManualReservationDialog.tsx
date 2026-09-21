import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CheckCircle2, Loader2, Table2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MIN_CRM_LEAD_PREFILL_PHONE_DIGITS, useCrmLeadPrefill } from '@/hooks/useCrmLeadPrefill';
import { supabase } from '@/integrations/supabase/client';
import { MANUAL_RESERVATION_MAX_PARTY_SIZE } from '@/lib/calendar-slot-availability';
import {
  formatBrazilPhone,
  getEmailValidationMessage,
  getPhoneValidationMessage,
  normalizeBrazilPhoneDigits,
  normalizeEmail,
} from '@/lib/validation';

interface ManualReservationForm {
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  guest_birthdate: string;
  date: string;
  time: string;
  party_size: string;
  occasion: string;
  notes: string;
}

export interface ManualReservationPresetTable {
  id: string;
  number: number;
  sectionName: string | null;
  capacity: number;
}

/**
 * Valores iniciais do formulario. Com mesa definida, data e horario ficam
 * travados porque a disponibilidade da mesa vale so para aquele horario.
 */
export interface ManualReservationPreset {
  date?: string;
  time?: string;
  partySize?: number;
  /** Vagas de pessoas restantes na faixa, exibidas como referencia. */
  remainingCapacity?: number | null;
  table?: ManualReservationPresetTable | null;
}

export interface CreatedManualReservation {
  id: string;
}

interface ManualReservationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string | null | undefined;
  preset?: ManualReservationPreset | null;
  onCreated?: (reservation: CreatedManualReservation) => void;
}

function getNextHalfHourDate() {
  const next = new Date();
  next.setSeconds(0, 0);

  const minutes = next.getMinutes();
  const roundedMinutes = minutes === 0 || minutes === 30 ? minutes : minutes < 30 ? 30 : 60;
  next.setMinutes(roundedMinutes);

  return next;
}

function createManualReservationForm(preset?: ManualReservationPreset | null): ManualReservationForm {
  const nextReservationAt = getNextHalfHourDate();
  const presetLimit = Math.min(
    preset?.table?.capacity ?? MANUAL_RESERVATION_MAX_PARTY_SIZE,
    preset?.remainingCapacity ?? MANUAL_RESERVATION_MAX_PARTY_SIZE,
    MANUAL_RESERVATION_MAX_PARTY_SIZE,
  );
  const requestedPartySize = preset?.partySize ?? 2;

  return {
    guest_name: '',
    guest_phone: '',
    guest_email: '',
    guest_birthdate: '',
    date: preset?.date ?? format(nextReservationAt, 'yyyy-MM-dd'),
    time: preset?.time ?? format(nextReservationAt, 'HH:mm'),
    party_size: String(Math.max(Math.min(requestedPartySize, presetLimit), 1)),
    occasion: '',
    notes: '',
  };
}

function formatPresetDateLabel(date: string) {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return format(parsed, 'EEEE, dd/MM', { locale: ptBR });
}

export default function ManualReservationDialog({
  open,
  onOpenChange,
  companyId,
  preset,
  onCreated,
}: ManualReservationDialogProps) {
  const [manualReservationForm, setManualReservationForm] = useState<ManualReservationForm>(
    () => createManualReservationForm(preset),
  );
  const [wasOpen, setWasOpen] = useState(open);
  const appliedLeadPrefillRef = useRef<{
    phone: string;
    guest_name: string | null;
    guest_email: string | null;
    guest_birthdate: string | null;
  } | null>(null);
  const qc = useQueryClient();
  const presetTable = preset?.table ?? null;
  const maxPartySize = Math.min(
    presetTable?.capacity ?? MANUAL_RESERVATION_MAX_PARTY_SIZE,
    preset?.remainingCapacity ?? MANUAL_RESERVATION_MAX_PARTY_SIZE,
    MANUAL_RESERVATION_MAX_PARTY_SIZE,
  );
  const lockSchedule = !!presetTable && !!preset?.date && !!preset?.time;

  // Reinicia o formulario a cada abertura, ja com os valores do preset, sem
  // renderizar um quadro com os dados da abertura anterior.
  if (open !== wasOpen) {
    setWasOpen(open);
    appliedLeadPrefillRef.current = null;
    if (open) {
      setManualReservationForm(createManualReservationForm(preset));
    }
  }

  const manualReservationPhoneDigits = useMemo(
    () => normalizeBrazilPhoneDigits(manualReservationForm.guest_phone),
    [manualReservationForm.guest_phone],
  );
  const {
    data: manualReservationLead,
    isFetching: manualReservationLeadLoading,
  } = useCrmLeadPrefill(companyId, manualReservationPhoneDigits, open);
  const showManualReservationLeadLookup = open
    && manualReservationPhoneDigits.length >= MIN_CRM_LEAD_PREFILL_PHONE_DIGITS;

  useEffect(() => {
    const appliedPrefill = appliedLeadPrefillRef.current;
    if (!appliedPrefill || appliedPrefill.phone === manualReservationPhoneDigits) return;

    setManualReservationForm((current) => ({
      ...current,
      guest_name: appliedPrefill.guest_name != null && current.guest_name === appliedPrefill.guest_name
        ? ''
        : current.guest_name,
      guest_email: appliedPrefill.guest_email != null && current.guest_email === appliedPrefill.guest_email
        ? ''
        : current.guest_email,
      guest_birthdate: appliedPrefill.guest_birthdate != null
        && current.guest_birthdate === appliedPrefill.guest_birthdate
        ? ''
        : current.guest_birthdate,
    }));
    appliedLeadPrefillRef.current = null;
  }, [manualReservationPhoneDigits]);

  useEffect(() => {
    if (
      !open
      || !manualReservationLead
      || manualReservationLead.phone_normalized !== manualReservationPhoneDigits
      || appliedLeadPrefillRef.current?.phone === manualReservationPhoneDigits
    ) return;

    setManualReservationForm((current) => {
      const appliedName = !current.guest_name ? manualReservationLead.full_name : null;
      const appliedEmail = !current.guest_email ? manualReservationLead.email : null;
      const appliedBirthdate = !current.guest_birthdate ? manualReservationLead.birthdate : null;

      appliedLeadPrefillRef.current = {
        phone: manualReservationPhoneDigits,
        guest_name: appliedName,
        guest_email: appliedEmail,
        guest_birthdate: appliedBirthdate,
      };

      return {
        ...current,
        guest_name: appliedName || current.guest_name,
        guest_email: appliedEmail || current.guest_email,
        guest_birthdate: appliedBirthdate || current.guest_birthdate,
      };
    });
  }, [manualReservationLead, manualReservationPhoneDigits, open]);

  const createReservationMutation = useMutation({
    mutationFn: async () => {
      const parsedPartySize = Number.parseInt(manualReservationForm.party_size, 10);
      const guestPhoneError = getPhoneValidationMessage(manualReservationForm.guest_phone, 'o WhatsApp do cliente', true);
      const guestEmailError = getEmailValidationMessage(manualReservationForm.guest_email, 'o e-mail do cliente');

      if (!manualReservationForm.guest_name.trim() || !manualReservationForm.guest_phone.trim()) {
        throw new Error('Informe nome e WhatsApp do cliente.');
      }

      if (guestPhoneError) {
        throw new Error(guestPhoneError);
      }

      if (guestEmailError) {
        throw new Error(guestEmailError);
      }

      if (!manualReservationForm.date || !manualReservationForm.time) {
        throw new Error('Informe data e horário da reserva.');
      }

      if (Number.isNaN(parsedPartySize) || parsedPartySize < 1 || parsedPartySize > MANUAL_RESERVATION_MAX_PARTY_SIZE) {
        throw new Error('Informe uma quantidade válida de pessoas.');
      }

      if (preset?.remainingCapacity != null && parsedPartySize > preset.remainingCapacity) {
        throw new Error(
          preset.remainingCapacity === 1
            ? 'Resta apenas 1 vaga neste horário.'
            : `Restam apenas ${preset.remainingCapacity} vagas neste horário.`,
        );
      }

      if (presetTable && parsedPartySize > presetTable.capacity) {
        throw new Error(`A mesa ${presetTable.number} comporta até ${presetTable.capacity} pessoas.`);
      }

      // Criacao via RPC segura: valida capacidade/limites e auto-atribui a
      // menor mesa livre no modo por mesas, em vez de inserir direto com
      // table_id nulo (Fase 4). _allow_unassigned mantem a criacao possivel
      // mesmo sem mesa livre, marcando a reserva como "alocar depois". Com
      // mesa escolhida, a RPC exige que ela caiba e esteja livre no horario.
      const { data, error } = await (supabase.rpc as any)('create_panel_reservation', {
        _company_id: companyId,
        _date: manualReservationForm.date,
        _time: `${manualReservationForm.time}:00`,
        _party_size: parsedPartySize,
        _guest_name: manualReservationForm.guest_name.trim(),
        _guest_phone: normalizeBrazilPhoneDigits(manualReservationForm.guest_phone),
        _guest_email: normalizeEmail(manualReservationForm.guest_email) || null,
        _guest_birthdate: manualReservationForm.guest_birthdate || null,
        _occasion: manualReservationForm.occasion.trim() || null,
        _notes: manualReservationForm.notes.trim() || null,
        _table_id: presetTable?.id ?? null,
        _allow_unassigned: true,
        _assignment_note: null,
        _status: 'confirmed',
      });

      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as CreatedManualReservation;
    },
    onSuccess: (createdReservation) => {
      toast.success('Reserva criada manualmente.');
      onCreated?.(createdReservation);
      onOpenChange(false);

      supabase.functions.invoke('reservation-events', {
        body: {
          event: 'reservation_created',
          reservation: { id: createdReservation.id },
        },
      }).catch((error) => console.warn('Reservation events error:', error));
    },
    onError: (err: any) => {
      toast.error(`Erro: ${err.message}`);
      // A mesa pode ter sido ocupada por outra reserva desde a ultima leitura.
      if (presetTable) {
        qc.invalidateQueries({ queryKey: ['calendar-slot-tables', companyId] });
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nova reserva manual</DialogTitle>
          <DialogDescription>
            Preencha os dados do cliente e confirme a reserva para o horário selecionado.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            createReservationMutation.mutate();
          }}
        >
          {lockSchedule && presetTable && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Table2 className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    Mesa {presetTable.number}
                    {presetTable.sectionName ? ` · ${presetTable.sectionName}` : ''}
                    {` · ${presetTable.capacity} ${presetTable.capacity === 1 ? 'lugar' : 'lugares'}`}
                  </p>
                  <p className="text-xs capitalize text-muted-foreground">
                    {formatPresetDateLabel(preset?.date ?? '')} · {preset?.time}
                  </p>
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Escolher outra mesa
              </Button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="manual-reservation-name">Nome *</Label>
              <Input
                id="manual-reservation-name"
                name="guest_name"
                value={manualReservationForm.guest_name}
                onChange={(event) =>
                  setManualReservationForm((current) => ({ ...current, guest_name: event.target.value }))
                }
                placeholder="Nome do cliente"
                autoComplete="name"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-reservation-phone">WhatsApp *</Label>
              <Input
                id="manual-reservation-phone"
                name="guest_phone"
                type="tel"
                value={manualReservationForm.guest_phone}
                onChange={(event) =>
                  setManualReservationForm((current) => ({ ...current, guest_phone: formatBrazilPhone(event.target.value) }))
                }
                placeholder="(11) 99999-9999"
                autoComplete="tel"
                inputMode="tel"
                maxLength={15}
                required
              />
              {showManualReservationLeadLookup && (manualReservationLeadLoading || manualReservationLead) && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                  {manualReservationLeadLoading ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Buscando lead pelo WhatsApp...</span>
                    </>
                  ) : manualReservationLead ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      <span>
                        Lead encontrado{manualReservationLead.full_name ? `: ${manualReservationLead.full_name}` : ''}. Dados preenchidos.
                      </span>
                    </>
                  ) : null}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-reservation-email">Email</Label>
              <Input
                id="manual-reservation-email"
                name="guest_email"
                type="email"
                value={manualReservationForm.guest_email}
                onChange={(event) =>
                  setManualReservationForm((current) => ({ ...current, guest_email: event.target.value }))
                }
                placeholder="cliente@email.com"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-reservation-birthdate">Data de nascimento</Label>
              <Input
                id="manual-reservation-birthdate"
                name="guest_birthdate"
                type="date"
                value={manualReservationForm.guest_birthdate}
                onChange={(event) =>
                  setManualReservationForm((current) => ({ ...current, guest_birthdate: event.target.value }))
                }
                autoComplete="bday"
              />
            </div>

            {!lockSchedule && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="manual-reservation-date">Data *</Label>
                  <Input
                    id="manual-reservation-date"
                    name="date"
                    type="date"
                    value={manualReservationForm.date}
                    onChange={(event) =>
                      setManualReservationForm((current) => ({ ...current, date: event.target.value }))
                    }
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-reservation-time">Horário *</Label>
                  <Input
                    id="manual-reservation-time"
                    name="time"
                    type="time"
                    value={manualReservationForm.time}
                    onChange={(event) =>
                      setManualReservationForm((current) => ({ ...current, time: event.target.value }))
                    }
                    required
                  />
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="manual-reservation-party-size">Pessoas *</Label>
              <Input
                id="manual-reservation-party-size"
                name="party_size"
                type="number"
                min="1"
                max={Math.max(maxPartySize, 1)}
                value={manualReservationForm.party_size}
                onChange={(event) =>
                  setManualReservationForm((current) => ({ ...current, party_size: event.target.value }))
                }
                required
              />
              {presetTable ? (
                <p className="text-xs text-muted-foreground">Até {maxPartySize} pessoas nesta mesa e horário.</p>
              ) : preset?.remainingCapacity != null && (
                <p className="text-xs text-muted-foreground">
                  {preset.remainingCapacity === 1 ? 'Resta 1 vaga' : `Restam ${preset.remainingCapacity} vagas`} neste horário.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-reservation-occasion">Ocasião</Label>
              <Input
                id="manual-reservation-occasion"
                name="occasion"
                value={manualReservationForm.occasion}
                onChange={(event) =>
                  setManualReservationForm((current) => ({ ...current, occasion: event.target.value }))
                }
                placeholder="Ex: aniversário"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="manual-reservation-notes">Observações</Label>
            <Textarea
              id="manual-reservation-notes"
              name="notes"
              value={manualReservationForm.notes}
              onChange={(event) =>
                setManualReservationForm((current) => ({ ...current, notes: event.target.value }))
              }
              placeholder="Preferências do cliente, restrições, observações internas..."
              rows={4}
              autoComplete="off"
            />
          </div>

          <div className="rounded-2xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            A reserva será criada como <span className="font-medium text-foreground">Confirmada</span>
            {presetTable ? <> na <span className="font-medium text-foreground">Mesa {presetTable.number}</span></> : null}
            . O check-in e os acompanhantes podem ser registrados depois, no dia do atendimento.
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createReservationMutation.isPending}>
              {createReservationMutation.isPending ? 'Criando...' : 'Criar reserva'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
