import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReservationTracking from './ReservationTracking';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), payment: vi.fn(), success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, functions: { invoke: mocks.invoke } } }));
vi.mock('@/hooks/useFunnelTracking', () => ({ getVisitorId: () => 'visitor-test' }));
vi.mock('@/lib/publicCompanyIcons', () => ({ useFaviconOverride: vi.fn() }));
vi.mock('@/lib/asaas-prepayment-api', () => ({ getReservationPaymentByTrackingCode: mocks.payment, checkReservationPayment: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, info: mocks.info, error: mocks.error } }));

let entry: Record<string, unknown>;
let enabled: boolean;
function snapshot() {
  return { id: entry.id, date: entry.date, time: String(entry.time).slice(0, 5), party_size: entry.party_size, updated_at: entry.updated_at };
}
beforeEach(() => {
  vi.clearAllMocks();
  enabled = false;
  entry = { id: 'reservation-1', company_id: 'company-1', guest_name: 'Ana Teste', date: '2026-11-24', time: '19:00:00', party_size: 2,
    status: 'confirmed', occasion: null, notes: null, created_at: '2026-11-22T12:00:00Z', updated_at: '2026-11-22T12:00:00Z',
    public_tracking_code: 'tracking-code', review_token: null, review_status: null };
  mocks.payment.mockResolvedValue(null);
  mocks.invoke.mockResolvedValue({ data: null, error: null });
  mocks.rpc.mockImplementation(async (name: string, input: Record<string, unknown>) => {
    if (name === 'get_public_company_by_slug') return { data: [{ id: 'company-1', name: 'Restaurante Teste', logo_url: null, whatsapp: '5562999990000', reservation_late_tolerance_minutes: 0 }], error: null };
    if (name === 'get_public_reservation_by_tracking_code') return { data: [{ ...entry }], error: null };
    if (name === 'get_public_reservation_change_options') return { data: { allowed: enabled, reason: enabled ? null : 'disabled', revision: entry.updated_at,
      reservation: snapshot(), date: input._date, party_size: input._party_size, max_party_size: 20, min_notice_minutes: 120,
      time_zone: 'America/Sao_Paulo', server_now: '2026-11-22T12:00:00Z', slots: enabled ? [
        { time: '19:00', available: true, reason: null, duration_minutes: 60 },
        { time: '20:00', available: true, reason: null, duration_minutes: 60 },
      ] : [] }, error: null };
    if (name === 'change_public_reservation') {
      entry = { ...entry, date: input._date, time: `${input._time}:00`, party_size: input._party_size, updated_at: '2026-11-22T13:00:00Z' };
      return { data: { changed: true, replayed: false, reason: null, revision: entry.updated_at, reservation: snapshot() }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
});
afterEach(() => cleanup());
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/restaurant/reserva/tracking-code']}><Routes>
    <Route path="/:slug/reserva/:code" element={<ReservationTracking />} />
  </Routes></MemoryRouter></QueryClientProvider>);
}

describe('ReservationTracking — alterações autônomas opcionais', () => {
  it('mantém o botão e o encaminhamento atual com a opção desativada', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Alterar reserva' }));
    expect(await screen.findByRole('link', { name: 'Falar pelo WhatsApp' })).toBeVisible();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'change_public_reservation')).toBe(false);
  });
  it('atualiza a mesma reserva e recarrega o acompanhamento após a mudança', async () => {
    enabled = true;
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Alterar reserva' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar' }));
    fireEvent.click(await screen.findByRole('button', { name: '20:00' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar alteração' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('20:00')).toBeVisible();
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'get_public_reservation_by_tracking_code');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(([, params]) => params._tracking_code === 'tracking-code')).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith('Reserva alterada com sucesso.');
  });
  it('mesmo com a função ativada, reserva paga continua pelo WhatsApp', async () => {
    enabled = true;
    mocks.payment.mockResolvedValue({ status: 'paid', paid_at: '2026-11-22T12:30:00Z', expires_at: '2026-11-22T12:40:00Z' });
    setup();
    await screen.findByRole('link', { name: 'Cancelar pelo WhatsApp' });
    fireEvent.click(screen.getByRole('button', { name: 'Alterar reserva' }));
    expect(await screen.findByRole('link', { name: 'Falar pelo WhatsApp' })).toBeVisible();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'get_public_reservation_change_options')).toBe(false);
  });
  it.each(['checked_in', 'cancelled', 'no-show'])('não oferece alteração autônoma para reserva %s', async status => {
    enabled = true;
    entry.status = status;
    setup();
    await screen.findByText('Acompanhamento da reserva');
    expect(screen.queryByRole('button', { name: 'Alterar reserva' })).not.toBeInTheDocument();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'get_public_reservation_change_options')).toBe(false);
  });
});
