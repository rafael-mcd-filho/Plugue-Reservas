import { describe, expect, it } from 'vitest';
import type { CrmLeadPresenceVisit, CrmLeadRow } from '@/hooks/useCrmLeads';
import {
  formatLeadPhoneText,
  formatLeadState,
  formatLeadVisitContext,
  formatReservationStatus,
  mapCrmLeadRowToProfile,
} from '@/lib/crm-lead-profile';

const leadRow: CrmLeadRow = {
  customer_key: 'phone:5583999991020',
  phone_normalized: '5583999991020',
  display_phone: '(83) 99999-1020',
  latest_name: 'João Rocha',
  latest_email: 'joao@example.com',
  latest_birthdate: '1990-07-11',
  first_seen_at: '2026-05-28T20:00:00Z',
  last_visit_date: '2026-08-01',
  last_visit_time: '20:25:00',
  state_code: 'PB',
  state_name: 'Paraíba',
  source: 'mixed',
  canonical_visit_count: 3,
  crm_lead: {
    id: 'crm-lead-1',
    notes: 'Cliente recorrente',
    imported_at: '2026-08-01T12:30:00Z',
    imported_by_user_id: 'user-1',
    import_filename: 'clientes.csv',
  },
};

describe('mapCrmLeadRowToProfile', () => {
  it('preserva a chave canônica e todos os dados usados pelo perfil compartilhado', () => {
    expect(mapCrmLeadRowToProfile(leadRow)).toEqual({
      key: 'phone:5583999991020',
      guest_phone: '(83) 99999-1020',
      guest_name: 'João Rocha',
      guest_email: 'joao@example.com',
      guest_birthdate: '1990-07-11',
      total_reservations: 3,
      lead_created_at: '2026-05-28T20:00:00Z',
      last_reservation_date: '2026-08-01',
      last_reservation_time: '20:25:00',
      stateCode: 'PB',
      stateName: 'Paraíba',
      source: 'mixed',
      importedLeadId: 'crm-lead-1',
      importedNotes: 'Cliente recorrente',
      importedAt: '2026-08-01T12:30:00Z',
      importedByUserId: 'user-1',
      importFilename: 'clientes.csv',
    });
  });

  it('aplica fallbacks seguros quando telefone, nome e importação não existem', () => {
    const profile = mapCrmLeadRowToProfile({
      ...leadRow,
      phone_normalized: null,
      display_phone: null,
      latest_name: '',
      last_visit_date: null,
      last_visit_time: null,
      crm_lead: null,
    });

    expect(profile.guest_phone).toBe('');
    expect(profile.guest_name).toBe('Lead sem nome');
    expect(profile.last_reservation_date).toBe('');
    expect(profile.last_reservation_time).toBe('');
    expect(profile.importedLeadId).toBeNull();
  });
});

describe('formatação do perfil do lead', () => {
  it('formata telefone, estado e status como na lista de Leads', () => {
    const profile = mapCrmLeadRowToProfile(leadRow);

    expect(formatLeadPhoneText(profile.guest_phone)).toBe('(83) 99999-1020');
    expect(formatLeadState(profile)).toBe('Paraíba (PB)');
    expect(formatReservationStatus('seated')).toBe('Sentado');
    expect(formatReservationStatus('checked_in')).toBe('Check-in realizado');
  });

  it('descreve titular e acompanhante sem perder a origem da presença', () => {
    const baseVisit: CrmLeadPresenceVisit = {
      id: 'event-1',
      visit_id: 'reservation-1',
      created_at: '2026-08-01T20:25:00Z',
      date: '2026-08-01',
      time: '20:25:00',
      party_size: 2,
      status: 'checked_in',
      occasion: null,
      lead_source: 'reservation_holder',
      visit_origin: 'reservation',
      origin_waitlist_id: null,
      reservation_holder_name: 'João Rocha',
    };

    expect(formatLeadVisitContext(baseVisit)).toBe(' · Titular da reserva');
    expect(formatLeadVisitContext({
      ...baseVisit,
      lead_source: 'waitlist_companion',
      visit_origin: 'waitlist',
      visit_id: 'waitlist-1',
      reservation_holder_name: 'Maria Rocha',
    })).toBe(' · Acompanhou Maria Rocha');
  });
});
