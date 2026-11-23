import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReportFilters } from './useReportFilters';

function createWrapper(initialEntry: string) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>;
  };
}

describe('useReportFilters', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it('hydrates custom period, granularity and comparison from the URL', () => {
    const { result } = renderHook(() => useReportFilters(), {
      wrapper: createWrapper('/relatorio?period=custom&from=2026-08-01&to=2026-08-20&granularity=week&compare=0'),
    });

    expect(result.current.periodPreset).toBe('custom');
    expect(result.current.dateOnlyRange).toEqual({ from: '2026-08-01', to: '2026-08-20' });
    expect(result.current.granularity).toBe('week');
    expect(result.current.comparisonEnabled).toBe(false);
    expect(result.current.comparisonDateOnlyRange).toBeNull();
  });

  it('updates shared filters without discarding unrelated URL parameters', async () => {
    const { result } = renderHook(() => useReportFilters(), {
      wrapper: createWrapper('/relatorio?segment=night'),
    });

    act(() => {
      result.current.setGranularity('month');
    });

    await waitFor(() => {
      expect(result.current.granularity).toBe('month');
    });

    act(() => {
      result.current.setComparisonEnabled(false);
    });

    await waitFor(() => {
      expect(result.current.comparisonEnabled).toBe(false);
    });
  });

  it('exposes an inline error for a custom range over 366 days', () => {
    const { result } = renderHook(() => useReportFilters(), {
      wrapper: createWrapper('/relatorio?period=custom&from=2025-01-01&to=2026-01-02'),
    });

    expect(result.current.rangeError).toContain('366');
  });

  it('moves rolling windows at the unit midnight while preserving equal comparison lengths', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T02:59:59.000Z'));
    const { result } = renderHook(() => useReportFilters({ timeZone: 'America/Fortaleza' }), {
      wrapper: createWrapper('/relatorio'),
    });
    expect(result.current.dateOnlyRange).toEqual({ from: '2026-08-28', to: '2026-09-26' });
    expect(result.current.comparisonDateOnlyRange).toEqual({ from: '2026-07-29', to: '2026-08-27' });
    act(() => { vi.advanceTimersByTime(1_020); });
    expect(result.current.dateOnlyRange).toEqual({ from: '2026-08-29', to: '2026-09-27' });
    expect(result.current.comparisonDateOnlyRange).toEqual({ from: '2026-07-30', to: '2026-08-28' });
  });

  it('refreshes today on window focus after a suspended tab and resolves a changed unit time zone', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T02:30:00Z'));
    const { result, rerender } = renderHook(({ timeZone }) => useReportFilters({ timeZone }), {
      initialProps: { timeZone: 'America/Manaus' }, wrapper: createWrapper('/relatorio?period=today'),
    });
    expect(result.current.dateOnlyRange.to).toBe('2026-09-26');
    rerender({ timeZone: 'Europe/Lisbon' });
    expect(result.current.dateOnlyRange.to).toBe('2026-09-27');
    vi.setSystemTime(new Date('2026-09-28T09:00:00Z'));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(result.current.dateOnlyRange.to).toBe('2026-09-28');
  });
});
