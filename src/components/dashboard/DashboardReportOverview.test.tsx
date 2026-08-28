import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DashboardReportOverview, {
  type DashboardReportOverviewProps,
} from '@/components/dashboard/DashboardReportOverview';

const defaultProps: DashboardReportOverviewProps = {
  slug: 'beco-magico-goiania',
  search: '?period=30d&compare=1',
  canViewRecurrence: true,
  demand: {
    createdReservations: 1_258,
    scheduledCreated: 1_000,
    sameDayReservations: 250,
    waitlistCreated: 258,
    averageLeadDays: 4.5,
    dominantEntryLabel: 'Online',
    dominantEntryPercentage: 62.4,
  },
  attendance: {
    realizationRate: 81.7,
    losses: 143,
    noShows: 99,
    cancellations: 44,
    pending: 12,
  },
  capacity: {
    hasCapacity: true,
    occupancyRate: 74.2,
    pressureDays: 5,
    idleSeats: 1_320,
  },
  waitlist: {
    entries: 87,
    conversionRate: 78.2,
    averageWaitMinutes: 9,
    dropped: 6,
  },
  recurrence: {
    totalVisits: 412,
    firstVisits: 274,
    returnVisits: 138,
    returnRate: 33.5,
  },
};

const renderOverview = (props: Partial<DashboardReportOverviewProps> = {}) =>
  render(
    <MemoryRouter>
      <DashboardReportOverview {...defaultProps} {...props} />
    </MemoryRouter>,
  );

