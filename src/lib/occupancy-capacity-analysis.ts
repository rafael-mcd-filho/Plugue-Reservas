import type {
  OccupancyCapacityHeatmapCell,
  OccupancyCapacityReport,
  OccupancyCapacityReservationRow,
} from './occupancy-capacity-report';

export type CapacityMatrixMetric = 'offer' | 'reserved' | 'checked_in';

export interface OccupancyRecordSelection {
  title: string;
  metric: CapacityMatrixMetric | 'no_show';
  weekday?: number;
  timeSlot?: string;
  hour?: string;
  from?: string;
  to?: string;
  /** Summary/heatmap include only reservations matched to a published slot. */
  basisOnly?: boolean;
}

export function buildCapacityMatrix(cells: OccupancyCapacityHeatmapCell[]) {
  const times = [...new Set(cells.map(cell => cell.time_slot))].sort();
  const weekdays = [...new Set(cells.map(cell => cell.weekday))]
    .sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7));
  return {
    times,
    rows: weekdays.map(weekday => ({
      weekday,
      label: cells.find(cell => cell.weekday === weekday)!.weekday_label,
      cells: times.map(time => cells.find(cell => cell.weekday === weekday && cell.time_slot === time) ?? null),
    })),
  };
}

export function capacityMatrixValue(cell: OccupancyCapacityHeatmapCell, metric: CapacityMatrixMetric) {
  if (metric === 'offer') return { people: cell.published_capacity, rate: null };
  return metric === 'checked_in'
    ? { people: cell.checked_in_people, rate: cell.published_capacity > 0 ? cell.check_in_capacity_rate : null }
    : { people: cell.reserved_people, rate: cell.published_capacity > 0 ? cell.capacity_pressure_rate : null };
}

export function filterOccupancyRecords(
  rows: OccupancyCapacityReservationRow[],
  selection: OccupancyRecordSelection,
) {
  return rows.filter(row => {
    if (selection.basisOnly !== false && !row.capacity_basis_available) return false;
    if (selection.weekday !== undefined && new Date(row.date + 'T12:00:00Z').getUTCDay() !== selection.weekday) return false;
    if (selection.timeSlot && row.time.slice(0, 5) !== selection.timeSlot.slice(0, 5)) return false;
    if (selection.hour && row.time.slice(0, 2) !== selection.hour.slice(0, 2)) return false;
    if (selection.from && row.date < selection.from) return false;
    if (selection.to && row.date > selection.to) return false;
    if (selection.metric === 'checked_in') return row.outcome === 'checked_in';
    if (selection.metric === 'no_show') return row.outcome === 'no_show';
    return row.counts_toward_capacity;
  });
}

/**
 * The reservation's creation mode may differ from the published slot's mode.
 * A mode-filtered matrix only includes dates with an offer in that mode; its
 * detail flags refer to any published basis, so verify those dates explicitly.
 */
export async function retainCapacityMatrixContributors(
  rows: OccupancyCapacityReservationRow[],
  selection: OccupancyRecordSelection,
  fetchDayCells: (date: string) => Promise<OccupancyCapacityHeatmapCell[]>,
  signal?: AbortSignal,
) {
  if (selection.weekday === undefined || !selection.timeSlot || rows.length === 0) return rows;
  const dates = [...new Set(rows.map(row => row.date))].sort();
  const contributingDates = new Set<string>();
  for (let offset = 0; offset < dates.length; offset += 4) {
    if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
    const batch = dates.slice(offset, offset + 4);
    const contributions = await Promise.all(batch.map(async date => {
      const cells = await fetchDayCells(date);
      return cells.some(cell => cell.weekday === selection.weekday
        && cell.time_slot.slice(0, 5) === selection.timeSlot!.slice(0, 5)
        && cell.slot_count > 0) ? date : null;
    }));
    if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
    contributions.forEach(date => { if (date) contributingDates.add(date); });
  }
  return rows.filter(row => contributingDates.has(row.date));
}

export function getCapacityPeriodWindow(period: string, granularity: 'day' | 'week' | 'month') {
  const date = new Date(period + 'T12:00:00Z');
  if (granularity === 'week') date.setUTCDate(date.getUTCDate() + 6);
  if (granularity === 'month') date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return { from: period, to: date.toISOString().slice(0, 10) };
}

export function buildCapacityInsights(report: OccupancyCapacityReport) {
  const number = (value: number) => value.toLocaleString('pt-BR');
  const percent = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  const quality = report.meta.capacity_history === 'snapshot'
    ? 'histórico publicado'
    : report.meta.capacity_history === 'unavailable' ? 'sem base publicada' : 'base com estimativas';
  const strongest = [...report.heatmap].filter(cell => cell.published_capacity > 0 && cell.reserved_people > 0)
    .sort((left, right) => right.capacity_pressure_rate - left.capacity_pressure_rate)[0];
  const eligible = report.summary.checked_in_reservations + report.summary.no_show_reservations;
  return [
    {
      title: report.meta.capacity_history === 'unavailable' ? 'Oferta sem base disponível' : 'Oferta do período',
      detail: report.meta.capacity_history === 'unavailable'
        ? 'Não há capacidade publicada suficiente para medir oferta ou taxas neste recorte. Ausência de base não significa salão vazio ou capacidade zero; confira os registros e a configuração.'
        : `${number(report.summary.published_capacity)} lugares ofertados em ${number(report.summary.slot_count)} horários publicados; ${quality}. A soma representa o período, sem medir a lotação física simultânea.`,
      tone: 'neutral' as const,
    },
    strongest ? {
      title: report.summary.reservations < 10 ? 'Recorte com poucas reservas' : 'Maior pressão observada',
      detail: `${strongest.weekday_label}, ${strongest.time_slot.slice(0, 5)}: ${number(strongest.reserved_people)} pessoas reservadas para ${number(strongest.published_capacity)} lugares (${percent(strongest.capacity_pressure_rate)}), em ${number(strongest.slot_count)} horários do recorte. ${report.summary.reservations < 10 ? 'O total de reservas ainda é pequeno para concluir um padrão.' : 'Compare a quantidade de horários e a qualidade da base antes de interpretar a concentração.'}`,
      tone: 'neutral' as const,
    } : {
      title: 'Demanda registrada',
      detail: `${number(report.summary.reserved_people)} pessoas reservadas com base de capacidade neste período. ${number(report.meta.unmatched_reservations)} reservas sem horário publicado correspondente ficam fora das taxas de capacidade.`,
      tone: 'neutral' as const,
    },
    {
      title: eligible < 10 ? 'Comparecimento com base reduzida' : 'Comparecimento no período',
      detail: `${number(report.summary.checked_in_reservations)} reservas com check-in e ${number(report.summary.no_show_reservations)} no-shows entre ${number(eligible)} resultados elegíveis com base de capacidade. ${eligible < 10 ? 'Leia os registros antes de generalizar a taxa.' : 'Cancelamentos e reservas em aberto não entram nesse denominador.'}`,
      tone: report.summary.no_show_reservations > 0 ? 'attention' as const : 'neutral' as const,
    },
  ];
}
