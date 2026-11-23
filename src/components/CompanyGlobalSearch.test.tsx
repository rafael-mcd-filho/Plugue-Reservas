import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyGlobalSearch from '@/components/CompanyGlobalSearch';
import type { CrmLeadRow } from '@/hooks/useCrmLeads';

const mocks = vi.hoisted(() => ({
  companyId: 'company-1',
  userId: 'user-1',
  impersonatedUserId: null as string | null,
  permissions: new Set(['reservations_view', 'leads_view', 'events_view']),
  permissionsLoading: false,
  permissionsError: null as Error | null,
  searchReservations: vi.fn(),
  searchCustomers: vi.fn(),
  from: vi.fn(),
  filters: [] as unknown[][],
  signal: undefined as AbortSignal | undefined,
  reservationProps: vi.fn(),
  customerProps: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: mocks.userId }, profile: { company_id: mocks.companyId }, roles: ['admin'], loading: false }),
}));
vi.mock('@/hooks/useImpersonation', () => ({
  useImpersonation: () => ({ impersonatedUserId: mocks.impersonatedUserId }),
}));
vi.mock('@/hooks/useCompanyPermissions', () => ({
  useCompanyPermissions: () => ({
    activeCompanyId: mocks.companyId,
    activeRoles: ['admin'],
    hasPermission: (permission: string) => mocks.permissions.has(permission),
    permissionsLoading: mocks.permissionsLoading,
    permissionsError: mocks.permissionsError,
  }),
}));
vi.mock('@/lib/company-global-search', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/company-global-search')>(),
  searchCompanyReservations: mocks.searchReservations,
  searchCompanyCustomers: mocks.searchCustomers,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/components/ReservationDetailsDialog', async () => {
  const { Dialog, DialogContent, DialogTitle, DialogDescription } = await import('@/components/ui/dialog');
  return {
    default: (props: {
      open: boolean;
      reservation: { guest_name: string } | null;
      onOpenChange: (open: boolean) => void;
      onBackToList: () => void;
      readOnly?: boolean;
      showEventHistory?: boolean;
      showLeadHistory?: boolean;
    }) => {
      mocks.reservationProps(props);
      return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent>
          <DialogTitle>Reserva encontrada</DialogTitle>
          <DialogDescription>Detalhes da reserva selecionada.</DialogDescription>
          <p>{props.reservation?.guest_name ?? 'Carregando reserva'}</p>
          <button type="button" onClick={props.onBackToList}>Voltar à busca</button>
        </DialogContent>
      </Dialog>;
    },
  };
});
vi.mock('@/components/leads/LeadProfileDialog', async () => {
  const { Dialog, DialogContent, DialogTitle, DialogDescription } = await import('@/components/ui/dialog');
  return {
    default: (props: {
      open: boolean;
      lead: { guest_name: string; key: string } | null;
      onOpenChange: (open: boolean) => void;
      canViewReservations?: boolean;
      readOnly?: boolean;
    }) => {
      mocks.customerProps(props);
      return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent>
          <DialogTitle>Perfil encontrado</DialogTitle>
          <DialogDescription>Perfil do cliente selecionado.</DialogDescription>
          <p>{props.lead?.guest_name}</p>
          <button type="button" onClick={() => props.onOpenChange(false)}>Voltar à busca de clientes</button>
        </DialogContent>
      </Dialog>;
    },
  };
});

const reservation = {
  id: 'reservation-1', company_id: 'company-1', guest_name: 'Maria Reserva',
  guest_phone: '11999998888', guest_phone_e164: '+5511999998888',
  date: '2026-10-30', time: '18:00:00', party_size: 5, status: 'confirmed',
  public_tracking_code: 'RES123',
};
const customer: CrmLeadRow = {
  customer_key: 'phone:5511999997777', profile_customer_key: 'phone:5511999997777',
  phone_e164: '+5511999997777', phone_normalized: '5511999997777', display_phone: '+5511999997777',
  latest_name: 'Maria Cliente', latest_email: null, latest_birthdate: null,
  first_seen_at: '2026-01-01T12:00:00Z', last_visit_date: '2026-10-01', last_visit_time: '20:00:00',
  state_code: 'SP', state_name: 'São Paulo', source: 'reservation_holder', canonical_visit_count: 3,
  crm_lead: null,
};

