import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AttendanceLossesReport from '@/pages/AttendanceLossesReport';
import type { AttendanceLossesReport as AttendanceLossesReportData } from '@/lib/attendance-losses-report';
import type { AttendanceOutcomeSeries } from '@/hooks/useAttendanceOutcomeSeries';

const refetch = vi.fn();
const seriesRefetch = vi.fn();
let reportQueryState: {
  data?: AttendanceLossesReportData;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  error?: Error;
  refetch: typeof refetch;
};
let seriesQueryState: {
  data?: AttendanceOutcomeSeries;
  isError: boolean;
  isFetching: boolean;
  refetch: typeof seriesRefetch;
};

vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({
    companyId: 'company-1',
    companyName: 'Restaurante Teste',
    companyTimeZone: 'America/Manaus',
    companyTimeZoneResolved: true,
    slug: 'restaurante-teste',
  }),
}));

vi.mock('@/hooks/useReportFilters', () => ({
  useReportFilters: () => ({
    periodPreset: 'current_month',
    range: { from: new Date('2026-08-01'), to: new Date('2026-08-20') },
    dateRange: { from: new Date('2026-08-01'), to: new Date('2026-08-20') },
    dateOnlyRange: { from: '2026-08-01', to: '2026-08-20' },
    comparisonRange: null,
    comparisonDateOnlyRange: null,
    granularity: 'day',
    comparisonEnabled: true,
    rangeError: null,
    setPeriodPreset: vi.fn(),
    setDateRange: vi.fn(),
    setGranularity: vi.fn(),
    setComparisonEnabled: vi.fn(),
  }),
}));

