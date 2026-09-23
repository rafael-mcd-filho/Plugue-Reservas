import { getReservationsOverviewIntensity } from './reservations-overview';

describe('reservations-overview', () => {
  it('calcula a intensidade relativa ao dia mais cheio', () => {
    expect(getReservationsOverviewIntensity(24, 24)).toBe(1);
    expect(getReservationsOverviewIntensity(12, 24)).toBe(0.5);
  });

  it('zera quando não há reserva ou não há referência', () => {
    expect(getReservationsOverviewIntensity(0, 24)).toBe(0);
    expect(getReservationsOverviewIntensity(5, 0)).toBe(0);
  });

  it('mantém um fio visível para dias de volume baixo', () => {
    expect(getReservationsOverviewIntensity(1, 100)).toBe(0.12);
  });
});
