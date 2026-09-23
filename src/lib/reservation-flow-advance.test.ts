import { resolveReservationTimeAdvance } from './reservation-flow';

const base = {
  isCheckingTable: false,
  canContinue: false,
  hasNoTableAvailable: false,
  hasAvailabilityError: false,
  isSlotUnavailable: false,
};

describe('resolveReservationTimeAdvance', () => {
  it('espera enquanto a mesa está sendo procurada', () => {
    expect(resolveReservationTimeAdvance({ ...base, isCheckingTable: true })).toBe('wait');
    // Mesmo que o resto já pareça pronto, a verificação manda.
    expect(resolveReservationTimeAdvance({ ...base, isCheckingTable: true, canContinue: true })).toBe('wait');
  });

  it('avança quando horário e mesa estão confirmados', () => {
    expect(resolveReservationTimeAdvance({ ...base, canContinue: true })).toBe('advance');
  });

  it('cancela o avanço quando não há mesa, houve erro ou o horário saiu do ar', () => {
    expect(resolveReservationTimeAdvance({ ...base, hasNoTableAvailable: true })).toBe('cancel');
    expect(resolveReservationTimeAdvance({ ...base, hasAvailabilityError: true })).toBe('cancel');
    expect(resolveReservationTimeAdvance({ ...base, isSlotUnavailable: true })).toBe('cancel');
  });

  it('espera enquanto nada está resolvido, para não pular etapa sem reserva possível', () => {
    expect(resolveReservationTimeAdvance(base)).toBe('wait');
  });
});