vi.mock('@/components/reports/ReportFilterBar', () => ({
  REPORT_FILTER_TOGGLE_CLASS: 'report-filter-toggle',
  default: ({ children }: { children?: ReactNode }) => <div data-testid="report-filters">{children}</div>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock('@/hooks/useAttendanceOutcomeSeries', () => ({
  useAttendanceOutcomeSeries: () => seriesQueryState,
}));

vi.mock('@/hooks/useAttendanceLossesReport', () => ({
  useAttendanceLossesReport: () => reportQueryState,
}));

const summary = {
  reservations: 10,
  attended: 6,
  no_show: 2,
  cancelled: 1,
  scheduled: 1,
  reserved_people: 28,
  attended_people: 18,
  lost_people: 7,
  attendance_rate: 75,
  no_show_rate: 25,
  loss_rate: 30,
};

const report: AttendanceLossesReportData = {
  summary,
  comparison: { ...summary, period_start: '2026-07-12', period_end: '2026-07-31' },
  daily_series: [{ ...summary, date: '2026-08-10' }],
  segments: {
    weekday: [{ ...summary, key: '1', label: 'Segunda-feira', sort_order: 1 }],
    time_band: [{ ...summary, key: 'dinner', label: 'Jantar', sort_order: 1 }],
    party_size: [{ ...summary, key: 'three_four', label: '3–4 pessoas', sort_order: 1 }],
    lead_time: [{ ...summary, key: 'same_day', label: 'Mesmo dia', sort_order: 1 }],
    entry_method: [{ ...summary, key: 'online', label: 'Online', sort_order: 1 }],
  },
  associations: {
    whatsapp: [
      { ...summary, key: 'with', label: 'Com mensagem' },
      { ...summary, key: 'without', label: 'Sem mensagem' },
    ],
    prepayment: [
      { ...summary, key: 'with', label: 'Com pré-pagamento' },
      { ...summary, key: 'without', label: 'Sem pré-pagamento' },
    ],
  },
  cancellation_curve: {
    coverage_start: '2026-01-01T00:00:00Z',
    cancelled_total: 1,
    cancelled_with_audit: 1,
    coverage_percentage: 100,
    buckets: [{ key: 'more_24h', label: 'Mais de 24 h antes', sort_order: 1, reservations: 1, people: 3, percentage: 100 }],
  },
  reservations: [{
    id: 'reservation-1', company_id: 'company-1', guest_name: 'Cliente Teste', guest_phone: '5599999999999',
    guest_email: null, source: 'public', origin_affiliate_code: null, origin_affiliate_name: null,
    date: '2026-08-10', time: '19:00:00', party_size: 3, status: 'checked_in', occasion: null,
    notes: null, checked_in_at: '2026-08-10T22:00:00Z', checked_in_party_size: 3,
    created_at: '2026-08-01T12:00:00Z', updated_at: '2026-08-10T22:00:00Z', public_tracking_code: 'track-1',
    outcome: 'attended', entry_method: 'online', lead_days: 9, cancelled_at: null, cancellation_lead_hours: null,
    whatsapp_evolution: true, whatsapp_pluguechat: false, has_whatsapp: true, has_prepayment: true,
  }],
  meta: {
    period_start: '2026-08-01', period_end: '2026-08-20', comparison_enabled: true,
    comparison_start: '2026-07-12', comparison_end: '2026-07-31', time_zone: 'America/Manaus',
    page: 1, page_size: 20, reservations_total: 10, filtered_reservations_total: 1,
    outcome: 'all', entry_method: 'all', search: null, generated_at: '2026-08-20T12:00:00Z',
  },
};

describe('AttendanceLossesReport', () => {
  beforeEach(() => {
    refetch.mockClear();
    seriesRefetch.mockClear();
    reportQueryState = { data: report, isLoading: false, isError: false, isFetching: false, refetch };
    seriesQueryState = {
      data: {
        series: [{
          period: '2026-08-10', reservations: 10, attended: 6, no_show: 2, cancelled: 1,
          scheduled: 1, reserved_people: 28, attended_people: 18, no_show_people: 5,
          cancelled_people: 2, scheduled_people: 3, lost_people: 7,
          expected_reservations: 10, realized_reservations: 6,
          expected_people: 28, realized_people: 18, attendance_rate: 75, no_show_rate: 25,
          loss_rate: 30, realized_reservation_rate: 60, realized_people_rate: 64.3,
        }],
        meta: {
          period_start: '2026-08-01', period_end: '2026-08-20', time_zone: 'America/Manaus',
          granularity: 'day', outcome: 'all', entry_method: 'all',
          attendance_rate_formula: 'attended / (attended + no_show)',
          realized_rate_formula: 'attended / all_reservations',
          generated_at: '2026-08-20T12:00:00Z',
        },
      },
      isError: false,
      isFetching: false,
      refetch: seriesRefetch,
    };
  });

  it('labels associations as observational', () => {
    render(<MemoryRouter><AttendanceLossesReport /></MemoryRouter>);

    expect(screen.getByText(/diferenças não comprovam que WhatsApp ou pré-pagamento causaram/)).toBeInTheDocument();
    expect(screen.getByText(/Pagamento recebido antes do horário e ainda em estado pago/)).toBeInTheDocument();
  });

  it('summarizes expected, realized, losses and realization for the selected unit', () => {
    render(<MemoryRouter><AttendanceLossesReport /></MemoryRouter>);

    const reservationTotals = within(screen.getByTestId('attendance-series-totals'));
    expect(reservationTotals.getByText('Esperado')).toBeInTheDocument();
    expect(reservationTotals.getByText('10')).toBeInTheDocument();
    expect(reservationTotals.getByText('Check-ins')).toBeInTheDocument();
    expect(reservationTotals.getByText('6')).toBeInTheDocument();
    expect(reservationTotals.getByText('Perdas')).toBeInTheDocument();
    expect(reservationTotals.getByText('3')).toBeInTheDocument();
    expect(reservationTotals.getByText('Realização')).toBeInTheDocument();
    expect(reservationTotals.getByText('60,0%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pessoas' }));

    const peopleTotals = within(screen.getByTestId('attendance-series-totals'));
    expect(peopleTotals.getByText('28')).toBeInTheDocument();
    expect(peopleTotals.getByText('Compareceram')).toBeInTheDocument();
    expect(peopleTotals.getByText('18')).toBeInTheDocument();
    expect(peopleTotals.getByText('7')).toBeInTheDocument();
    expect(peopleTotals.getByText('64,3%')).toBeInTheDocument();
  });

  it('does not expose the per-reservation listing', () => {
    render(<MemoryRouter><AttendanceLossesReport /></MemoryRouter>);

    expect(screen.queryByText('Reservas do recorte')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente Teste')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows explicit empty states for charts and reservations', () => {
    seriesQueryState = {
      data: {
        series: [],
        meta: {
          period_start: '2026-08-01', period_end: '2026-08-20', time_zone: 'America/Manaus',
          granularity: 'day', outcome: 'all', entry_method: 'all',
          attendance_rate_formula: 'attended / (attended + no_show)',
          realized_rate_formula: 'attended / all_reservations',
          generated_at: '2026-08-20T12:00:00Z',
        },
      },
      isError: false,
      isFetching: false,
      refetch: seriesRefetch,
    };
    const emptySummary = Object.fromEntries(Object.keys(summary).map((key) => [key, 0])) as typeof summary;
    reportQueryState = {
      data: {
        ...report,
        summary: emptySummary,
        comparison: null,
        daily_series: [],
        segments: { weekday: [], time_band: [], party_size: [], lead_time: [], entry_method: [] },
        reservations: [],
        meta: { ...report.meta, reservations_total: 0, filtered_reservations_total: 0 },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };

    render(<MemoryRouter><AttendanceLossesReport /></MemoryRouter>);

    expect(screen.getByText('Nenhuma reserva neste recorte')).toBeInTheDocument();
    expect(screen.getByText('Sem dados para esta dimensão.')).toBeInTheDocument();
  });

  it('shows a recoverable error state when no report is available', () => {
    reportQueryState = { isLoading: false, isError: true, isFetching: false, error: new Error('offline'), refetch };

    render(<MemoryRouter><AttendanceLossesReport /></MemoryRouter>);

    expect(screen.getByText('Não foi possível carregar o relatório')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('preserves the last valid report when a refresh fails', () => {
    reportQueryState = {
      data: report,
      isLoading: false,
      isError: true,
      isFetching: false,
      error: new Error('offline'),
      refetch,
    };

    render(<MemoryRouter><AttendanceLossesReport /></MemoryRouter>);

    expect(screen.getByText('Dados preservados')).toBeInTheDocument();
    expect(screen.getByText('Evolução diária dos resultados')).toBeInTheDocument();
    expect(screen.queryByText('Não foi possível carregar o relatório')).not.toBeInTheDocument();
  });
});
