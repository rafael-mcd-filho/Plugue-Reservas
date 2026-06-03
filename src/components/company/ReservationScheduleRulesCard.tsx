import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CalendarClock,
  CalendarRange,
  Clock,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  useArchiveReservationScheduleRule,
  useReservationScheduleRules,
  useSaveReservationScheduleRule,
  type ReservationScheduleRule,
  type ReservationScheduleRuleScope,
} from '@/hooks/useReservationScheduleRules';
import {
  generateReservationScheduleSlots,
  normalizeReservationScheduleSlot,
  sortReservationScheduleSlotSettings,
} from '@/lib/reservation-schedule';

const CARD_CLASS = 'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]';
const BADGE_CLASS = 'flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary';
const FIELD_CLASS = 'h-10 w-full rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none';

const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Seg', longLabel: 'Segunda' },
  { value: 2, label: 'Ter', longLabel: 'Terça' },
  { value: 3, label: 'Qua', longLabel: 'Quarta' },
  { value: 4, label: 'Qui', longLabel: 'Quinta' },
  { value: 5, label: 'Sex', longLabel: 'Sexta' },
  { value: 6, label: 'Sáb', longLabel: 'Sábado' },
  { value: 0, label: 'Dom', longLabel: 'Domingo' },
];

const INTERVAL_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hora' },
  { value: '90', label: '1h30' },
  { value: '120', label: '2 horas' },
];

interface SlotFormValue {
  time: string;
  max_party_size_per_reservation: string;
  max_reservations_per_slot: string;
}

interface FormState {
  name: string;
  scope: ReservationScheduleRuleScope;
  weekdays: number[];
  start_date: string;
  end_date: string;
  enabled: boolean;
  priority: string;
  max_party_size_per_reservation: string;
  slots: SlotFormValue[];
  slotToAdd: string;
  generatorStart: string;
  generatorEnd: string;
  generatorInterval: string;
}

function createSlotFormValue(time: string): SlotFormValue {
  return {
    time,
    max_party_size_per_reservation: '',
    max_reservations_per_slot: '',
  };
}

function formatOptionalNumberInput(value: number | null | undefined) {
  return value == null ? '' : String(value);
}

function mergeSlots(current: SlotFormValue[], times: string[]) {
  return sortReservationScheduleSlotSettings([
    ...current,
    ...times.map(createSlotFormValue),
  ]);
}

