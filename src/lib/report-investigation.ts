import { supabase } from '@/integrations/supabase/client';
import {
  buildAttendanceLossesRpcParams,
  normalizeAttendanceLossesReport,
  type AttendanceLossesReport,
  type AttendanceLossesReportParams,
  type AttendanceLossesReservationRow,
  type AttendanceOutcome,
  type AttendanceSegmentDimension,
} from '@/lib/attendance-losses-report';
import {
  buildDemandConversionRpcParams,
  normalizeDemandConversionReport,
  type DemandConversionReport,
  type DemandReservationRow,
  type UseDemandConversionReportParams,
} from '@/hooks/useDemandConversionReport';
import { loadCompleteReportRecords } from '@/lib/report-records';

export interface ReportReading {
  title: string;
  detail: string;
  tone?: 'neutral' | 'positive' | 'attention';
}

export interface AttendanceInvestigation {
  title: string;
  outcome?: AttendanceOutcome | 'losses';
  dimension?: AttendanceSegmentDimension;
  segmentKey?: string;
  cancellationBucket?: string;
  from?: string;
  to?: string;
}

export interface DemandInvestigation {
  title: string;
  basis?: 'created' | 'visit';
  entryMode?: 'online' | 'affiliate' | 'manual' | 'waitlist';
  outcome?: AttendanceOutcome;
  leadTimeBand?: string;
  partySizeBand?: string;
}

const integer = (value: number) => value.toLocaleString('pt-BR');
const percent = (value: number) => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export function matchesAttendanceInvestigation(row: AttendanceLossesReservationRow, selection: AttendanceInvestigation) {
  if (selection.outcome === 'losses' && row.outcome !== 'cancelled' && row.outcome !== 'no_show') return false;
  if (selection.outcome && selection.outcome !== 'losses' && row.outcome !== selection.outcome) return false;
  if (selection.from && row.date < selection.from) return false;
  if (selection.to && row.date > selection.to) return false;
  if (selection.dimension && selection.segmentKey) {
    let key: string;
    switch (selection.dimension) {
      case 'weekday': key = String(new Date(`${row.date}T12:00:00Z`).getUTCDay() || 7); break;
      case 'time_band': key = row.time < '18:00' ? 'before_18' : row.time < '20:00' ? '18_20' : row.time < '22:00' ? '20_22' : 'after_22'; break;
      case 'party_size': key = row.party_size <= 2 ? '1_2' : row.party_size <= 4 ? '3_4' : row.party_size <= 6 ? '5_6' : '7_plus'; break;
      case 'lead_time': key = row.lead_days === 0 ? 'same_day' : row.lead_days <= 2 ? '1_2' : row.lead_days <= 7 ? '3_7' : row.lead_days <= 14 ? '8_14' : row.lead_days <= 30 ? '15_30' : '31_plus'; break;
      case 'entry_method': key = row.entry_method; break;
    }
    if (key !== selection.segmentKey) return false;
  }
  if (selection.cancellationBucket) {
    if (row.outcome !== 'cancelled') return false;
    const hours = row.cancellation_lead_hours;
    const key = row.cancelled_at === null ? 'without_audit'
      : hours !== null && hours < 0 ? 'after_start'
      : hours !== null && hours < 2 ? 'under_2h'
      : hours !== null && hours < 6 ? '2_6h'
      : hours !== null && hours < 24 ? '6_24h'
      : hours !== null && hours < 72 ? '1_3d' : '3d_plus';
    if (key !== selection.cancellationBucket) return false;
  }
  return true;
}

export function matchesDemandInvestigation(row: DemandReservationRow, selection: DemandInvestigation) {
  if (selection.partySizeBand) {
    const key = row.party_size <= 2 ? 'one_two' : row.party_size <= 4 ? 'three_four' : row.party_size <= 6 ? 'five_six' : 'seven_plus';
    if (selection.partySizeBand !== key) return false;
  }
  if (selection.leadTimeBand) {
    const key = row.lead_days === 0 ? 'same_day' : row.lead_days === 1 ? 'one_day' : row.lead_days <= 7 ? 'two_to_seven' : row.lead_days <= 14 ? 'eight_to_fourteen' : row.lead_days <= 30 ? 'fifteen_to_thirty' : 'thirty_one_plus';
    if (selection.leadTimeBand !== key) return false;
  }
  return true;
}

