import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReservationTableAssignment from './ReservationTableAssignment';
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mock.rpc } }));
beforeEach(() => mock.rpc.mockReset());
describe('consulta de mesas no relatório', () => {
  it('mostra a atribuição existente sem oferecer edição ou consultar alternativas', async () => {
    mock.rpc.mockResolvedValue({ data: [{ table_id: 't1', table_number: 12, section_code: 'salao', capacity: 4, sort_order: 0, is_primary: true }], error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<QueryClientProvider client={client}><ReservationTableAssignment companyId="company-1" reservationId="r1" date="2026-11-21" time="19:00" partySize={2} readOnly /></QueryClientProvider>);
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('get_reservation_table_assignments', { _reservation_id: 'r1' }));
    expect(await screen.findByText(/Mesa 12/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Alterar mesas|Atribuir mesas/ })).not.toBeInTheDocument();
    expect(mock.rpc.mock.calls.every(([name]) => name !== 'assign_reservation_tables')).toBe(true);
  });
});
