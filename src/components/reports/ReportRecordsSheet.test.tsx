import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReportRecordsSheet from './ReportRecordsSheet';

const mocks = vi.hoisted(() => ({ permission: true, company: 'company-1', error: false, from: vi.fn(), filters: [] as unknown[][] }));
vi.mock('@/hooks/useCompanyPermissions', () => ({ useCompanyPermissions: () => ({ permissionsLoading: false, permissionsError: mocks.error, activeCompanyId: mocks.company, hasPermission: () => mocks.permission }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/components/ReservationDetailsDialog', async () => {
  const { Dialog, DialogContent, DialogTitle, DialogDescription } = await import('@/components/ui/dialog');
  return { default: ({ open, reservation, onBackToList }: { open: boolean; reservation: { guest_name: string } | null; onBackToList: () => void }) => <Dialog open={open} onOpenChange={next => { if (!next) onBackToList(); }}><DialogContent><DialogTitle>Detalhe da reserva</DialogTitle><DialogDescription>Reserva selecionada</DialogDescription><p>{reservation?.guest_name}</p><button onClick={onBackToList}>Voltar aos registros</button></DialogContent></Dialog> };
});

const records = Array.from({ length: 31 }, (_, index) => ({ id: 'r' + index, guest_name: 'Cliente ' + index, date: '2026-11-10', time: '19:00:00', party_size: 2, status: 'confirmed' }));
function renderSheet(loadRecords = vi.fn(async () => records), initialOpen = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Harness() { const [open, setOpen] = useState(initialOpen); return <ReportRecordsSheet open={open} onOpenChange={setOpen} title="No-shows" description="Data da visita de 01 a 30/11, unidade 1." companyId="company-1" slug="casa" scopeKey={['attendance', '2026-11-01', 'no_show']} loadRecords={loadRecords} />; }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  return loadRecords;
}
beforeEach(() => {
  mocks.permission = true; mocks.company = 'company-1'; mocks.error = false; mocks.filters = [];
  mocks.from.mockReset();
  mocks.from.mockImplementation(() => { const builder = { select: () => builder, eq: (...args: unknown[]) => { mocks.filters.push(args); return builder; }, maybeSingle: async () => ({ data: { ...records[25], company_id: 'company-1' }, error: null }) }; return builder; });
});
describe('registros responsáveis pelo indicador', () => {
  it('pagina a base completa e mantém a página ao abrir e voltar da reserva', async () => {
    const load = renderSheet();
    expect(await screen.findByRole('button', { name: 'Abrir reserva de Cliente 0' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Abrir reserva de Cliente 25' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página dos registros' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir reserva de Cliente 25' }));
    await waitFor(() => expect(mocks.from).toHaveBeenCalledWith('reservations'));
    expect(mocks.filters).toEqual([['company_id', 'company-1'], ['id', 'r25']]);
    fireEvent.click(await screen.findByRole('button', { name: 'Voltar aos registros' }));
    expect(screen.getByText('Página 2 de 2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Abrir reserva de Cliente 25' })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it.each(['permission', 'company', 'error'])('não consulta nem mostra registros fora do acesso: %s', async boundary => {
    if (boundary === 'permission') mocks.permission = false;
    if (boundary === 'company') mocks.company = 'other';
    if (boundary === 'error') mocks.error = true;
    const load = renderSheet();
    expect(await screen.findByRole('alert')).toHaveTextContent('não permite');
    expect(load).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('não consulta enquanto o painel está fechado', () => { const load = renderSheet(undefined, false); expect(load).not.toHaveBeenCalled(); });
  it('oferece nova tentativa sem apresentar uma base parcial', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('página indisponível')).mockResolvedValueOnce(records);
    renderSheet(load);
    expect(await screen.findByRole('alert')).toHaveTextContent('todos os registros');
    expect(screen.queryByText('31 reservas neste recorte.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Abrir reserva de Cliente 0' })).toBeVisible();
  });
});
