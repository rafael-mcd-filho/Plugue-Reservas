import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useReportFilters } from './useReportFilters';

function createWrapper(initialEntry: string) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>;
  };
}

describe('useReportFilters', () => {
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
});
