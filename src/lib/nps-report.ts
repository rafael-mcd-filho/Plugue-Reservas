import { getEffectiveReviewStatus, type NpsCategory, type RatingField } from '@/lib/nps-reviews';

export const NPS_ANALYSIS_PAGE_SIZE = 500;

export interface NpsSubmittedReview {
  id: string;
  submitted_at: string | null;
  recommend_score: number | null;
  nps_category: NpsCategory | null;
  comment: string | null;
  ambiance_rating: number | null;
  food_rating: number | null;
  service_rating: number | null;
  reservations: { date: string | null; guest_name?: string | null; guest_phone?: string | null } | null;
}

export interface NpsCohortRow extends NpsSubmittedReview {
  status: string;
  invited_at: string;
  expires_at: string | null;
  return_score: number | null;
}

export interface NpsSummary {
  total_invited: number;
  total_submitted: number;
  total_pending: number;
  total_expired: number;
  response_rate: number;
  nps_score: number;
  promoters: number;
  passives: number;
  detractors: number;
  avg_ambiance: number | null;
  avg_food: number | null;
  avg_service: number | null;
  avg_return: number | null;
}

export interface NpsCohortPage {
  rows: NpsCohortRow[];
  total: number | null;
}

/** A complete ordered cohort; failed or truncated pages never resolve as a complete read. */
export async function loadCompleteNpsCohort(
  fetchPage: (offset: number, size: number) => Promise<NpsCohortPage>,
): Promise<NpsCohortRow[]> {
  const rows: NpsCohortRow[] = [];
  const ids = new Set<string>();
  let total: number | null = null;
  do {
    const page = await fetchPage(rows.length, NPS_ANALYSIS_PAGE_SIZE);
    if (page.total === null || !Number.isInteger(page.total) || page.total < 0) {
      throw new Error('Não foi possível confirmar a cobertura das avaliações. Tente novamente.');
    }
    if (total !== null && page.total !== total) {
      throw new Error('Os convites mudaram durante a leitura. Atualize para obter uma base completa.');
    }
    total = page.total;
    if (!Array.isArray(page.rows) || (!page.rows.length && rows.length < total)) {
      throw new Error('A leitura das avaliações ficou incompleta. Tente novamente.');
    }
    for (const row of page.rows) {
      if (!row.id || ids.has(row.id)) {
        throw new Error('Os registros mudaram durante a leitura. Atualize para obter uma base completa.');
      }
      ids.add(row.id);
      rows.push(row);
    }
    if (rows.length > total) throw new Error('A contagem das avaliações mudou. Tente novamente.');
  } while (rows.length < total);
  return rows;
}

const roundOne = (value: number) => Math.round(value * 10) / 10;

export function buildNpsCohortReport(rows: NpsCohortRow[], now = new Date()) {
  const submitted = rows.filter(row => row.status === 'submitted');
  const promoters = submitted.filter(row => row.nps_category === 'promoter').length;
  const passives = submitted.filter(row => row.nps_category === 'passive').length;
  const detractors = submitted.filter(row => row.nps_category === 'detractor').length;
  const scored = promoters + passives + detractors;
  const average = (field: RatingField | 'return_score') => {
    const values = submitted.map(row => row[field]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length ? roundOne(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  const summary: NpsSummary = {
    total_invited: rows.length,
    total_submitted: submitted.length,
    total_pending: rows.filter(row => getEffectiveReviewStatus(row.status, row.expires_at, now) === 'pending').length,
    total_expired: rows.filter(row => getEffectiveReviewStatus(row.status, row.expires_at, now) === 'expired').length,
    response_rate: rows.length ? roundOne((submitted.length / rows.length) * 100) : 0,
    nps_score: scored ? Math.round(((promoters - detractors) / scored) * 100) : 0,
    promoters, passives, detractors,
    avg_ambiance: average('ambiance_rating'),
    avg_food: average('food_rating'),
    avg_service: average('service_rating'),
    avg_return: average('return_score'),
  };
  return {
    summary,
    submitted: submitted.sort((left, right) => String(right.submitted_at ?? '').localeCompare(String(left.submitted_at ?? ''))),
    generatedAt: now.toISOString(),
  };
}