describe('DashboardReportOverview', () => {
  it('renders the four report links with accessible names and preserves the query string', () => {
    renderOverview();

    expect(screen.getByRole('heading', { name: 'Aprofunde a análise' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Demanda & conversão' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Comparecimento & perdas' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Ocupação & capacidade' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Recorrência' })).toBeVisible();

    expect(screen.getByRole('link', { name: 'Abrir relatório Demanda & conversão' })).toHaveAttribute(
      'href',
      '/beco-magico-goiania/admin/relatorios/demanda-conversao?period=30d&compare=1',
    );
    expect(screen.getByRole('link', { name: 'Abrir relatório Comparecimento & perdas' })).toHaveAttribute(
      'href',
      '/beco-magico-goiania/admin/relatorios/comparecimento-perdas?period=30d&compare=1',
    );
    expect(screen.getByRole('link', { name: 'Abrir relatório Ocupação & capacidade' })).toHaveAttribute(
      'href',
      '/beco-magico-goiania/admin/relatorios/ocupacao-capacidade?period=30d&compare=1',
    );
    expect(screen.getByRole('link', { name: 'Abrir relatório Recorrência' })).toHaveAttribute(
      'href',
      '/beco-magico-goiania/admin/relatorios/recorrencia?period=30d&compare=1',
    );
  });

  it('shows the compact demand, attendance, capacity and waitlist metrics', () => {
    renderOverview();

    const demandCard = screen.getByRole('link', { name: 'Abrir relatório Demanda & conversão' });
    expect(within(demandCard).getByText('1.258')).toBeVisible();
    expect(within(demandCard).getByText('4,5 dias')).toBeVisible();
    expect(within(demandCard).getByText('Online')).toBeVisible();
    expect(within(demandCard).getByText('62,4%')).toBeVisible();
    expect(within(demandCard).getByText('258')).toBeVisible();

    const attendanceCard = screen.getByRole('link', { name: 'Abrir relatório Comparecimento & perdas' });
    expect(within(attendanceCard).getByText('81,7%')).toBeVisible();
    expect(within(attendanceCard).getByText('143 perdas')).toBeVisible();
    expect(within(attendanceCard).getByText('99')).toBeVisible();
    expect(within(attendanceCard).getByText('44')).toBeVisible();
    expect(within(attendanceCard).getByText('12')).toBeVisible();

    const capacityCard = screen.getByRole('link', { name: 'Abrir relatório Ocupação & capacidade' });
    expect(within(capacityCard).getByText('74,2%')).toBeVisible();
    expect(within(capacityCard).getByText('1.320 lugares ociosos')).toBeVisible();
    expect(within(capacityCard).getByText('87')).toBeVisible();
    expect(within(capacityCard).getByText('78,2%')).toBeVisible();
    expect(within(capacityCard).getByText('9 min')).toBeVisible();
    expect(within(capacityCard).getByText('6')).toBeVisible();
  });

  it('derives the last-minute, no-show and pressure readings from the raw counters', () => {
    renderOverview();

    expect(screen.getByRole('link', { name: 'Abrir relatório Demanda & conversão' })).toHaveTextContent(
      '25% entram em cima da hora, no mesmo dia da visita',
    );
    expect(screen.getByRole('link', { name: 'Abrir relatório Comparecimento & perdas' })).toHaveTextContent(
      '143 perdas, e 69,2% delas viraram no-show',
    );
    expect(screen.getByRole('link', { name: 'Abrir relatório Ocupação & capacidade' })).toHaveTextContent(
      '1.320 lugares ociosos · 5 dias sob pressão',
    );
  });

  it('breaks the recurrence card into first visits and returns', () => {
    renderOverview();

    const recurrenceCard = screen.getByRole('link', { name: 'Abrir relatório Recorrência' });
    expect(within(recurrenceCard).getByText('33,5%')).toBeVisible();
    expect(within(recurrenceCard).getByText('412')).toBeVisible();
    expect(within(recurrenceCard).getByText('138')).toBeVisible();
    expect(recurrenceCard).toHaveTextContent('274 primeiras visitas para conquistar no período');
  });

  it('explains when the period has no identified visits for recurrence', () => {
    renderOverview({ recurrence: null });

    const recurrenceCard = screen.getByRole('link', { name: 'Abrir relatório Recorrência' });
    expect(recurrenceCard).toHaveTextContent('Sem visitas identificadas para medir recorrência no período.');
    expect(within(recurrenceCard).queryByLabelText('Composição das visitas')).not.toBeInTheDocument();
  });

  it('reserva o espaço do resumo de recorrência enquanto carrega', () => {
    renderOverview({ recurrence: null, recurrenceStatus: 'loading' });

    expect(screen.getByRole('status', { name: 'Carregando resumo de recorrência' })).toBeVisible();
  });

  it('diferencia erro de carregamento de um período vazio', () => {
    renderOverview({ recurrence: null, recurrenceStatus: 'error' });

    expect(screen.getByText('Não foi possível carregar o resumo de recorrência agora.')).toBeVisible();
  });

  it('avoids dividing by zero when there is no scheduled demand and no losses', () => {
    renderOverview({
      demand: { ...defaultProps.demand, scheduledCreated: 0, sameDayReservations: 0 },
      attendance: { ...defaultProps.attendance, losses: 0, noShows: 0, cancellations: 0 },
    });

    expect(screen.getByRole('link', { name: 'Abrir relatório Demanda & conversão' })).toHaveTextContent(
      'Sem reservas agendadas para medir antecedência',
    );
    expect(screen.getByRole('link', { name: 'Abrir relatório Comparecimento & perdas' })).toHaveTextContent(
      'Nenhuma perda registrada no período',
    );
  });

  it('omits only Recorrência when access is unavailable', () => {
    renderOverview({ canViewRecurrence: false, search: '' });

    expect(screen.queryByRole('link', { name: 'Abrir relatório Recorrência' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Abrir relatório Demanda & conversão' })).toHaveAttribute(
      'href',
      '/beco-magico-goiania/admin/relatorios/demanda-conversao',
    );
    expect(screen.getByRole('link', { name: 'Abrir relatório Comparecimento & perdas' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Abrir relatório Ocupação & capacidade' })).toBeVisible();
  });

  it('communicates when no capacity rule is configured while keeping the waitlist pulse', () => {
    renderOverview({
      capacity: {
        hasCapacity: false,
        occupancyRate: 0,
        pressureDays: 0,
      },
    });

    const capacityCard = screen.getByRole('link', { name: 'Abrir relatório Ocupação & capacidade' });
    expect(within(capacityCard).getByText('capacidade não configurada')).toBeVisible();
    expect(within(capacityCard).getByLabelText('Pulso da fila de espera')).toBeVisible();
    expect(within(capacityCard).getByText('87')).toBeVisible();
  });
});
