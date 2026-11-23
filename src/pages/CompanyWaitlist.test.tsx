import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyWaitlist from './CompanyWaitlist';

const mock = vi.hoisted(() => ({ companyId: 'company-a', waiting: vi.fn(), seated: vi.fn(), history: vi.fn(), notice: vi.fn(), events: vi.fn(), update: vi.fn(), scopes: [] as string[] }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: mock.companyId, companyName: 'Unidade teste', slug: 'casa' }) }));
vi.mock('@/hooks/useCrmLeadPrefill', () => ({ useCrmLeadPrefill: () => ({ data: null, isFetching: false }) }));
vi.mock('@/components/ReservationDetailsDialog', () => ({ default: () => null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: (table: string) => {
    let isSeated = false;
    let updates: Record<string, unknown> | null = null;
    const query = {
      select: () => query,
      update: (values: Record<string, unknown>) => { updates = values; return query; },
      eq: (key: string, value: string) => { if (key === 'status') isSeated = value === 'seated'; if (key === 'company_id') mock.scopes.push(value); return query; },
      in: () => query, gte: () => query, lte: () => query, or: () => query, order: () => query,
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => (updates ? mock.update(updates) : table === 'reservations' ? mock.history() : isSeated ? mock.seated() : mock.waiting()).then(resolve, reject),
    };
    return query;
  },
  channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; },
  removeChannel: vi.fn(),
  functions: { invoke: (name: string, options: { body: Record<string, unknown> }) => name === 'waitlist-call-notification' ? mock.notice(options.body) : mock.events(options.body) },
} }));

