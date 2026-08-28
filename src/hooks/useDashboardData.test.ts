import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDashboardDailyStats,
  type DashboardDailyReservationInput,
  useDashboardData,
} from '@/hooks/useDashboardData';

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

interface CapturedQueryOptions {
  queryKey: readonly unknown[];
  enabled?: boolean;
}

function getQueryOptions(queryKey: string) {
  const match = useQueryMock.mock.calls.find(([options]) => (
    (options as CapturedQueryOptions).queryKey[0] === queryKey
  ));

  expect(match, `Query ${queryKey} não foi registrada`).toBeDefined();
  return match![0] as CapturedQueryOptions;
}

function reservation(
  status: string,
  partySize: number,
  checkedInPartySize: number | null = null,
): DashboardDailyReservationInput {
  return {
    date: '2026-08-01',
    status,
    party_size: partySize,
    checked_in_party_size: checkedInPartySize,
    source: 'reservation',
  };
}

describe('buildDashboardDailyStats', () => {
  it('separa reservas ativas, perdidas e pendentes com a mesma regra da tela de Reservas', () => {
    const result = buildDashboardDailyStats(
      [
        reservation('confirmed', 2),
        reservation('checked_in', 3, 1),
        reservation('cancelled', 4),
        reservation('no-show', 5),
        reservation('payment_expired', 6),
        reservation('payment_cancelled', 7),
        reservation('paid_after_expiration', 8),
        reservation('pending_payment', 9),
      ],
      new Date(2026, 7, 1),
      new Date(2026, 7, 2),
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(expect.objectContaining({
      date: '2026-08-01',
      reservations: 8,
      totalGuests: 44,
      activeReservations: 2,
      activeGuests: 5,
      lostReservations: 5,
      lostGuests: 30,
      completed: 1,
      completedGuests: 1,
      cancellations: 1,
      noShows: 1,
    }));
    expect(result[1]).toEqual(expect.objectContaining({
      date: '2026-08-02',
      reservations: 0,
      activeReservations: 0,
      lostReservations: 0,
      totalGuests: 0,
    }));
  });

  it('mantém reservas convertidas da fila dentro dos totais operacionais', () => {
    const result = buildDashboardDailyStats(
      [{
        ...reservation('confirmed', 4),
        source: 'waitlist',
      }],
      new Date(2026, 7, 1),
      new Date(2026, 7, 1),
    );

    expect(result[0]).toEqual(expect.objectContaining({
      activeReservations: 1,
      activeGuests: 4,
      waitlistReservations: 1,
    }));
  });
});

describe('useDashboardData — perfil de consultas', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockImplementation((options: CapturedQueryOptions) => {
      const disabled = options.enabled === false;

      return {
        data: undefined,
        dataUpdatedAt: disabled ? 999 : 100,
        error: null,
        isError: false,
        isFetching: disabled,
        isLoading: disabled,
        refetch: vi.fn(),
      };
    });
  });

  it('mantém somente reservas atuais e anteriores quando o overview está desabilitado', () => {
    const { result } = renderHook(() => useDashboardData(
      'company-1',
      new Date(2026, 7, 1),
      new Date(2026, 7, 2),
      undefined,
      undefined,
      { includeReportOverview: false },
    ));

    expect(getQueryOptions('dashboard-reservations').enabled).toBeUndefined();
    expect(getQueryOptions('dashboard-reservations').queryKey).toContain('operational');
    expect(getQueryOptions('dashboard-reservations-prev').enabled).toBeUndefined();

    for (const queryKey of [
      'dashboard-waitlist',
      'dashboard-waitlist-seated',
      'dashboard-waitlist-dropped',
      'dashboard-reservations-created',
      'dashboard-daily-capacity',
    ]) {
      expect(getQueryOptions(queryKey).enabled).toBe(false);
    }

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(false);
    expect(result.current.lastUpdatedAt).toBe(100);
    expect(result.current.dailyStats).toHaveLength(2);
    expect(result.current.dailyCapacityStats).toEqual([]);
    expect(result.current.createdReservationDailyStats).toEqual([]);
    expect(result.current.reservationLeadTrend).toEqual([]);
    expect(result.current.reservationOriginBreakdown).toEqual({
      total: 0,
      totalPeople: 0,
      items: [],
    });
    expect(result.current.reservationOriginDailyStats).toEqual([]);
    expect(result.current.waitlistDailyStats).toEqual([]);
  });

  it('preserva por padrão o perfil completo para consumidores existentes', () => {
    const { result } = renderHook(() => useDashboardData(
      'company-1',
      new Date(2026, 7, 1),
      new Date(2026, 7, 2),
    ));

    expect(getQueryOptions('dashboard-reservations').queryKey).toEqual([
      'dashboard-reservations',
      'company-1',
      '2026-08-01',
      '2026-08-02',
    ]);

    for (const queryKey of [
      'dashboard-waitlist',
      'dashboard-waitlist-seated',
      'dashboard-waitlist-dropped',
      'dashboard-reservations-created',
      'dashboard-daily-capacity',
    ]) {
      expect(getQueryOptions(queryKey).enabled).toBe(true);
    }

    expect(result.current.createdReservationDailyStats).toHaveLength(2);
    expect(result.current.dailyCapacityStats).toHaveLength(2);
    expect(result.current.reservationOriginBreakdown.items).toHaveLength(4);
    expect(result.current.waitlistDailyStats).toHaveLength(2);
  });

  it('expõe falha operacional sem confundi-la com período vazio', () => {
    const operationalError = new Error('reservations unavailable');
    useQueryMock.mockImplementation((options: CapturedQueryOptions) => {
      const isOperationalFailure = options.queryKey[0] === 'dashboard-reservations';
      return {
        data: undefined,
        dataUpdatedAt: 0,
        error: isOperationalFailure ? operationalError : null,
        isError: isOperationalFailure,
        isFetching: false,
        isLoading: false,
        refetch: vi.fn(),
      };
    });

    const { result } = renderHook(() => useDashboardData(
      'company-1',
      new Date(2026, 7, 1),
      new Date(2026, 7, 2),
      undefined,
      undefined,
      { includeReportOverview: false },
    ));

    expect(result.current.operationalIsError).toBe(true);
    expect(result.current.reportOverviewIsError).toBe(false);
    expect(result.current.error).toBe(operationalError);
  });

  it('inclui capacidade no loading e no erro do overview', () => {
    const capacityError = new Error('capacity unavailable');
    useQueryMock.mockImplementation((options: CapturedQueryOptions) => {
      const isCapacity = options.queryKey[0] === 'dashboard-daily-capacity';
      return {
        data: undefined,
        dataUpdatedAt: 0,
        error: isCapacity ? capacityError : null,
        isError: isCapacity,
        isFetching: false,
        isLoading: isCapacity,
        refetch: vi.fn(),
      };
    });

    const { result } = renderHook(() => useDashboardData(
      'company-1',
      new Date(2026, 7, 1),
      new Date(2026, 7, 2),
    ));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.operationalIsError).toBe(false);
    expect(result.current.reportOverviewIsError).toBe(true);
    expect(result.current.error).toBe(capacityError);
  });
});
