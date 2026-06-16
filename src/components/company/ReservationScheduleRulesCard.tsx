import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CalendarClock,
  CalendarIcon,
  CalendarRange,
  Clock,
  Copy,
  CopyPlus,
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
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  useArchiveReservationScheduleRule,
  useReservationScheduleRules,
  useSaveReservationScheduleRule,
  type ReservationAvailabilityMode,
  type ReservationScheduleRule,
  type ReservationScheduleRuleBlock,
  type ReservationScheduleRuleScope,
} from '@/hooks/useReservationScheduleRules';
import {
  generateReservationScheduleSlots,
  normalizeReservationScheduleSlot,
  sortReservationScheduleSlotSettings,
} from '@/lib/reservation-schedule';
import { cn } from '@/lib/utils';

const CARD_CLASS = 'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]';
const BADGE_CLASS = 'flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary';
const FIELD_CLASS = 'h-10 min-w-0 w-full rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none';

const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Seg', longLabel: 'Segunda' },
  { value: 2, label: 'Ter', longLabel: 'Terça' },
  { value: 3, label: 'Qua', longLabel: 'Quarta' },
  { value: 4, label: 'Qui', longLabel: 'Quinta' },
  { value: 5, label: 'Sex', longLabel: 'Sexta' },
  { value: 6, label: 'Sáb', longLabel: 'Sábado' },
  { value: 0, label: 'Dom', longLabel: 'Domingo' },
];
const ALL_WEEKDAYS = WEEKDAY_OPTIONS.map((day) => day.value);

const INTERVAL_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hora' },
  { value: '90', label: '1h30' },
  { value: '120', label: '2 horas' },
];

const DURATION_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hora' },
  { value: '90', label: '1h30' },
  { value: '120', label: '2 horas' },
  { value: '150', label: '2h30' },
  { value: '180', label: '3 horas' },
];

interface SlotFormValue {
  time: string;
  duration_minutes: string;
  max_party_size_per_reservation: string;
  max_reservations_per_slot: string;
  max_guests_per_slot: string;
}

interface BlockFormValue {
  id?: string;
  clientId: string;
  name: string;
  weekdays: number[];
  availability_mode: ReservationAvailabilityMode;
  slots: SlotFormValue[];
  slotToAdd: string;
  generatorStart: string;
  generatorEnd: string;
  generatorInterval: string;
}

interface FormState {
  name: string;
  scope: ReservationScheduleRuleScope;
  start_date: string;
  end_date: string;
  publish_at: string;
  enabled: boolean;
  priority: string;
  blocks: BlockFormValue[];
}

function createClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getDefaultWeekdays(scope: ReservationScheduleRuleScope) {
  return scope === 'date_specific' ? [] : [...ALL_WEEKDAYS];
}

function getStoredWeekdaysForForm(scope: ReservationScheduleRuleScope, weekdays: number[] | null | undefined) {
  if (scope === 'date_specific') return [];
  return weekdays?.length ? weekdays : [...ALL_WEEKDAYS];
}

function createSlotFormValue(time: string): SlotFormValue {
  return {
    time,
    duration_minutes: '',
    max_party_size_per_reservation: '',
    max_reservations_per_slot: '',
    max_guests_per_slot: '',
  };
}

