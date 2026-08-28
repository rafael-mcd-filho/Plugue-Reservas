import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '@/pages/Dashboard';

const useDashboardDataMock = vi.hoisted(() => vi.fn());
const useLiveFunnelPresenceMock = vi.hoisted(() => vi.fn());
const useCompanyFeatureFlagsMock = vi.hoisted(() => vi.fn());
const useCompanyPermissionsMock = vi.hoisted(() => vi.fn());
const useMaybeCompanySlugMock = vi.hoisted(() => vi.fn());
const useCustomerRecurrenceVisitSeriesMock = vi.hoisted(() => vi.fn());
const referenceLineMock = vi.hoisted(() => vi.fn());

const realtime = vi.hoisted(() => {
  const channelApi: {
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  } = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };

  channelApi.on.mockImplementation(() => channelApi);
  channelApi.subscribe.mockImplementation(() => channelApi);

  return {
    channelApi,
    channel: vi.fn(() => channelApi),
    removeChannel: vi.fn(),
  };
});

const companiesQuery = vi.hoisted(() => ({
  from: vi.fn(() => ({
    select: vi.fn(() => ({
      order: vi.fn(async () => ({ data: [], error: null })),
    })),
  })),
}));

vi.mock('@/contexts/CompanySlugContext', () => ({
  useMaybeCompanySlug: () => useMaybeCompanySlugMock(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => useDashboardDataMock(...args),
}));

vi.mock('@/hooks/useLiveFunnelPresence', () => ({
  useLiveFunnelPresence: (...args: unknown[]) => useLiveFunnelPresenceMock(...args),
}));

vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatureFlags: (...args: unknown[]) => useCompanyFeatureFlagsMock(...args),
}));

vi.mock('@/hooks/useCompanyPermissions', () => ({
  useCompanyPermissions: () => useCompanyPermissionsMock(),
}));

vi.mock('@/hooks/useCustomerRecurrenceVisitSeries', () => ({
  useCustomerRecurrenceVisitSeries: (...args: unknown[]) => useCustomerRecurrenceVisitSeriesMock(...args),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: realtime.channel,
    removeChannel: realtime.removeChannel,
    from: companiesQuery.from,
  },
}));

