// Resumos curtos usados nos cards de disponibilidade. Quando todos os horarios
// de um bloco compartilham os mesmos limites, o card mostra o limite uma vez na
// linha de contexto em vez de repeti-lo em cada chip de horario.

export interface ScheduleSlotLimits {
  duration_minutes?: number | null;
  max_party_size_per_reservation?: number | null;
  max_reservations_per_slot?: number | null;
  max_guests_per_slot?: number | null;
}

const SHORT_WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
// A semana comeca na segunda, como no seletor de dias do formulario.
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function formatScheduleDurationLabel(minutes: number | null | undefined) {
  if (!minutes) return '';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

export function formatShortWeekdaysLabel(weekdays: number[] | null | undefined, emptyLabel = 'Todos os dias') {
  const selected = WEEKDAY_DISPLAY_ORDER.filter((day) => weekdays?.includes(day));
  if (selected.length === 0) return emptyLabel;
  if (selected.length === WEEKDAY_DISPLAY_ORDER.length) return 'Todos os dias';
  return selected.map((day) => SHORT_WEEKDAY_LABELS[day]).join(', ');
}

function normalizeLimit(value: number | null | undefined) {
  return value ?? null;
}

function hasSameLimits(left: ScheduleSlotLimits, right: ScheduleSlotLimits) {
  return normalizeLimit(left.duration_minutes) === normalizeLimit(right.duration_minutes)
    && normalizeLimit(left.max_party_size_per_reservation) === normalizeLimit(right.max_party_size_per_reservation)
    && normalizeLimit(left.max_reservations_per_slot) === normalizeLimit(right.max_reservations_per_slot)
    && normalizeLimit(left.max_guests_per_slot) === normalizeLimit(right.max_guests_per_slot);
}

function formatLimitParts(slot: ScheduleSlotLimits) {
  const parts: string[] = [];
  if (slot.duration_minutes) parts.push(formatScheduleDurationLabel(slot.duration_minutes));
  if (slot.max_party_size_per_reservation) parts.push(`até ${slot.max_party_size_per_reservation} pessoas`);
  if (slot.max_reservations_per_slot) {
    parts.push(`${slot.max_reservations_per_slot} ${slot.max_reservations_per_slot === 1 ? 'reserva' : 'reservas'} por horário`);
  }
  if (slot.max_guests_per_slot) parts.push(`${slot.max_guests_per_slot} lugares por horário`);
  return parts;
}

// Null quando nao ha limite algum ou quando os horarios divergem: nesse caso o
// detalhe volta a aparecer chip a chip.
export function summarizeScheduleSlotLimits(slots: readonly ScheduleSlotLimits[]) {
  if (slots.length === 0) return null;

  const [first, ...rest] = slots;
  if (!rest.every((slot) => hasSameLimits(first, slot))) return null;

  const parts = formatLimitParts(first);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatScheduleSlotLimitsDetail(slot: ScheduleSlotLimits) {
  const parts = formatLimitParts(slot);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}
