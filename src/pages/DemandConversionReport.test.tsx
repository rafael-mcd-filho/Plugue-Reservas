import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DemandConversionReport from '@/pages/DemandConversionReport';
import type { DemandConversionReport as DemandConversionReportData } from '@/hooks/useDemandConversionReport';
import type { DemandTemporalAnalysis } from '@/hooks/useDemandTemporalAnalysis';

const refetch = vi.fn();
const temporalRefetch = vi.fn();
let companyTimeZoneResolved = true;
let reportQueryState: {
  data?: DemandConversionReportData;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error?: Error;
  refetch: typeof refetch;
};
let temporalQueryState: {
  data?: DemandTemporalAnalysis;
  isError: boolean;
  isFetching: boolean;
  refetch: typeof temporalRefetch;
};
const useDemandConversionReportMock = vi.fn((_params?: unknown) => reportQueryState);

vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({
    companyId: 'company-1',
    companyName: 'Restaurante Teste',
    companyTimeZone: 'America/Manaus',
    companyTimeZoneResolved,
    slug: 'restaurante-teste',
  }),
}));

vi.mock('@/hooks/useReportFilters', () => ({
  useReportFilters: () => ({
    periodPreset: 'last_30_days',
    range: { from: new Date('2026-08-01'), to: new Date('2026-08-20') },
    dateRange: { from: new Date('2026-08-01'), to: new Date('2026-08-20') },
    dateOnlyRange: { from: '2026-08-01', to: '2026-08-20' },
    comparisonRange: null,
    comparisonDateOnlyRange: null,
    granularity: 'day',
    comparisonEnabled: false,
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
  AreaChart: () => <div data-testid="area-chart" />,
  BarChart: ({ children }: { children?: ReactNode }) => <div data-testid="bar-chart">{children}</div>,
  ComposedChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Area: () => null,
  Bar: ({ dataKey, name, stackId }: { dataKey?: string; name?: string; stackId?: string }) => (
    <div data-testid="bar-series" data-data-key={dataKey} data-stack-id={stackId}>{name}</div>
  ),
  CartesianGrid: () => null,
  Cell: () => null,
  LabelList: () => null,
  Legend: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock('@/hooks/useDemandTemporalAnalysis', () => ({
  useDemandTemporalAnalysis: () => temporalQueryState,
}));

vi.mock('@/hooks/useDemandConversionReport', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useDemandConversionReport')>('@/hooks/useDemandConversionReport');
  return {
    ...actual,
    useDemandConversionReport: (params: unknown) => useDemandConversionReportMock(params),
  };
});

const report: DemandConversionReportData = {
  summary: {
    sessions: 100,
    completed: 30,
    overall_conversion_rate: 30,
    created_reservations: 42,
    created_people: 118,
    average_lead_days: 6.5,
  },
  comparison: null,
  funnel: [
    { step: 'page_view', label: 'Página pública', count: 100, conversion_from_previous: 100, conversion_from_start: 100, dropoff: 30, dropoff_rate: 30 },
    { step: 'date_select', label: 'Seleção de data', count: 70, conversion_from_previous: 70, conversion_from_start: 70, dropoff: 40, dropoff_rate: 57.1 },
    { step: 'time_select', label: 'Seleção de horário', count: 55, conversion_from_previous: 78.6, conversion_from_start: 55, dropoff: 15, dropoff_rate: 27.3 },
    { step: 'form_fill', label: 'Dados pessoais', count: 40, conversion_from_previous: 72.7, conversion_from_start: 40, dropoff: 10, dropoff_rate: 25 },
    { step: 'completed', label: 'Reserva finalizada', count: 30, conversion_from_previous: 42.9, conversion_from_start: 30, dropoff: 0, dropoff_rate: 0 },
  ],
  trend: [{ period: '2026-08-01', page_views: 100, date_selections: 70, time_selections: 55, forms: 40, completed: 30, created_reservations: 42, created_people: 118 }],
  transition_times: [{ key: 'page_to_date', from_label: 'Página pública', to_label: 'Seleção de data', median_seconds: 25, sample_size: 70 }],
  lead_time_bands: [{ key: 'same_day', label: 'Mesmo dia', reservations: 12, people: 28, percentage: 28.6 }],
  entry_modes: [
    { key: 'online', label: 'Online', reservations: 20, people: 54, percentage: 47.6 },
    { key: 'affiliate', label: 'Filiados e parceiros', reservations: 4, people: 10, percentage: 9.5 },
    { key: 'manual', label: 'Criada no painel', reservations: 14, people: 42, percentage: 33.3 },
    { key: 'waitlist', label: 'Convertida da fila', reservations: 4, people: 12, percentage: 9.5 },
  ],
  party_size_bands: [
    { key: 'one_two', label: '1–2 pessoas', reservations: 14, people: 24, percentage: 33.3 },
    { key: 'three_four', label: '3–4 pessoas', reservations: 20, people: 70, percentage: 47.6 },
    { key: 'five_six', label: '5–6 pessoas', reservations: 6, people: 32, percentage: 14.3 },
    { key: 'seven_plus', label: '7+ pessoas', reservations: 2, people: 16, percentage: 4.8 },
  ],
  details: [{
    id: 'reservation-1', guest_name: 'Cliente Teste', guest_phone: '5599999999999', guest_email: null,
    reservation_date: '2026-08-10', reservation_time: '19:00:00', party_size: 3, status: 'confirmed',
    entry_mode: 'online', lead_days: 4, created_at: '2026-08-06T12:00:00Z', source: 'public',
    origin_affiliate_code: null, origin_affiliate_name: null, checked_in_at: null, checked_in_party_size: null,
    updated_at: '2026-08-06T12:00:00Z', occasion: null, notes: null, table_id: null,
    created_in_mode: 'availability', public_tracking_code: 'track-1',
  }],
  meta: {
    period_start: '2026-08-01', period_end: '2026-08-20', time_zone: 'America/Manaus', unique_only: false,
    comparison_enabled: false, comparison_start: null, comparison_end: null, granularity: 'day', page: 1,
    page_size: 15, details_total: 1, entry_mode: 'all', search: null,
    generated_at: '2026-08-20T12:00:00Z', funnel_source: 'tracking_funnel_sessions',
  },
};

describe('DemandConversionReport', () => {
  beforeEach(() => {
    refetch.mockClear();
    temporalRefetch.mockClear();
    useDemandConversionReportMock.mockClear();
    companyTimeZoneResolved = true;
    reportQueryState = { data: report, isPending: false, isError: false, isFetching: false, refetch };
    temporalQueryState = {
      data: {
        entry_mode_created_trend: [
          {
            period: '2026-08-01',
            online_reservations: 3, online_people: 8,
            affiliate_reservations: 1, affiliate_people: 2,
            manual_reservations: 2, manual_people: 5,
            waitlist_reservations: 0, waitlist_people: 0,
          },
          {
            period: '2026-08-02',
            online_reservations: 1, online_people: 3,
            affiliate_reservations: 0, affiliate_people: 0,
            manual_reservations: 1, manual_people: 2,
            waitlist_reservations: 1, waitlist_people: 4,
          },
        ],
        entry_mode_visit_trend: [
          {
            period: '2026-08-01',
            online_reservations: 2, online_people: 6,
            affiliate_reservations: 1, affiliate_people: 3,
            manual_reservations: 3, manual_people: 8,
            waitlist_reservations: 1, waitlist_people: 2,
          },
          {
            period: '2026-08-02',
            online_reservations: 2, online_people: 5,
            affiliate_reservations: 1, affiliate_people: 2,
            manual_reservations: 1, manual_people: 3,
            waitlist_reservations: 1, waitlist_people: 4,
          },
        ],
        lead_time_trend: [],
        meta: {
          period_start: '2026-08-01',
          period_end: '2026-08-20',
          time_zone: 'America/Manaus',
          granularity: 'day',
          generated_at: '2026-08-20T12:00:00Z',
        },
      },
      isError: false,
      isFetching: false,
      refetch: temporalRefetch,
    };
  });

  it('separates the total funnel from reservation-entry filters', () => {
    render(<MemoryRouter><DemandConversionReport /></MemoryRouter>);

    expect(screen.getByText('Funil web total; não muda com a forma de entrada')).toBeInTheDocument();
    expect(screen.getByText(/o funil web permanece total/)).toBeInTheDocument();
    expect(screen.getByText(/não depende de mesa ou seção/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1–2 pessoas' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Funil de Reservas' })).toBeInTheDocument();
    expect(screen.getByText(/percentual ao fim de cada barra é sobre a base inicial/)).toBeInTheDocument();
    expect(screen.getByText(/Taxa de conversão geral:/)).toHaveTextContent('30,0%');
  });

  it('keeps the visit-date entry evolution visible inside the entry card', () => {
    render(<MemoryRouter><DemandConversionReport /></MemoryRouter>);

    const evolution = screen.getByRole('region', { name: 'Evolução das formas de entrada' });
    expect(within(evolution).getByText('Forma de entrada por dia')).toBeInTheDocument();
    expect(within(evolution).getByText(/Uma barra empilhada por data da visita/)).toBeInTheDocument();

    let series = within(evolution).getAllByTestId('bar-series');
    expect(series.map((element) => element.dataset.dataKey)).toEqual([
      'online_reservations', 'affiliate_reservations', 'manual_reservations', 'waitlist_reservations',
    ]);
    expect(series.every((element) => element.dataset.stackId === 'entry-mode-over-time')).toBe(true);

    const metricControl = screen.getByLabelText('Métrica das formas de entrada');
    fireEvent.click(within(metricControl).getByRole('button', { name: 'Pessoas' }));

    series = within(screen.getByRole('region', { name: 'Evolução das formas de entrada' })).getAllByTestId('bar-series');
    expect(series.map((element) => element.dataset.dataKey)).toEqual([
      'online_people', 'affiliate_people', 'manual_people', 'waitlist_people',
    ]);
  });

  it('does not expose the per-reservation listing', () => {
    render(<MemoryRouter><DemandConversionReport /></MemoryRouter>);

    expect(screen.queryByText('Reservas criadas no período')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente Teste')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('preserves the visit-date entry view with a compact summary and stacked bars', () => {
    render(
      <MemoryRouter initialEntries={['/?analysis=entry_visit']}>
        <DemandConversionReport />
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: 'Entrada por visita' })).toHaveAttribute('aria-selected', 'true');
    const summary = screen.getByRole('region', { name: 'Formas de entrada das reservas' });
    expect(summary).toHaveTextContent('12 reservas · 33 pessoas');
    expect(within(summary).getByRole('article', { name: 'Online: 4 reservas, 33,3%, 11 pessoas' })).toBeInTheDocument();
    expect(within(summary).getByRole('article', { name: 'Filiados e parceiros: 2 reservas, 16,7%, 5 pessoas' })).toBeInTheDocument();
    expect(within(summary).getByRole('article', { name: 'Criada no painel: 4 reservas, 33,3%, 11 pessoas' })).toBeInTheDocument();
    expect(within(summary).getByRole('article', { name: 'Convertida da fila: 2 reservas, 16,7%, 6 pessoas' })).toBeInTheDocument();

    let series = within(screen.getByRole('tabpanel', { name: 'Evolução: Entrada por visita' })).getAllByTestId('bar-series');
    expect(series).toHaveLength(4);
    expect(series.map((element) => element.dataset.dataKey)).toEqual([
      'online_reservations', 'affiliate_reservations', 'manual_reservations', 'waitlist_reservations',
    ]);
    expect(series.every((element) => element.dataset.stackId === 'entry-mode')).toBe(true);

    fireEvent.click(within(screen.getByLabelText('Métrica da evolução')).getByRole('button', { name: 'Pessoas' }));
    series = within(screen.getByRole('tabpanel', { name: 'Evolução: Entrada por visita' })).getAllByTestId('bar-series');
    expect(series.map((element) => element.dataset.dataKey)).toEqual([
      'online_people', 'affiliate_people', 'manual_people', 'waitlist_people',
    ]);
  });

  it('keeps the entry-by-capture view backed by creation-date totals', () => {
    render(
      <MemoryRouter initialEntries={['/?analysis=entry_created']}>
        <DemandConversionReport />
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: 'Entrada por captação' })).toHaveAttribute('aria-selected', 'true');
    const summary = screen.getByRole('region', { name: 'Formas de entrada das reservas' });
    expect(summary).toHaveTextContent('9 reservas · 24 pessoas');
    expect(summary).toHaveTextContent('Distribuição pela data em que a reserva foi registrada');
    expect(within(summary).getByRole('article', { name: 'Online: 4 reservas, 44,4%, 11 pessoas' })).toBeInTheDocument();
  });

  it('renders explicit empty states instead of empty charts', () => {
    reportQueryState = {
      data: {
        ...report,
        summary: { sessions: 0, completed: 0, overall_conversion_rate: 0, created_reservations: 0, created_people: 0, average_lead_days: 0 },
        funnel: report.funnel.map((stage) => ({ ...stage, count: 0, dropoff: 0, dropoff_rate: 0, conversion_from_previous: 0, conversion_from_start: 0 })),
        trend: [], transition_times: [], lead_time_bands: [],
        party_size_bands: report.party_size_bands.map((band) => ({ ...band, reservations: 0, people: 0, percentage: 0 })),
        details: [],
        meta: { ...report.meta, details_total: 0 },
      },
      isPending: false,
      isError: false,
      isFetching: false,
      refetch,
    };

    render(<MemoryRouter><DemandConversionReport /></MemoryRouter>);

    expect(screen.getByText('Nenhuma jornada pública no período')).toBeInTheDocument();
    expect(screen.getByText('Sem dados para esta leitura')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma reserva criada neste recorte.')).toBeInTheDocument();
    expect(screen.getByText('Nenhum grupo reservado neste recorte.')).toBeInTheDocument();
  });

  it('shows a recoverable error state when no report is available', () => {
    reportQueryState = { isPending: false, isError: true, isFetching: false, error: new Error('offline'), refetch };

    render(<MemoryRouter><DemandConversionReport /></MemoryRouter>);

    expect(screen.getByText('Não foi possível abrir o relatório')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('keeps the report query disabled until the company time zone is resolved', () => {
    companyTimeZoneResolved = false;

    render(<MemoryRouter><DemandConversionReport /></MemoryRouter>);

    expect(useDemandConversionReportMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.getByLabelText('Carregando relatório')).toBeInTheDocument();
  });
});
