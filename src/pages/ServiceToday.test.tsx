import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ServiceToday from './ServiceToday';
import type { ServiceTodayContext } from '@/lib/service-today';

const state = vi.hoisted(() => ({ companyId: 'unit-a', userId: 'actor-a', delegatedId: undefined as string | undefined, timeZone: 'America/Sao_Paulo', loading: false, permissions: new Set(['checkins_view', 'tables_view', 'reservations_view', 'waitlist_view']) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: state.userId } }) }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: state.companyId, companyTimeZone: state.timeZone, companyTimeZoneResolved: true }) }));
vi.mock('@/hooks/useImpersonation', () => ({ useImpersonation: () => ({ impersonatedUserId: state.delegatedId }) }));
vi.mock('@/hooks/useCompanyPermissions', () => ({ useCompanyPermissions: () => ({ permissionsLoading: state.loading, hasPermission: (permission: string) => state.permissions.has(permission) }) }));
vi.mock('@/pages/service-today/ServiceArrivals', () => ({ default: ({ serviceContext: context }: { serviceContext: ServiceTodayContext }) => <div>
  <output aria-label="Contexto de chegadas">{JSON.stringify({ date: context.date, search: context.search, period: context.period, section: context.section, timeZone: context.timeZone })}</output>
  <button onClick={() => context.onSectionsChange?.(['Varanda', 'Salão'])}>Carregar ambientes</button>
  <button onClick={() => context.onFreshnessChange?.({ updatedAt: Date.parse('2026-11-22T13:42:14Z'), fetching: false, hasError: false })}>Confirmar consulta</button>
  <button onClick={() => context.onFreshnessChange?.({ updatedAt: Date.parse('2026-11-22T13:42:14Z'), fetching: true, hasError: false })}>Atualizar consulta</button>
  {context.onOpenSalon && <button onClick={() => context.onOpenSalon?.('table-7')}>Ver mesa 7</button>}
</div> }));
vi.mock('@/pages/service-today/ServiceWaitlist', () => ({ default: ({ serviceContext: context }: { serviceContext: ServiceTodayContext }) => <output aria-label="Contexto da fila">{JSON.stringify({ date: context.date, search: context.search, period: context.period, section: context.section, reservations: context.canViewReservations })}</output> }));
vi.mock('@/components/service-today/ServiceSalon', () => ({ default: ({ context, selectedTableId }: { context: ServiceTodayContext; selectedTableId: string | null }) => <div><output aria-label="Contexto do salão">{JSON.stringify({ search: context.search, period: context.period, section: context.section, selectedTableId })}</output></div> }));

