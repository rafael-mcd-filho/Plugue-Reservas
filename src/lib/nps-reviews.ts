// Regras de leitura das avaliações pós-visita usadas na tela de Avaliações:
// zona do NPS, status real do convite (o banco só marca "expired" quando alguém
// tenta responder depois do prazo) e os agrupamentos dos gráficos.

import { eachWeekOfInterval, endOfWeek, format, getDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export type NpsCategory = 'promoter' | 'passive' | 'detractor';
export type ReviewEffectiveStatus = 'submitted' | 'pending' | 'expired';
export type NpsTone = 'success' | 'warning' | 'destructive';

// Abaixo disso o NPS oscila demais a cada resposta nova, e os gráficos de
// tendência mostram mais ruído do que padrão.
export const MIN_RESPONSES_FOR_TRENDS = 10;

export function getNpsCategory(score: number): NpsCategory {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

// Faixas usadas no mercado brasileiro para ler o NPS.
export function getNpsZone(score: number): { label: string; tone: NpsTone } {
  if (score >= 75) return { label: 'Zona de excelência', tone: 'success' };
  if (score >= 50) return { label: 'Zona de qualidade', tone: 'success' };
  if (score >= 0) return { label: 'Zona de aperfeiçoamento', tone: 'warning' };
  return { label: 'Zona crítica', tone: 'destructive' };
}

export function getEffectiveReviewStatus(
  status: string,
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): ReviewEffectiveStatus {
  if (status === 'submitted') return 'submitted';
  if (status === 'expired') return 'expired';
  if (expiresAt && new Date(expiresAt).getTime() < now.getTime()) return 'expired';
  return 'pending';
}

export function formatNpsScore(score: number) {
  return `${score > 0 ? '+' : ''}${score}`;
}

interface ReviewForNps {
  submitted_at: string;
  nps_category: NpsCategory | null;
}

function computeNps(reviews: ReviewForNps[]) {
  const scored = reviews.filter((review) => review.nps_category !== null);
  if (!scored.length) return null;
  const promoters = scored.filter((review) => review.nps_category === 'promoter').length;
  const detractors = scored.filter((review) => review.nps_category === 'detractor').length;
  return Math.round(((promoters - detractors) / scored.length) * 100);
}

export interface WeeklyNpsPoint {
  week: string;
  nps: number | null;
  responses: number;
}

// Semanas sem resposta ficam com nps nulo: a linha quebra em vez de ligar dois
// pontos distantes como se houvesse dado no meio.
export function computeWeeklyNps(reviews: ReviewForNps[], fromDate: string, toDate: string): WeeklyNpsPoint[] {
  if (!reviews.length) return [];
  const start = new Date(`${fromDate}T00:00:00`);
  const end = new Date(`${toDate}T23:59:59`);

  return eachWeekOfInterval({ start, end }, { weekStartsOn: 1 }).map((weekStart) => {
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    const weekReviews = reviews.filter((review) => {
      const submittedAt = new Date(review.submitted_at);
      return submittedAt >= weekStart && submittedAt <= weekEnd;
    });

    return {
      week: format(weekStart, 'dd/MM', { locale: ptBR }),
      nps: computeNps(weekReviews),
      responses: weekReviews.length,
    };
  });
}

// Eixo que acompanha os dados: com tudo entre +80 e +100, a escala inteira de
// -100 a +100 deixa a linha colada no topo sem mostrar variação. As marcas
// seguem um passo redondo (10, 25 ou 50) para não surgirem valores quebrados.
export function getNpsAxis(values: number[]): { domain: [number, number]; ticks: number[] } {
  if (!values.length) return { domain: [-100, 100], ticks: [-100, -50, 0, 50, 100] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 10);
  const step = span <= 30 ? 10 : span <= 80 ? 25 : 50;
  const lower = Math.max(-100, Math.floor((min - step / 2) / step) * step);
  const upper = Math.min(100, Math.ceil((max + step / 2) / step) * step);
  const ticks: number[] = [];
  for (let tick = lower; tick <= upper; tick += step) ticks.push(tick);
  return { domain: [lower, upper], ticks };
}

const WEEKDAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
// Segunda primeiro, como a operação lê a semana.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface VisitWeekdayNps {
  weekday: number;
  label: string;
  nps: number;
  responses: number;
}

// Agrupa pelo dia da visita (data da reserva), não pelo dia em que o cliente
// respondeu: quem jantou no sábado e respondeu na quarta fala do sábado.
export function computeVisitWeekdayNps(
  reviews: (ReviewForNps & { visit_date: string | null })[],
): VisitWeekdayNps[] {
  return WEEKDAY_ORDER.flatMap((weekday) => {
    const dayReviews = reviews.filter((review) => (
      review.visit_date !== null && getDay(new Date(`${review.visit_date}T12:00:00`)) === weekday
    ));
    const nps = computeNps(dayReviews);
    if (nps === null) return [];
    return [{ weekday, label: WEEKDAY_LABELS[weekday], nps, responses: dayReviews.length }];
  });
}

export type RatingField = 'food_rating' | 'service_rating' | 'ambiance_rating';

export interface RatingDistribution {
  total: number;
  average: number | null;
  // Índice 0 = 1 estrela ... índice 4 = 5 estrelas.
  counts: [number, number, number, number, number];
}

export function computeRatingDistribution(
  reviews: Partial<Record<RatingField, number | null>>[],
  field: RatingField,
): RatingDistribution {
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;

  reviews.forEach((review) => {
    const value = review[field];
    if (typeof value === 'number' && value >= 1 && value <= 5) {
      counts[value - 1] += 1;
      sum += value;
    }
  });

  const total = counts.reduce((acc, count) => acc + count, 0);
  return { total, average: total > 0 ? sum / total : null, counts };
}

export function averageOf(values: (number | null | undefined)[]): number | null {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((acc, value) => acc + value, 0) / valid.length;
}

// Escapa curingas do ILIKE para a busca por nome tratar % e _ como texto.
export function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
