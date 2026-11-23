import React, { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reservations from './Reservations';

const mock = vi.hoisted(() => ({ companyId: 'company-a', rpcResult: vi.fn(), rpcCalls: [] as Array<Record<string, unknown>>, fromCalls: [] as Array<{ table: string; selected: string; from?: number }>, abortSignals: [] as AbortSignal[], exportRows: [] as Array<Record<string, unknown>>, download: vi.fn() }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: mock.companyId, slug: 'unidade' }) }));
vi.mock('@/hooks/useCompanyPermissions', () => ({ useCompanyPermissions: () => ({ hasPermission: () => true }) }));
vi.mock('@/components/ReservationDetailsDialog', () => ({ default: () => null }));
vi.mock('@/components/ManualReservationDialog', () => ({ default: () => null }));
vi.mock('@/components/PhoneWhatsAppLink', () => ({ default: () => null }));
vi.mock('@/lib/export-utils', async (original) => ({ ...await original<Record<string, unknown>>(), downloadSpreadsheet: mock.download }));
vi.mock('@/components/ui/date-range-picker', () => ({ DateRangePicker: ({ onChange }: { onChange: (range: unknown) => void }) => <div><button type="button" onClick={() => onChange({ from: new Date(2026, 9, 1), to: new Date(2026, 9, 30) })}>Selecionar período de teste</button><button type="button" onClick={() => onChange({ from: new Date(2026, 9, 1) })}>Selecionar início de teste</button></div> }));
vi.mock('@/components/ui/select', () => {
  const SelectTrigger = () => null;
  const SelectContent = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) => {
      const parts = React.Children.toArray(children) as React.ReactElement[];
      const trigger = parts.find((part) => part.type === SelectTrigger);
      return <select value={value} aria-label={trigger?.props['aria-label'] ?? 'Tipo de data'} onChange={(event) => onValueChange(event.target.value)}>{parts.filter((part) => part.type === SelectContent)}</select>;
    }, SelectTrigger, SelectContent, SelectValue: () => null,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  };
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: (name: string, args: Record<string, unknown>) => {
    if (name !== 'get_company_reservation_history') throw new Error(`Unexpected RPC ${name}`);
    mock.rpcCalls.push(args);
    const promise = Promise.resolve(mock.rpcResult(args));
    const builder = { then: promise.then.bind(promise), abortSignal: (signal: AbortSignal) => { mock.abortSignals.push(signal); return builder; } };
    return builder;
  },
  from: (table: string) => {
    const call = { table, selected: '', from: undefined as number | undefined };
    mock.fromCalls.push(call);
    const result = () => ({ data: table === 'reservations' && call.selected === '*' && call.from !== undefined ? mock.exportRows.slice(call.from, call.from + 1000) : [], error: null });
    const builder = {
      select: (columns: string) => { call.selected = columns; return builder; }, eq: () => builder, order: () => builder,
      range: (from: number) => { call.from = from; return builder; },
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  },
} }));

function row(id: string, name = id, companyId = mock.companyId) {
  return { id, company_id: companyId, table_id: null, table_map_id: null, source: null, guest_name: name, guest_phone: '+5562999990000', guest_email: null, date: '2026-11-22', time: '19:00:00', party_size: 3, public_tracking_code: id, status: 'confirmed', occasion: null, notes: null, checked_in_at: null, checked_in_party_size: null, created_at: '2026-11-21T15:00:00Z', updated_at: '2026-11-21T15:00:00Z', reservation_payments: [] };
}
function page(args: Record<string, unknown>, total = 31, prefix = 'Cliente') {
  const currentPage = Math.min(Number(args._page), Math.max(1, Math.ceil(total / 15)));
  return { data: {
    company_id: args._company_id, rows: Array.from({ length: Math.min(15, Math.max(0, total - (currentPage - 1) * 15)) }, (_, index) => row(`reservation-${(currentPage - 1) * 15 + index + 1}`, `${prefix} ${(currentPage - 1) * 15 + index + 1}`, args._company_id as string)),
    total, total_people: total * 3, by_status: total ? [{ status: 'confirmed', count: total, people: total * 3 }] : [], page: currentPage, page_size: 15,
  }, error: null };
}
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } }); clients.push(client);
  const wrapper = (children: ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = render(wrapper(<Reservations view="list" />));
  return { ...view, client, refresh: () => view.rerender(wrapper(<Reservations view="list" />)) };
}
beforeEach(() => {
  mock.companyId = 'company-a'; mock.rpcCalls = []; mock.fromCalls = []; mock.abortSignals = []; mock.exportRows = [];
  mock.rpcResult.mockReset().mockImplementation((args) => page(args)); mock.download.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); });

