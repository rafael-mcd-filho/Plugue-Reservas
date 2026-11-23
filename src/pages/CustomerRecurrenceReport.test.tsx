import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import CustomerRecurrenceReport from './CustomerRecurrenceReport';

const summary = { identified_customers: 5, returning_customers: 2, new_customers: 3, recurrence_rate: 40, repeated_in_period: 1, repeat_rate: 20, additional_visits: 2, period_visits: 7, avg_visits_per_customer: 1.4 };
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: 'company-1', slug: 'casa', companyTimeZone: 'America/Sao_Paulo', companyTimeZoneResolved: true }) }));
vi.mock('@/hooks/useCustomerRecurrenceReport', async importOriginal => {
  const original = await importOriginal<typeof import('@/hooks/useCustomerRecurrenceReport')>();
  return { ...original, useCustomerRecurrenceReport: () => ({ data: {
    summary, comparison: { ...summary, period_start: '2026-10-01', period_end: '2026-10-21' },
    frequency_bands: [], monthly_composition: [], customers: [], meta: { period_start: '2026-11-01', period_end: '2026-11-21', comparison_mode: 'month_to_date', include_companions: false, page: 1, page_size: 12, customers_total: 5, filtered_customers_total: 5, min_total_visits: null, generated_at: '2026-11-21T15:00:00Z' },
  }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }), useCustomerRecurrenceLeadProfile: () => ({ data: null, isLoading: false, isFetching: false, refetch: vi.fn() }) };
});
vi.mock('@/hooks/useCustomerRecurrenceVisitSeries', () => ({ useCustomerRecurrenceVisitSeries: () => ({ data: { series: [] }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }) }));
vi.mock('@/components/leads/LeadProfileDialog', () => ({ default: () => null }));
vi.mock('recharts', () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Bar: () => null, BarChart: Container, Cell: () => null, ComposedChart: Container, Legend: () => null, Line: () => null, ResponsiveContainer: Container, Tooltip: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null };
});

describe('relatório de clientes com leitura progressiva', () => {
  it('começa pelas leituras e mantém gráficos e base de clientes em Explorar dados', () => {
    render(<MemoryRouter initialEntries={['/?period=current_month']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><CustomerRecurrenceReport /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Recorrência de clientes' })).toBeVisible();
    expect(screen.getByText('2 clientes já visitavam antes do período')).toBeVisible();
    expect(screen.getByText(/Base pequena/)).toBeVisible();
    expect(screen.queryByText('Primeiras visitas × visitas de retorno')).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Explorar dados' }), { button: 0, ctrlKey: false });
    expect(screen.getByText('Primeiras visitas × visitas de retorno')).toBeVisible();
    expect(screen.getByLabelText('Mínimo de visitas')).toBeVisible();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Resumo' }), { button: 0, ctrlKey: false });
    expect(screen.getByText('Cobertura: visitas identificadas')).toBeVisible();
  });
});