function entry(overrides = {}) {
  return { id: 'entry-a', company_id: 'company-a', guest_name: 'Ana da fila', guest_phone: '+5562999999999', guest_email: null, guest_birthdate: null, party_size: 3, seated_party_size: null, tracking_code: 'ABC', status: 'waiting', position: 1, notes: null, called_at: null, seated_at: null, expired_at: null, created_at: new Date().toISOString(), ...overrides };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><CompanyWaitlist /></QueryClientProvider>);
  return { client, ...view };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.companyId = 'company-a'; mock.scopes = [];
  mock.waiting.mockResolvedValue({ data: [], error: null }); mock.seated.mockResolvedValue({ data: [], error: null }); mock.history.mockResolvedValue({ data: [], error: null });
  mock.update.mockResolvedValue({ data: null, error: null });
  mock.notice.mockImplementation(({ company_id }: { company_id: string }) => Promise.resolve({ data: { company_id, channel: 'evolution', automation_enabled: true, failures: [] }, error: null }));
  mock.events.mockResolvedValue({ data: { success: true, results: { whatsapp: 'sent' } }, error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('CompanyWaitlist query feedback', () => {
  it('does not show an empty queue or zero count on failure and retries the failed query', async () => {
    mock.waiting.mockResolvedValue({ data: null, error: new Error('Offline') });
    mount();
    expect(await screen.findByText('Não foi possível carregar a fila.')).toBeInTheDocument();
    expect(screen.queryByText('Fila vazia')).not.toBeInTheDocument();
    expect(screen.getByText('— aguardando')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chamar próximo' })).toBeDisabled();
    expect(screen.queryByText(/Última atualização:/)).not.toBeInTheDocument();
    const seatedCalls = mock.seated.mock.calls.length;
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Ana da fila')).toBeInTheDocument();
    expect(mock.seated).toHaveBeenCalledTimes(seatedCalls);
    expect(screen.getByText(/Última atualização:/)).toBeInTheDocument();
  });

  it('keeps cached rows and the last confirmed timestamp when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T15:00:00Z'));
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    const { client } = mount();
    await screen.findByText('Ana da fila');
    const updated = screen.getByText(/Última atualização:/).textContent;
    vi.setSystemTime(new Date('2026-11-21T15:10:00Z'));
    mock.waiting.mockResolvedValue({ data: null, error: new Error('Offline') });
    await act(async () => { await client.invalidateQueries({ queryKey: ['waitlist', 'company-a'] }); });
    expect(await screen.findByText(/Mostrando os últimos dados disponíveis/)).toBeInTheDocument();
    expect(screen.getByText('Ana da fila')).toBeInTheDocument();
    expect(screen.getByText(/Última atualização:/)).toHaveTextContent(updated!);
    expect(screen.getByRole('button', { name: 'Chamar próximo' })).toBeDisabled();
    expect(screen.queryByText('Atualizado agora')).not.toBeInTheDocument();
  });

  it('does not invent zero seated metrics when only that query fails, including its dialog', async () => {
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    mock.seated.mockResolvedValue({ data: null, error: new Error('Offline') });
    mount();
    expect(await screen.findByText('Não foi possível carregar os atendimentos de hoje.')).toBeInTheDocument();
    expect(screen.getByText('Ana da fila')).toBeInTheDocument();
    expect(screen.getByText('Espera média de hoje: —')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir lista de clientes sentados hoje' }));
    const dialog = screen.getByRole('dialog', { name: 'Sentados hoje' });
    expect(within(dialog).queryByText('Ninguém foi sentado hoje ainda.')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Clientes')).not.toBeInTheDocument();
    mock.seated.mockResolvedValue({ data: [entry({ id: 'seated-a', guest_name: 'Beatriz atendida', status: 'seated', seated_at: new Date().toISOString() })], error: null });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(dialog).findByText('Beatriz atendida')).toBeInTheDocument();
  });

  it('retries contact history instead of presenting a failed lookup as no reservations', async () => {
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    mock.history.mockResolvedValue({ data: null, error: new Error('Offline') });
    mount();
    await screen.findByText('Ana da fila');
    fireEvent.click(screen.getByRole('button', { name: 'Histórico de Ana da fila' }));
    const dialog = screen.getByRole('dialog', { name: 'Histórico do contato' });
    expect(await within(dialog).findByText('Não foi possível carregar o histórico deste contato.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Nenhuma reserva encontrada')).not.toBeInTheDocument();
    mock.history.mockResolvedValue({ data: [], error: null });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(dialog).findByText('Nenhuma reserva encontrada')).toBeInTheDocument();
  });

  it('preserves seated metrics and their confirmed timestamp when refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T15:00:00Z'));
    mock.seated.mockResolvedValue({ data: [entry({ status: 'seated', seated_at: '2026-11-21T15:00:00Z', created_at: '2026-11-21T14:30:00Z' })], error: null });
    const { client } = mount();
    await screen.findByText('Espera média de hoje: 30min');
    const updated = screen.getByText(/Última atualização:/).textContent;
    vi.setSystemTime(new Date('2026-11-21T15:10:00Z'));
    mock.seated.mockResolvedValue({ data: null, error: new Error('Offline') });
    await act(async () => { await client.invalidateQueries({ queryKey: ['waitlist-seated-today'] }); });
    expect(await screen.findByText(/Não foi possível atualizar os atendimentos de hoje/)).toBeInTheDocument();
    expect(screen.getByText('Espera média de hoje: 30min')).toBeInTheDocument();
    expect(screen.getByText(/Última atualização:/)).toHaveTextContent(updated!);
  });

  it('never reuses a different company queue while its new query is pending', async () => {
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    const { client, rerender } = mount();
    await screen.findByText('Ana da fila');
    mock.companyId = 'company-b';
    mock.waiting.mockReturnValue(new Promise(() => undefined));
    rerender(<QueryClientProvider client={client}><CompanyWaitlist /></QueryClientProvider>);
    expect(screen.queryByText('Ana da fila')).not.toBeInTheDocument();
    expect(screen.getByText('— aguardando')).toBeInTheDocument();
    await waitFor(() => expect(mock.scopes).toContain('company-b'));
  });
});

