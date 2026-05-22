import {
  buildLargePartyWhatsappUrl,
  DEFAULT_RESERVATION_LATE_TOLERANCE_MINUTES,
  isLargePartyReservation,
  LARGE_PARTY_SIZE,
  normalizeLargePartyThreshold,
  normalizeReservationLateToleranceMinutes,
} from './reservation-flow';

describe('reservation-flow', () => {
  it('considers parties with 10 or more people as large reservations', () => {
    expect(isLargePartyReservation(LARGE_PARTY_SIZE - 1)).toBe(false);
    expect(isLargePartyReservation(LARGE_PARTY_SIZE)).toBe(true);
    expect(isLargePartyReservation(LARGE_PARTY_SIZE + 1)).toBe(true);
  });

  it('uses the configured threshold for large reservations', () => {
    expect(isLargePartyReservation(19, 20)).toBe(false);
    expect(isLargePartyReservation(20, 20)).toBe(true);
  });

  it('keeps the configurable threshold inside the public selector range', () => {
    expect(normalizeLargePartyThreshold(null)).toBe(10);
    expect(normalizeLargePartyThreshold(1)).toBe(2);
    expect(normalizeLargePartyThreshold(30)).toBe(20);
  });

  it('builds the WhatsApp URL for large party reservations', () => {
    expect(buildLargePartyWhatsappUrl('(11) 99999-9999')).toBe(
      'https://wa.me/5511999999999?text=Oi%2C%20vim%20pelo%20site%20e%20preciso%20de%20uma%20reserva%20a%20partir%20de%2010%20pessoas',
    );
  });

  it('builds the WhatsApp URL with the configured threshold', () => {
    expect(buildLargePartyWhatsappUrl('(11) 99999-9999', 20)).toBe(
      'https://wa.me/5511999999999?text=Oi%2C%20vim%20pelo%20site%20e%20preciso%20de%20uma%20reserva%20a%20partir%20de%2020%20pessoas',
    );
  });

  it('returns null when the restaurant has no WhatsApp configured', () => {
    expect(buildLargePartyWhatsappUrl(null)).toBeNull();
    expect(buildLargePartyWhatsappUrl('')).toBeNull();
  });

  it('normalizes the reservation late tolerance', () => {
    expect(normalizeReservationLateToleranceMinutes(null)).toBe(DEFAULT_RESERVATION_LATE_TOLERANCE_MINUTES);
    expect(normalizeReservationLateToleranceMinutes(-1)).toBe(0);
    expect(normalizeReservationLateToleranceMinutes(121)).toBe(120);
  });
});