const EMPTY_FORM: FormState = {
  name: '',
  scope: 'weekly',
  weekdays: [],
  start_date: '',
  end_date: '',
  enabled: true,
  priority: '100',
  max_party_size_per_reservation: '',
  slots: [],
  slotToAdd: '',
  generatorStart: '18:00',
  generatorEnd: '22:00',
  generatorInterval: '30',
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function getInitialForm(rule?: ReservationScheduleRule): FormState {
  if (!rule) return { ...EMPTY_FORM };

  return {
    name: rule.name,
    scope: rule.scope,
    weekdays: rule.weekdays ?? [],
    start_date: rule.start_date ?? '',
    end_date: rule.end_date ?? '',
    enabled: rule.enabled,
    priority: String(rule.priority),
    max_party_size_per_reservation: formatOptionalNumberInput(rule.max_party_size_per_reservation),
    slots: sortReservationScheduleSlotSettings(rule.reservation_schedule_rule_slots.map((slot) => ({
      time: slot.time,
      max_party_size_per_reservation: formatOptionalNumberInput(slot.max_party_size_per_reservation),
      max_reservations_per_slot: formatOptionalNumberInput(slot.max_reservations_per_slot),
    }))),
    slotToAdd: '',
    generatorStart: '18:00',
    generatorEnd: '22:00',
    generatorInterval: '30',
  };
}

function formatDate(date: string) {
  return format(new Date(`${date}T12:00:00`), "dd 'de' MMM 'de' yyyy", { locale: ptBR });
}

function getWeekdayLabel(weekdays: number[] | null) {
  const selected = WEEKDAY_OPTIONS.filter((day) => weekdays?.includes(day.value));
  return selected.map((day) => day.longLabel).join(', ');
}

function getRulePeriodLabel(rule: ReservationScheduleRule) {
  if (rule.scope === 'weekly') return getWeekdayLabel(rule.weekdays);
  if (rule.scope === 'date_specific') return rule.start_date ? formatDate(rule.start_date) : '';
  if (!rule.start_date || !rule.end_date) return '';
  return `${formatDate(rule.start_date)} até ${formatDate(rule.end_date)}`;
}

function validateForm(form: FormState) {
  if (!form.name.trim()) return 'Informe o nome da regra.';
  if (form.scope === 'weekly' && form.weekdays.length === 0) return 'Selecione ao menos um dia da semana.';
  if (form.scope !== 'weekly' && !form.start_date) return 'Informe a data inicial.';
  if (form.scope === 'date_range' && !form.end_date) return 'Informe a data final.';
  if (form.scope === 'date_range' && form.end_date < form.start_date) return 'A data final deve ser igual ou posterior à inicial.';
  if (form.slots.length === 0) return 'Adicione pelo menos um horário.';
  if (!Number.isInteger(Number(form.priority))) return 'Informe uma prioridade válida.';
  if (
    form.max_party_size_per_reservation
    && (
      !Number.isInteger(Number(form.max_party_size_per_reservation))
      || Number(form.max_party_size_per_reservation) < 1
      || Number(form.max_party_size_per_reservation) > 20
    )
  ) return 'O máximo por reserva deve ser um número entre 1 e 20.';
  if (form.slots.some((slot) => (
    slot.max_party_size_per_reservation
    && (
      !Number.isInteger(Number(slot.max_party_size_per_reservation))
      || Number(slot.max_party_size_per_reservation) < 1
      || Number(slot.max_party_size_per_reservation) > 20
    )
  ))) return 'O maximo por reserva de cada horario deve estar entre 1 e 20.';
  if (form.slots.some((slot) => (
    slot.max_reservations_per_slot
    && (
      !Number.isInteger(Number(slot.max_reservations_per_slot))
      || Number(slot.max_reservations_per_slot) < 1
      || Number(slot.max_reservations_per_slot) > 500
    )
  ))) return 'O maximo de reservas de cada horario deve estar entre 1 e 500.';
  return null;
}

interface RuleDialogProps {
  companyId: string;
  rule?: ReservationScheduleRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RuleDialog({ companyId, rule, open, onOpenChange }: RuleDialogProps) {
  const [form, setForm] = useState<FormState>(() => getInitialForm(rule));
  const [validationError, setValidationError] = useState<string | null>(null);
  const saveMutation = useSaveReservationScheduleRule();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setValidationError(null);
  }

  function resetAndClose() {
    setForm(getInitialForm(rule));
    setValidationError(null);
    onOpenChange(false);
  }

  function addSlot() {
    const slot = normalizeReservationScheduleSlot(form.slotToAdd);
    if (!slot) {
      setValidationError('Informe um horário válido.');
      return;
    }

    update('slots', mergeSlots(form.slots, [slot]));
    update('slotToAdd', '');
  }

  function generateSlots() {
    const slots = generateReservationScheduleSlots(
      form.generatorStart,
      form.generatorEnd,
      Number(form.generatorInterval),
    );

    if (slots.length === 0) {
      setValidationError('Confira o início, o fim e o intervalo usados para gerar horários.');
      return;
    }

    update('slots', mergeSlots(form.slots, slots));
  }

  function updateSlot(time: string, key: keyof Omit<SlotFormValue, 'time'>, value: string) {
    update('slots', form.slots.map((slot) => (
      slot.time === time ? { ...slot, [key]: value } : slot
    )));
  }

  async function handleSubmit() {
    const error = validateForm(form);
    if (error) {
      setValidationError(error);
      return;
    }

    try {
      await saveMutation.mutateAsync({
        id: rule?.id,
        company_id: companyId,
        name: form.name,
        scope: form.scope,
        weekdays: form.scope === 'weekly' ? form.weekdays : null,
        start_date: form.scope === 'weekly' ? null : form.start_date,
        end_date: form.scope === 'date_range' ? form.end_date : form.start_date,
        enabled: form.enabled,
        priority: Number(form.priority),
        max_party_size_per_reservation: form.max_party_size_per_reservation
          ? Number(form.max_party_size_per_reservation)
          : null,
        slots: form.slots.map((slot) => ({
          time: slot.time,
          max_party_size_per_reservation: slot.max_party_size_per_reservation
            ? Number(slot.max_party_size_per_reservation)
            : null,
          max_reservations_per_slot: slot.max_reservations_per_slot
            ? Number(slot.max_reservations_per_slot)
            : null,
        })),
      });
      resetAndClose();
    } catch {
      // The mutation already exposes the server message in a toast.
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : resetAndClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? 'Editar regra de horários' : 'Nova regra de horários'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_11rem]">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-rule-name">Nome</Label>
              <Input
                id="schedule-rule-name"
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="Ex.: Jantar de sexta"
                className={FIELD_CLASS}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="schedule-rule-priority">Prioridade</Label>
              <Input
                id="schedule-rule-priority"
                type="number"
                value={form.priority}
                onChange={(event) => update('priority', event.target.value)}
                className={FIELD_CLASS}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="schedule-rule-max-party-size">Máx. pessoas padrão</Label>
              <Input
                id="schedule-rule-max-party-size"
                type="number"
                min={1}
                max={20}
                value={form.max_party_size_per_reservation}
                onChange={(event) => update('max_party_size_per_reservation', event.target.value)}
                placeholder="Sem limite"
                className={FIELD_CLASS}
              />
              <p className="text-[11px] leading-tight text-muted-foreground">Usado nos horários sem limite próprio.</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Tipo de regra</Label>
            <Select value={form.scope} onValueChange={(value) => update('scope', value as ReservationScheduleRuleScope)}>
              <SelectTrigger className={FIELD_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Recorrente semanal</SelectItem>
                <SelectItem value="date_specific">Data específica</SelectItem>
                <SelectItem value="date_range">Período de datas</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.scope === 'weekly' ? (
            <div className="space-y-2">
              <Label>Dias da semana</Label>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                {WEEKDAY_OPTIONS.map((day) => {
                  const checked = form.weekdays.includes(day.value);
                  return (
                    <label
                      key={day.value}
                      className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-[rgba(0,0,0,0.10)] bg-muted/15 px-2 py-2.5 text-sm font-medium transition-colors hover:bg-muted/35"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(nextChecked) => update(
                          'weekdays',
                          nextChecked
                            ? [...form.weekdays, day.value]
                            : form.weekdays.filter((weekday) => weekday !== day.value),
                        )}
                      />
                      {day.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className={form.scope === 'date_range' ? 'grid gap-3 sm:grid-cols-2' : ''}>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-rule-start-date">
                  {form.scope === 'date_specific' ? 'Data' : 'Data inicial'}
                </Label>
                <Input
                  id="schedule-rule-start-date"
                  type="date"
                  min={rule ? undefined : todayIso()}
                  value={form.start_date}
                  onChange={(event) => update('start_date', event.target.value)}
                  className={FIELD_CLASS}
                />
              </div>

              {form.scope === 'date_range' && (
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-rule-end-date">Data final</Label>
                  <Input
                    id="schedule-rule-end-date"
                    type="date"
                    min={form.start_date || (rule ? undefined : todayIso())}
                    value={form.end_date}
                    onChange={(event) => update('end_date', event.target.value)}
                    className={FIELD_CLASS}
                  />
                </div>
              )}
            </div>
          )}

          <div className="space-y-3 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-4">
            <div>
              <Label className="text-base font-semibold">Horários permitidos</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Apenas estes horários aparecerão para reserva online quando a regra estiver ativa.
              </p>
            </div>

            <div className="flex gap-2">
              <Input
                type="time"
                value={form.slotToAdd}
                onChange={(event) => update('slotToAdd', event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addSlot();
                  }
                }}
                className={FIELD_CLASS}
                aria-label="Horário para adicionar"
              />
              <Button type="button" variant="outline" onClick={addSlot} className="shrink-0">
                <Plus className="h-4 w-4" />
                Adicionar
              </Button>
            </div>

            {form.slots.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[rgba(0,0,0,0.14)] bg-white px-3 py-4 text-center text-xs text-muted-foreground">
                Nenhum horário adicionado.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="hidden grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
                  <span>Horário</span>
                  <span>Máx. pessoas por reserva</span>
                  <span>Máx. reservas</span>
                  <span />
                </div>
                {form.slots.map((slot) => (
                  <div
                    key={slot.time}
                    className="grid gap-2 rounded-lg border border-primary/10 bg-white p-2 sm:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_2rem] sm:items-center"
                  >
                    <span className="rounded-md bg-primary/5 px-2 py-2 text-center text-sm font-semibold text-primary">
                      {slot.time}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={slot.max_party_size_per_reservation}
                      onChange={(event) => updateSlot(slot.time, 'max_party_size_per_reservation', event.target.value)}
                      placeholder="Herda o padrão"
                      className={FIELD_CLASS}
                      aria-label={`Máximo de pessoas por reserva às ${slot.time}`}
                    />
                    <Input
                      type="number"
                      min={1}
                      max={500}
                      value={slot.max_reservations_per_slot}
                      onChange={(event) => updateSlot(slot.time, 'max_reservations_per_slot', event.target.value)}
                      placeholder="Sem limite"
                      className={FIELD_CLASS}
                      aria-label={`Máximo de reservas às ${slot.time}`}
                    />
                    <button
                      type="button"
                      onClick={() => update('slots', form.slots.filter((current) => current.time !== slot.time))}
                      className="flex h-8 w-8 items-center justify-center justify-self-end rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remover horário ${slot.time}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-dashed border-[rgba(0,0,0,0.14)] bg-white p-4">
            <div className="flex items-center gap-2">
              <WandSparkles className="h-4 w-4 text-primary" />
              <Label className="font-semibold">Gerar horários por intervalo</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Use como atalho e remova horários individuais depois, se necessário.
            </p>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem_auto]">
              <Input
                type="time"
                value={form.generatorStart}
                onChange={(event) => update('generatorStart', event.target.value)}
                className={FIELD_CLASS}
                aria-label="Início do gerador"
              />
              <Input
                type="time"
                value={form.generatorEnd}
                onChange={(event) => update('generatorEnd', event.target.value)}
                className={FIELD_CLASS}
                aria-label="Fim do gerador"
              />
              <Select value={form.generatorInterval} onValueChange={(value) => update('generatorInterval', value)}>
                <SelectTrigger className={FIELD_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" onClick={generateSlots}>
                Gerar
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3">
            <div>
              <Label htmlFor="schedule-rule-enabled" className="text-sm font-semibold">Regra ativa</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">Regras desativadas permanecem salvas, mas não alteram a agenda.</p>
            </div>
            <Switch id="schedule-rule-enabled" checked={form.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
          </div>

          {validationError && <p className="text-sm text-destructive">{validationError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={resetAndClose} disabled={saveMutation.isPending}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar regra
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RuleList({ title, description, rules, onEdit, onArchive }: {
  title: string;
  description: string;
  rules: ReservationScheduleRule[];
  onEdit: (rule: ReservationScheduleRule) => void;
  onArchive: (rule: ReservationScheduleRule) => void;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>

      {rules.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[rgba(0,0,0,0.12)] bg-muted/10 px-4 py-5 text-center text-sm text-muted-foreground">
          Nenhuma regra configurada nesta seção.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <article key={rule.id} className="rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{rule.name}</p>
                    <Badge variant={rule.enabled ? 'secondary' : 'outline'} className="px-2 py-0.5 text-[10px]">
                      {rule.enabled ? 'Ativa' : 'Desativada'}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">Prioridade {rule.priority}</span>
                    {rule.max_party_size_per_reservation != null && (
                      <span className="text-[11px] text-muted-foreground">
                        Máx. {rule.max_party_size_per_reservation} pessoas por reserva
                      </span>
                    )}
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {rule.scope === 'weekly' ? <CalendarClock className="h-3.5 w-3.5" /> : <CalendarRange className="h-3.5 w-3.5" />}
                    {getRulePeriodLabel(rule)}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {rule.reservation_schedule_rule_slots.map((slot) => (
                      <span key={slot.id} className="rounded-full border border-primary/10 bg-white px-2 py-1 text-[11px] font-semibold text-primary">
                        {slot.time.slice(0, 5)}
                        {slot.max_party_size_per_reservation != null && ` · até ${slot.max_party_size_per_reservation} pessoas`}
                        {slot.max_reservations_per_slot != null && ` · ${slot.max_reservations_per_slot} reservas`}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => onEdit(rule)} aria-label={`Editar ${rule.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onArchive(rule)} aria-label={`Arquivar ${rule.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function ReservationScheduleRulesCard({ companyId }: { companyId: string }) {
  const { data: rules = [], isLoading } = useReservationScheduleRules(companyId);
  const archiveMutation = useArchiveReservationScheduleRule();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ReservationScheduleRule | null>(null);
  const [archivingRule, setArchivingRule] = useState<ReservationScheduleRule | null>(null);

  const weeklyRules = useMemo(() => rules.filter((rule) => rule.scope === 'weekly'), [rules]);
  const exceptionRules = useMemo(() => rules.filter((rule) => rule.scope !== 'weekly'), [rules]);

  return (
    <>
      <Card className={CARD_CLASS}>
        <CardHeader className="space-y-0 pb-2">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div className={BADGE_CLASS}>
                <Clock className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <CardTitle className="text-lg">Horários de reserva online</CardTitle>
                <CardDescription>
                  Defina exatamente quais horários aparecem no modal público. Exceções por data têm precedência sobre a grade semanal.
                </CardDescription>
              </div>
            </div>
            <Button type="button" size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Nova regra
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 pt-3">
          {isLoading ? (
            <Skeleton className="h-44 w-full rounded-xl" />
          ) : (
            <>
              <RuleList
                title="Grade semanal"
                description="Regras recorrentes aplicadas pelos dias da semana selecionados."
                rules={weeklyRules}
                onEdit={setEditingRule}
                onArchive={setArchivingRule}
              />
              <RuleList
                title="Exceções"
                description="Datas específicas e períodos que substituem a grade semanal."
                rules={exceptionRules}
                onEdit={setEditingRule}
                onArchive={setArchivingRule}
              />
            </>
          )}
        </CardContent>
      </Card>

      <RuleDialog companyId={companyId} open={createOpen} onOpenChange={setCreateOpen} />

      {editingRule && (
        <RuleDialog
          key={editingRule.id}
          companyId={companyId}
          rule={editingRule}
          open={!!editingRule}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setEditingRule(null);
          }}
        />
      )}

      <AlertDialog open={!!archivingRule} onOpenChange={(nextOpen) => {
        if (!nextOpen) setArchivingRule(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Arquivar regra?</AlertDialogTitle>
            <AlertDialogDescription>
              A regra deixará de alterar os horários públicos. O histórico será preservado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={archiveMutation.isPending}
              onClick={() => {
                if (!archivingRule) return;
                archiveMutation.mutate({ id: archivingRule.id, companyId });
                setArchivingRule(null);
              }}
            >
              Arquivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
