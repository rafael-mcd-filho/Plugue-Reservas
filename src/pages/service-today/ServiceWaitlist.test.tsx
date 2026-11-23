import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ServiceWaitlist from './ServiceWaitlist';

const mock = vi.hoisted(() => ({ companyId: 'company-a', waiting: vi.fn(), seated: vi.fn(), history: vi.fn(), notice: vi.fn(), events: vi.fn(), update: vi.fn(), scopes: [] as string[], bounds: [] as Array<{ key: string; operator: string; value: string }> }));
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
      in: () => query,
      gte: (key: string, value: string) => { mock.bounds.push({ key, value, operator: 'gte' }); return query; },
      lte: (key: string, value: string) => { mock.bounds.push({ key, value, operator: 'lte' }); return query; },
      lt: (key: string, value: string) => { mock.bounds.push({ key, value, operator: 'lt' }); return query; },
      abortSignal: () => query, or: () => query, order: () => query,
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
function mount(props: Parameters<typeof ServiceWaitlist>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><ServiceWaitlist {...props} /></QueryClientProvider>);
  return { client, ...view };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.companyId = 'company-a'; mock.scopes = []; mock.bounds = [];
  mock.waiting.mockResolvedValue({ data: [], error: null }); mock.seated.mockResolvedValue({ data: [], error: null }); mock.history.mockResolvedValue({ data: [], error: null });
  mock.update.mockResolvedValue({ data: null, error: null });
  mock.notice.mockImplementation(({ company_id }: { company_id: string }) => Promise.resolve({ data: { company_id, channel: 'evolution', automation_enabled: true, failures: [] }, error: null }));
  mock.events.mockResolvedValue({ data: { success: true, results: { whatsapp: 'sent' } }, error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ServiceWaitlist query feedback', () => {
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
    rerender(<QueryClientProvider client={client}><ServiceWaitlist /></QueryClientProvider>);
    expect(screen.queryByText('Ana da fila')).not.toBeInTheDocument();
    expect(screen.getByText('— aguardando')).toBeInTheDocument();
    await waitFor(() => expect(mock.scopes).toContain('company-b'));
  });
});

