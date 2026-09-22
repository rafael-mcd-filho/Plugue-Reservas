// Estado de uma regra de disponibilidade a partir das datas que ela cobre.
// O badge do painel usava apenas `enabled`/`publish_at`, entao excecoes de
// datas passadas continuavam anunciadas como "Ativa" mesmo sem efeito nenhum
// sobre os horarios publicos.

export type ReservationScheduleRuleScopeValue = 'weekly' | 'date_specific' | 'date_range';

export type ReservationScheduleRuleStatus = 'active' | 'scheduled' | 'draft' | 'expired' | 'archived';

export interface ReservationScheduleRuleStatusInput {
  scope: ReservationScheduleRuleScopeValue;
  enabled: boolean;
  publish_at?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  archived_at?: string | null;
}

const STATUS_LABELS: Record<ReservationScheduleRuleStatus, string> = {
  active: 'Ativa',
  scheduled: 'Programada',
  draft: 'Rascunho',
  expired: 'Encerrada',
  archived: 'Arquivada',
};

function startOfLocalDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function parseRuleDate(value: string | null | undefined) {
  if (!value) return null;
  // Meio-dia evita que o fuso empurre a data para o dia anterior.
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Ultimo dia coberto pela regra. Regras semanais sao recorrentes e nao terminam.
export function getReservationScheduleRuleLastDate(rule: ReservationScheduleRuleStatusInput) {
  if (rule.scope === 'weekly') return null;
  if (rule.scope === 'date_range') return parseRuleDate(rule.end_date ?? rule.start_date);
  return parseRuleDate(rule.start_date);
}

export function isReservationScheduleRuleExpired(
  rule: ReservationScheduleRuleStatusInput,
  reference: Date = new Date(),
) {
  const lastDate = getReservationScheduleRuleLastDate(rule);
  if (!lastDate) return false;
  return startOfLocalDay(lastDate).getTime() < startOfLocalDay(reference).getTime();
}

export function isReservationScheduleRuleScheduled(
  rule: ReservationScheduleRuleStatusInput,
  reference: Date = new Date(),
) {
  if (!rule.enabled || !rule.publish_at) return false;
  const publishDate = new Date(rule.publish_at);
  if (Number.isNaN(publishDate.getTime())) return false;
  return publishDate.getTime() > reference.getTime();
}

export function getReservationScheduleRuleStatus(
  rule: ReservationScheduleRuleStatusInput,
  reference: Date = new Date(),
): ReservationScheduleRuleStatus {
  if (rule.archived_at) return 'archived';
  if (isReservationScheduleRuleExpired(rule, reference)) return 'expired';
  if (!rule.enabled) return 'draft';
  return isReservationScheduleRuleScheduled(rule, reference) ? 'scheduled' : 'active';
}

export function getReservationScheduleRuleStatusLabel(status: ReservationScheduleRuleStatus) {
  return STATUS_LABELS[status];
}

// Separa o que ainda vale do que ja passou, com as encerradas mais recentes na frente.
export function partitionReservationScheduleRulesByEnd<T extends ReservationScheduleRuleStatusInput>(
  rules: readonly T[],
  reference: Date = new Date(),
) {
  const current: T[] = [];
  const expired: T[] = [];

  rules.forEach((rule) => {
    if (isReservationScheduleRuleExpired(rule, reference)) {
      expired.push(rule);
      return;
    }
    current.push(rule);
  });

  expired.sort((left, right) => {
    const leftDate = getReservationScheduleRuleLastDate(left)?.getTime() ?? 0;
    const rightDate = getReservationScheduleRuleLastDate(right)?.getTime() ?? 0;
    return rightDate - leftDate;
  });

  return { current, expired };
}