describe('CompanyWaitlist call notice failures', () => {
  const calledAt = () => new Date(Date.now() - 30000).toISOString();
  const failedSnapshot = (called_at: string, overrides: Record<string, unknown> = {}) => ({
    company_id: 'company-a', channel: 'evolution', automation_enabled: true,
    failures: [{ waitlist_id: 'entry-a', called_at, can_retry: true }], ...overrides,
  });
  const failCall = (called_at: string, overrides: Record<string, unknown> = {}) => {
    mock.waiting.mockResolvedValue({ data: [entry({ status: 'called', called_at })], error: null });
    mock.notice.mockResolvedValue({ data: failedSnapshot(called_at, overrides), error: null });
  };

  it.each(['evolution', 'pluguechat_official'])('shows a persisted %s failure with retry while preserving operational actions', async (channel) => {
    failCall(calledAt(), { channel });
    mount();
    expect(await screen.findByText('Falha ao enviar o WhatsApp')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar envio novamente para Ana da fila' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sentar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expirar Ana da fila' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Histórico de Ana da fila' })).toBeInTheDocument();
    expect(screen.queryByText(/WhatsApp enviado|Verificar envio|Envio sem confirmação|WhatsApp na fila/)).not.toBeInTheDocument();
  });

  it('loads a known failure again after remount instead of depending on a transient toast', async () => {
    failCall(calledAt());
    const first = mount();
    await screen.findByText('Falha ao enviar o WhatsApp');
    first.unmount(); first.client.clear();
    mount();
    expect(await screen.findByText('Falha ao enviar o WhatsApp')).toBeInTheDocument();
    expect(mock.notice.mock.calls.filter(([body]) => body.action === 'list')).toHaveLength(2);
  });

  it('hides an earlier failure when the server reports that the automation was disabled', async () => {
    const at = calledAt();
    failCall(at);
    const { client } = mount();
    await screen.findByText('Falha ao enviar o WhatsApp');
    mock.notice.mockResolvedValue({ data: failedSnapshot(at, { automation_enabled: false }), error: null });
    await act(async () => { await client.invalidateQueries({ queryKey: ['waitlist-call-notifications', 'company-a'] }); });
    await waitFor(() => expect(screen.queryByText('Falha ao enviar o WhatsApp')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Tentar envio novamente/ })).not.toBeInTheDocument();
    expect(mock.events).not.toHaveBeenCalled();
  });

  it('hides the previous channel failure after switching to a channel without a failure', async () => {
    failCall(calledAt());
    const { client } = mount();
    await screen.findByText('Falha ao enviar o WhatsApp');
    mock.notice.mockResolvedValue({ data: failedSnapshot(calledAt(), { channel: 'pluguechat_official', failures: [] }), error: null });
    await act(async () => { await client.invalidateQueries({ queryKey: ['waitlist-call-notifications', 'company-a'] }); });
    await waitFor(() => expect(screen.queryByText('Falha ao enviar o WhatsApp')).not.toBeInTheDocument());
  });

  it('retries only the notice once without changing the call, its deadline, or opening row details', async () => {
    const at = calledAt();
    failCall(at);
    let complete!: (value: unknown) => void;
    mock.notice.mockImplementation((body) => body.action === 'retry'
      ? new Promise((resolve) => { complete = resolve; })
      : Promise.resolve({ data: failedSnapshot(at), error: null }));
    mount();
    const retry = await screen.findByRole('button', { name: 'Tentar envio novamente para Ana da fila' });
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(mock.notice.mock.calls.filter(([body]) => body.action === 'retry')).toHaveLength(1));
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent('Tentando...');
    expect(mock.notice).toHaveBeenCalledWith({ action: 'retry', company_id: 'company-a', waitlist_id: 'entry-a', expected_called_at: at });
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.events).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mock.notice.mockResolvedValue({ data: failedSnapshot(at, { failures: [] }), error: null });
    await act(async () => { complete({ data: failedSnapshot(at, { failures: [] }), error: null }); });
    await waitFor(() => expect(screen.queryByText('Falha ao enviar o WhatsApp')).not.toBeInTheDocument());
    await expect(mock.waiting.mock.results[0].value).resolves.toMatchObject({ data: [{ called_at: at }] });
  });

  it('preserves the known failure when the retry fails and supports another attempt', async () => {
    const at = calledAt();
    failCall(at);
    mock.notice.mockImplementation((body) => body.action === 'retry'
      ? Promise.resolve({ data: null, error: new Error('offline') })
      : Promise.resolve({ data: failedSnapshot(at), error: null }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar envio novamente para Ana da fila' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tentar envio novamente para Ana da fila' })).toBeEnabled());
    expect(screen.getByText('Falha ao enviar o WhatsApp')).toBeInTheDocument();
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('does not invent a WhatsApp failure or allow retries when its status cannot be read', async () => {
    mock.waiting.mockResolvedValue({ data: [entry({ status: 'called', called_at: calledAt() })], error: null });
    mock.notice.mockResolvedValue({ data: null, error: new Error('offline') });
    mount();
    await waitFor(() => expect(mock.notice).toHaveBeenCalled());
    expect(screen.queryByText('Falha ao enviar o WhatsApp')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tentar envio novamente/ })).not.toBeInTheDocument();
  });

  it('hides a stale cached failure after the next status read fails', async () => {
    failCall(calledAt());
    const { client } = mount();
    await screen.findByText('Falha ao enviar o WhatsApp');
    mock.notice.mockResolvedValue({ data: null, error: new Error('offline') });
    await act(async () => { await client.invalidateQueries({ queryKey: ['waitlist-call-notifications', 'company-a'] }); });
    await waitFor(() => expect(screen.queryByText('Falha ao enviar o WhatsApp')).not.toBeInTheDocument());
  });

  it.each([
    { label: 'a stale call timestamp', offset: 1000, can_retry: true },
    { label: 'a server-controlled retry lock', offset: 0, can_retry: false },
    { label: 'an expired original deadline', offset: -360000, can_retry: true },
  ])('does not permit retry for $label', async ({ offset, can_retry }) => {
    const at = new Date(Date.now() - 30000 + (offset === -360000 ? offset : 0)).toISOString();
    mock.waiting.mockResolvedValue({ data: [entry({ status: 'called', called_at: at })], error: null });
    mock.notice.mockResolvedValue({ data: failedSnapshot(at, { failures: [{ waitlist_id: 'entry-a', called_at: new Date(Date.parse(at) + (offset === 1000 ? offset : 0)).toISOString(), can_retry }] }), error: null });
    mount();
    await waitFor(() => expect(mock.notice).toHaveBeenCalled());
    if (offset === 1000) expect(screen.queryByRole('button', { name: /Tentar envio novamente/ })).not.toBeInTheDocument();
    else expect(await screen.findByRole('button', { name: /Tentar envio novamente/ })).toBeDisabled();
    expect(mock.events).not.toHaveBeenCalled();
  });

  it('never carries another company failure into a pending unit', async () => {
    failCall(calledAt());
    const { client, rerender } = mount();
    await screen.findByText('Falha ao enviar o WhatsApp');
    mock.companyId = 'company-b';
    mock.waiting.mockResolvedValue({ data: [entry({ id: 'entry-b', company_id: 'company-b', guest_name: 'Bia da fila', status: 'called', called_at: calledAt() })], error: null });
    mock.notice.mockReturnValue(new Promise(() => undefined));
    rerender(<QueryClientProvider client={client}><CompanyWaitlist /></QueryClientProvider>);
    expect(await screen.findByText('Bia da fila')).toBeInTheDocument();
    expect(screen.queryByText('Falha ao enviar o WhatsApp')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tentar envio novamente/ })).not.toBeInTheDocument();
  });

  it.each(['pluguechat_queued', undefined])('keeps the original call once when its notice result is %s', async (whatsapp) => {
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    mock.update.mockImplementation((values) => {
      mock.waiting.mockResolvedValue({ data: [entry({ status: 'called', called_at: values.called_at })], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    mock.events.mockResolvedValue({ data: { success: true, results: { whatsapp } }, error: null });
    mount();
    const call = await screen.findByRole('button', { name: 'Chamar' });
    fireEvent.click(call); fireEvent.click(call);
    await waitFor(() => expect(mock.events).toHaveBeenCalledOnce());
    expect(mock.update).toHaveBeenCalledOnce();
    expect(mock.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'called', called_at: expect.any(String) }));
    expect(screen.queryByText('Falha ao enviar o WhatsApp')).not.toBeInTheDocument();
  });
});
