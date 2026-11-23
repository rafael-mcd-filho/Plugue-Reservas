import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changePublicReservation, getPublicReservationChangeOptions, parsePublicReservationChangeOptions, parsePublicReservationChangeResult, publicReservationChangeDateBounds } from './public-reservation-changes';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
const reservation = { id: 'reservation-1', date: '2026-11-24', time: '19:00', party_size: 2, updated_at: '2026-11-22T12:00:00+00:00' };
const payload = { allowed: true, reason: null, reservation, revision: reservation.updated_at, min_notice_minutes: 120,
  time_zone: 'America/Sao_Paulo', server_now: '2026-11-22T12:00:00+00:00', date: reservation.date, party_size: 2, max_party_size: 20,
  slots: [{ time: '19:00', available: true, reason: null, duration_minutes: 60 }] };
beforeEach(() => vi.clearAllMocks());
describe('public reservation change contract', () => {
  it('verifica que a resposta pertence à reserva solicitada', () => {
    expect(() => parsePublicReservationChangeOptions(payload, 'another-reservation')).toThrow();
    expect(() => parsePublicReservationChangeResult({ changed: true, replayed: false, reason: null, reservation, revision: reservation.updated_at }, 'another-reservation')).toThrow();
  });
  it.each([
    { allowed: 'true' }, { reason: 'future-unknown-value' }, { revision: 'bad' }, { time_zone: 'unknown' },
    { slots: [{ time: '25:00', available: true, reason: null, duration_minutes: 60 }] },
    { slots: [{ time: '19:00', available: true, reason: 'payment', duration_minutes: 60 }] },
  ])('rejeita resposta incompleta ou contraditória: %j', invalid => {
    expect(() => parsePublicReservationChangeOptions({ ...payload, ...invalid }, reservation.id)).toThrow();
  });
  it('aceita empresa desativada como resposta válida sem habilitar alteração', () => {
    expect(parsePublicReservationChangeOptions({ ...payload, allowed: false, reason: 'disabled', slots: [] }, reservation.id).allowed).toBe(false);
  });
  it('usa o dia da unidade na virada de data e não o fuso do navegador', () => {
    expect(publicReservationChangeDateBounds('2026-11-23T01:30:00Z', 'America/Sao_Paulo')).toEqual({ min: '2026-11-22', max: '2027-11-22' });
    expect(publicReservationChangeDateBounds('2026-11-23T01:30:00Z', 'Europe/Lisbon').min).toBe('2026-11-23');
  });
  it('consulta opções com a identificação pública e os dados escolhidos', async () => {
    mocks.rpc.mockResolvedValue({ data: payload, error: null });
    await getPublicReservationChangeOptions({ trackingCode: 'code', visitorId: 'visitor', reservationId: reservation.id, date: reservation.date, partySize: 2 });
    expect(mocks.rpc).toHaveBeenCalledWith('get_public_reservation_change_options', { _tracking_code: 'code', _visitor_id: 'visitor', _date: reservation.date, _party_size: 2 });
  });
  it('não aceita opções de outra data ou quantidade como se fossem da seleção atual', async () => {
    mocks.rpc.mockResolvedValue({ data: payload, error: null });
    await expect(getPublicReservationChangeOptions({ trackingCode: 'code', visitorId: 'visitor', reservationId: reservation.id, date: '2026-11-25', partySize: 3 })).rejects.toThrow();
  });
  it('envia revisão e chave de idempotência sem criar outra reserva', async () => {
    mocks.rpc.mockResolvedValue({ data: { changed: true, replayed: false, reason: null, revision: reservation.updated_at, reservation }, error: null });
    await changePublicReservation({ trackingCode: 'code', visitorId: 'visitor', reservationId: reservation.id, date: reservation.date, time: '19:00', partySize: 3, revision: reservation.updated_at, requestId: 'request-id' });
    expect(mocks.rpc).toHaveBeenCalledWith('change_public_reservation', { _tracking_code: 'code', _visitor_id: 'visitor', _date: reservation.date,
      _time: '19:00', _party_size: 3, _expected_revision: reservation.updated_at, _request_id: 'request-id' });
  });
  it('preserva erros de transporte para que uma falha não vire sucesso aparente', async () => {
    const error = new Error('network');
    mocks.rpc.mockResolvedValue({ data: null, error });
    await expect(changePublicReservation({ trackingCode: 'code', visitorId: 'visitor', reservationId: reservation.id, date: reservation.date, time: '19:00', partySize: 3, revision: reservation.updated_at, requestId: 'request-id' })).rejects.toBe(error);
  });
});
