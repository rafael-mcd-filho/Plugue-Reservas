import { describe, expect, it } from 'vitest';
import {
  countsAsCanonicalLeadPresence,
  getPresenceLinkedWaitlistIds,
  getCanonicalLeadPresenceEventKey,
  getLeadReactivationPhone,
  matchesLeadPhoneDigits,
  normalizeLeadPhoneKey,
  selectCanonicalLeadPresenceEvents,
  shouldIncludeCanonicalLeadVisit,
} from '@/lib/lead-consistency';
import { isValidPhone, toStoredWhatsAppNumber } from '@/lib/phone';

describe('reactivation broadcast phone', () => {
  it.each([
    [{ guest_phone: '4072641934', phone_normalized: '14072641934' }, '+14072641934'],
    [{ guest_phone: '912345678', phone_normalized: '351912345678' }, '+351912345678'],
    [{ guest_phone: '(55) 99988-7766', phone_normalized: '5555999887766' }, '+5555999887766'],
    [{ guest_phone: '(11) 9999-8888', phone_normalized: '551199998888' }, '+551199998888'],
    [{ guest_phone: '(55) 9999-8888', phone_normalized: '555599998888' }, '+555599998888'],
  ])('uses the RPC international identity instead of guessing the raw phone country', (candidate, expected) => {
    const phone = getLeadReactivationPhone(candidate);
    expect(phone).toBe(expected);
    expect(toStoredWhatsAppNumber(phone)).toBe(expected.slice(1));
  });

  it('prefers E164 metadata and still supports a legacy BR raw fallback', () => {
    expect(getLeadReactivationPhone({
      guest_phone_e164: '+14165550123', phone_normalized: '14072641934', guest_phone: '4165550123',
    })).toBe('+14165550123');
    expect(getLeadReactivationPhone({ guest_phone: '(83) 99999-1020' })).toBe('+5583999991020');
    expect(getLeadReactivationPhone({ guest_phone: '(11) 9999-8888' })).toBe('+551199998888');
    expect(getLeadReactivationPhone({ guest_phone_e164: '+551199998888' })).toBe('+551199998888');
  });
});

describe('normalizeLeadPhoneKey', () => {
  it('keeps historical eight-digit contacts searchable and grouped without accepting them as new phones', () => {
    expect(normalizeLeadPhoneKey('(11) 9999-8888')).toBe('551199998888');
    expect(normalizeLeadPhoneKey('+55 11 9999-8888')).toBe('551199998888');
    expect(normalizeLeadPhoneKey('(55) 9999-8888')).toBe('555599998888');
    expect(matchesLeadPhoneDigits('(11) 9999-8888', '551199998888')).toBe(true);
    expect(isValidPhone('(11) 9999-8888')).toBe(false);
  });

  it('usa a mesma chave com DDI 55 para telefones brasileiros equivalentes', () => {
    expect(normalizeLeadPhoneKey('(83) 99999-1020')).toBe('5583999991020');
    expect(normalizeLeadPhoneKey('+55 (83) 99999-1020')).toBe('5583999991020');
  });

  it('preserva os DDIs internacionais e retorna vazio quando nao ha digitos', () => {
    expect(normalizeLeadPhoneKey('+1 407 264 1934')).toBe('14072641934');
    expect(normalizeLeadPhoneKey('+351 912 345 678')).toBe('351912345678');
    expect(normalizeLeadPhoneKey('(55) 99988-7766')).toBe('5555999887766');
    expect(normalizeLeadPhoneKey('sem telefone')).toBe('');
  });

  it('mantem separados paises que compartilham o mesmo sufixo de onze digitos', () => {
    expect(normalizeLeadPhoneKey('+351912345678')).not.toBe(normalizeLeadPhoneKey('+5551912345678'));
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
