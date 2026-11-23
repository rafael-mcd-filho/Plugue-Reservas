import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LeadRelationshipPanel from './LeadRelationshipPanel';
import type { CrmRelationshipPage, CrmRelationshipRequest, CrmRelationshipSection } from '@/lib/crm-relationship';

const mock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/crm-relationship', async (original) => ({ ...await original<typeof import('@/lib/crm-relationship')>(), getCrmRelationshipPage: mock.get }));
const caps = { reservations: true, payments: true, messages: true };
const summary = { upcoming_count: 2, reservation_count: 31, cancelled_count: 3, no_show_count: 1 };
const reservation = (id = 'reservation-1') => ({ id, date: '2026-11-25', time: '19:00:00', party_size: 4, status: 'confirmed', source: 'reservation', occasion: 'Aniversário', is_upcoming: true, relationship_role: 'holder', holder_name: 'Ana' });
const payment = { id: 'payment-1', reservation_id: 'reservation-1', reservation_date: '2026-11-25', reservation_time: '19:00:00', status: 'refunded', billing_type: 'PIX', base_amount: 50, charged_amount: 54, paid_at: '2026-11-22T18:30:00Z', created_at: '2026-11-22T18:00:00Z', refunded_at: null };
const message = { id: 'evolution:message-1', channel: 'evolution', type: 'waitlist_called', status: 'pending', created_at: '2026-11-22T18:30:00Z', reservation_id: null, record_source: 'log', provider_status: null, message_preview: 'Ana, sua mesa está pronta.' };
function response(section: CrmRelationshipSection, overrides: Partial<CrmRelationshipPage> = {}): CrmRelationshipPage {
  return {
    company_id: 'unit-a', customer_key: 'phone:ana', section, page: 1, page_size: 25,
    total: section === 'summary' ? 0 : 1,
    rows: (section === 'summary' ? [] : [section === 'reservations' ? reservation() : section === 'payments' ? payment : message]) as CrmRelationshipPage['rows'],
    capabilities: caps, summary, ...overrides,
  };
}
const clients: QueryClient[] = [];
const selected = vi.fn();
const revoked = vi.fn();
function mount(overrides: Partial<Parameters<typeof LeadRelationshipPanel>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const props = { companyId: 'unit-a', customerKey: 'phone:ana', open: true, canViewReservations: true, onOpenReservation: selected, onReservationAccessChange: revoked, children: <p>Histórico atual de visitas</p> };
  const content = (next = {}) => {
    const current = { ...props, ...overrides, ...next };
    return <QueryClientProvider client={client}><LeadRelationshipPanel key={`${current.companyId}:${current.customerKey}`} {...current} /></QueryClientProvider>;
  };
  const view = render(content());
  return { ...view, client, rerenderPanel: (next = {}) => view.rerender(content(next)) };
}
async function tab(name: string) {
  const trigger = await screen.findByRole('tab', { name });
  fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
  return trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.get.mockImplementation(async (request: CrmRelationshipRequest) => response(request.section, { company_id: request.companyId, customer_key: request.customerKey, page: request.page ?? 1 }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); });

