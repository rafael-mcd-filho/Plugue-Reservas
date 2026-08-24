import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OccupancyCapacityReport from '@/pages/OccupancyCapacityReport';
import type { OccupancyCapacityReport as OccupancyCapacityReportData } from '@/lib/occupancy-capacity-report';

const refetch = vi.fn();
let reportQueryState: {
  data?: OccupancyCapacityReportData;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  error?: Error;
  refetch: typeof refetch;
};
let comparisonQueryState: typeof reportQueryState;
let comparisonEnabled = false;
let comparisonDateOnlyRange: { from: string; to: string } | null = null;

vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({
    companyId: 'company-1',
    companyTimeZone: 'America/Manaus',
    companyTimeZoneResolved: true,
  }),
}));

vi.mock('@/hooks/useReportFilters', () => ({
  useReportFilters: () => ({
    periodPreset: 'last_30_days',
    range: { from: new Date('2026-08-01'), to: new Date('2026-08-20') },
    dateRange: { from: new Date('2026-08-01'), to: new Date('2026-08-20') },
    dateOnlyRange: { from: '2026-08-01', to: '2026-08-20' },
    comparisonRange: null,
    comparisonDateOnlyRange,
    granularity: 'day',
    comparisonEnabled,
    rangeError: null,
    setPeriodPreset: vi.fn(),
    setDateRange: vi.fn(),
    setGranularity: vi.fn(),
    setComparisonEnabled: vi.fn(),
  }),
}));

