import type {
  CrmLeadMatchedSource,
  CrmLeadPresenceVisit,
  CrmLeadRow,
  CrmLeadSource,
} from '@/hooks/useCrmLeads';
import { getReservationStatusLabel, normalizeReservationStatus } from '@/lib/reservation-status';
import { formatBrazilPhone } from '@/lib/validation';

export interface CrmLeadProfile {
  key: string;
  guest_phone: string;
  guest_name: string;
  guest_email: string | null;
  guest_birthdate: string | null;
  total_reservations: number;
  lead_created_at: string;
  last_reservation_date: string;
  last_reservation_time: string;
  stateCode: string | null;
  stateName: string | null;
  source: CrmLeadSource;
  importedLeadId: string | null;
  importedNotes: string | null;
  importedAt: string | null;
  importedByUserId: string | null;
  importFilename: string | null;
}

export function mapCrmLeadRowToProfile(row: CrmLeadRow): CrmLeadProfile {
  const phone = row.display_phone ?? row.phone_normalized ?? '';

  return {
    key: row.customer_key,
    guest_phone: phone,
    guest_name: row.latest_name || 'Lead sem nome',
    guest_email: row.latest_email,
    guest_birthdate: row.latest_birthdate,
    total_reservations: row.canonical_visit_count,
    lead_created_at: row.first_seen_at,
    last_reservation_date: row.last_visit_date ?? '',
    last_reservation_time: row.last_visit_time ?? '',
    stateCode: row.state_code,
    stateName: row.state_name,
    source: row.source,
    importedLeadId: row.crm_lead?.id ?? null,
    importedNotes: row.crm_lead?.notes ?? null,
    importedAt: row.crm_lead?.imported_at ?? null,
    importedByUserId: row.crm_lead?.imported_by_user_id ?? null,
    importFilename: row.crm_lead?.import_filename ?? null,
  };
}

export function formatLeadPhoneText(phone: string | null | undefined) {
  return formatBrazilPhone(phone) || 'Não informado';
}

export function formatLeadState(
  lead: Pick<CrmLeadProfile, 'guest_phone' | 'stateCode' | 'stateName'>,
) {
  if (!lead.guest_phone) {
    return 'Sem telefone informado';
  }

  return lead.stateCode && lead.stateName
    ? `${lead.stateName} (${lead.stateCode})`
    : 'DDD não identificado';
}

export function isCompanionVisitSource(source: CrmLeadMatchedSource) {
  return source === 'companion'
    || source === 'reservation_companion'
    || source === 'waitlist_companion';
}

export function formatLeadSource(source: CrmLeadMatchedSource) {
  if (source === 'imported') {
    return 'Importado';
  }

  if (source === 'mixed') {
    return 'Múltiplos papéis';
  }

  return isCompanionVisitSource(source) ? 'Acompanhante' : 'Titular';
}

export function formatLeadVisitContext(visit: CrmLeadPresenceVisit) {
  const cameFromWaitlist = visit.visit_origin === 'waitlist' || !!visit.origin_waitlist_id;

  if (isCompanionVisitSource(visit.lead_source)) {
    return visit.reservation_holder_name
      ? ` · Acompanhou ${visit.reservation_holder_name}`
      : cameFromWaitlist
        ? ' · Acompanhante da fila'
        : ' · Acompanhante da reserva';
  }

  return cameFromWaitlist
    ? ' · Titular da fila'
    : ' · Titular da reserva';
}

export function normalizeLeadVisitStatus(status: string) {
  if (status === 'seated') {
    return 'seated';
  }

  return normalizeReservationStatus(status);
}

export function formatReservationStatus(status: string) {
  const normalizedStatus = normalizeLeadVisitStatus(status);
  if (normalizedStatus === 'seated') {
    return 'Sentado';
  }

  return getReservationStatusLabel(normalizedStatus);
}

export function getLeadVisitStatusClassName(status: string) {
  switch (normalizeLeadVisitStatus(status)) {
    case 'confirmed':
      return 'bg-primary text-primary-foreground';
    case 'checked_in':
      return 'bg-info text-info-foreground';
    case 'cancelled':
      return 'bg-destructive text-destructive-foreground';
    case 'no-show':
      return 'bg-secondary text-secondary-foreground';
    case 'seated':
      return 'bg-success text-success-foreground';
    default:
      return 'bg-secondary text-secondary-foreground';
  }
}