function LocationProbe() { const location = useLocation(); return <output aria-label="URL do serviço">{location.pathname}{location.search}</output>; }
function mount(path = '/') {
  const element = () => <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><LocationProbe /><Routes><Route path="/" element={<ServiceToday />} /><Route path="/acesso-negado" element={<p>Sem acesso</p>} /></Routes></MemoryRouter>;
  const view = render(element());
  return { ...view, refresh: () => view.rerender(element()) };
}
function tab(name: string) { fireEvent.click(screen.getByRole('tab', { name })); }
beforeEach(() => {
  state.companyId = 'unit-a'; state.userId = 'actor-a'; state.delegatedId = undefined; state.timeZone = 'America/Sao_Paulo'; state.loading = false;
  state.permissions = new Set(['checkins_view', 'tables_view', 'reservations_view', 'waitlist_view']);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ServiceToday real container', () => {
  it('opens the queue from the canonical shared URL even when arrivals are also permitted', () => {
    mount('/?tab=fila');
    expect(screen.getByRole('tab', { name: 'Fila' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Contexto da fila')).toBeInTheDocument();
    expect(screen.queryByLabelText('Contexto de chegadas')).not.toBeInTheDocument();
    tab('Chegadas');
    expect(screen.getByLabelText('URL do serviço')).toHaveTextContent('?tab=chegadas');
  });
  it('keeps unpermitted query tabs from mounting hidden operational data', () => {
    state.permissions = new Set(['waitlist_view']); mount('/?tab=salao');
    expect(screen.getByRole('tab', { name: 'Fila' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Contexto do salão')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Contexto de chegadas')).not.toBeInTheDocument();
  });
  it('starts with tabs and the date, without the duplicated visual heading, test badge or clock', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-22T22:10:00Z'));
    mount();
    expect(screen.getByRole('heading', { name: 'Serviços de Hoje' })).toHaveClass('sr-only');
    expect(screen.queryByText('Em teste')).not.toBeInTheDocument();
    expect(screen.queryByText('Acompanhe chegadas, mesas e fila no mesmo lugar.')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/data da unidade/)).toHaveTextContent('Hoje, 22 de nov. de 2026');
    expect(screen.getByLabelText(/data da unidade/)).not.toHaveTextContent('19:10');
  });
  it('keeps the shared search and full day when switching among all three views without artificial period or environment filters', () => {
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar no serviço' }), { target: { value: 'Ana' } });
    expect(screen.queryByRole('combobox', { name: 'Ambiente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Horário' })).not.toBeInTheDocument();
    const arrivals = JSON.parse(screen.getByLabelText('Contexto de chegadas').textContent!);
    tab('Fila');
    expect(JSON.parse(screen.getByLabelText('Contexto da fila').textContent!)).toMatchObject({ date: arrivals.date, search: 'Ana', period: 'all', section: 'all', reservations: true });
    tab('Salão');
    expect(JSON.parse(screen.getByLabelText('Contexto do salão').textContent!)).toMatchObject({ search: 'Ana', section: 'all', period: 'all' });
    tab('Chegadas'); expect(screen.getByRole('textbox', { name: 'Buscar no serviço' })).toHaveValue('Ana');
  });
  it('opens the selected table only when Salon is permitted', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Ver mesa 7' }));
    expect(screen.getByRole('tab', { name: 'Salão' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Contexto do salão')).toHaveTextContent('table-7');
  });
  it('gives a queue-only operator a functioning first view without mounting hidden screens', () => {
    state.permissions = new Set(['waitlist_view']); mount();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Fila' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Contexto de chegadas')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Contexto do salão')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Ambiente' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Contexto da fila')).toHaveTextContent('"reservations":false');
  });
  it('does not grant Salon to the default operator or to a tables-only operator', () => {
    state.permissions = new Set(['checkins_view', 'reservations_view', 'waitlist_view']); const view = mount();
    expect(screen.queryByRole('tab', { name: 'Salão' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ver mesa 7' })).not.toBeInTheDocument();
    state.permissions = new Set(['tables_view', 'waitlist_view']); view.refresh();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.queryByLabelText('Contexto do salão')).not.toBeInTheDocument();
  });
  it('removes open records and clears the previous scope when permissions or identity change', () => {
    const view = mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar no serviço' }), { target: { value: 'Previous actor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ver mesa 7' }));
    state.permissions = new Set(['waitlist_view']); view.refresh();
    expect(screen.queryByLabelText('Contexto do salão')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Buscar no serviço' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar no serviço' }), { target: { value: 'Other scope' } });
    state.companyId = 'unit-b'; state.userId = 'actor-b'; view.refresh();
    expect(screen.getByRole('textbox', { name: 'Buscar no serviço' })).toHaveValue('');
  });
  it('does not mount any operational view while permissions are unresolved or absent', () => {
    state.loading = true; const view = mount();
    expect(screen.getByRole('status', { name: 'Carregando Serviços de Hoje' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    state.loading = false; state.permissions = new Set(); view.refresh(); expect(screen.getByText('Sem acesso')).toBeVisible();
  });
  it('changes the day at the unit midnight rather than the browser midnight', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T02:59:55Z'));
    mount(); expect(screen.getByLabelText('Contexto de chegadas')).toHaveTextContent('2026-11-22');
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByLabelText('Contexto de chegadas')).toHaveTextContent('2026-11-23');
  });
  it('moves between authorized tabs with the keyboard', () => {
    mount(); fireEvent.keyDown(screen.getByRole('tab', { name: 'Chegadas' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Salão' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Salão' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Fila' })).toHaveAttribute('aria-selected', 'true');
  });
  it('keeps the last successful timestamp in its fixed header slot during background updates', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Confirmar consulta' }));
    const stamp = screen.getByLabelText('Última atualização: 22/11/2026, 10:42:14');
    expect(stamp).toHaveTextContent('Atualizado às 10:42:14');
    expect(stamp).toHaveClass('h-8');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar consulta' }));
    expect(stamp).toHaveTextContent('Atualizado às 10:42:14');
    expect(screen.getByLabelText('Atualizando dados')).toBeInTheDocument();
    expect(screen.getAllByText(/Atualizado às/)).toHaveLength(1);
  });
});