function createBlockFormValue(overrides: Partial<BlockFormValue> = {}): BlockFormValue {
  return {
    clientId: createClientId(),
    name: 'Padrão',
    weekdays: [],
    availability_mode: 'tables',
    slots: [],
    slotToAdd: '',
    generatorStart: '18:00',
    generatorEnd: '22:00',
    generatorInterval: '30',
    ...overrides,
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
  start_date: '',
  end_date: '',
  publish_at: '',
  enabled: true,
  priority: '100',
  blocks: [createBlockFormValue({ weekdays: getDefaultWeekdays('weekly') })],
};

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

function toDateInputValue(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function fromDateInputValue(value: string) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toDateValue(value: string | null | undefined) {
  if (!value) return undefined;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toDateLabel(value: string, placeholder = 'Selecionar data') {
  const date = toDateValue(value);
  return date ? format(date, 'dd/MM/yyyy', { locale: ptBR }) : placeholder;
}

function startOfLocalDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

interface RuleDateFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  min?: string;
  className?: string;
  description?: string;
}

function RuleDateField({
  id,
  label,
  value,
  onChange,
  placeholder = 'Selecionar data',
  min,
  className,
  description,
}: RuleDateFieldProps) {
  const [open, setOpen] = useState(false);
  const selectedDate = toDateValue(value);
  const minDate = toDateValue(min);

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className={cn(
              FIELD_CLASS,
              'justify-between px-3 text-left font-normal',
              !selectedDate && 'text-muted-foreground',
            )}
          >
            <span className="truncate">{toDateLabel(value, placeholder)}</span>
            <CalendarIcon className="h-4 w-4 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selectedDate}
            defaultMonth={selectedDate ?? minDate}
            onSelect={(date) => {
              if (!date) return;
              onChange(format(date, 'yyyy-MM-dd'));
              setOpen(false);
            }}
            disabled={minDate ? (date) => startOfLocalDay(date) < startOfLocalDay(minDate) : undefined}
            initialFocus
            className="pointer-events-auto p-3"
          />
        </PopoverContent>
      </Popover>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

interface RuleDateRangeFieldProps {
  id: string;
  label: string;
  startValue: string;
  endValue: string;
  onChange: (range: { start: string; end: string }) => void;
  placeholder?: string;
  min?: string;
  description?: string;
}

function RuleDateRangeField({
  id,
  label,
  startValue,
  endValue,
  onChange,
  placeholder = 'Selecionar período',
  min,
  description,
}: RuleDateRangeFieldProps) {
  const [open, setOpen] = useState(false);
  const startDate = toDateValue(startValue);
  const endDate = toDateValue(endValue);
  const minDate = toDateValue(min);
  const numberOfMonths = typeof window !== 'undefined' && window.innerWidth < 640 ? 1 : 2;
  const labelText = startDate && endDate
    ? `${format(startDate, 'dd/MM/yyyy', { locale: ptBR })} até ${format(endDate, 'dd/MM/yyyy', { locale: ptBR })}`
    : startDate
      ? format(startDate, 'dd/MM/yyyy', { locale: ptBR })
      : placeholder;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className={cn(
              FIELD_CLASS,
              'justify-between px-3 text-left font-normal',
              !startDate && 'text-muted-foreground',
            )}
          >
            <span className="truncate">{labelText}</span>
            <CalendarRange className="h-4 w-4 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={{ from: startDate, to: endDate }}
            defaultMonth={startDate ?? minDate}
            numberOfMonths={numberOfMonths}
            onSelect={(range) => {
              const nextStart = range?.from ? format(range.from, 'yyyy-MM-dd') : '';
              const nextEnd = range?.to ? format(range.to, 'yyyy-MM-dd') : '';
              onChange({ start: nextStart, end: nextEnd });
              if (nextStart && nextEnd) setOpen(false);
            }}
            disabled={minDate ? (date) => startOfLocalDay(date) < startOfLocalDay(minDate) : undefined}
            initialFocus
            className="pointer-events-auto p-3"
          />
        </PopoverContent>
      </Popover>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function getSlotsFromBlock(block: ReservationScheduleRuleBlock, rule: ReservationScheduleRule) {
  return sortReservationScheduleSlotSettings((block.reservation_schedule_rule_slots ?? []).map((slot) => ({
    time: slot.time,
    duration_minutes: formatOptionalNumberInput(slot.duration_minutes),
    max_party_size_per_reservation: formatOptionalNumberInput(
      slot.max_party_size_per_reservation ?? rule.max_party_size_per_reservation,
    ),
    max_reservations_per_slot: formatOptionalNumberInput(slot.max_reservations_per_slot),
    max_guests_per_slot: formatOptionalNumberInput(slot.max_guests_per_slot),
  })));
}

function getInitialBlocks(rule: ReservationScheduleRule): BlockFormValue[] {
  if (rule.reservation_schedule_rule_blocks?.length) {
    return rule.reservation_schedule_rule_blocks.map((block, index) => createBlockFormValue({
      id: block.id,
      name: block.name || `Bloco ${index + 1}`,
      weekdays: getStoredWeekdaysForForm(rule.scope, block.weekdays),
      availability_mode: block.availability_mode ?? rule.availability_mode ?? 'tables',
      slots: getSlotsFromBlock(block, rule),
    }));
  }

  return [createBlockFormValue({
    name: 'Padrão',
    weekdays: getStoredWeekdaysForForm(rule.scope, rule.weekdays),
    availability_mode: rule.availability_mode ?? 'tables',
    slots: sortReservationScheduleSlotSettings((rule.reservation_schedule_rule_slots ?? []).map((slot) => ({
      time: slot.time,
      duration_minutes: formatOptionalNumberInput(slot.duration_minutes),
      max_party_size_per_reservation: formatOptionalNumberInput(
        slot.max_party_size_per_reservation ?? rule.max_party_size_per_reservation,
      ),
      max_reservations_per_slot: formatOptionalNumberInput(slot.max_reservations_per_slot),
      max_guests_per_slot: formatOptionalNumberInput(slot.max_guests_per_slot),
    }))),
  })];
}

function getInitialForm(rule?: ReservationScheduleRule): FormState {
  if (!rule) return { ...EMPTY_FORM, blocks: [createBlockFormValue({ weekdays: getDefaultWeekdays('weekly') })] };

  return {
    name: rule.name,
    scope: rule.scope,
    start_date: rule.start_date ?? '',
    end_date: rule.end_date ?? '',
    publish_at: toDateInputValue(rule.publish_at),
    enabled: rule.enabled,
    priority: String(rule.priority),
    blocks: getInitialBlocks(rule),
  };
}

function formatDate(date: string) {
  return format(new Date(`${date}T12:00:00`), "dd 'de' MMM 'de' yyyy", { locale: ptBR });
}

function getWeekdayLabel(weekdays: number[] | null | undefined, emptyLabel = 'Nenhum dia') {
  const selected = WEEKDAY_OPTIONS.filter((day) => weekdays?.includes(day.value));
  if (selected.length === WEEKDAY_OPTIONS.length) return 'Todos os dias';
  return selected.length > 0 ? selected.map((day) => day.longLabel).join(', ') : emptyLabel;
}

function getRuleScopeLabel(scope: ReservationScheduleRuleScope) {
  if (scope === 'weekly') return 'Semanal';
  if (scope === 'date_specific') return 'Data específica';
  return 'Período';
}

function getRulePeriodLabel(rule: ReservationScheduleRule) {
  if (rule.scope === 'weekly') return 'Recorrente semanal';
  if (rule.scope === 'date_specific') return rule.start_date ? formatDate(rule.start_date) : '';
  if (!rule.start_date || !rule.end_date) return '';
  return `${formatDate(rule.start_date)} até ${formatDate(rule.end_date)}`;
}

function getPublishDate(rule: Pick<ReservationScheduleRule, 'publish_at'>) {
  if (!rule.publish_at) return null;
  const publishDate = new Date(rule.publish_at);
  return Number.isNaN(publishDate.getTime()) ? null : publishDate;
}

function isRuleScheduled(rule: ReservationScheduleRule) {
  const publishDate = getPublishDate(rule);
  return rule.enabled && !!publishDate && publishDate.getTime() > Date.now();
}

function getRuleStatusLabel(rule: ReservationScheduleRule) {
  if (!rule.enabled) return 'Rascunho';
  return isRuleScheduled(rule) ? 'Programada' : 'Ativa';
}

function getRulePublishLabel(rule: ReservationScheduleRule) {
  const publishDate = getPublishDate(rule);
  if (!publishDate) return 'Entrada imediata';
  return `Entrada em vigor em ${format(publishDate, 'dd/MM/yyyy', { locale: ptBR })}`;
}

function getAvailabilityModeLabel(mode: ReservationAvailabilityMode | null | undefined) {
  return mode === 'capacity' ? 'Por capacidade' : 'Por mesas';
}

function getBlockDaysLabel(scope: ReservationScheduleRuleScope) {
  return scope === 'date_range' ? 'Dias dentro do período' : 'Dias da semana';
}

function getBlocksDescription(scope: ReservationScheduleRuleScope) {
  if (scope === 'date_specific') return 'A data da regra usa os horários do bloco.';
  if (scope === 'date_range') return 'Use blocos para diferenciar dias e horários dentro do período.';
  return 'Use blocos para separar dias da semana com horários diferentes.';
}

function formatMinutesLabel(minutes: number | null | undefined) {
  if (!minutes) return '';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

function toNumberOrNull(value: string) {
  return value ? Number(value) : null;
}

function buildRuleDraft(form: FormState, companyId: string, ruleId?: string) {
  return {
    id: ruleId,
    company_id: companyId,
    name: form.name,
    scope: form.scope,
    start_date: form.scope === 'weekly' ? null : form.start_date,
    end_date: form.scope === 'date_range' ? form.end_date : form.start_date,
    enabled: form.enabled,
    priority: Number(form.priority),
    publish_at: fromDateInputValue(form.publish_at),
    blocks: form.blocks.map((block) => ({
      name: block.name,
      weekdays: form.scope === 'date_specific' ? null : block.weekdays,
      availability_mode: block.availability_mode,
      slots: block.slots.map((slot) => ({
        time: slot.time,
        duration_minutes: toNumberOrNull(slot.duration_minutes),
        max_party_size_per_reservation: toNumberOrNull(slot.max_party_size_per_reservation),
        max_reservations_per_slot: toNumberOrNull(slot.max_reservations_per_slot),
        max_guests_per_slot: toNumberOrNull(slot.max_guests_per_slot),
      })),
    })),
  };
}

function validateForm(form: FormState) {
  if (!form.name.trim()) return 'Informe o nome da regra.';
  if (form.scope !== 'weekly' && !form.start_date) return 'Informe a data inicial.';
  if (form.scope === 'date_range' && !form.end_date) return 'Informe a data final.';
  if (form.scope === 'date_range' && form.end_date < form.start_date) return 'A data final deve ser igual ou posterior à inicial.';
  if (!Number.isInteger(Number(form.priority))) return 'Informe uma prioridade válida.';
  if (form.blocks.length === 0) return 'Adicione pelo menos um bloco.';
  if (form.scope === 'date_specific' && form.blocks.length > 1) return 'Use um único bloco em regras de data específica.';

  const usedWeekdays = new Set<number>();
  for (const block of form.blocks) {
    if (!block.name.trim()) return 'Informe o nome de todos os blocos.';
    if (form.scope !== 'date_specific' && block.weekdays.length === 0) {
      return 'Selecione os dias da semana de todos os blocos.';
    }

    if (form.scope !== 'date_specific') {
      for (const weekday of block.weekdays) {
        if (usedWeekdays.has(weekday)) return 'Não repita o mesmo dia da semana em mais de um bloco.';
        usedWeekdays.add(weekday);
      }
    }

    if (block.slots.length === 0) return `Adicione pelo menos um horário em "${block.name}".`;
    if (block.slots.some((slot) => (
      slot.duration_minutes
      && (
        !Number.isInteger(Number(slot.duration_minutes))
        || Number(slot.duration_minutes) < 1
        || Number(slot.duration_minutes) > 1440
      )
    ))) return 'A duração de cada horário deve estar entre 1 e 1440 minutos.';
    if (block.slots.some((slot) => (
      slot.max_party_size_per_reservation
      && (
        !Number.isInteger(Number(slot.max_party_size_per_reservation))
        || Number(slot.max_party_size_per_reservation) < 1
        || Number(slot.max_party_size_per_reservation) > 20
      )
    ))) return 'O máximo por reserva de cada horário deve estar entre 1 e 20.';
    if (block.slots.some((slot) => (
      slot.max_reservations_per_slot
      && (
        !Number.isInteger(Number(slot.max_reservations_per_slot))
        || Number(slot.max_reservations_per_slot) < 1
        || Number(slot.max_reservations_per_slot) > 500
      )
    ))) return 'O máximo de reservas de cada horário deve estar entre 1 e 500.';
    if (block.slots.some((slot) => (
      slot.max_guests_per_slot
      && (
        !Number.isInteger(Number(slot.max_guests_per_slot))
        || Number(slot.max_guests_per_slot) < 1
        || Number(slot.max_guests_per_slot) > 10000
      )
    ))) return 'A capacidade total de cada horário deve estar entre 1 e 10000 pessoas.';
    if (block.availability_mode === 'capacity' && block.slots.some((slot) => !slot.max_guests_per_slot)) {
      return `Informe a capacidade total de todos os horários em "${block.name}".`;
    }
  }

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
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const saveMutation = useSaveReservationScheduleRule();
  const activeBlock = form.blocks.find((block) => block.clientId === activeBlockId) ?? form.blocks[0] ?? null;
  const activeBlockIndex = activeBlock
    ? form.blocks.findIndex((block) => block.clientId === activeBlock.clientId)
    : -1;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setValidationError(null);
  }

  function handleScopeChange(scope: ReservationScheduleRuleScope) {
    setForm((current) => ({
      ...current,
      scope,
      blocks: scope === 'date_specific'
        ? current.blocks.slice(0, 1).map((block) => ({ ...block, weekdays: [] }))
        : current.blocks.map((block) => ({
            ...block,
            weekdays: block.weekdays.length > 0 || current.blocks.length > 1
              ? block.weekdays
              : getDefaultWeekdays(scope),
          })),
    }));
    setActiveBlockId(null);
    setValidationError(null);
  }

  function updateBlock(clientId: string, updater: (block: BlockFormValue) => BlockFormValue) {
    setForm((current) => ({
      ...current,
      blocks: current.blocks.map((block) => (block.clientId === clientId ? updater(block) : block)),
    }));
    setValidationError(null);
  }

  function resetAndClose() {
    setForm(getInitialForm(rule));
    setActiveBlockId(null);
    setValidationError(null);
    onOpenChange(false);
  }

  function addBlock() {
    const newBlock = createBlockFormValue({ name: `Bloco ${form.blocks.length + 1}` });
    setForm((current) => ({
      ...current,
      blocks: [...current.blocks, newBlock],
    }));
    setActiveBlockId(newBlock.clientId);
    setValidationError(null);
  }

  function duplicateBlock(source: BlockFormValue) {
    const newBlock = createBlockFormValue({
      name: `Cópia de ${source.name}`,
      weekdays: [],
      availability_mode: source.availability_mode,
      slots: source.slots.map((slot) => ({ ...slot })),
    });
    setForm((current) => ({
      ...current,
      blocks: [...current.blocks, newBlock],
    }));
    setActiveBlockId(newBlock.clientId);
    setValidationError(null);
  }

  function removeBlock(clientId: string) {
    setForm((current) => ({
      ...current,
      blocks: current.blocks.filter((block) => block.clientId !== clientId),
    }));
    if (activeBlockId === clientId) setActiveBlockId(null);
    setValidationError(null);
  }

  function addSlot(block: BlockFormValue) {
    const slot = normalizeReservationScheduleSlot(block.slotToAdd);
    if (!slot) {
      setValidationError('Informe um horário válido.');
      return;
    }

    updateBlock(block.clientId, (current) => ({
      ...current,
      slots: mergeSlots(current.slots, [slot]),
      slotToAdd: '',
    }));
  }

  function generateSlots(block: BlockFormValue) {
    const slots = generateReservationScheduleSlots(
      block.generatorStart,
      block.generatorEnd,
      Number(block.generatorInterval),
    );

    if (slots.length === 0) {
      setValidationError('Confira o início, o fim e o intervalo usados para gerar horários.');
      return;
    }

    updateBlock(block.clientId, (current) => ({
      ...current,
      slots: mergeSlots(current.slots, slots),
    }));
  }

  function updateSlot(block: BlockFormValue, time: string, key: keyof Omit<SlotFormValue, 'time'>, value: string) {
    updateBlock(block.clientId, (current) => ({
      ...current,
      slots: current.slots.map((slot) => (
        slot.time === time ? { ...slot, [key]: value } : slot
      )),
    }));
  }

  function copySlotSettingsToAll(block: BlockFormValue, source: SlotFormValue) {
    updateBlock(block.clientId, (current) => ({
      ...current,
      slots: current.slots.map((slot) => (
        slot.time === source.time
          ? slot
          : {
              ...slot,
              duration_minutes: source.duration_minutes,
              max_party_size_per_reservation: source.max_party_size_per_reservation,
              max_reservations_per_slot: source.max_reservations_per_slot,
              max_guests_per_slot: source.max_guests_per_slot,
            }
      )),
    }));
  }

  async function handleSubmit() {
    const error = validateForm(form);
    if (error) {
      setValidationError(error);
      return;
    }

    try {
      await saveMutation.mutateAsync(buildRuleDraft(form, companyId, rule?.id));
      resetAndClose();
    } catch {
      // The mutation already exposes the server message in a toast.
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : resetAndClose())}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] overflow-y-auto overflow-x-hidden sm:w-[calc(100vw-3rem)] sm:max-w-[88rem]">
        <DialogHeader>
          <DialogTitle>{rule ? 'Editar regra de disponibilidade' : 'Nova regra de disponibilidade'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem_9rem]">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-rule-name">Nome</Label>
              <Input
                id="schedule-rule-name"
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="Ex.: Junho, alta temporada, Dia dos Namorados"
                className={FIELD_CLASS}
              />
            </div>

            <RuleDateField
              id="schedule-rule-publish-at"
              label="Entrada em vigor"
              value={form.publish_at}
              onChange={(value) => update('publish_at', value)}
              placeholder="Imediata"
              description="Em branco, entra em vigor imediatamente. Com data futura, fica programada."
            />

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
          </div>

          <div className="flex items-center justify-between rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3">
            <div>
              <Label htmlFor="schedule-rule-enabled" className="text-sm font-semibold">Regra ativa</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {form.enabled
                  ? form.publish_at
                    ? `A regra só altera a agenda a partir de ${toDateLabel(form.publish_at)}.`
                    : 'A regra altera a agenda assim que for salva, respeitando tipo, prioridade e período.'
                  : 'Regras desativadas ficam salvas como rascunho e não alteram a agenda.'}
              </p>
            </div>
            <Switch id="schedule-rule-enabled" checked={form.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
          </div>

          <div className="space-y-1.5">
            <Label>Tipo de regra</Label>
            <Select value={form.scope} onValueChange={(value) => handleScopeChange(value as ReservationScheduleRuleScope)}>
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

          {form.scope !== 'weekly' && (
            <>
              {form.scope === 'date_range' ? (
                <RuleDateRangeField
                  id="schedule-rule-date-range"
                  label="Período em que a regra vale"
                  startValue={form.start_date}
                  endValue={form.end_date}
                  onChange={({ start, end }) => {
                    setForm((current) => ({
                      ...current,
                      start_date: start,
                      end_date: end,
                    }));
                    setValidationError(null);
                  }}
                  placeholder="Selecionar período"
                  min={rule ? undefined : todayIso()}
                  description="Define a data inicial e final desta regra. Dentro desse período, os blocos controlam os dias e horários."
                />
              ) : (
                <RuleDateField
                  id="schedule-rule-start-date"
                  label="Data"
                  value={form.start_date}
                  onChange={(value) => update('start_date', value)}
                  placeholder="Selecionar data"
                  min={rule ? undefined : todayIso()}
                />
              )}
            </>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-base font-semibold">Blocos de disponibilidade</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {getBlocksDescription(form.scope)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addBlock}
                disabled={form.scope === 'date_specific' && form.blocks.length >= 1}
              >
                <Plus className="h-4 w-4" />
                Adicionar bloco
              </Button>
            </div>

            <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
              <div className="rounded-lg border border-[rgba(0,0,0,0.08)] bg-muted/10 p-2">
                <div className="mb-2 flex items-center justify-between px-2 py-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Blocos
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {form.blocks.length}
                  </span>
                </div>
                <div className="space-y-1.5">
              {form.blocks.map((block, blockIndex) => {
                const selected = activeBlock?.clientId === block.clientId;
                const slotCount = block.slots.length;
                const weekdayLabel = form.scope === 'date_specific' ? 'Data da regra' : getWeekdayLabel(block.weekdays);

                return (
                  <button
                    key={block.clientId}
                    type="button"
                    aria-expanded={selected}
                    onClick={() => setActiveBlockId(block.clientId)}
                    className={cn(
                      'group relative w-full overflow-hidden rounded-lg border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-primary/35 bg-white shadow-[0_1px_10px_rgba(197,126,52,0.12)]'
                        : 'border-transparent bg-transparent hover:border-[rgba(0,0,0,0.08)] hover:bg-white'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute inset-y-2 left-0 w-1 rounded-r-full transition-colors',
                        selected ? 'bg-primary' : 'bg-transparent group-hover:bg-primary/30'
                      )}
                    />
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Bloco {blockIndex + 1}
                        </span>
                        <p className="mt-0.5 truncate text-sm font-semibold text-foreground">
                          {block.name || `Bloco ${blockIndex + 1}`}
                        </p>
                      </div>
                      <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {slotCount}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                      <Badge variant="outline" className="h-5 rounded-md border-[rgba(0,0,0,0.08)] px-1.5 text-[10px]">
                        {getAvailabilityModeLabel(block.availability_mode)}
                      </Badge>
                      <span className="min-w-0 truncate rounded-md bg-muted/50 px-1.5 py-1 text-muted-foreground">
                        {weekdayLabel}
                      </span>
                    </div>
                  </button>
                );
              })}
                </div>
              </div>

            {activeBlock && (
              <div key={activeBlock.clientId} className="min-w-0 overflow-hidden rounded-lg border border-[rgba(0,0,0,0.08)] bg-white">
                <div className="grid gap-3 border-b border-[rgba(0,0,0,0.08)] bg-muted/10 p-4 lg:grid-cols-[minmax(0,1fr)_12rem_4.75rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor={`schedule-block-name-${activeBlock.clientId}`}>Nome do bloco</Label>
                    <Input
                      id={`schedule-block-name-${activeBlock.clientId}`}
                      value={activeBlock.name}
                      onChange={(event) => updateBlock(activeBlock.clientId, (current) => ({ ...current, name: event.target.value }))}
                      placeholder={`Bloco ${activeBlockIndex + 1}`}
                      className={FIELD_CLASS}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Disponibilidade</Label>
                    <Select
                      value={activeBlock.availability_mode}
                      onValueChange={(value) => updateBlock(activeBlock.clientId, (current) => ({
                        ...current,
                        availability_mode: value as ReservationAvailabilityMode,
                      }))}
                    >
                      <SelectTrigger className={FIELD_CLASS}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tables">Por mesas</SelectItem>
                        <SelectItem value="capacity">Por capacidade</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-end justify-end gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9"
                      onClick={() => duplicateBlock(activeBlock)}
                      disabled={form.scope === 'date_specific'}
                      aria-label={`Duplicar bloco ${activeBlock.name}`}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9 text-destructive hover:text-destructive"
                      onClick={() => removeBlock(activeBlock.clientId)}
                      disabled={form.blocks.length === 1}
                      aria-label={`Remover bloco ${activeBlock.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {form.scope !== 'date_specific' && (
                  <div className="space-y-2 border-b border-[rgba(0,0,0,0.08)] p-4">
                    <div>
                      <Label>{getBlockDaysLabel(form.scope)}</Label>
                      {form.scope === 'date_range' && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          O bloco vale apenas nas datas do período que caem nos dias marcados.
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                      {WEEKDAY_OPTIONS.map((day) => {
                        const checked = activeBlock.weekdays.includes(day.value);
                        return (
                          <label
                            key={day.value}
                            className={cn(
                              'flex cursor-pointer items-center justify-center gap-2 rounded-md border px-2 py-2 text-sm font-medium transition-colors',
                              checked
                                ? 'border-primary/35 bg-primary/10 text-foreground'
                                : 'border-[rgba(0,0,0,0.10)] bg-white text-muted-foreground hover:bg-muted/35 hover:text-foreground'
                            )}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(nextChecked) => updateBlock(activeBlock.clientId, (current) => ({
                                ...current,
                                weekdays: nextChecked
                                  ? [...current.weekdays, day.value]
                                  : current.weekdays.filter((weekday) => weekday !== day.value),
                              }))}
                            />
                            {day.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="space-y-3 p-4">
                  <div>
                    <Label className="text-sm font-semibold">Horários do bloco</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Capacidade total limita pessoas simultâneas; em mesas, deixe vazio para usar o limite global. A duração é definida por horário.
                    </p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <Input
                      type="time"
                      value={activeBlock.slotToAdd}
                      onChange={(event) => updateBlock(activeBlock.clientId, (current) => ({ ...current, slotToAdd: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addSlot(activeBlock);
                        }
                      }}
                      className={FIELD_CLASS}
                      aria-label={`Horário para adicionar no bloco ${activeBlock.name}`}
                    />
                    <Button type="button" variant="outline" onClick={() => addSlot(activeBlock)} className="shrink-0">
                      <Plus className="h-4 w-4" />
                      Adicionar
                    </Button>
                  </div>

                  {activeBlock.slots.length === 0 ? (
                    <p className="rounded-md border border-dashed border-[rgba(0,0,0,0.14)] bg-muted/10 px-3 py-5 text-center text-xs text-muted-foreground">
                      Nenhum horário adicionado.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div className="hidden gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_4.75rem]">
                        <span>Horário</span>
                        <span>Duração</span>
                        <span>Máx. pessoas por reserva</span>
                        <span>Máx. reservas</span>
                        <span>Capacidade total</span>
                        <span>Ações</span>
                      </div>
                      {activeBlock.slots.map((slot) => (
                        <div
                          key={slot.time}
                          className="grid gap-2 border-t border-[rgba(0,0,0,0.08)] py-2 sm:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_4.75rem] sm:items-center"
                        >
                          <div className="flex items-center justify-between gap-1 rounded-md bg-primary/5 px-2 py-1.5 text-sm font-semibold text-primary">
                            <span>{slot.time}</span>
                            <button
                              type="button"
                              onClick={() => copySlotSettingsToAll(activeBlock, slot)}
                              className="flex h-6 w-6 items-center justify-center rounded text-primary/70 hover:bg-primary/10 hover:text-primary"
                              aria-label={`Replicar configurações do horário ${slot.time} para os demais`}
                              title="Replicar valores para os demais horários do bloco"
                            >
                              <CopyPlus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <Select
                            value={slot.duration_minutes || 'inherit'}
                            onValueChange={(value) => updateSlot(activeBlock, slot.time, 'duration_minutes', value === 'inherit' ? '' : value)}
                          >
                            <SelectTrigger className={FIELD_CLASS} aria-label={`Duração do horário ${slot.time}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="inherit">Usar empresa</SelectItem>
                              {DURATION_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            type="number"
                            min={1}
                            max={20}
                            value={slot.max_party_size_per_reservation}
                            onChange={(event) => updateSlot(activeBlock, slot.time, 'max_party_size_per_reservation', event.target.value)}
                            placeholder="Sem limite"
                            className={FIELD_CLASS}
                            aria-label={`Máximo de pessoas por reserva às ${slot.time}`}
                          />
                          <Input
                            type="number"
                            min={1}
                            max={500}
                            value={slot.max_reservations_per_slot}
                            onChange={(event) => updateSlot(activeBlock, slot.time, 'max_reservations_per_slot', event.target.value)}
                            placeholder="Sem limite"
                            className={FIELD_CLASS}
                            aria-label={`Máximo de reservas às ${slot.time}`}
                          />
                          <Input
                            type="number"
                            min={1}
                            max={10000}
                            value={slot.max_guests_per_slot}
                            onChange={(event) => updateSlot(activeBlock, slot.time, 'max_guests_per_slot', event.target.value)}
                            placeholder={activeBlock.availability_mode === 'capacity' ? 'Obrigatória' : 'Usar global'}
                            className={FIELD_CLASS}
                            aria-label={`Capacidade total às ${slot.time}`}
                          />
                          <button
                            type="button"
                            onClick={() => updateBlock(activeBlock.clientId, (current) => ({
                              ...current,
                              slots: current.slots.filter((currentSlot) => currentSlot.time !== slot.time),
                            }))}
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

                <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] bg-muted/10 p-4">
                  <div className="flex items-center gap-2">
                    <WandSparkles className="h-4 w-4 text-primary" />
                    <Label className="font-semibold">Gerar horários por intervalo</Label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem_auto]">
                    <Input
                      type="time"
                      value={activeBlock.generatorStart}
                      onChange={(event) => updateBlock(activeBlock.clientId, (current) => ({ ...current, generatorStart: event.target.value }))}
                      className={FIELD_CLASS}
                      aria-label="Início do gerador"
                    />
                    <Input
                      type="time"
                      value={activeBlock.generatorEnd}
                      onChange={(event) => updateBlock(activeBlock.clientId, (current) => ({ ...current, generatorEnd: event.target.value }))}
                      className={FIELD_CLASS}
                      aria-label="Fim do gerador"
                    />
                    <Select
                      value={activeBlock.generatorInterval}
                      onValueChange={(value) => updateBlock(activeBlock.clientId, (current) => ({ ...current, generatorInterval: value }))}
                    >
                      <SelectTrigger className={FIELD_CLASS}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INTERVAL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button type="button" variant="outline" onClick={() => generateSlots(activeBlock)}>
                      Gerar
                    </Button>
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>

          {validationError && <p className="text-sm text-destructive">{validationError}</p>}
        </div>

        <DialogFooter className="sticky bottom-0 z-10 mt-2 gap-2 border-t border-[rgba(0,0,0,0.08)] bg-white/95 py-4 backdrop-blur sm:space-x-0 [&>button]:w-full sm:[&>button]:w-auto">
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

function RuleList({ title, description, rules, onEdit, onDuplicate, onArchive }: {
  title: string;
  description: string;
  rules: ReservationScheduleRule[];
  onEdit: (rule: ReservationScheduleRule) => void;
  onDuplicate: (rule: ReservationScheduleRule) => void;
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
          {rules.map((rule) => {
            const blocks = rule.reservation_schedule_rule_blocks?.length
              ? rule.reservation_schedule_rule_blocks
              : getInitialBlocks(rule).map((block, index) => ({
                  id: block.clientId,
                  rule_id: rule.id,
                  name: block.name,
                  weekdays: block.weekdays,
                  availability_mode: block.availability_mode,
                  sort_order: (index + 1) * 10,
                  created_at: rule.created_at,
                  updated_at: rule.updated_at,
                  reservation_schedule_rule_slots: block.slots.map((slot, slotIndex) => ({
                    id: `${block.clientId}-${slot.time}`,
                    rule_id: rule.id,
                    block_id: block.clientId,
                    time: slot.time,
                    sort_order: (slotIndex + 1) * 10,
                    duration_minutes: toNumberOrNull(slot.duration_minutes),
                    max_party_size_per_reservation: toNumberOrNull(slot.max_party_size_per_reservation),
                    max_reservations_per_slot: toNumberOrNull(slot.max_reservations_per_slot),
                    max_guests_per_slot: toNumberOrNull(slot.max_guests_per_slot),
                    created_at: rule.created_at,
                  })),
                }));

            return (
              <article key={rule.id} className="rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{rule.name}</p>
                      <Badge
                        variant={rule.enabled && !isRuleScheduled(rule) ? 'secondary' : 'outline'}
                        className={cn(
                          'px-2 py-0.5 text-[10px]',
                          isRuleScheduled(rule) && 'border-primary/30 bg-primary/5 text-primary',
                        )}
                      >
                        {getRuleStatusLabel(rule)}
                      </Badge>
                      <Badge variant="outline" className="px-2 py-0.5 text-[10px]">
                        {getRuleScopeLabel(rule.scope)}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">Prioridade {rule.priority}</span>
                    </div>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {rule.scope === 'weekly' ? <CalendarClock className="h-3.5 w-3.5" /> : <CalendarRange className="h-3.5 w-3.5" />}
                      {getRulePeriodLabel(rule)}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {getRulePublishLabel(rule)}
                    </p>
                    <div className="space-y-2">
                      {blocks.map((block) => (
                        <div key={block.id} className="rounded-lg border border-primary/10 bg-white px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-foreground">{block.name}</span>
                            {rule.scope !== 'date_specific' && (
                              <span className="text-[11px] text-muted-foreground">{getWeekdayLabel(block.weekdays, 'Todos os dias')}</span>
                            )}
                            <Badge variant="outline" className="px-2 py-0.5 text-[10px]">
                              {getAvailabilityModeLabel(block.availability_mode)}
                            </Badge>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {block.reservation_schedule_rule_slots.map((slot) => (
                              <span key={slot.id} className="rounded-full border border-primary/10 bg-muted/10 px-2 py-1 text-[11px] font-semibold text-primary">
                                {slot.time.slice(0, 5)}
                                {slot.duration_minutes != null && ` · ${formatMinutesLabel(slot.duration_minutes)}`}
                                {slot.max_party_size_per_reservation != null && ` · até ${slot.max_party_size_per_reservation} pessoas`}
                                {slot.max_reservations_per_slot != null && ` · ${slot.max_reservations_per_slot} reservas`}
                                {slot.max_guests_per_slot != null && ` · cap. ${slot.max_guests_per_slot}`}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => onEdit(rule)} aria-label={`Editar ${rule.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => onDuplicate(rule)} aria-label={`Duplicar ${rule.name}`}>
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onArchive(rule)} aria-label={`Arquivar ${rule.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ReservationScheduleRulesCard({ companyId }: { companyId: string }) {
  const { data: rules = [], isLoading } = useReservationScheduleRules(companyId);
  const saveMutation = useSaveReservationScheduleRule();
  const archiveMutation = useArchiveReservationScheduleRule();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ReservationScheduleRule | null>(null);
  const [archivingRule, setArchivingRule] = useState<ReservationScheduleRule | null>(null);

  const weeklyRules = useMemo(() => rules.filter((rule) => rule.scope === 'weekly'), [rules]);
  const exceptionRules = useMemo(() => rules.filter((rule) => rule.scope !== 'weekly'), [rules]);

  async function duplicateRule(rule: ReservationScheduleRule) {
    const duplicateForm = getInitialForm(rule);
    duplicateForm.name = `Cópia de ${rule.name}`;
    duplicateForm.enabled = false;
    duplicateForm.publish_at = '';

    const error = validateForm(duplicateForm);
    if (error) return;

    try {
      await saveMutation.mutateAsync(buildRuleDraft(duplicateForm, companyId));
    } catch {
      // The mutation already exposes the server message in a toast.
    }
  }

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
                <CardTitle className="text-lg">Disponibilidade de reservas</CardTitle>
                <CardDescription>
                  Crie regras por período, data ou semana. Dentro de cada regra, use blocos para dias e horários diferentes.
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
                description="Regras recorrentes aplicadas por blocos de dias da semana."
                rules={weeklyRules}
                onEdit={setEditingRule}
                onDuplicate={duplicateRule}
                onArchive={setArchivingRule}
              />
              <RuleList
                title="Exceções"
                description="Datas específicas e períodos que substituem a grade semanal."
                rules={exceptionRules}
                onEdit={setEditingRule}
                onDuplicate={duplicateRule}
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
