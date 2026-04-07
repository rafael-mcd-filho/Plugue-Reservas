import { endOfDay, format, startOfDay } from 'date-fns';
import type { DateRange } from 'react-day-picker';

export function escapeCsvValue(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => escapeCsvValue(String(cell ?? ''))).join(','))
    .join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  URL.revokeObjectURL(url);
}

export function formatDateRangeLabel(range: DateRange | undefined, placeholder: string) {
  if (!range?.from) {
    return placeholder;
  }

  if (!range.to) {
    return `${format(range.from, 'dd/MM/yy')} - ...`;
  }

  return `${format(range.from, 'dd/MM/yy')} - ${format(range.to, 'dd/MM/yy')}`;
}

export function matchesTimestampRange(value: string | null | undefined, range: DateRange | undefined) {
  if (!range?.from) {
    return true;
  }

  if (!value) {
    return false;
  }

  const current = new Date(value);

  if (Number.isNaN(current.getTime())) {
    return false;
  }

  if (current < startOfDay(range.from)) {
    return false;
  }

  if (range.to && current > endOfDay(range.to)) {
    return false;
  }

  return true;
}

export function matchesLocalDateRange(value: string | null | undefined, range: DateRange | undefined) {
  if (!range?.from) {
    return true;
  }

  if (!value) {
    return false;
  }

  const current = new Date(`${value}T12:00:00`);

  if (Number.isNaN(current.getTime())) {
    return false;
  }

  if (current < startOfDay(range.from)) {
    return false;
  }

  if (range.to && current > endOfDay(range.to)) {
    return false;
  }

  return true;
}