vi.mock('@/components/reports/ReportFilterBar', () => ({
  REPORT_FILTER_TOGGLE_CLASS: 'report-filter-toggle',
  default: ({ children }: { children?: React.ReactNode }) => <div data-testid="filters">{children}</div>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  Bar: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const report: OccupancyCapacityReportData = {
  summary: {
    published_capacity: 200,
    slot_count: 4,
    capacity_slots: 2,
    table_slots: 2,
    snapshot_slots: 2,
    estimated_slots: 2,
    reservations: 4,
    reserved_people: 12,
    checked_in_reservations: 2,
    checked_in_people: 6,
    no_show_reservations: 1,
    no_show_people: 2,
    unmatched_reservations: 0,
    unmatched_people: 0,
    capacity_pressure_rate: 6,
    check_in_capacity_rate: 3,
    waitlist_entries: 3,
    waitlist_people: 6,
    waitlist_seated: 2,
    waitlist_dropped: 1,
    average_wait_minutes: 18,
  },
  series: [],
  heatmap: [{
    weekday: 1,
    weekday_label: 'Seg',
    time_slot: '19:00:00',
    slot_count: 1,
    published_capacity: 50,
    reserved_people: 25,
    checked_in_people: 20,
    no_show_reservations: 1,
    capacity_pressure_rate: 50,
    check_in_capacity_rate: 40,
    data_quality: 'snapshot',
    capacity_basis_available: true,
    counts_toward_capacity: true,
  }],
  waitlist_by_hour: [],
  no_show_by_hour: [],
  table_breakdown: [{
    section_code: 'salao',
    section_name: 'Sal\u00e3o',
    table_id: 'table-1',
    table_number: 1,
    reservations: 1,
    reserved_people: 3,
    checked_in_reservations: 1,
    checked_in_people: 3,
  }],
  table_assignment: {
    eligible_reservations: 2,
    assigned_reservations: 1,
    unassigned_reservations: 1,
    coverage_rate: 50,
  },
  details: [{
    id: 'reservation-1',
    guest_name: 'Cliente Teste',
    guest_phone: '5583999999999',
    guest_email: null,
    date: '2026-08-10',
    time: '19:00:00',
    party_size: 3,
    status: 'checked_in',
    outcome: 'checked_in',
    availability_mode: 'tables',
    published_capacity: 50,
    data_quality: 'snapshot',
    checked_in_at: '2026-08-10T22:00:00Z',
    checked_in_party_size: 3,
    table_id: 'table-1',
    table_number: 1,
    section_code: 'salao',
    section_name: 'Sal\u00e3o',
    created_at: '2026-08-01T12:00:00Z',
    public_tracking_code: null,
  }],
  meta: {
    period_start: '2026-08-01',
    period_end: '2026-08-20',
    time_zone: 'America/Manaus',
    granularity: 'day',
    page: 1,
    page_size: 20,
    details_total: 1,
    unmatched_reservations: 0,
    unmatched_people: 0,
    availability_mode: 'all',
    outcome: 'all',
    generated_at: '2026-08-20T12:00:00Z',
    capacity_history: 'mixed',
    estimation_notice: 'Parte do per\u00edodo usa estimativa.',
    unmatched_notice: null,
  },
};

// Both queries now request the smallest page, so they are told apart by the
// period they cover. With the comparison off its result is never read, and
// returning the main state for both calls keeps the mock harmless.
vi.mock('@/hooks/useOccupancyCapacityReport', () => ({
  useOccupancyCapacityReport: (params: { periodStart?: string }) => (
    comparisonDateOnlyRange && params.periodStart === comparisonDateOnlyRange.from
      ? comparisonQueryState
      : reportQueryState
  ),
}));

describe('OccupancyCapacityReport', () => {
  beforeEach(() => {
    refetch.mockClear();
    comparisonEnabled = false;
    comparisonDateOnlyRange = null;
    reportQueryState = {
      data: report,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };
    comparisonQueryState = {
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };
  });

  it('shows mixed capacity quality and the aggregated views', () => {
    render(<MemoryRouter><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Ocupa\u00e7\u00e3o & Capacidade' })).toBeInTheDocument();
    expect(screen.getByText('Parte do per\u00edodo usa estimativa.')).toBeInTheDocument();
    expect(screen.getByText('Check-ins sobre capacidade')).toBeInTheDocument();
    expect(screen.getAllByText('50,0%').length).toBeGreaterThan(0);
    expect(screen.getByRole('note')).toHaveTextContent(
      'os indicadores e o gráfico consideram todo o período selecionado e não mudam com “Modo de capacidade”',
    );
    expect(screen.queryByText(/perman\u00eancia real/i)).not.toBeInTheDocument();
  });

  it('does not expose the per-reservation listing or the table breakdown', () => {
    render(<MemoryRouter><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.queryByText('Reservas do per\u00edodo')).not.toBeInTheDocument();
    expect(screen.queryByText('Mesas e se\u00e7\u00f5es')).not.toBeInTheDocument();
    expect(screen.queryByText('Resultado da lista')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente Teste')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('surfaces comparison quality and avoids a direct variation for non-equivalent bases', () => {
    comparisonEnabled = true;
    comparisonDateOnlyRange = { from: '2026-07-12', to: '2026-07-31' };
    reportQueryState = {
      data: {
        ...report,
        meta: { ...report.meta, capacity_history: 'snapshot', estimation_notice: null },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };
    comparisonQueryState = {
      data: {
        ...report,
        summary: { ...report.summary, capacity_pressure_rate: 4 },
        meta: {
          ...report.meta,
          period_start: '2026-07-12',
          period_end: '2026-07-31',
          capacity_history: 'estimated_current_configuration',
          estimation_notice: 'A configuração atual foi aplicada ao período anterior.',
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };

    render(<MemoryRouter><OccupancyCapacityReport /></MemoryRouter>);

    const warning = screen.getByText('Bases não equivalentes para comparação').closest('[role="alert"]');
    expect(warning).toHaveTextContent('Período atual: Snapshot histórico');
    expect(warning).toHaveTextContent('Período anterior: Configuração atual (estimativa)');
    expect(warning).toHaveTextContent('A configuração atual foi aplicada ao período anterior.');

    expect(screen.getByText(/Comparação limitada · período anterior/)).toBeInTheDocument();
    expect(screen.queryByText(/p\.p\. vs\. período anterior/)).not.toBeInTheDocument();
  });

  it('shows the direct delta only when both periods use historical snapshots', () => {
    comparisonEnabled = true;
    comparisonDateOnlyRange = { from: '2026-07-12', to: '2026-07-31' };
    reportQueryState = {
      data: {
        ...report,
        meta: { ...report.meta, capacity_history: 'snapshot', estimation_notice: null },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };
    comparisonQueryState = {
      data: {
        ...report,
        summary: { ...report.summary, capacity_pressure_rate: 5 },
        meta: {
          ...report.meta,
          period_start: '2026-07-12',
          period_end: '2026-07-31',
          capacity_history: 'snapshot',
          estimation_notice: null,
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };

    render(<MemoryRouter><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.queryByText('Bases não equivalentes para comparação')).not.toBeInTheDocument();
    expect(screen.getByText('+1,0 p.p. vs. período anterior')).toBeInTheDocument();
  });

  it('shows explicit empty states instead of blank charts', () => {
    reportQueryState = {
      data: {
        ...report,
        summary: {
          ...report.summary,
          published_capacity: 0,
          reserved_people: 0,
          checked_in_people: 0,
          waitlist_entries: 0,
          waitlist_seated: 0,
          waitlist_dropped: 0,
          no_show_reservations: 0,
          no_show_people: 0,
        },
        series: [],
        waitlist_by_hour: [],
        no_show_by_hour: [],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };

    render(<MemoryRouter><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.getByText('Nenhum dado de capacidade ou demanda')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma entrada na fila neste recorte.')).toBeInTheDocument();
    expect(screen.getByText('Sem reservas elegíveis para calcular no-show por horário.')).toBeInTheDocument();
  });

  it('keeps cached data visible and warns when refresh fails', () => {
    reportQueryState = {
      data: report,
      isLoading: false,
      isError: true,
      isFetching: false,
      error: new Error('offline'),
      refetch,
    };

    render(<MemoryRouter><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.getByText('Dados preservados')).toBeInTheDocument();
    expect(screen.getByText('Check-ins sobre capacidade')).toBeInTheDocument();
  });
});