describe('Reservations server history', () => {
  it('loads only 15 rows, shows complete totals and requests the next page from the server', async () => {
    mount();
    await screen.findByText('Cliente 15');
    expect(screen.queryByText('Cliente 16')).not.toBeInTheDocument();
    expect(screen.getByText('31 reservas')).toBeInTheDocument();
    expect(screen.getByText('93 pessoas')).toBeInTheDocument();
    expect(screen.getByText('1–15 de 31')).toBeInTheDocument();
    expect(mock.fromCalls.filter((call) => call.table === 'reservations')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await screen.findByText('Cliente 16');
    expect(mock.rpcCalls.at(-1)).toMatchObject({ _company_id: 'company-a', _page: 2, _page_size: 15 });
    expect(screen.queryByText('Cliente 1')).not.toBeInTheDocument();
    expect(screen.getByText('16–30 de 31')).toBeInTheDocument();
  });

  it('debounces search, resets the page before requesting and preserves the input focus', async () => {
    mount(); await screen.findByText('Cliente 1');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' })); await screen.findByText('Cliente 16');
    const search = screen.getByPlaceholderText('Buscar por nome ou telefone...'); search.focus();
    const before = mock.rpcCalls.length;
    fireEvent.change(search, { target: { value: 'Mar' } }); fireEvent.change(search, { target: { value: 'Maria' } });
    expect(mock.rpcCalls).toHaveLength(before);
    expect(screen.queryByText('Cliente 16')).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _page: 1, _search: 'Maria' }));
    expect(mock.rpcCalls.slice(before)).toHaveLength(1);
    expect(screen.getByPlaceholderText('Buscar por nome ou telefone...')).toBe(search);
    expect(search).toHaveFocus();
  });

  it('does not show a late response from an older search', async () => {
    let oldResponse!: (value: unknown) => void;
    mock.rpcResult.mockImplementation((args) => args._search === 'Maria' ? new Promise((resolve) => { oldResponse = resolve; }) : page(args, 1, String(args._search || 'Inicial')));
    mount(); await screen.findByText('Inicial 1');
    fireEvent.change(screen.getByPlaceholderText(/Buscar por nome/), { target: { value: 'Maria' } });
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _search: 'Maria' }));
    const signal = mock.abortSignals.at(-1)!;
    fireEvent.change(screen.getByPlaceholderText(/Buscar por nome/), { target: { value: 'Bruno' } });
    await screen.findByText('Bruno 1');
    expect(signal.aborted).toBe(true);
    await act(async () => oldResponse(page({ _company_id: 'company-a', _page: 1 }, 1, 'Maria')));
    expect(screen.queryByText('Maria 1')).not.toBeInTheDocument();
    expect(screen.getByText('Bruno 1')).toBeInTheDocument();
  });

  it('sends every visible filter to the server and resets page selection on a filter change', async () => {
    mount(); await screen.findByText('Cliente 1');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' })); await screen.findByText('Cliente 16');
    fireEvent.click(screen.getByRole('button', { name: 'Perdidas' }));
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _page: 1, _operational_filter: 'lost', _status: 'all' }));
    fireEvent.change(screen.getByLabelText('Filtrar reservas por status'), { target: { value: 'cancelled' } });
    fireEvent.change(screen.getByLabelText('Filtrar reservas por forma de entrada'), { target: { value: 'affiliate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar período de teste' }));
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _status: 'cancelled', _entry_method: 'affiliate', _start_date: '2026-10-01', _end_date: '2026-10-30' }));
    fireEvent.change(screen.getByLabelText('Tipo de data'), { target: { value: 'created' } });
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _date_filter_mode: 'created', _start_date: null, _end_date: null, _created_start_at: new Date(2026, 9, 1).toISOString(), _created_end_at: new Date(2026, 9, 31).toISOString() }));
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar início de teste' }));
    await waitFor(() => expect(mock.rpcCalls.at(-1)?._created_end_at).toBeNull());
  });

  it('uses the returned clamped page for navigation after the total shrinks', async () => {
    const { client } = mount(); await screen.findByText('Cliente 1');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' })); await screen.findByText('Cliente 16');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' })); await screen.findByText('Cliente 31');
    mock.rpcResult.mockImplementation((args) => page(args, 16));
    await act(async () => { await client.invalidateQueries({ queryKey: ['reservations', 'company-a'] }); });
    expect(await screen.findByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('16–16 de 16')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Página anterior' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Página anterior' }));
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _page: 1 }));
  });

  it('keeps a failed initial query distinct from empty results and retries without loading all history', async () => {
    mock.rpcResult.mockResolvedValue({ data: null, error: new Error('missing RPC') });
    mount(); expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as reservas.');
    expect(screen.queryByText('Nenhuma reserva encontrada.')).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText(/Buscar por nome/); input.focus();
    mock.rpcResult.mockImplementation((args) => page(args, 1));
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Cliente 1');
    expect(screen.getByPlaceholderText(/Buscar por nome/)).toBe(input);
    expect(mock.fromCalls.filter((call) => call.table === 'reservations')).toHaveLength(0);
  });

  it('keeps the adopted page when a shrunken history grows again during a later refresh', async () => {
    const { client } = mount(); await screen.findByText('Cliente 1');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' })); await screen.findByText('Cliente 16');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' })); await screen.findByText('Cliente 31');
    mock.rpcResult.mockImplementation((args) => page(args, 1));
    await act(async () => { await client.invalidateQueries({ queryKey: ['reservations', 'company-a'] }); });
    await screen.findByText('1 reserva');
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _page: 1 }));
    mock.rpcResult.mockImplementation((args) => page(args, 31));
    await act(async () => { await client.invalidateQueries({ queryKey: ['reservations', 'company-a'] }); });
    expect(await screen.findByText('1 / 3')).toBeInTheDocument();
    expect(screen.queryByText('Cliente 31')).not.toBeInTheDocument();
    expect(mock.rpcCalls.at(-1)).toMatchObject({ _page: 1 });
  });

  it('keeps cached rows and full counts identified after a background update fails', async () => {
    const { client } = mount(); await screen.findByText('Cliente 1');
    mock.rpcResult.mockResolvedValue({ data: null, error: new Error('offline') });
    await act(async () => { await client.invalidateQueries({ queryKey: ['reservations', 'company-a'] }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Mostrando os últimos dados disponíveis.');
    expect(screen.getByText('Cliente 1')).toBeInTheDocument();
    expect(screen.getByText('31 reservas')).toBeInTheDocument();
  });

  it('does not carry a previous company page into another company', async () => {
    let nextCompany!: (value: unknown) => void;
    const { refresh } = mount(); await screen.findByText('Cliente 1');
    mock.rpcResult.mockImplementation((args) => args._company_id === 'company-b' ? new Promise((resolve) => { nextCompany = resolve; }) : page(args));
    mock.companyId = 'company-b'; refresh();
    expect(screen.queryByText('Cliente 1')).not.toBeInTheDocument();
    expect(screen.queryByText('31 reservas')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.rpcCalls.at(-1)).toMatchObject({ _company_id: 'company-b', _page: 1 }));
    await act(async () => nextCompany(page({ _company_id: 'company-b', _page: 1 }, 1, 'Outra unidade')));
    expect(await screen.findByText('Outra unidade 1')).toBeInTheDocument();
  });

  it('keeps full export independent from the fifteen visible records', async () => {
    mock.exportRows = Array.from({ length: 22 }, (_, index) => row(`export-${index}`, `Exportação ${index}`));
    mount(); await screen.findByText('Cliente 15');
    fireEvent.click(screen.getByRole('button', { name: 'Exportar reservas' }));
    const dialog = screen.getByRole('dialog');
    expect(mock.fromCalls.filter((call) => call.table === 'reservations')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Exportar planilha' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar planilha' }));
    await waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
    expect(mock.download.mock.calls[0][0].rows).toHaveLength(22);
    expect(mock.fromCalls.some((call) => call.table === 'reservations' && call.selected === '*' && call.from === 22)).toBe(true);
  });
});
