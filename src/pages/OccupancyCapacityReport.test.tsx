import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OccupancyCapacityReport from '@/pages/OccupancyCapacityReport';
import type { OccupancyCapacityReport as OccupancyCapacityReportData } from '@/lib/occupancy-capacity-report';
import type { OccupancyWaitlistSeries } from '@/hooks/useOccupancyWaitlistSeries';
import type { ReportReservationRecord } from '@/lib/report-records';

const api = vi.hoisted(() => ({ rpc: vi.fn() }));
let openedRecords: { title: string; scopeKey: readonly unknown[]; loadRecords: () => Promise<ReportReservationRecord[]> } | null = null;
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: api.rpc } }));
vi.mock('@/components/reports/ReportRecordsSheet', () => ({
  default: (props: { title: string; open: boolean; scopeKey: readonly unknown[]; loadRecords: () => Promise<ReportReservationRecord[]>; onOpenChange: (open: boolean) => void }) => {
    openedRecords = props;
    return props.open ? <aside role="dialog" aria-label={props.title}><button type="button" onClick={() => props.onOpenChange(false)}>Fechar registros</button></aside> : null;
  },
}));

const refetch = vi.fn();
const waitlistRefetch = vi.fn();
let reportQueryState: {
  data?: OccupancyCapacityReportData;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  error?: Error;
  refetch: typeof refetch;
};
let comparisonQueryState: typeof reportQueryState;
let waitlistQueryState: {
  data?: OccupancyWaitlistSeries;
  isError: boolean;
  isFetching: boolean;
  refetch: typeof waitlistRefetch;
};
let comparisonEnabled = false;
let comparisonDateOnlyRange: { from: string; to: string } | null = null;

vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({
    companyId: 'company-1',
    slug: 'unidade',
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
  Bar: ({ dataKey }: { dataKey?: string }) => <i data-testid={`bar-${dataKey}`} />,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: ({ dataKey }: { dataKey?: string }) => <i data-testid={`line-${dataKey}`} />,
  ReferenceLine: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock('@/hooks/useOccupancyWaitlistSeries', () => ({
  useOccupancyWaitlistSeries: () => waitlistQueryState,
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
    capacity_basis_available: true,
    counts_toward_capacity: true,
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
    waitlistRefetch.mockClear();
    api.rpc.mockReset();
    openedRecords = null;
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
    waitlistQueryState = {
      data: {
        series: [{
          period: '2026-08-10', entries: 3, entry_people: 6, seated: 2,
          seated_people: 4, dropped: 1, dropped_people: 2, average_wait_minutes: 18,
        }],
        meta: {
          period_start: '2026-08-01', period_end: '2026-08-20', time_zone: 'America/Manaus',
          granularity: 'day', event_semantics: 'event_timestamp', generated_at: '2026-08-20T12:00:00Z',
        },
      },
      isError: false,
      isFetching: false,
      refetch: waitlistRefetch,
    };
  });

  it('shows mixed capacity quality and the aggregated views', () => {
    render(<MemoryRouter initialEntries={['/?report_view=explore']}><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Ocupa\u00e7\u00e3o & Capacidade' })).toBeInTheDocument();
    expect(screen.getByText('Parte do per\u00edodo usa estimativa.')).toBeInTheDocument();
    expect(screen.getByText('Check-ins sobre capacidade')).toBeInTheDocument();
    expect(screen.getAllByText('50,0%').length).toBeGreaterThan(0);
    expect(screen.getByRole('note')).toHaveTextContent(
      'os indicadores e o gráfico consideram todo o período selecionado e não mudam com “Modo de capacidade”',
    );
    expect(screen.queryByText(/perman\u00eancia real/i)).not.toBeInTheDocument();
  });

  it('preserves the operational waitlist KPIs and line chart without inventing a daily conversion', () => {
    waitlistQueryState = {
      data: {
        series: [
          {
            period: '2026-08-10', entries: 4, entry_people: 8, seated: 1,
            seated_people: 2, dropped: 0, dropped_people: 0, average_wait_minutes: 10,
          },
          {
            period: '2026-08-11', entries: 0, entry_people: 0, seated: 3,
            seated_people: 6, dropped: 2, dropped_people: 4, average_wait_minutes: 30,
          },
        ],
        meta: {
          period_start: '2026-08-01', period_end: '2026-08-20', time_zone: 'America/Manaus',
          granularity: 'day', event_semantics: 'event_timestamp', generated_at: '2026-08-20T12:00:00Z',
        },
      },
      isError: false,
      isFetching: false,
      refetch: waitlistRefetch,
    };

    render(<MemoryRouter initialEntries={['/?report_view=explore']}><OccupancyCapacityReport /></MemoryRouter>);

    const summary = screen.getByLabelText('Resumo da fila de espera');
    expect(within(summary).getByText('Entradas')).toBeInTheDocument();
    expect(within(summary).getByText('Sentados')).toBeInTheDocument();
    expect(within(summary).getByText('Sa\u00eddas sem sentar')).toBeInTheDocument();
    expect(within(summary).getByText('Convers\u00e3o geral')).toBeInTheDocument();
    expect(within(summary).getByText('Espera m\u00e9dia')).toBeInTheDocument();
    expect(within(summary).getAllByText('4')).toHaveLength(2);
    expect(within(summary).getByText('2')).toBeInTheDocument();
    // 2 sentados entre as 3 entradas da mesma coorte do relat\u00f3rio. O valor
    // n\u00e3o usa 4 / 4 eventos da s\u00e9rie temporal.
    expect(within(summary).getByText('66,7%')).toBeInTheDocument();
    expect(within(summary).getByText('25,0 min')).toBeInTheDocument();
    expect(screen.getByText(/n\u00e3o \u00e9 calculada dia a dia/i)).toBeInTheDocument();

    expect(screen.getByTestId('line-entries')).toBeInTheDocument();
    expect(screen.getByTestId('line-seated')).toBeInTheDocument();
    expect(screen.getByTestId('line-dropped')).toBeInTheDocument();
    expect(screen.getByTestId('line-average_wait_minutes')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-entries')).not.toBeInTheDocument();
  });

  it('keeps the hourly analysis as bars behind its URL view', () => {
    reportQueryState = {
      data: {
        ...report,
        waitlist_by_hour: [{
          hour: '19:00:00', entries: 3, people: 6, seated: 2, dropped: 1,
          average_wait_minutes: 18,
        }],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch,
    };

    render(
      <MemoryRouter initialEntries={['/?waitlist_view=hour&report_view=explore']}>
        <OccupancyCapacityReport />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Por hor\u00e1rio' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('bar-entries')).toBeInTheDocument();
    expect(screen.getByTestId('bar-seated')).toBeInTheDocument();
    expect(screen.getByTestId('bar-dropped')).toBeInTheDocument();
    expect(screen.queryByTestId('line-average_wait_minutes')).not.toBeInTheDocument();
  });

  it('keeps personal records out of the initial report until an indicator is opened', () => {
    render(<MemoryRouter initialEntries={['/?report_view=explore']}><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.queryByText('Reservas do per\u00edodo')).not.toBeInTheDocument();
    expect(screen.queryByText('Mesas e se\u00e7\u00f5es')).not.toBeInTheDocument();
    expect(screen.queryByText('Resultado da lista')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente Teste')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Matriz de reservas por dia e horário' })).toBeInTheDocument();
    expect(api.rpc).not.toHaveBeenCalled();
    expect(openedRecords).toBeNull();
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

    render(<MemoryRouter initialEntries={['/?report_view=explore']}><OccupancyCapacityReport /></MemoryRouter>);

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

    render(<MemoryRouter initialEntries={['/?report_view=explore']}><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.queryByText('Bases não equivalentes para comparação')).not.toBeInTheDocument();
    expect(screen.getByText('+1,0 p.p. vs. período anterior')).toBeInTheDocument();
  });

  it('shows explicit empty states instead of blank charts', () => {
    waitlistQueryState = {
      data: {
        series: [],
        meta: {
          period_start: '2026-08-01', period_end: '2026-08-20', time_zone: 'America/Manaus',
          granularity: 'day', event_semantics: 'event_timestamp', generated_at: '2026-08-20T12:00:00Z',
        },
      },
      isError: false,
      isFetching: false,
      refetch: waitlistRefetch,
    };
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

    render(<MemoryRouter initialEntries={['/?report_view=explore']}><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.getByText('Nenhum dado de capacidade ou demanda')).toBeInTheDocument();
    expect(screen.getByText('Nenhum evento da fila neste recorte.')).toBeInTheDocument();
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

    render(<MemoryRouter initialEntries={['/?report_view=explore']}><OccupancyCapacityReport /></MemoryRouter>);

    expect(screen.getByText('Dados preservados')).toBeInTheDocument();
    expect(screen.getByText('Check-ins sobre capacidade')).toBeInTheDocument();
  });

  it('separates offer, reservations and check-ins on a comparable matrix and preserves its URL view', () => {
    render(<MemoryRouter initialEntries={['/?report_view=explore&capacity_matrix=checked_in']}><OccupancyCapacityReport /></MemoryRouter>);
    expect(screen.getByRole('table', { name: 'Matriz de check-ins por dia e horário' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check-ins' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('columnheader', { name: '19:00' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Seg' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir reservas de Seg às 19:00: 20 pessoas' })).toHaveTextContent('20 / 50');
    fireEvent.click(screen.getByRole('button', { name: 'Oferta' }));
    expect(screen.getByRole('table', { name: 'Matriz de oferta por dia e horário' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir reservas de Seg às 19:00: 50 lugares ofertados' })).toHaveTextContent('50');
    expect(screen.getByText(/Não representa a ocupação física simultânea/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reservas' }));
    expect(screen.getByRole('button', { name: 'Abrir reservas de Seg às 19:00: 25 pessoas' })).toHaveTextContent('25 / 50');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Resumo' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('heading', { name: 'Leituras do período' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Explorar dados' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('table', { name: 'Matriz de reservas por dia e horário' })).toBeInTheDocument();
  });

  it('loads the complete authorized dataset on demand and filters matrix cells using the same capacity basis', async () => {
    const rows = [
      report.details[0],
      { ...report.details[0], id: 'other-time', time: '20:00:00' },
      { ...report.details[0], id: 'outside-basis', capacity_basis_available: false },
      { ...report.details[0], id: 'expired', status: 'payment_expired', counts_toward_capacity: false },
      { ...report.details[0], id: 'other-day', date: '2026-08-11' },
    ];
    api.rpc.mockImplementation(async (_name, params) => ({
      data: { ...report, details: rows.slice(0, params._page_size), meta: { ...report.meta, period_start: params._start_date, period_end: params._end_date, page: params._page, page_size: params._page_size, details_total: rows.length, availability_mode: params._availability_mode } },
      error: null,
    }));
    render(<MemoryRouter initialEntries={['/?report_view=explore&capacity_mode=tables']}><OccupancyCapacityReport /></MemoryRouter>);
    expect(api.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir reservas de Seg às 19:00: 25 pessoas' }));
    expect(screen.getByRole('dialog', { name: 'Reservas · Seg, 19:00' })).toBeInTheDocument();
    let loaded: ReportReservationRecord[] = [];
    await act(async () => { loaded = await openedRecords!.loadRecords(); });
    expect(loaded.map(row => row.id)).toEqual(['reservation-1']);
    expect(api.rpc).toHaveBeenCalledWith('get_occupancy_capacity_report', expect.objectContaining({
      _company_id: 'company-1', _start_date: '2026-08-01', _end_date: '2026-08-20',
      _availability_mode: 'tables', _outcome: 'all', _page: 1, _page_size: 100,
    }));
    expect(api.rpc).toHaveBeenCalledWith('get_occupancy_capacity_report', expect.objectContaining({
      _start_date: '2026-08-10', _end_date: '2026-08-10', _availability_mode: 'tables', _page_size: 1,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar registros' }));
    expect(screen.getByRole('table', { name: 'Matriz de reservas por dia e horário' })).toBeInTheDocument();
  });

  it('reads every page before presenting an indicator record list and surfaces a failed later page', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ ...report.details[0], id: `reservation-${index}` }));
    api.rpc.mockImplementation(async (_name, params) => ({
      data: { ...report, details: rows.slice((params._page - 1) * 100, params._page * 100), meta: { ...report.meta, page: params._page, page_size: 100, details_total: rows.length } },
      error: null,
    }));
    render(<MemoryRouter><OccupancyCapacityReport /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir registros de Pressão da demanda' }));
    let loaded: ReportReservationRecord[] = [];
    await act(async () => { loaded = await openedRecords!.loadRecords(); });
    expect(loaded).toHaveLength(101);
    expect(api.rpc).toHaveBeenCalledTimes(2);
    api.rpc.mockImplementation(async (_name, params) => params._page === 2
      ? { data: null, error: new Error('A página falhou') }
      : { data: { ...report, details: rows.slice(0, 100), meta: { ...report.meta, page: 1, page_size: 100, details_total: rows.length } }, error: null });
    await expect(openedRecords!.loadRecords()).rejects.toThrow('A página falhou');
  });
});
