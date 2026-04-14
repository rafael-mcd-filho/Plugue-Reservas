import { buildLargePartyWhatsappUrl, isLargePartyReservation, LARGE_PARTY_SIZE } from './reservation-flow';

describe('reservation-flow', () => {
  it('considers parties with 10 or more people as large reservations', () => {
    expect(isLargePartyReservation(LARGE_PARTY_SIZE - 1)).toBe(false);
    expect(isLargePartyReservation(LARGE_PARTY_SIZE)).toBe(true);
    expect(isLargePartyReservation(LARGE_PARTY_SIZE + 1)).toBe(true);
  });

  it('builds the WhatsApp URL for large party reservations', () => {
    expect(buildLargePartyWhatsappUrl('(11) 99999-9999')).toBe(
      'https://wa.me/5511999999999?text=Oi%2C%20vim%20pelo%20site%20e%20preciso%20de%20uma%20reserva%20a%20partir%20de%2010%20pessoas',
    );
  });

  it('returns null when the restaurant has no WhatsApp configured', () => {
    expect(buildLargePartyWhatsappUrl(null)).toBeNull();
    expect(buildLargePartyWhatsappUrl('')).toBeNull();
  });
});