export async function loadAttendanceInvestigation(params: AttendanceLossesReportParams, selection: AttendanceInvestigation, signal?: AbortSignal) {
  const records = await loadCompleteReportRecords<AttendanceLossesReservationRow>({
    signal,
    fetchPage: async page => {
      const rpc = buildAttendanceLossesRpcParams({ ...params, page, pageSize: 100, comparisonEnabled: false });
      let request = (supabase as any).rpc('get_attendance_losses_report', rpc);
      if (signal && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      const report = normalizeAttendanceLossesReport(data, rpc);
      return { rows: report.reservations, total: report.meta.filtered_reservations_total };
    },
  });
  return records.filter(row => matchesAttendanceInvestigation(row, selection));
}

export async function loadDemandInvestigation(params: UseDemandConversionReportParams, selection: DemandInvestigation, signal?: AbortSignal) {
  if (selection.basis === 'visit') {
    return loadAttendanceInvestigation({
      companyId: params.companyId, periodStart: params.periodStart, periodEnd: params.periodEnd,
      outcome: selection.outcome ?? 'all', entryMethod: selection.entryMode ?? 'all',
    }, { title: selection.title }, signal);
  }
  const records = await loadCompleteReportRecords<DemandReservationRow>({
    signal,
    fetchPage: async page => {
      const request = { ...params, entryMode: selection.entryMode ?? params.entryMode, page, pageSize: 100, comparisonEnabled: false };
      let query = (supabase as any).rpc('get_demand_conversion_report', buildDemandConversionRpcParams(request));
      if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
      const { data, error } = await query;
      if (error) throw error;
      const report = normalizeDemandConversionReport(data, {
        periodStart: params.periodStart, periodEnd: params.periodEnd,
        uniqueOnly: params.uniqueOnly ?? false, comparisonEnabled: false,
        granularity: params.granularity ?? 'day', pageSize: 100, entryMode: selection.entryMode ?? params.entryMode ?? 'all',
      });
      return { rows: report.details, total: report.meta.details_total };
    },
  });
  return records.filter(row => matchesDemandInvestigation(row, selection)).map(row => ({
    ...row, date: row.reservation_date, time: row.reservation_time,
  }));
}

export function getAttendanceReadings(report: AttendanceLossesReport): ReportReading[] {
  const base = report.summary.attended + report.summary.no_show;
  const previousBase = report.comparison ? report.comparison.attended + report.comparison.no_show : 0;
  const change = report.comparison ? report.summary.attendance_rate - report.comparison.attendance_rate : 0;
  const lossDay = [...report.segments.weekday].sort((a, b) => (b.no_show + b.cancelled) - (a.no_show + a.cancelled))[0];
  return [
    { title: 'Resultados dos atendimentos', detail: `${integer(report.summary.attended)} comparecimentos, ${integer(report.summary.no_show)} no-shows e ${integer(report.summary.cancelled)} cancelamentos em ${integer(report.summary.reservations)} reservas pela data da visita. ${integer(report.summary.scheduled)} continuam abertas.` },
    report.comparison && base >= 10 && previousBase >= 10
      ? { title: 'Comparação de comparecimento', detail: `A taxa variou ${change > 0 ? '+' : ''}${change.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} pontos percentuais. Base: ${integer(base)} reservas concluídas no período e ${integer(previousBase)} no anterior; canceladas e abertas ficam fora.`, tone: change < 0 ? 'attention' : 'neutral' }
      : { title: 'Volume da comparação', detail: `${integer(base)} reservas têm desfecho de presença ou no-show. ${base < 10 ? 'Amostra pequena: interprete as taxas com cautela.' : 'Use a comparação com um período anterior de volume suficiente para avaliar a variação.'}` },
    lossDay && lossDay.no_show + lossDay.cancelled > 0
      ? { title: 'Onde investigar as perdas', detail: `${lossDay.label} reúne ${integer(lossDay.no_show + lossDay.cancelled)} no-shows/cancelamentos em ${integer(lossDay.reservations)} reservas desse dia da semana. O volume indica concentração e não uma causa.`, tone: 'attention' }
      : { title: 'Cobertura dos cancelamentos', detail: `${integer(report.cancellation_curve.cancelled_with_audit)} de ${integer(report.cancellation_curve.cancelled_total)} cancelamentos têm horário auditado (${percent(report.cancellation_curve.coverage_percentage)}). A curva usa apenas o horário conhecido e identifica os demais.` },
  ];
}

export function getDemandReadings(report: DemandConversionReport, uniqueOnly: boolean): ReportReading[] {
  const mostDropoff = [...report.funnel.slice(0, -1)].sort((a, b) => b.dropoff - a.dropoff)[0];
  return [
    { title: 'Conversão web', detail: `${integer(report.summary.completed)} de ${integer(report.summary.sessions)} ${uniqueOnly ? 'visitantes únicos' : 'sessões'} chegaram à etapa final (${percent(report.summary.overall_conversion_rate)}). A base é a jornada web iniciada no período. ${report.summary.sessions < 10 ? 'Volume pequeno: leia a taxa com cautela.' : ''}`.trim() },
    { title: 'Reservas registradas no período', detail: `${integer(report.summary.created_reservations)} reservas e ${integer(report.summary.created_people)} pessoas por todas as formas de entrada, considerando a data de criação. Antecedência média de ${report.summary.average_lead_days.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias.` },
    mostDropoff && mostDropoff.dropoff > 0
      ? { title: 'Etapa para investigar', detail: `${integer(mostDropoff.dropoff)} ${uniqueOnly ? 'visitantes' : 'sessões'} não avançaram depois de “${mostDropoff.label}”, de uma base de ${integer(mostDropoff.count)} nessa etapa. Os registros de navegação não demonstram o motivo da saída.`, tone: 'attention' }
      : { title: 'Cobertura da jornada', detail: 'As etapas mostram a navegação registrada. Reservas criadas pelo painel, parceiros e fila têm outra base e são investigadas separadamente.' },
  ];
}