type SearchParams = {
  companyId?: string;
  query: string;
  page?: number;
  signal?: AbortSignal;
};
function section<T>(items: T[], params: SearchParams, hasMore = false) {
  return { items, page: params.page ?? 1, hasMore, error: null };
}
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Contexto atual">{location.pathname}{location.search}</output>;
}
function renderSearch(companyId = 'company-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = (id: string) => <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/casa/admin/calendario?date=2026-10-30']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <LocationProbe />
      <CompanyGlobalSearch companyId={id} companyName={id === 'company-1' ? 'Casa de teste' : 'Outra unidade'} slug="casa" />
    </MemoryRouter>
  </QueryClientProvider>;
  const view = render(tree(companyId));
  return { ...view, client, changeCompany: (id: string) => { mocks.companyId = id; view.rerender(tree(id)); } };
}
function openSearch() {
  fireEvent.click(screen.getByRole('button', { name: 'Buscar clientes e reservas' }));
  return screen.getByRole('combobox', { name: 'Nome, telefone ou código' });
}
function enterQuery(input: HTMLElement, query = 'Maria') {
  fireEvent.change(input, { target: { value: query } });
}
async function findReservation() {
  return screen.findByRole('option', { name: /Maria Reserva/ });
}
beforeEach(() => {
  mocks.companyId = 'company-1'; mocks.userId = 'user-1'; mocks.impersonatedUserId = null;
  mocks.permissions = new Set(['reservations_view', 'leads_view', 'events_view']);
  mocks.permissionsLoading = false; mocks.permissionsError = null; mocks.filters = []; mocks.signal = undefined;
  mocks.reservationProps.mockClear(); mocks.customerProps.mockClear();
  mocks.searchReservations.mockReset().mockImplementation(async (params: SearchParams) => section([reservation], params));
  mocks.searchCustomers.mockReset().mockImplementation(async (params: SearchParams) => section([customer], params));
  mocks.from.mockReset().mockImplementation(() => {
    const builder = {
      select: () => builder,
      eq: (...args: unknown[]) => { mocks.filters.push(args); return builder; },
      abortSignal: (signal: AbortSignal) => { mocks.signal = signal; return builder; },
      maybeSingle: async () => ({ data: { ...reservation, guest_email: null, source: 'web' }, error: null }),
    };
    return builder;
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('busca global da unidade', () => {
  it.each(['no-permissions', 'wrong-company', 'loading', 'permission-error'])('não monta nem consulta fora do acesso: %s', boundary => {
    if (boundary === 'no-permissions') mocks.permissions.clear();
    if (boundary === 'wrong-company') mocks.companyId = 'other';
    if (boundary === 'loading') mocks.permissionsLoading = true;
    if (boundary === 'permission-error') mocks.permissionsError = new Error('sem acesso');
    renderSearch();
    expect(screen.queryByRole('button', { name: 'Buscar clientes e reservas' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(mocks.searchReservations).not.toHaveBeenCalled();
    expect(mocks.searchCustomers).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('aguarda três caracteres e o debounce para consultar apenas o termo mais recente', async () => {
    vi.useFakeTimers();
    renderSearch();
    const input = openSearch();
    enterQuery(input, 'Ma');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.searchReservations).not.toHaveBeenCalled();
    enterQuery(input, 'Mari');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    enterQuery(input, 'Maria');
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(mocks.searchReservations).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.searchReservations).toHaveBeenCalledTimes(1);
    expect(mocks.searchCustomers).toHaveBeenCalledTimes(1);
    for (const search of [mocks.searchReservations, mocks.searchCustomers]) {
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', query: 'Maria', page: 1, signal: expect.any(AbortSignal) }));
    }
    expect(input).toHaveAttribute('maxlength', '200');
  });

  it('mostra as reservas sem esperar a busca de clientes terminar', async () => {
    mocks.searchCustomers.mockImplementation(() => new Promise(() => undefined));
    renderSearch(); enterQuery(openSearch());
    expect(await findReservation()).toBeVisible();
    expect(screen.getByText('Buscando clientes…')).toBeVisible();
  });

  it('abre a reserva autorizada e volta à mesma busca sem navegar ou permitir edição', async () => {
    renderSearch();
    const input = openSearch(); enterQuery(input);
    fireEvent.click(await findReservation());
    expect(await screen.findByRole('dialog', { name: 'Reserva encontrada' })).toBeVisible();
    await waitFor(() => expect(mocks.filters).toEqual([['company_id', 'company-1'], ['id', 'reservation-1']]));
    expect(mocks.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.reservationProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, showEventHistory: true, showLeadHistory: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Voltar à busca' }));
    expect(screen.getByRole('combobox', { name: 'Nome, telefone ou código' })).toHaveValue('Maria');
    expect(screen.getByRole('option', { name: /Maria Reserva/ })).toBeVisible();
    expect(screen.getByLabelText('Contexto atual')).toHaveTextContent('/casa/admin/calendario?date=2026-10-30');
    expect(mocks.searchReservations).toHaveBeenCalledTimes(1);
  });

  it('reutiliza o perfil canônico e bloqueia abrir reservas quando o acesso é só a clientes', async () => {
    mocks.permissions = new Set(['leads_view']);
    renderSearch();
    const input = openSearch(); enterQuery(input);
    fireEvent.click(await screen.findByRole('option', { name: /Maria Cliente/ }));
    expect(await screen.findByRole('dialog', { name: 'Perfil encontrado' })).toBeVisible();
    expect(mocks.searchReservations).not.toHaveBeenCalled();
    expect(mocks.customerProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, canViewReservations: false, lead: expect.objectContaining({ key: customer.customer_key, guest_name: 'Maria Cliente' }) }));
    expect(mocks.from).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar à busca de clientes' }));
    expect(screen.getByRole('combobox', { name: 'Nome, telefone ou código' })).toHaveValue('Maria');
  });

  it('não solicita clientes quando a permissão é somente de reservas', async () => {
    mocks.permissions = new Set(['reservations_view']);
    renderSearch(); enterQuery(openSearch());
    expect(await findReservation()).toBeVisible();
    expect(mocks.searchCustomers).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: /Maria Cliente/ })).not.toBeInTheDocument();
  });

  it('mostra falha por seção sem esconder os resultados válidos e oferece nova tentativa', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.searchCustomers.mockRejectedValueOnce(new Error('timeout'))
      .mockImplementation(async (params: SearchParams) => section([customer], params));
    renderSearch(); enterQuery(openSearch());
    expect(await findReservation()).toBeVisible();
    expect(await screen.findByText('Não foi possível buscar clientes.')).toBeVisible();
    expect(warn).toHaveBeenCalledWith('Busca global: falha ao buscar clientes', expect.any(Error));
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));
    expect(await screen.findByRole('option', { name: /Maria Cliente/ })).toBeVisible();
    expect(mocks.searchCustomers).toHaveBeenCalledTimes(2);
    expect(mocks.searchReservations).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('carrega mais resultados em cada grupo sem perder os anteriores nem recarregar o outro', async () => {
    mocks.searchReservations.mockImplementation(async (params: SearchParams) => section(
      [{ ...reservation, id: `reservation-${params.page ?? 1}`, guest_name: (params.page ?? 1) === 1 ? 'Maria Reserva' : 'Maria Outra Reserva' }],
      params, (params.page ?? 1) === 1,
    ));
    mocks.searchCustomers.mockImplementation(async (params: SearchParams) => section(
      [{ ...customer, customer_key: `phone:${params.page ?? 1}`, latest_name: (params.page ?? 1) === 1 ? 'Maria Cliente' : 'Maria Outra Cliente' }],
      params, (params.page ?? 1) === 1,
    ));
    renderSearch(); enterQuery(openSearch());
    await findReservation();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais reservas' }));
    expect(await screen.findByRole('option', { name: /Maria Outra Reserva/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /Maria Reserva/ })).toBeVisible();
    expect(mocks.searchReservations).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, query: 'Maria' }));
    expect(mocks.searchCustomers).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Carregar mais reservas' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais clientes' }));
    expect(await screen.findByRole('option', { name: /Maria Outra Cliente/ })).toBeVisible();
    expect(mocks.searchCustomers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    enterQuery(screen.getByRole('combobox', { name: 'Nome, telefone ou código' }), 'Outra');
    await waitFor(() => expect(mocks.searchReservations).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'Outra', page: 1 })));
    await waitFor(() => expect(mocks.searchCustomers).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'Outra', page: 1 })));
  });

  it('ignora a resposta atrasada do termo anterior e aborta a consulta substituída', async () => {
    let finishOld: ((value: unknown) => void) | undefined;
    let oldParams: SearchParams | undefined;
    mocks.searchReservations.mockImplementation((params: SearchParams) => {
      if (params.query === 'Maria') {
        oldParams = params;
        return new Promise(resolve => { finishOld = resolve; });
      }
      return Promise.resolve(section([{ ...reservation, guest_name: 'Joana Reserva' }], params));
    });
    mocks.searchCustomers.mockImplementation(async (params: SearchParams) => section([], params));
    renderSearch(); const input = openSearch(); enterQuery(input);
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    enterQuery(input, 'Joana');
    expect(await screen.findByRole('option', { name: /Joana Reserva/ })).toBeVisible();
    expect(oldParams?.signal?.aborted).toBe(true);
    await act(async () => { finishOld?.(section([reservation], oldParams!)); });
    expect(screen.queryByRole('option', { name: /Maria Reserva/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Joana Reserva/ })).toBeVisible();
  });

  it('abre pelo atalho e permite selecionar um resultado pelo teclado', async () => {
    renderSearch();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Nome, telefone ou código' });
    enterQuery(input);
    await findReservation();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.reservationProps.mock.calls.length + mocks.customerProps.mock.calls.length).toBeGreaterThan(0));
    expect(screen.getByRole('dialog', { name: /Reserva encontrada|Perfil encontrado/ })).toBeVisible();
  });

  it('limpa texto e resultados imediatamente ao mudar a unidade', async () => {
    const view = renderSearch(); enterQuery(openSearch());
    await findReservation();
    view.changeCompany('company-2');
    expect(screen.queryByRole('option', { name: /Maria Reserva/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Buscar na unidade' })).not.toBeInTheDocument();
    const input = openSearch();
    expect(input).toHaveValue('');
    enterQuery(input, 'Joana');
    await waitFor(() => expect(mocks.searchReservations).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 'company-2', query: 'Joana' })));
  });

  it('encerra o acesso à busca e aos detalhes se a permissão for revogada', async () => {
    const view = renderSearch(); enterQuery(openSearch());
    fireEvent.click(await findReservation());
    expect(await screen.findByRole('dialog', { name: 'Reserva encontrada' })).toBeVisible();
    mocks.permissions.clear();
    view.rerender(<QueryClientProvider client={view.client}><MemoryRouter><CompanyGlobalSearch companyId="company-1" companyName="Casa de teste" slug="casa" /></MemoryRouter></QueryClientProvider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buscar clientes e reservas' })).not.toBeInTheDocument();
  });

  it('diferencia nenhum resultado de falha e permite fechar pelo teclado', async () => {
    mocks.searchReservations.mockImplementation(async (params: SearchParams) => section([], params));
    mocks.searchCustomers.mockImplementation(async (params: SearchParams) => section([], params));
    renderSearch(); const input = openSearch(); enterQuery(input);
    expect(await screen.findByText('Nenhuma reserva encontrada.')).toBeVisible();
    expect(await screen.findByText('Nenhum cliente encontrado.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Buscar na unidade' })).not.toBeInTheDocument());
    expect(openSearch()).toHaveValue('');
  });

  it('não reapresenta a busca do usuário anterior ao trocar a identidade da sessão', async () => {
    const view = renderSearch(); enterQuery(openSearch());
    await findReservation();
    mocks.userId = 'user-2';
    view.changeCompany('company-1');
    expect(screen.queryByRole('dialog', { name: 'Buscar na unidade' })).not.toBeInTheDocument();
    expect(openSearch()).toHaveValue('');
    expect(screen.queryByRole('option', { name: /Maria Reserva/ })).not.toBeInTheDocument();
  });
});
