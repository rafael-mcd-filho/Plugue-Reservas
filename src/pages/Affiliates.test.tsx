import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Affiliates from './Affiliates';

const mock = vi.hoisted(() => ({ companyId: 'company-a', stats: vi.fn(), daily: vi.fn(), reservations: vi.fn(), rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>, reservationScopes: [] as string[] }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: mock.companyId, companyName: 'Unidade teste', slug: 'casa' }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-a' } }) }));
vi.mock('@/components/ui/date-range-picker', () => ({ DateRangePicker: ({ onChange }: { onChange: (value: unknown) => void }) => <button onClick={() => onChange({ from: new Date(2026, 10, 2), to: new Date(2026, 10, 3) })}>Mudar período</button> }));
vi.mock('recharts', () => ({ ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, ComposedChart: ({ data }: { data: unknown[] }) => <div aria-label="Gráfico de parceiros">{JSON.stringify(data)}</div>, Bar: () => null, CartesianGrid: () => null, Legend: () => null, Line: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: (name: string, args: Record<string, unknown>) => { mock.rpcCalls.push({ name, args }); return name === 'get_affiliate_link_stats' ? mock.stats() : mock.daily(); },
  from: () => {
    const query = { select: () => query, eq: (key: string, value: string) => { if (key === 'company_id') mock.reservationScopes.push(value); return query; }, order: () => query, limit: () => query, gte: () => query, lte: () => query, then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => mock.reservations().then(resolve, reject) };
    return query;
  },
} }));

function link() {
  return { affiliate_link_id: 'link-a', reference_name: 'Hotel Centro', code: 'HOTEL', notes: null, is_active: true, visits: 11, reservations: 4, party_size_total: 12, conversion_rate: 36.4, last_reservation_at: null };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><Affiliates /></QueryClientProvider>);
  return { client, ...view };
}
function reports() { fireEvent.mouseDown(screen.getByRole('tab', { name: 'Relatórios' }), { button: 0, ctrlKey: false }); }
beforeEach(() => { vi.clearAllMocks(); mock.companyId = 'company-a'; mock.rpcCalls = []; mock.reservationScopes = []; mock.stats.mockResolvedValue({ data: [], error: null }); mock.daily.mockResolvedValue({ data: [], error: null }); mock.reservations.mockResolvedValue({ data: [], error: null }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Affiliates query feedback', () => {
  it('does not claim zero totals or no links when stats fail and retries', async () => {
    mock.stats.mockResolvedValue({ data: null, error: new Error('Offline') });
    mount();
    expect(await screen.findByText('Não foi possível carregar os parceiros.')).toBeInTheDocument();
    expect(screen.queryByText('Links ativos')).not.toBeInTheDocument();
    expect(screen.queryByText('Nenhum link criado ainda.')).not.toBeInTheDocument();
    mock.stats.mockResolvedValue({ data: [link()], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Hotel Centro')).toBeInTheDocument();
    expect(screen.getByText('Links ativos')).toBeInTheDocument();
  });

  it('retains the previous rows and timestamp after a failed refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T15:00:00Z'));
    mock.stats.mockResolvedValue({ data: [link()], error: null });
    const { client } = mount();
    await screen.findByText('Hotel Centro');
    const updated = screen.getByText(/Última atualização:/).textContent;
    vi.setSystemTime(new Date('2026-11-21T15:10:00Z'));
    mock.stats.mockResolvedValue({ data: null, error: new Error('Offline') });
    await act(async () => { await client.invalidateQueries({ queryKey: ['affiliate-link-stats'] }); });
    expect(await screen.findByText(/Mostrando os últimos dados disponíveis/)).toBeInTheDocument();
    expect(screen.getByText('Hotel Centro')).toBeInTheDocument();
    expect(screen.getByText(/Última atualização:/)).toHaveTextContent(updated!);
  });

  it('does not render a zero chart when the auxiliary daily query failed', async () => {
    mock.stats.mockResolvedValue({ data: [link()], error: null });
    mock.daily.mockResolvedValue({ data: null, error: new Error('Offline') });
    mount();
    await screen.findByText('Hotel Centro');
    reports();
    expect(await screen.findByText('Não foi possível carregar o gráfico dos parceiros.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Gráfico de parceiros')).not.toBeInTheDocument();
    const statsCalls = mock.stats.mock.calls.length;
    mock.daily.mockResolvedValue({ data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByLabelText('Gráfico de parceiros')).toBeInTheDocument();
    expect(mock.stats).toHaveBeenCalledTimes(statsCalls);
  });

  it('shows a retryable detail failure and keeps known stats separate from unknown reservations', async () => {
    mock.stats.mockResolvedValue({ data: [link()], error: null });
    mock.reservations.mockResolvedValue({ data: null, error: new Error('Offline') });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver reservas de Hotel Centro' }));
    const dialog = screen.getByRole('dialog', { name: 'Hotel Centro' });
    expect(await within(dialog).findByText('Não foi possível carregar as reservas deste parceiro.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Nenhuma reserva originada/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('Visitas')).toBeInTheDocument();
    expect(mock.reservationScopes).toEqual(['company-a']);
    mock.reservations.mockResolvedValue({ data: [], error: null });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(dialog).findByText(/Nenhuma reserva originada/)).toBeInTheDocument();
  });

  it('preserves a chart with a stale-source warning when its refresh fails', async () => {
    mock.stats.mockResolvedValue({ data: [link()], error: null });
    const { client } = mount();
    await screen.findByText('Hotel Centro');
    reports();
    const chart = await screen.findByLabelText('Gráfico de parceiros');
    const originalSeries = chart.textContent;
    mock.daily.mockResolvedValue({ data: null, error: new Error('Offline') });
    await act(async () => { await client.invalidateQueries({ queryKey: ['affiliate-link-daily-stats'] }); });
    expect(await screen.findByText(/Não foi possível atualizar o gráfico dos parceiros/)).toBeInTheDocument();
    expect(screen.getByLabelText('Gráfico de parceiros')).toHaveTextContent(originalSeries!);
  });

  it('does not reuse stats or the selected partner across units', async () => {
    mock.stats.mockResolvedValue({ data: [link()], error: null });
    const { client, rerender } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver reservas de Hotel Centro' }));
    await within(screen.getByRole('dialog')).findByText(/Nenhuma reserva originada/);
    mock.companyId = 'company-b';
    mock.stats.mockReturnValue(new Promise(() => undefined));
    mock.daily.mockReturnValue(new Promise(() => undefined));
    rerender(<QueryClientProvider client={client}><Affiliates /></QueryClientProvider>);
    expect(screen.queryByText('Hotel Centro')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Links ativos')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.rpcCalls.some((call) => call.args._company_id === 'company-b')).toBe(true));
    expect(mock.reservationScopes).toEqual(['company-a']);
  });

  it('does not display the old period totals or chart under the new period label', async () => {
    mock.stats.mockResolvedValue({ data: [link()], error: null });
    mount();
    await screen.findByText('Hotel Centro');
    reports();
    expect(await screen.findByLabelText('Gráfico de parceiros')).toBeInTheDocument();
    mock.stats.mockReturnValue(new Promise(() => undefined));
    mock.daily.mockReturnValue(new Promise(() => undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Mudar período' }));
    expect(screen.queryByText('Links ativos')).not.toBeInTheDocument();
    expect(screen.queryByText('Hotel Centro')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Gráfico de parceiros')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.rpcCalls.some((call) => String(call.args._start_at).startsWith('2026-11-02'))).toBe(true));
  });
});