describe('ServiceWaitlist embedded service context', () => {
  const context = (overrides = {}) => ({ date: '2026-11-22', period: 'all' as const, section: 'all', search: '', timeZone: 'America/Sao_Paulo', canViewReservations: true, ...overrides });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T22:30:00Z'));
  });

  it('keeps active groups from the previous unit day after midnight and explains the carry-over', async () => {
    vi.setSystemTime(new Date('2026-11-23T03:05:00Z'));
    mock.waiting.mockResolvedValue({ data: [entry({ created_at: '2026-11-23T02:55:00Z' })], error: null });
    mount({ serviceContext: context({ date: '2026-11-23' }) });
    expect(await screen.findByText('Ana da fila')).toBeInTheDocument();
    expect(screen.getByText('Entrada em 22/11')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Lista de Espera' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chamar próximo' })).toBeEnabled();
  });

  it('preserves original positions and never skips a hidden earlier group when searching', async () => {
    mock.waiting.mockResolvedValue({ data: [entry({ id: 'first', guest_name: 'Primeiro grupo', position: 1 }), entry({ id: 'second', guest_name: 'Segundo grupo', position: 2 })], error: null });
    mount({ serviceContext: context({ search: 'Segundo' }) });
    expect(await screen.findByText('Segundo grupo')).toBeInTheDocument();
    expect(screen.queryByText('Primeiro grupo')).not.toBeInTheDocument();
    const row = screen.getByRole('button', { name: 'Abrir resumo da fila de Segundo grupo' });
    expect(within(row).getByText('2', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chamar próximo' })).toBeDisabled();
    expect(screen.getByText(/1 grupo ativo está fora dos filtros atuais/)).toBeInTheDocument();
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('filters the entry period in the unit timezone and does not pretend the queue has sections', async () => {
    mock.waiting.mockResolvedValue({ data: [entry({ id: 'before', guest_name: 'Antes das dezoito', created_at: '2026-11-22T20:59:59Z' }), entry({ id: 'after', guest_name: 'A partir das dezoito', created_at: '2026-11-22T21:00:00Z' })], error: null });
    mount({ serviceContext: context({ period: 'dinner', section: 'Varanda' }) });
    expect(await screen.findByText('A partir das dezoito')).toBeInTheDocument();
    expect(screen.queryByText('Antes das dezoito')).not.toBeInTheDocument();
    expect(screen.getByText(/A fila é única e não possui vínculo com um ambiente/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeEnabled();
  });

  it('blocks adding a current-time entry while viewing another period', async () => {
    mount({ serviceContext: context({ period: 'lunch' }) });
    await waitFor(() => expect(mock.waiting).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeDisabled();
    expect(screen.getByText(/Novas entradas são registradas no dia e horário atuais/)).toBeInTheDocument();
  });

  it('matches a tracking code literally without treating its digits as another guest phone', async () => {
    mock.waiting.mockResolvedValue({ data: [
      entry({ id: 'code-match', guest_name: 'Código correto', tracking_code: 'ABC123' }),
      entry({ id: 'phone-only', guest_name: 'Outro telefone', tracking_code: 'XYZ', guest_phone: '+5562991239999' }),
    ], error: null });
    mount({ serviceContext: context({ search: 'ABC123' }) });
    expect(await screen.findByText('Código correto')).toBeInTheDocument();
    expect(screen.queryByText('Outro telefone')).not.toBeInTheDocument();
  });

  it('uses an exact UTC half-open day for seated metrics and preserves search in that list', async () => {
    mock.seated.mockResolvedValue({ data: [
      entry({ id: 'old', guest_name: 'Fora do dia', status: 'seated', seated_at: '2026-11-22T02:59:59Z' }),
      entry({ id: 'included', guest_name: 'Ana atendida', status: 'seated', seated_at: '2026-11-22T21:00:00Z', created_at: '2026-11-22T20:30:00Z' }),
      entry({ id: 'excluded', guest_name: 'Beatriz atendida', status: 'seated', seated_at: '2026-11-22T22:00:00Z' }),
      entry({ id: 'next', guest_name: 'Outro dia', status: 'seated', seated_at: '2026-11-23T03:00:00Z' }),
    ], error: null });
    mount({ serviceContext: context({ search: 'Ana', period: 'dinner' }) });
    await screen.findByText('Espera média do período: 30min');
    expect(mock.bounds).toContainEqual({ key: 'seated_at', operator: 'gte', value: '2026-11-22T03:00:00.000Z' });
    expect(mock.bounds).toContainEqual({ key: 'seated_at', operator: 'lt', value: '2026-11-23T03:00:00.000Z' });
    fireEvent.click(screen.getByRole('button', { name: 'Abrir lista de clientes sentados no período' }));
    const dialog = screen.getByRole('dialog', { name: 'Sentados no período' });
    expect(await within(dialog).findByText('Ana atendida')).toBeInTheDocument();
    expect(within(dialog).queryByText('Beatriz atendida')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Fora do dia')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Outro dia')).not.toBeInTheDocument();
    expect(within(dialog).getByText('18:00', { exact: true })).toBeInTheDocument();
  });

  it('closes an old entry dialog when the shared filter scope changes', async () => {
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    const { client, rerender } = mount({ serviceContext: context() });
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir resumo da fila de Ana da fila' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(<QueryClientProvider client={client}><ServiceWaitlist serviceContext={context({ search: 'Outra pessoa' })} /></QueryClientProvider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps queue service actions and contact data but never queries reservation history without its permission', async () => {
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    mount({ serviceContext: context({ canViewReservations: false }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Histórico de Ana da fila' }));
    const dialog = screen.getByRole('dialog', { name: 'Histórico do contato' });
    expect(within(dialog).getByText('Ana da fila')).toBeInTheDocument();
    expect(within(dialog).getByText(/é necessária a permissão de visualizar reservas/)).toBeInTheDocument();
    expect(within(dialog).queryByText('Nenhuma reserva encontrada')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Total de reservas')).not.toBeInTheDocument();
    expect(mock.history).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fechar' })[0]);
    expect(screen.getByRole('button', { name: 'Chamar' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeEnabled();
  });

  it('closes the reservation history and stops querying after its permission is revoked', async () => {
    mock.waiting.mockResolvedValue({ data: [entry()], error: null });
    const { client, rerender } = mount({ serviceContext: context() });
    fireEvent.click(await screen.findByRole('button', { name: 'Histórico de Ana da fila' }));
    await within(screen.getByRole('dialog')).findByText('Nenhuma reserva encontrada');
    expect(mock.history).toHaveBeenCalledOnce();
    rerender(<QueryClientProvider client={client}><ServiceWaitlist serviceContext={context({ canViewReservations: false })} /></QueryClientProvider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Histórico de Ana da fila' }));
    expect(screen.getByText(/é necessária a permissão de visualizar reservas/)).toBeInTheDocument();
    expect(mock.history).toHaveBeenCalledOnce();
  });
});

describe('ServiceWaitlist call notice failures', () => {
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
    rerender(<QueryClientProvider client={client}><ServiceWaitlist /></QueryClientProvider>);
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