vi.mock('@/components/dashboard/DashboardReportOverview', () => ({
  default: () => <div data-testid="dashboard-report-overview" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  CartesianGrid: () => null,
  Cell: () => null,
  Legend: () => null,
  Line: () => null,
  Pie: () => null,
  ReferenceLine: (props: Record<string, unknown>) => {
    referenceLineMock(props);
    return null;
  },
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const currentTotals = {
  reservations: 1_345,
  scheduledReservations: 1_234,
  waitlistReservations: 111,
  completed: 1_000,
  scheduledCompleted: 920,
  waitlistCompleted: 80,
  confirmed: 0,
  cancellations: 145,
  noShows: 200,
  totalGuests: 5_678,
  checkedInGuests: 4_000,
  noShowGuests: 1_000,
  cancelledGuests: 678,
};

const previousTotals = {
  reservations: 1_200,
  scheduledReservations: 1_100,
  waitlistReservations: 100,
  completed: 900,
  scheduledCompleted: 830,
  waitlistCompleted: 70,
  confirmed: 0,
  cancellations: 130,
  noShows: 170,
  totalGuests: 5_000,
  checkedInGuests: 3_600,
  noShowGuests: 850,
  cancelledGuests: 550,
};

const dashboardData = {
  dailyStats: [{
    date: '2026-08-01',
    label: '01/08',
    reservations: 1_345,
    activeReservations: 1_000,
    lostReservations: 345,
    scheduledReservations: 1_234,
    waitlistReservations: 111,
    completed: 1_000,
    scheduledCompleted: 920,
    waitlistCompleted: 80,
    confirmed: 0,
    cancellations: 145,
    noShows: 200,
    totalGuests: 5_678,
    activeGuests: 4_000,
    lostGuests: 1_678,
    completedGuests: 4_000,
    noShowGuests: 1_000,
    cancelledGuests: 678,
  }],
  dailyCapacityStats: [{
    date: '2026-08-01',
    label: '01/08',
    totalCapacity: 5_000,
    slotCount: 10,
    checkedInGuests: 4_000,
    occupancyRate: 80,
    overCapacityGuests: 0,
    status: 'below',
  }],
  dailyCapacityTotals: {
    totalCapacity: 5_000,
    checkedInGuests: 4_000,
    occupancyRate: 80,
    daysWithCapacity: 1,
    fullDays: 0,
    overCapacityDays: 0,
    noCapacityDays: 0,
  },
  createdReservationDailyStats: [{
    date: '2026-08-01',
    label: '01/08',
    createdReservations: 40,
    scheduledCreatedReservations: 35,
    waitlistCreatedReservations: 5,
  }],
  reservationLeadTrend: [{
    date: '2026-08-01',
    label: '01/08',
    createdReservations: 40,
    avgLeadDays: 4,
    sameDayReservations: 10,
  }],
  createdReservationTotals: {
    totalCreated: 40,
    scheduledCreated: 35,
    waitlistCreated: 5,
    avgLeadDays: 4,
    sameDayReservations: 10,
  },
  reservationOriginBreakdown: {
    total: 1_345,
    totalPeople: 5_678,
    items: [
      { key: 'online', label: 'Online', value: 900, people: 3_600, percentage: 66.9, color: '#1598df' },
      { key: 'affiliate', label: 'Filiados e parceiros', value: 45, people: 180, percentage: 3.3, color: '#27aa62' },
      { key: 'manual', label: 'Criada no painel', value: 300, people: 1_400, percentage: 22.3, color: '#666' },
      { key: 'waitlist', label: 'Convertida da fila', value: 100, people: 498, percentage: 7.5, color: '#e52c78' },
    ],
  },
  reservationOriginDailyStats: [{
    date: '2026-08-01',
    label: '01/08',
    totalReservations: 1_345,
    totalPeople: 5_678,
    online: 900,
    affiliate: 45,
    manual: 300,
    waitlist: 100,
    onlinePeople: 3_600,
    affiliatePeople: 180,
    manualPeople: 1_400,
    waitlistPeople: 498,
  }],
  waitlistDailyStats: [{
    date: '2026-08-01',
    label: '01/08',
    entries: 14,
    seated: 10,
    dropped: 4,
    avgWaitMin: 12,
  }],
  totals: currentTotals,
  prevTotals: previousTotals,
  waitlistTotals: { total: 14, seated: 10, expired: 4, avgWaitMin: 12 },
  isLoading: false,
  isFetching: false,
  lastUpdatedAt: Date.now(),
  operationalIsError: false,
  reportOverviewIsError: false,
  error: null,
  refetch: vi.fn(async () => undefined),
};

const livePresenceQuery = {
  data: {
    totalActive: 4,
    windowMinutes: 5,
    stages: [
      { stage: 'page_view', count: 2 },
      { stage: 'date_select', count: 1 },
      { stage: 'time_select', count: 1 },
      { stage: 'form_fill', count: 0 },
      { stage: 'completed', count: 0 },
    ],
  },
  dataUpdatedAt: Date.now(),
  isFetching: false,
};

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Dashboard — blocos operacionais protegidos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMaybeCompanySlugMock.mockReturnValue({
      companyId: 'company-1',
      companyName: 'Restaurante Teste',
      companyLogoUrl: null,
      companyTimeZone: 'America/Sao_Paulo',
      companyTimeZoneAvailable: true,
      companyTimeZoneResolved: true,
      slug: 'restaurante-teste',
    });
    useDashboardDataMock.mockReturnValue(dashboardData);
    useLiveFunnelPresenceMock.mockReturnValue(livePresenceQuery);
    useCompanyFeatureFlagsMock.mockReturnValue({
      data: { planTier: 'growth', features: { advanced_reports: true } },
      isLoading: false,
    });
    useCompanyPermissionsMock.mockReturnValue({
      activeRoles: ['admin'],
      hasPermission: () => true,
      permissionsError: null,
      permissionsLoading: false,
    });
    useCustomerRecurrenceVisitSeriesMock.mockReturnValue({
      data: { series: [] },
      isLoading: false,
      isError: false,
    });
  });

  it('mantém Ao Vivo, Resumo e Funil com os totais essenciais no contexto da empresa', () => {
    renderDashboard();

    expect(screen.getByText('Ao Vivo')).toBeInTheDocument();
    expect(screen.getByText('Resumo de Atendimentos')).toBeInTheDocument();
    expect(screen.getByText('Funil de Conversão')).toBeInTheDocument();

    expect(screen.getByText('1.234')).toBeInTheDocument();
    expect(screen.getAllByText('1.345').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('5.678').length).toBeGreaterThanOrEqual(2);
    expect(useLiveFunnelPresenceMock).toHaveBeenCalledWith('company-1');
    expect(useDashboardDataMock.mock.calls.at(-1)?.[5]).toEqual({ includeReportOverview: true });
  });

  it('reserva o espaço do Ao Vivo antes da primeira resposta', () => {
    useLiveFunnelPresenceMock.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      isFetching: true,
      isPending: true,
      isError: false,
    });

    renderDashboard();

    expect(screen.getByText('Ao Vivo')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Carregando atividade ao vivo' })).toBeInTheDocument();
    expect(screen.getByText('Resumo de Atendimentos')).toBeInTheDocument();
  });

  it('usa um skeleton compacto alinhado à composição final', () => {
    useDashboardDataMock.mockReturnValue({ ...dashboardData, isLoading: true });

    renderDashboard();

    expect(screen.getByRole('status', { name: 'Carregando dados da Dashboard' })).toBeInTheDocument();
    expect(screen.queryByText('Resumo de Atendimentos')).not.toBeInTheDocument();
  });

  it('não transforma falha operacional em indicadores zerados', () => {
    const refetch = vi.fn(async () => undefined);
    useDashboardDataMock.mockReturnValue({
      ...dashboardData,
      operationalIsError: true,
      refetch,
    });

    renderDashboard();

    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar a Dashboard');
    expect(screen.queryByText('Resumo de Atendimentos')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('isola falha do overview sem esconder os indicadores operacionais', () => {
    useDashboardDataMock.mockReturnValue({
      ...dashboardData,
      reportOverviewIsError: true,
    });

    renderDashboard();

    expect(screen.getByText('Resumo de Atendimentos')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Resumo dos relatórios indisponível');
    expect(screen.queryByTestId('dashboard-report-overview')).not.toBeInTheDocument();
  });

  it('não remove o Resumo nem o Funil operacional quando relatórios avançados estão desativados', () => {
    useCompanyFeatureFlagsMock.mockReturnValue({
      data: { planTier: 'basic', features: { advanced_reports: false } },
      isLoading: false,
    });

    renderDashboard();

    expect(screen.getByText('Ao Vivo')).toBeInTheDocument();
    expect(screen.getByText('Resumo de Atendimentos')).toBeInTheDocument();
    expect(screen.getByText('Funil de Conversão')).toBeInTheDocument();
    expect(screen.getByText('1.234')).toBeInTheDocument();
    expect(screen.getAllByText('5.678').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Reservas por dia')).not.toBeInTheDocument();
    expect(screen.queryByText('Fila de Espera por Dia')).not.toBeInTheDocument();
    expect(screen.queryByText('Ocupação da capacidade diária')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-report-overview')).not.toBeInTheDocument();
    expect(useDashboardDataMock.mock.calls.at(-1)?.[5]).toEqual({ includeReportOverview: false });
  });

  it('mantém o dashboard global enxuto sem atalhos de relatórios ou gráficos legados', () => {
    useMaybeCompanySlugMock.mockReturnValue(null);

    renderDashboard();

    expect(screen.getByText('Resumo de Atendimentos')).toBeInTheDocument();
    expect(screen.getByText('Funil de Conversão')).toBeInTheDocument();
    expect(screen.getByText('Reservas por dia')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-report-overview')).not.toBeInTheDocument();
    expect(screen.queryByText('Fila de Espera por Dia')).not.toBeInTheDocument();
    expect(screen.queryByText('Ocupação da capacidade diária')).not.toBeInTheDocument();
    expect(screen.queryByText('Forma de entrada das reservas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reservation-funnel-chart')).not.toBeInTheDocument();
    expect(realtime.channel).not.toHaveBeenCalled();
    expect(useDashboardDataMock.mock.calls.at(-1)?.[5]).toEqual({ includeReportOverview: false });
  });

  it('troca os gráficos inferiores pelo overview para admin com relatórios avançados', () => {
    renderDashboard();

    expect(screen.getByText('Reservas por dia')).toBeInTheDocument();
    expect(screen.queryByText('Esperado vs. Realizado')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-report-overview')).toBeInTheDocument();
    expect(screen.queryByText('Fila de Espera por Dia')).not.toBeInTheDocument();
    expect(screen.queryByText('Ocupação da capacidade diária')).not.toBeInTheDocument();
    expect(screen.queryByText('Forma de entrada das reservas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reservation-funnel-chart')).not.toBeInTheDocument();
    expect(realtime.channelApi.on).toHaveBeenCalledTimes(2);
  });

  it('mostra somente reservas ativas e alterna a métrica para pessoas', () => {
    renderDashboard();

    const reservationsButton = screen.getByRole('button', { name: 'Reservas' });
    const peopleButton = screen.getByRole('button', { name: 'Pessoas' });

    expect(reservationsButton).toHaveAttribute('aria-pressed', 'true');
    expect(peopleButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByText('1.000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Reservas ativas pela data da visita no período selecionado.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ativas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Perdidas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Todas' })).not.toBeInTheDocument();
    expect(referenceLineMock).toHaveBeenLastCalledWith(expect.objectContaining({ y: 1_000, isFront: true }));

    fireEvent.click(peopleButton);

    expect(reservationsButton).toHaveAttribute('aria-pressed', 'false');
    expect(peopleButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('4.000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('4.000 pessoas')).toBeInTheDocument();
    expect(referenceLineMock).toHaveBeenLastCalledWith(expect.objectContaining({ y: 4_000 }));
  });

  it('calcula a média diária incluindo dias sem reservas e mantém o primeiro pico', () => {
    useDashboardDataMock.mockReturnValue({
      ...dashboardData,
      dailyStats: [
        dashboardData.dailyStats[0],
        {
          ...dashboardData.dailyStats[0],
          date: '2026-08-02',
          label: '02/08',
          reservations: 0,
          activeReservations: 0,
          lostReservations: 0,
          scheduledReservations: 0,
          waitlistReservations: 0,
          completed: 0,
          scheduledCompleted: 0,
          waitlistCompleted: 0,
          confirmed: 0,
          cancellations: 0,
          noShows: 0,
          totalGuests: 0,
          activeGuests: 0,
          lostGuests: 0,
          completedGuests: 0,
          noShowGuests: 0,
          cancelledGuests: 0,
        },
      ],
    });

    renderDashboard();

    expect(screen.getByText('500,0')).toBeInTheDocument();
    expect(screen.getAllByText('01/08').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1.000 reservas')).toBeInTheDocument();
    expect(referenceLineMock).toHaveBeenLastCalledWith(expect.objectContaining({
      y: 500,
      label: expect.objectContaining({ value: 'Média 500,0' }),
    }));
  });

  it('explica o estado vazio nas duas métricas sem oferecer outros estados', () => {
    useDashboardDataMock.mockReturnValue({
      ...dashboardData,
      dailyStats: [{
        ...dashboardData.dailyStats[0],
        activeReservations: 0,
        activeGuests: 0,
      }],
    });

    renderDashboard();

    expect(screen.getByText('Nenhuma reserva ativa no período')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pessoas' }));

    expect(screen.getByText('Nenhuma reserva ativa no período')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Todas' })).not.toBeInTheDocument();
  });

  it('mantém a dashboard enxuta para operador sem expor atalhos ou gráficos legados', () => {
    useCompanyPermissionsMock.mockReturnValue({
      activeRoles: ['operator'],
      hasPermission: () => true,
      permissionsError: null,
      permissionsLoading: false,
    });

    renderDashboard();

    expect(screen.queryByTestId('dashboard-report-overview')).not.toBeInTheDocument();
    expect(screen.getByText('Reservas por dia')).toBeInTheDocument();
    expect(screen.queryByText('Fila de Espera por Dia')).not.toBeInTheDocument();
    expect(screen.queryByText('Ocupação da capacidade diária')).not.toBeInTheDocument();
    expect(screen.queryByText('Forma de entrada das reservas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reservation-funnel-chart')).not.toBeInTheDocument();
    expect(realtime.channelApi.on).toHaveBeenCalledTimes(1);
    expect(useDashboardDataMock.mock.calls.at(-1)?.[5]).toEqual({ includeReportOverview: false });
  });

  it('assina e encerra o realtime da empresa sem emitir erro', () => {
    const consoleError = vi.spyOn(console, 'error');
    const { unmount } = renderDashboard();

    expect(realtime.channel).toHaveBeenCalledWith('dashboard-live:company-1');
    expect(realtime.channelApi.on).toHaveBeenCalledTimes(2);
    expect(realtime.channelApi.subscribe).toHaveBeenCalledTimes(1);

    expect(() => unmount()).not.toThrow();
    expect(realtime.removeChannel).toHaveBeenCalledWith(realtime.channelApi);
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
