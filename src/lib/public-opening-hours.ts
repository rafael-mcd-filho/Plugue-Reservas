import { addDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { findOpeningHoursForDayIndex, getDayIndexFromName } from '@/lib/openingHours';
import type { PublicReservationSchedule } from '@/lib/public-reservation-schedule';

export interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

export type OpeningSchedules = ReadonlyMap<string, PublicReservationSchedule>;

// Inclui ontem para manter o status correto em jornadas que passam da meia-noite.
export function getOpeningScheduleDates(now: Date): string[] {
  return Array.from({ length: 10 }, (_, index) => format(addDays(now, index - 1), 'yyyy-MM-dd'));
}

export function resolveOpeningHourForDate(
  hours: OpeningHour[],
  date: Date,
  schedules: OpeningSchedules,
): OpeningHour | null {
  const hour = findOpeningHoursForDayIndex(hours, date.getDay());
  if (!hour) return null;
  const schedule = schedules.get(format(date, 'yyyy-MM-dd'));
  if (!schedule || schedule.source === 'default') return hour;

  // As regras decidem se o dia abre. Os horarios continuam vindo da empresa,
  // inclusive os que ficam salvos quando o dia semanal esta marcado fechado.
  return { ...hour, closed: schedule.source === 'blocked' || schedule.slots.length === 0 };
}

const FULL_DAY_NAME_BY_ABBR: Record<string, string> = {
  Seg: 'Segunda',
  Ter: 'Terça',
  Qua: 'Quarta',
  Qui: 'Quinta',
  Sex: 'Sexta',
  'Sáb': 'Sábado',
  Dom: 'Domingo',
};

interface OpeningHourGroup {
  label: string;
  closed: boolean;
  open: string;
  close: string;
  isToday: boolean;
}

interface OpeningSlot {
  day: string;
  open: string;
  close: string;
  start: Date;
  end: Date;
}

interface OpeningStatus {
  title: string;
  description: string | null;
  variant: 'open' | 'closed';
}

function parseTimeToMinutes(time?: string | null) {
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function isSameCalendarDate(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function buildOpeningSlots(hours: OpeningHour[], now: Date, schedules: OpeningSchedules) {
  const slots: OpeningSlot[] = [];
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  for (let offset = -1; offset <= 8; offset += 1) {
    const dayStart = new Date(todayStart);
    dayStart.setDate(todayStart.getDate() + offset);

    const hour = resolveOpeningHourForDate(hours, dayStart, schedules);
    if (!hour || hour.closed) continue;

    const openMinutes = parseTimeToMinutes(hour.open);
    const closeMinutes = parseTimeToMinutes(hour.close);
    if (openMinutes === null || closeMinutes === null) continue;

    const closeOffset = closeMinutes <= openMinutes ? 24 * 60 : 0;
    const start = new Date(dayStart.getTime() + openMinutes * 60_000);
    const end = new Date(dayStart.getTime() + (closeMinutes + closeOffset) * 60_000);

    slots.push({
      day: hour.day,
      open: hour.open,
      close: hour.close,
      start,
      end,
    });
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function describeOpeningDay(slot: OpeningSlot, now: Date) {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (isSameCalendarDate(slot.start, tomorrow)) return 'Abre amanhã';
  return `Abre ${format(slot.start, "EEEE, dd/MM", { locale: ptBR })}`;
}

function hasUniformOpenHours(hours: OpeningHour[]) {
  const openDays = hours.filter((hour) => !hour.closed);
  if (openDays.length === 0) return false;

  const [first, ...rest] = openDays;
  return rest.every((hour) => hour.open === first.open && hour.close === first.close);
}

export function getOpeningStatus(hours: OpeningHour[], now: Date, schedules: OpeningSchedules): OpeningStatus | null {
  if (hours.length === 0) return null;

  const hasOverrides = [...schedules.values()].some((schedule) => schedule.source !== 'default');
  const uniformSuffix = !hasOverrides && hasUniformOpenHours(hours) ? ' · todos os dias' : '';
  const slots = buildOpeningSlots(hours, now, schedules);
  const currentSlot = slots.find((slot) => now >= slot.start && now < slot.end);

  if (currentSlot) {
    return {
      title: 'Aberto agora',
      description: `Fecha às ${currentSlot.close}${uniformSuffix}`,
      variant: 'open',
    };
  }

  const upcomingTodaySlot = slots.find((slot) => slot.start > now && isSameCalendarDate(slot.start, now));
  if (upcomingTodaySlot) {
    return {
      title: 'Abre hoje',
      description: `Abre às ${upcomingTodaySlot.open}${uniformSuffix}`,
      variant: 'closed',
    };
  }

  const nextSlot = slots.find((slot) => slot.start > now);
  if (!nextSlot) {
    return {
      title: 'Fechado hoje',
      description: null,
      variant: 'closed',
    };
  }

  return {
    title: describeOpeningDay(nextSlot, now),
    description: null,
    variant: 'closed',
  };
}

export function buildOpeningHourGroups(hours: OpeningHour[], now: Date, schedules: OpeningSchedules): OpeningHourGroup[] {
  const todayIndex = now.getDay();
  const groups: { startDay: string; endDay: string; closed: boolean; open: string; close: string; isToday: boolean }[] = [];

  for (const regularHour of hours) {
    const isToday = getDayIndexFromName(regularHour.day) === todayIndex;
    // A excecao altera apenas a linha de hoje; nao vira um horario semanal.
    const hour = isToday ? resolveOpeningHourForDate(hours, now, schedules)! : regularHour;
    const last = groups[groups.length - 1];
    const sameAsLast = last
      && !isToday
      && !last.isToday
      && last.closed === hour.closed
      && last.open === hour.open
      && last.close === hour.close;

    if (sameAsLast) {
      last.endDay = hour.day;
    } else {
      groups.push({
        startDay: hour.day,
        endDay: hour.day,
        closed: hour.closed,
        open: hour.open,
        close: hour.close,
        isToday,
      });
    }
  }

  return groups.map((group) => {
    if (group.isToday) {
      return {
        label: `${FULL_DAY_NAME_BY_ABBR[group.startDay] || group.startDay} · hoje`,
        closed: group.closed,
        open: group.open,
        close: group.close,
        isToday: true,
      };
    }

    return {
      label: group.startDay === group.endDay ? group.startDay : `${group.startDay} a ${group.endDay}`,
      closed: group.closed,
      open: group.open,
      close: group.close,
      isToday: false,
    };
  });
}
