import { describe, expect, it } from 'vitest';
import {
  countsAsCanonicalLeadPresence,
  getPresenceLinkedWaitlistIds,
  getCanonicalLeadPresenceEventKey,
  matchesLeadPhoneDigits,
  normalizeLeadPhoneKey,
  selectCanonicalLeadPresenceEvents,
  shouldIncludeCanonicalLeadVisit,
} from '@/lib/lead-consistency';

describe('normalizeLeadPhoneKey', () => {
  it('usa a mesma chave com DDI 55 para telefones brasileiros equivalentes', () => {
    expect(normalizeLeadPhoneKey('(83) 99999-1020')).toBe('5583999991020');
    expect(normalizeLeadPhoneKey('+55 (83) 99999-1020')).toBe('5583999991020');
  });

  it('preserva numeros longos e retorna vazio quando nao ha digitos', () => {
    expect(normalizeLeadPhoneKey('+1 202 555 01020')).toBe('120255501020');
    expect(normalizeLeadPhoneKey('sem telefone')).toBe('');
  });

  it('mantem a busca por trecho e aceita o telefone completo com DDI', () => {
    expect(matchesLeadPhoneDigits('83999991020', '1020')).toBe(true);
    expect(matchesLeadPhoneDigits('83999991020', '5583999991020')).toBe(true);
    expect(matchesLeadPhoneDigits('83999991020', '7777')).toBe(false);
  });
});

describe('canonical lead presences', () => {
  it('conta somente checked_in/completed de reserva, independentemente da origem', () => {
    expect(countsAsCanonicalLeadPresence({
      status: 'checked_in',
      visitOrigin: 'reservation',
    })).toBe(true);
    expect(countsAsCanonicalLeadPresence({
      status: 'completed',
      visitOrigin: 'reservation',
    })).toBe(true);
    expect(countsAsCanonicalLeadPresence({
      status: 'confirmed',
      visitOrigin: 'reservation',
    })).toBe(false);
  });

  it('prioriza a reserva vinculada e ignora a fila convertida', () => {
    const linkedWaitlistIds = getPresenceLinkedWaitlistIds([
      { origin_waitlist_id: 'waitlist-1', status: 'checked_in' },
    ]);
    const linkedWaitlistPair = [
      {
        visitId: 'waitlist-1',
        status: 'seated',
        visitOrigin: 'waitlist' as const,
      },
      {
        visitId: 'reservation-1',
        status: 'checked_in',
        visitOrigin: 'reservation' as const,
      },
    ];
    const canonicalVisits = linkedWaitlistPair.filter((visit) =>
      shouldIncludeCanonicalLeadVisit(visit.visitOrigin, visit.visitId, linkedWaitlistIds),
    );

    expect(canonicalVisits).toEqual([linkedWaitlistPair[1]]);
    expect(canonicalVisits.filter(countsAsCanonicalLeadPresence)).toHaveLength(1);
  });

  it('preserva reserva e fila quando o vinculo esta ausente', () => {
    const linkedWaitlistIds = new Set<string>();

    expect(shouldIncludeCanonicalLeadVisit('reservation', 'reservation-1', linkedWaitlistIds)).toBe(true);
    expect(shouldIncludeCanonicalLeadVisit('waitlist', 'waitlist-1', linkedWaitlistIds)).toBe(true);
  });

  it('preserva a fila sentada quando a reserva vinculada foi cancelada ou no-show', () => {
    const linkedWaitlistIds = getPresenceLinkedWaitlistIds([
      { origin_waitlist_id: 'waitlist-cancelled', status: 'cancelled' },
      { origin_waitlist_id: 'waitlist-no-show', status: 'no-show' },
      { origin_waitlist_id: 'waitlist-completed', status: 'completed' },
    ]);

    expect(linkedWaitlistIds).toEqual(new Set(['waitlist-completed']));
    expect(shouldIncludeCanonicalLeadVisit('waitlist', 'waitlist-cancelled', linkedWaitlistIds)).toBe(true);
    expect(shouldIncludeCanonicalLeadVisit('waitlist', 'waitlist-no-show', linkedWaitlistIds)).toBe(true);
    expect(shouldIncludeCanonicalLeadVisit('waitlist', 'waitlist-completed', linkedWaitlistIds)).toBe(false);
  });

  it('deduplica titular e acompanhante com o mesmo telefone no mesmo evento', () => {
    const sameReservationContacts = [
      {
        visitId: 'reservation-1',
        status: 'checked_in',
        visitOrigin: 'reservation' as const,
      },
      {
        visitId: 'reservation-1',
        status: 'checked_in',
        visitOrigin: 'reservation' as const,
      },
    ];
    const eventKeys = new Set(
      sameReservationContacts
        .map(getCanonicalLeadPresenceEventKey)
        .filter((key): key is string => key !== null),
    );

    expect(eventKeys).toEqual(new Set(['reservation:reservation-1']));
  });

  it('seleciona somente presencas canonicas para o historico do modal', () => {
    const visits = [
      { id: 'holder', visit_id: 'reservation-1', visit_origin: 'reservation' as const, status: 'completed' },
      { id: 'companion', visit_id: 'reservation-1', visit_origin: 'reservation' as const, status: 'completed' },
      { id: 'confirmed', visit_id: 'reservation-2', visit_origin: 'reservation' as const, status: 'confirmed' },
      { id: 'cancelled', visit_id: 'reservation-3', visit_origin: 'reservation' as const, status: 'cancelled' },
      { id: 'seated', visit_id: 'waitlist-1', visit_origin: 'waitlist' as const, status: 'seated' },
    ];

    expect(selectCanonicalLeadPresenceEvents(visits).map((visit) => visit.id)).toEqual([
      'holder',
      'seated',
    ]);
  });
});