describe('LeadRelationshipPanel', () => {
  it('keeps Visits as the default and does not fetch reservation, payment or message records before a tab is selected', async () => {
    mount();
    expect(screen.getByText('Histórico atual de visitas')).toBeVisible();
    expect(await screen.findByRole('tab', { name: 'Pagamentos' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Visitas' })).toHaveAttribute('aria-selected', 'true');
    expect(mock.get).toHaveBeenCalledOnce();
    expect(mock.get.mock.calls[0][0]).toMatchObject({ companyId: 'unit-a', customerKey: 'phone:ana', section: 'summary' });
  });

  it('does not load relationship metadata while the profile is closed', () => {
    mount({ open: false });
    expect(mock.get).not.toHaveBeenCalled();
  });

  it('keeps unavailable tabs and data hidden when server capabilities do not permit them', async () => {
    mock.get.mockResolvedValue(response('summary', { capabilities: { reservations: false, payments: false, messages: false }, summary: { upcoming_count: null, reservation_count: null, cancelled_count: null, no_show_count: null } }));
    mount();
    await waitFor(() => expect(mock.get).toHaveBeenCalledOnce());
    expect(screen.queryByRole('tab', { name: 'Reservas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Pagamentos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Mensagens' })).not.toBeInTheDocument();
    expect(revoked).toHaveBeenLastCalledWith(false);
  });

  it('also respects the local restriction on reservation details', async () => {
    mount({ canViewReservations: false });
    await tab('Pagamentos');
    expect(await screen.findByText('R$ 54,00')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Reservas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Abrir reserva/ })).not.toBeInTheDocument();
  });

  it('shows future reservations and all-period counts separately from actual visits', async () => {
    mount(); await tab('Reservas');
    expect(await screen.findByText('25/11/2026 às 19:00')).toBeInTheDocument();
    expect(screen.getByText('Confirmada')).toBeInTheDocument();
    expect(screen.getByText('Próxima reserva')).toBeInTheDocument();
    expect(screen.getByText('31')).toBeInTheDocument();
    expect(screen.getByText(/Agendamento confirmado não significa comparecimento/)).toBeInTheDocument();
    expect(screen.queryByText('Histórico atual de visitas')).not.toBeInTheDocument();
  });

  it('opens a reservation as a separate action without replacing the selected profile tab', async () => {
    mount(); await tab('Reservas');
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir reserva reservation-1' }));
    expect(selected).toHaveBeenCalledWith('reservation-1');
    expect(screen.getByRole('tab', { name: 'Reservas' })).toHaveAttribute('aria-selected', 'true');
  });

  it('requests only the next page and preserves totals from the server', async () => {
    mock.get.mockImplementation(async (request: CrmRelationshipRequest) => {
      if (request.section !== 'reservations') return response(request.section);
      const page = request.page ?? 1;
      const rows = page === 1 ? Array.from({ length: 25 }, (_, index) => reservation(`reservation-${index + 1}`)) : [reservation('reservation-26')];
      return response('reservations', { rows: rows as CrmRelationshipPage['rows'], total: 26, page });
    });
    mount(); await tab('Reservas');
    expect(await screen.findByText('1–25 de 26 reservas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página de reservas' }));
    expect(await screen.findByText('26–26 de 26 reservas')).toBeInTheDocument();
    expect(mock.get.mock.calls.filter(([request]) => request.section === 'reservations').map(([request]) => request.page)).toEqual([1, 2]);
    expect(screen.getByRole('button', { name: 'Próxima página de reservas' })).toBeDisabled();
  });

  it('shows payments of holder reservations without inventing a refund amount or date', async () => {
    mount(); await tab('Pagamentos');
    expect(await screen.findByText('R$ 54,00')).toBeInTheDocument();
    expect(screen.getByText('Estornado')).toBeInTheDocument();
    expect(screen.getByText(/em que este cliente é titular/)).toBeInTheDocument();
    expect(screen.queryByText(/Estorno registrado em/)).not.toBeInTheDocument();
    expect(screen.queryByText('R$ 50,00')).not.toBeInTheDocument();
  });

  it('describes recorded messages and does not claim reading from an accepted log', async () => {
    mount(); await tab('Mensagens');
    expect(await screen.findByText('Ana, sua mesa está pronta.')).toBeInTheDocument();
    expect(screen.getByText('Aceita pelo canal')).toBeInTheDocument();
    expect(screen.getByText(/conversas externas não estão incluídas/)).toBeInTheDocument();
    expect(screen.queryByText('Leitura registrada')).not.toBeInTheDocument();
  });

  it('distinguishes an authorized empty section from a failed request and retries without showing a false empty result', async () => {
    let failed = true;
    mock.get.mockImplementation(async (request: CrmRelationshipRequest) => {
      if (request.section === 'messages' && failed) throw new Error('offline');
      return response(request.section, request.section === 'messages' ? { total: 0, rows: [] } : {});
    });
    mount(); await tab('Mensagens');
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar');
    expect(screen.queryByText(/Nenhum registro de mensagens/)).not.toBeInTheDocument();
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Nenhum registro de mensagens para este cliente nesta unidade.')).toBeInTheDocument();
  });

  it('keeps visits usable and does not expose other tabs when relationship permissions cannot be read', async () => {
    mock.get.mockRejectedValue(new Error('not authorized'));
    mount();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Histórico atual de visitas')).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Pagamentos' })).not.toBeInTheDocument();
  });

  it('clears sensitive rows and returns to Visits when server access is revoked', async () => {
    const { client } = mount(); await tab('Pagamentos');
    await screen.findByText('R$ 54,00');
    mock.get.mockResolvedValue(response('summary', { capabilities: { reservations: false, payments: false, messages: false } }));
    await act(async () => { await client.invalidateQueries({ queryKey: ['crm-relationship', 'unit-a', 'phone:ana', 'summary'], exact: true }); });
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Pagamentos' })).not.toBeInTheDocument());
    expect(screen.queryByText('R$ 54,00')).not.toBeInTheDocument();
    expect(screen.getByText('Histórico atual de visitas')).toBeVisible();
  });

  it('does not reuse old customer or company rows while the next profile loads', async () => {
    const view = mount(); await tab('Mensagens');
    await screen.findByText('Ana, sua mesa está pronta.');
    mock.get.mockImplementation(() => new Promise(() => undefined));
    view.rerenderPanel({ customerKey: 'phone:bruno', companyId: 'unit-b' });
    expect(screen.queryByText('Ana, sua mesa está pronta.')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Visitas' })).toHaveAttribute('aria-selected', 'true');
    expect(mock.get.mock.calls.at(-1)?.[0]).toMatchObject({ companyId: 'unit-b', customerKey: 'phone:bruno', section: 'summary' });
  });

  it('clears financial rows and stops section requests as soon as the profile closes', async () => {
    const view = mount(); await tab('Pagamentos');
    await screen.findByText('R$ 54,00');
    const requests = mock.get.mock.calls.length;
    view.rerenderPanel({ open: false });
    expect(screen.queryByText('R$ 54,00')).not.toBeInTheDocument();
    expect(revoked).toHaveBeenLastCalledWith(false);
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['crm-relationship', 'unit-a'] }); });
    expect(mock.get).toHaveBeenCalledTimes(requests);
  });

  it('ignores late metadata from a previous unit/customer instead of enabling its tabs', async () => {
    let oldComplete!: (value: CrmRelationshipPage) => void;
    let nextComplete!: (value: CrmRelationshipPage) => void;
    mock.get.mockImplementation((request: CrmRelationshipRequest) => new Promise((resolve) => {
      if (request.companyId === 'unit-a') oldComplete = resolve;
      else nextComplete = resolve;
    }));
    const view = mount();
    await waitFor(() => expect(oldComplete).toBeTypeOf('function'));
    const oldSignal = mock.get.mock.calls[0][0].signal as AbortSignal;
    view.rerenderPanel({ companyId: 'unit-b', customerKey: 'phone:bruno' });
    await act(async () => { oldComplete(response('summary')); });
    expect(oldSignal.aborted).toBe(true);
    expect(screen.queryByRole('tab', { name: 'Pagamentos' })).not.toBeInTheDocument();
    await act(async () => { nextComplete(response('summary', { company_id: 'unit-b', customer_key: 'phone:bruno', capabilities: { reservations: false, payments: false, messages: false } })); });
    expect(screen.queryByRole('tab', { name: 'Pagamentos' })).not.toBeInTheDocument();
  });

  it('closes the detail gate and rechecks metadata when a section reports revoked reservation access', async () => {
    let denied = false;
    mock.get.mockImplementation(async (request: CrmRelationshipRequest) => response(request.section, denied ? { capabilities: { reservations: false, payments: true, messages: true } } : {}));
    const view = mount(); await tab('Pagamentos');
    await screen.findByRole('button', { name: 'Abrir reserva reservation-1' });
    denied = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['crm-relationship', 'unit-a', 'phone:ana', 'payments'] }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Abrir reserva reservation-1' })).not.toBeInTheDocument());
    expect(revoked).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('tab', { name: 'Reservas' })).not.toBeInTheDocument();
    expect(await screen.findByText('R$ 54,00')).toBeInTheDocument();
  });
});
