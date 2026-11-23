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
  search: vi.fn(),
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
  searchCompanyGlobal: mocks.search,
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
  query: string;
  reservationsPage?: number;
  customersPage?: number;
  signal?: AbortSignal;
};
function result(params: SearchParams, overrides: Record<string, unknown> = {}) {
  return {
    query: params.query,
    reservations: { items: [reservation], page: params.reservationsPage ?? 1, hasMore: false, error: null },
    customers: { items: [customer], page: params.customersPage ?? 1, hasMore: false, error: null },
    ...overrides,
  };
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
  mocks.search.mockReset().mockImplementation(async params => result(params));
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
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('aguarda três caracteres e o debounce para consultar apenas o termo mais recente', async () => {
    vi.useFakeTimers();
    renderSearch();
    const input = openSearch();
    enterQuery(input, 'Ma');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.search).not.toHaveBeenCalled();
    enterQuery(input, 'Mari');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    enterQuery(input, 'Maria');
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(mocks.search).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1', query: 'Maria', canViewReservations: true, canViewCustomers: true,
      signal: expect.any(AbortSignal),
    }));
    expect(input).toHaveAttribute('maxlength', '200');
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
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it('reutiliza o perfil canônico e bloqueia abrir reservas quando o acesso é só a clientes', async () => {
    mocks.permissions = new Set(['leads_view']);
    mocks.search.mockImplementation(async params => result(params, { reservations: { items: [], page: 1, hasMore: false, error: null } }));
    renderSearch();
    const input = openSearch(); enterQuery(input);
    fireEvent.click(await screen.findByRole('option', { name: /Maria Cliente/ }));
    expect(await screen.findByRole('dialog', { name: 'Perfil encontrado' })).toBeVisible();
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ canViewCustomers: true, canViewReservations: false }));
    expect(mocks.customerProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, canViewReservations: false, lead: expect.objectContaining({ key: customer.customer_key, guest_name: 'Maria Cliente' }) }));
    expect(mocks.from).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar à busca de clientes' }));
    expect(screen.getByRole('combobox', { name: 'Nome, telefone ou código' })).toHaveValue('Maria');
  });

  it('não solicita clientes quando a permissão é somente de reservas', async () => {
    mocks.permissions = new Set(['reservations_view']);
    mocks.search.mockImplementation(async params => result(params, { customers: { items: [], page: 1, hasMore: false, error: null } }));
    renderSearch(); enterQuery(openSearch());
    expect(await findReservation()).toBeVisible();
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ canViewCustomers: false, canViewReservations: true }));
    expect(screen.queryByRole('option', { name: /Maria Cliente/ })).not.toBeInTheDocument();
  });

  it('mostra falha por seção sem esconder os resultados válidos e oferece nova tentativa', async () => {
    mocks.search.mockImplementationOnce(async params => result(params, {
      customers: { items: [], page: 1, hasMore: false, error: 'Não foi possível buscar clientes.' },
    })).mockImplementation(async params => result(params));
    renderSearch(); enterQuery(openSearch());
    expect(await findReservation()).toBeVisible();
    expect(screen.getByText('Não foi possível buscar clientes.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));
    expect(await screen.findByRole('option', { name: /Maria Cliente/ })).toBeVisible();
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });

  it('pagina resultados de cada seção sem misturar a seleção do outro grupo', async () => {
    mocks.search.mockImplementation(async params => result(params, {
      reservations: { items: [{ ...reservation, guest_name: (params.reservationsPage ?? 1) === 1 ? 'Maria Reserva' : 'Maria Outra Reserva' }], page: params.reservationsPage ?? 1, hasMore: (params.reservationsPage ?? 1) === 1, error: null },
      customers: { items: [customer], page: params.customersPage ?? 1, hasMore: true, error: null },
    }));
    renderSearch(); enterQuery(openSearch());
    await findReservation();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página de reservas' }));
    expect(await screen.findByRole('option', { name: /Maria Outra Reserva/ })).toBeVisible();
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ reservationsPage: 2, customersPage: 1, query: 'Maria' }));
    expect(screen.getByRole('option', { name: /Maria Cliente/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página de clientes' }));
    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ reservationsPage: 2, customersPage: 2 })));
    enterQuery(screen.getByRole('combobox', { name: 'Nome, telefone ou código' }), 'Outra');
    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'Outra', reservationsPage: 1, customersPage: 1 })));
  });

  it('ignora a resposta atrasada do termo anterior e aborta a consulta substituída', async () => {
    let finishOld: ((value: ReturnType<typeof result>) => void) | undefined;
    let oldParams: SearchParams | undefined;
    mocks.search.mockImplementation((params: SearchParams) => {
      if (params.query === 'Maria') {
        oldParams = params;
        return new Promise(resolve => { finishOld = resolve; });
      }
      return Promise.resolve(result(params, { reservations: { items: [{ ...reservation, guest_name: 'Joana Reserva' }], page: 1, hasMore: false, error: null }, customers: { items: [], page: 1, hasMore: false, error: null } }));
    });
    renderSearch(); const input = openSearch(); enterQuery(input);
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    enterQuery(input, 'Joana');
    expect(await screen.findByRole('option', { name: /Joana Reserva/ })).toBeVisible();
    expect(oldParams?.signal?.aborted).toBe(true);
    await act(async () => { finishOld?.(result(oldParams!)); });
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
    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 'company-2', query: 'Joana' })));
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
    mocks.search.mockImplementation(async params => result(params, {
      reservations: { items: [], page: 1, hasMore: false, error: null },
      customers: { items: [], page: 1, hasMore: false, error: null },
    }));
    renderSearch(); const input = openSearch(); enterQuery(input);
    expect(await screen.findByText('Nenhuma reserva encontrada.')).toBeVisible();
    expect(screen.getByText('Nenhum cliente encontrado.')).toBeVisible();
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
