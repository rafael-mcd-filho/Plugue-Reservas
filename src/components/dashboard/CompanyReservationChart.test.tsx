import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CompanyReservationChart from './CompanyReservationChart';

const { fetchPages } = vi.hoisted(() => ({ fetchPages: vi.fn() }));
vi.mock('@/lib/supabase-pagination', () => ({ fetchAllSupabasePages: fetchPages }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown; children: ReactNode }) => <div data-testid="company-lines" data-series={JSON.stringify(data)}>{children}</div>,
  Line: ({ name }: { name: string }) => <span data-testid="company-line">{name}</span>,
  CartesianGrid: () => null, Legend: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));

const props = {
  companies: [{ id: 'a', name: 'Loja A' }, { id: 'b', name: 'Loja B' }],
  startDate: new Date(2026, 7, 30), endDate: new Date(2026, 8, 2),
  companiesLoading: false, companiesError: false, onRetryCompanies: vi.fn(),
};

function renderChart() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CompanyReservationChart {...props} />
  </QueryClientProvider>);
}

describe('CompanyReservationChart', () => {
  it('renders each store and switches aggregation without fetching the range again', async () => {
    fetchPages.mockResolvedValue([
      { company_id: 'a', date: '2026-08-30', status: 'confirmed', party_size: 2 },
      { company_id: 'a', date: '2026-08-31', status: 'checked_in', party_size: 4 },
      { company_id: 'b', date: '2026-09-01', status: 'confirmed', party_size: 3 },
    ]);
    fetchPages.mockClear();
    renderChart();
    await screen.findByTestId('company-lines');
    expect(screen.getAllByTestId('company-line').map((line) => line.textContent)).toEqual(['Loja A', 'Loja B']);
    fireEvent.click(screen.getByRole('button', { name: 'Mensal' }));
    expect(JSON.parse(screen.getByTestId('company-lines').getAttribute('data-series')!)).toEqual([
      { period: '2026-08-01', values: { a: 2, b: 0 } }, { period: '2026-09-01', values: { a: 0, b: 1 } },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Pessoas' }));
    expect(JSON.parse(screen.getByTestId('company-lines').getAttribute('data-series')!)[0].values.a).toBe(6);
    fireEvent.click(screen.getByRole('button', { name: 'Semanal' }));
    expect(JSON.parse(screen.getByTestId('company-lines').getAttribute('data-series')!)).toHaveLength(2);
    expect(fetchPages).toHaveBeenCalledTimes(1);
  });

  it('shows a recoverable error instead of zero values on a failed query', async () => {
    fetchPages.mockRejectedValue(new Error('offline'));
    renderChart();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('company-lines')).not.toBeInTheDocument();
    fetchPages.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Nenhuma reserva ativa nas empresas selecionadas neste período.');
  });
});
