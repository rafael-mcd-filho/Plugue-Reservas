import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageCircle,
  MessageSquareQuote,
  MoreHorizontal,
  PauseCircle,
  Power,
  Search,
  Star,
  ThumbsDown,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { differenceInCalendarDays, format, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';
import PhoneWhatsAppLink, { WhatsAppIcon } from '@/components/PhoneWhatsAppLink';
import ReportShell from '@/components/reports/ReportShell';
import {
  ReportKpiDelta,
  ReportKpiStrip,
  ReportKpiStripSkeleton,
  ReportKpiTile,
} from '@/components/reports/ReportKpiStrip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';
import { useCompanyNpsActivation } from '@/hooks/useCompanyNpsActivation';
import { supabase } from '@/integrations/supabase/client';
import {
  MIN_RESPONSES_FOR_TRENDS,
  averageOf,
  computeRatingDistribution,
  computeVisitWeekdayNps,
  computeWeeklyNps,
  escapeLikePattern,
  formatNpsScore,
  getEffectiveReviewStatus,
  getNpsAxis,
  getNpsZone,
  type NpsCategory,
  type NpsTone,
  type RatingField,
} from '@/lib/nps-reviews';
import { cn } from '@/lib/utils';
import { normalizeBrazilPhoneDigits, toBrazilWhatsAppNumber } from '@/lib/validation';

const PERIOD_OPTIONS = [
  { value: '30', label: 'Últimos 30 dias' },
  { value: '60', label: 'Últimos 60 dias' },
  { value: '90', label: 'Últimos 3 meses' },
  { value: '180', label: 'Últimos 6 meses' },
];

const RECORDS_PAGE_SIZE = 25;
const ATTENTION_LIMIT = 4;
const COMMENTS_STEP = 5;
// Muitos convites e quase nenhuma resposta costuma indicar que o link não está
// indo na mensagem de pós-visita, e não que os clientes ignoram a pesquisa.
const LOW_RESPONSE_MIN_INVITES = 20;
const LOW_RESPONSE_MAX_RATE = 10;

const integerFormatter = new Intl.NumberFormat('pt-BR');
const decimalFormatter = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percentFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

const formatInteger = (value: number) => integerFormatter.format(value);
const formatDecimal = (value: number) => decimalFormatter.format(value);

// ── tipos ────────────────────────────────────────────────────────────────────

interface NpsSummary {
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

interface ReviewReservation {
  guest_name: string | null;
  guest_phone: string | null;
  date: string | null;
}

interface SubmittedReview {
  id: string;
  submitted_at: string;
  recommend_score: number | null;
  nps_category: NpsCategory | null;
  comment: string | null;
  ambiance_rating: number | null;
  food_rating: number | null;
  service_rating: number | null;
  reservations: ReviewReservation | null;
}

interface ReviewRecord extends Omit<SubmittedReview, 'submitted_at'> {
  status: string;
  submitted_at: string | null;
  invited_at: string;
  expires_at: string | null;
}

type RecordFilter = 'submitted' | NpsCategory | 'pending' | 'expired' | 'all';
type CommentFilter = 'all' | NpsCategory;

// ── aparência ────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<NpsCategory, { label: string; plural: string; range: string; chip: string; dot: string }> = {
  promoter: {
    label: 'Promotor',
    plural: 'Promotores',
    range: '9 e 10',
    chip: 'border-success/25 bg-success/10 text-success',
    dot: 'bg-success',
  },
  passive: {
    label: 'Neutro',
    plural: 'Neutros',
    range: '7 e 8',
    chip: 'border-warning/35 bg-warning/10 text-amber-700 dark:text-amber-300',
    dot: 'bg-warning',
  },
  detractor: {
    label: 'Detrator',
    plural: 'Detratores',
    range: '0 a 6',
    chip: 'border-destructive/25 bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  },
};

// Da esquerda para a direita, na ordem da escala de 0 a 10.
const CATEGORY_ORDER: NpsCategory[] = ['detractor', 'passive', 'promoter'];

const TONE_TEXT: Record<NpsTone, string> = {
  success: 'text-success',
  warning: 'text-amber-700 dark:text-amber-300',
  destructive: 'text-destructive',
};

const TONE_BAR: Record<NpsTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

const RATING_FIELDS: { field: RatingField; label: string }[] = [
  { field: 'food_rating', label: 'Comida' },
  { field: 'service_rating', label: 'Atendimento' },
  { field: 'ambiance_rating', label: 'Ambiente' },
];

// Cor por quantidade de estrelas: verde para as boas, vermelho para as ruins.
const STAR_BAR: Record<number, string> = {
  5: 'bg-success',
  4: 'bg-success/50',
  3: 'bg-warning',
  2: 'bg-destructive/55',
  1: 'bg-destructive',
};

// ── helpers ──────────────────────────────────────────────────────────────────

function formatVisitDate(date: string | null | undefined) {
  if (!date) return null;
  return format(new Date(`${date}T12:00:00`), 'dd/MM/yyyy');
}

function formatShortDate(value: string) {
  return format(new Date(value), "dd 'de' MMM", { locale: ptBR });
}

function toneForNps(score: number): NpsTone {
  return getNpsZone(score).tone;
}

function buildWhatsAppUrl(phone: string | null | undefined) {
  const digits = normalizeBrazilPhoneDigits(phone);
  if (digits.length < 10) return null;
  const number = toBrazilWhatsAppNumber(digits);
  return number ? `https://wa.me/${number}` : null;
}

function isSubmittedFilter(filter: RecordFilter) {
  return filter === 'submitted' || filter === 'promoter' || filter === 'passive' || filter === 'detractor';
}

function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function readDismissed(key: string) {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(key: string) {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Sem armazenamento, o aviso só volta na próxima visita.
  }
}

// ── peças pequenas ───────────────────────────────────────────────────────────

function ScoreBadge({ score, category, showLabel = false }: {
  score: number | null;
  category: NpsCategory | null;
  showLabel?: boolean;
}) {
  if (score === null || category === null) return <span className="text-sm text-muted-foreground">—</span>;
  const meta = CATEGORY_META[category];

  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums', meta.chip)}
      aria-label={`Nota ${score} de 10, ${meta.label.toLowerCase()}`}
    >
      <span aria-hidden="true">{score}</span>
      {showLabel && <span aria-hidden="true" className="font-medium">· {meta.label}</span>}
    </span>
  );
}

function RatingsInline({ review, className }: {
  review: Pick<SubmittedReview, RatingField>;
  className?: string;
}) {
  const ratings = RATING_FIELDS.filter(({ field }) => review[field] !== null);
  if (!ratings.length) return null;

  return (
    <div className={cn('flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}>
      {ratings.map(({ field, label }) => (
        <span key={field} className="inline-flex items-center gap-1">
          <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />
          {label} <strong className="font-semibold text-foreground">{review[field]}</strong>
        </span>
      ))}
    </div>
  );
}

function CommentText({ comment, clampClassName = 'line-clamp-2' }: { comment: string; clampClassName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = comment.length > 140;

  return (
    <div className="text-sm leading-relaxed text-foreground/85">
      <p className={cn('whitespace-pre-line break-words', !expanded && isLong && clampClassName)}>{comment}</p>
      {isLong && (
        <button
          type="button"
          className="mt-0.5 inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <>ver menos <ChevronUp className="h-3 w-3" /></> : <>ver mais <ChevronDown className="h-3 w-3" /></>}
        </button>
      )}
    </div>
  );
}

function WhatsAppButton({ phone, name }: { phone: string | null | undefined; name: string }) {
  const url = buildWhatsAppUrl(phone);
  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Conversar com ${name} no WhatsApp`}
      title="Conversar no WhatsApp"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-card text-xs font-medium text-foreground transition hover:border-[#25D366]/45 hover:bg-[#25D366]/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto sm:px-2.5"
    >
      <WhatsAppIcon className="h-4 w-4 text-[#25D366]" />
      <span className="hidden sm:inline">WhatsApp</span>
    </a>
  );
}

function FilterChip({ active, onClick, label, count }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground',
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn('tabular-nums', active ? 'text-background/70' : 'text-muted-foreground/80')}>
          {formatInteger(count)}
        </span>
      )}
    </button>
  );
}

function SectionEmpty({ icon: Icon, title, text }: { icon: typeof Star; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <Icon className="mb-1 h-6 w-6 text-muted-foreground/70" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}

// ── Resumo ───────────────────────────────────────────────────────────────────

function NpsCompositionCard({ summary }: { summary: NpsSummary }) {
  const counts: Record<NpsCategory, number> = {
    detractor: summary.detractors,
    passive: summary.passives,
    promoter: summary.promoters,
  };
  const total = counts.detractor + counts.passive + counts.promoter;
  const zone = getNpsZone(summary.nps_score);
  const smallSample = summary.total_submitted < MIN_RESPONSES_FOR_TRENDS;

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Como o NPS se forma</CardTitle>
        <CardDescription>Respostas à pergunta “de 0 a 10, quanto você nos recomendaria?”.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className={cn('text-4xl font-semibold tracking-tight', TONE_TEXT[zone.tone])}>
            {formatNpsScore(summary.nps_score)}
          </span>
          <span className="text-sm text-muted-foreground">{zone.label}</span>
        </div>

        <div
          className="flex h-3 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={CATEGORY_ORDER.map((category) => `${counts[category]} ${CATEGORY_META[category].plural.toLowerCase()}`).join(', ')}
        >
          {total > 0 && CATEGORY_ORDER.map((category) => counts[category] > 0 && (
            <div
              key={category}
              className={cn('h-full first:rounded-l-full last:rounded-r-full', CATEGORY_META[category].dot)}
              style={{ width: `${(counts[category] / total) * 100}%` }}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {CATEGORY_ORDER.map((category) => {
            const meta = CATEGORY_META[category];
            const share = total > 0 ? Math.round((counts[category] / total) * 100) : 0;
            return (
              <div key={category} className="min-w-0 rounded-lg border border-border px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', meta.dot)} aria-hidden="true" />
                  <span className="truncate">{meta.plural}</span>
                </div>
                <p className="mt-1 text-lg font-semibold leading-none text-foreground">
                  {formatInteger(counts[category])}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">{share}%</span>
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">notas {meta.range}</p>
              </div>
            );
          })}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          NPS = % de promotores − % de detratores. Neutros contam no total, mas não somam nem subtraem.
        </p>

        {smallSample && (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Baseado em {formatInteger(summary.total_submitted)} {summary.total_submitted === 1 ? 'resposta' : 'respostas'}.
            Com menos de {MIN_RESPONSES_FOR_TRENDS}, cada avaliação nova muda bastante o resultado.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CategoryRatingsCard({ reviews }: { reviews: SubmittedReview[] }) {
  const rows = RATING_FIELDS
    .map(({ field, label }) => ({ field, label, distribution: computeRatingDistribution(reviews, field) }))
    .filter((row) => row.distribution.total > 0);

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Notas por categoria</CardTitle>
        <CardDescription>Média de 1 a 5 estrelas e como as notas se dividem.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <SectionEmpty icon={Star} title="Sem notas por categoria" text="As respostas do período não trouxeram notas de comida, atendimento ou ambiente." />
        ) : (
          <div className="space-y-5">
            {rows.map(({ field, label, distribution }) => (
              <div key={field}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">{label}</span>
                  <span className="flex items-baseline gap-1.5 text-sm">
                    <Star className="h-3.5 w-3.5 translate-y-0.5 fill-amber-400 text-amber-400" aria-hidden="true" />
                    <strong className="font-semibold text-foreground">{formatDecimal(distribution.average ?? 0)}</strong>
                    <span className="text-xs text-muted-foreground">
                      · {formatInteger(distribution.total)} {distribution.total === 1 ? 'nota' : 'notas'}
                    </span>
                  </span>
                </div>
                <div
                  className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={[5, 4, 3, 2, 1].map((star) => `${distribution.counts[star - 1]} de ${star} estrelas`).join(', ')}
                >
                  {[5, 4, 3, 2, 1].map((star) => distribution.counts[star - 1] > 0 && (
                    <div
                      key={star}
                      className={cn('h-full', STAR_BAR[star])}
                      style={{ width: `${(distribution.counts[star - 1] / distribution.total) * 100}%` }}
                      title={`${star} ${star === 1 ? 'estrela' : 'estrelas'}: ${distribution.counts[star - 1]}`}
                    />
                  ))}
                </div>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground" aria-hidden="true">
              {[5, 4, 3, 2, 1].map((star) => (
                <span key={star} className="inline-flex items-center gap-1">
                  <span className={cn('h-2 w-2 rounded-full', STAR_BAR[star])} />
                  {star}★
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AttentionCard({ reviews, onSeeAll }: { reviews: SubmittedReview[]; onSeeAll: () => void }) {
  const detractors = reviews.filter((review) => review.nps_category === 'detractor');

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
            Precisa de atenção
          </CardTitle>
          <CardDescription>Detratores do período (notas de 0 a 6). Um contato rápido pode reverter a experiência.</CardDescription>
        </div>
        {detractors.length > 0 && (
          <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-destructive">
            {formatInteger(detractors.length)}
          </span>
        )}
      </CardHeader>
      <CardContent>
        {detractors.length === 0 ? (
          <SectionEmpty
            icon={CheckCircle2}
            title="Nenhum detrator no período"
            text="Quando alguém der nota de 0 a 6, a avaliação aparece aqui para você entrar em contato."
          />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {detractors.slice(0, ATTENTION_LIMIT).map((review) => {
                const name = review.reservations?.guest_name?.trim() || 'Cliente';
                const visitDate = formatVisitDate(review.reservations?.date);
                return (
                  <li key={review.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <ScoreBadge score={review.recommend_score} category={review.nps_category} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <p className="truncate text-sm font-medium text-foreground">{name}</p>
                        {visitDate && <span className="text-xs text-muted-foreground">visita em {visitDate}</span>}
                      </div>
                      {review.comment
                        ? <CommentText comment={review.comment} />
                        : <p className="text-xs italic text-muted-foreground">Sem comentário</p>}
                      <RatingsInline review={review} />
                    </div>
                    <WhatsAppButton phone={review.reservations?.guest_phone} name={name} />
                  </li>
                );
              })}
            </ul>
            {detractors.length > ATTENTION_LIMIT && (
              <Button type="button" variant="ghost" size="sm" className="mt-2 w-full text-muted-foreground" onClick={onSeeAll}>
                Ver todos os {formatInteger(detractors.length)} detratores
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CommentsCard({ reviews }: { reviews: SubmittedReview[] }) {
  const [filter, setFilter] = useState<CommentFilter>('all');
  const [visible, setVisible] = useState(COMMENTS_STEP);
  const withComment = useMemo(() => reviews.filter((review) => review.comment?.trim()), [reviews]);
  const filtered = filter === 'all' ? withComment : withComment.filter((review) => review.nps_category === filter);
  const countOf = (category: NpsCategory) => withComment.filter((review) => review.nps_category === category).length;

  const changeFilter = (next: CommentFilter) => {
    setFilter(next);
    setVisible(COMMENTS_STEP);
  };

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareQuote className="h-4 w-4 text-primary" aria-hidden="true" />
          Comentários
        </CardTitle>
        <CardDescription>Avaliações anônimas dos clientes</CardDescription>
      </CardHeader>
      <CardContent>
        {withComment.length === 0 ? (
          <SectionEmpty
            icon={MessageSquareQuote}
            title="Nenhum comentário no período"
            text="O comentário é opcional na última etapa da avaliação. Quando alguém escrever, ele aparece aqui."
          />
        ) : (
          <>
            <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none">
              <FilterChip active={filter === 'all'} onClick={() => changeFilter('all')} label="Todos" count={withComment.length} />
              {(['promoter', 'passive', 'detractor'] as const).map((category) => (
                <FilterChip
                  key={category}
                  active={filter === category}
                  onClick={() => changeFilter(category)}
                  label={CATEGORY_META[category].plural}
                  count={countOf(category)}
                />
              ))}
            </div>

            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nenhum comentário nesta categoria.</p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.slice(0, visible).map((review) => (
                  <li key={review.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2">
                      <ScoreBadge score={review.recommend_score} category={review.nps_category} showLabel />
                      <span className="text-xs text-muted-foreground">{formatShortDate(review.submitted_at)}</span>
                    </div>
                    <CommentText comment={review.comment!} clampClassName="line-clamp-3" />
                  </li>
                ))}
              </ul>
            )}

            {filtered.length > visible && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 w-full text-muted-foreground"
                onClick={() => setVisible((value) => value + COMMENTS_STEP)}
              >
                Mostrar mais comentários
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function NpsEvolutionCard({ data }: { data: ReturnType<typeof computeWeeklyNps> }) {
  const values = data.flatMap((point) => (point.nps === null ? [] : [point.nps]));
  const { domain: [lower, upper], ticks } = getNpsAxis(values);

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4 text-primary" aria-hidden="true" />
          Evolução do NPS
        </CardTitle>
        <CardDescription>NPS por semana de resposta. Semanas sem resposta ficam em branco.</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="week" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis domain={[lower, upper]} ticks={ticks} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            {lower < 0 && upper > 0 && <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.4} strokeDasharray="4 4" />}
            <ChartTooltip
              formatter={(value: number, _name: string, item: { payload: { responses: number } }) => [
                `${formatNpsScore(value)} (${item.payload.responses} ${item.payload.responses === 1 ? 'resposta' : 'respostas'})`,
                'NPS',
              ]}
              labelFormatter={(label: string) => `Semana de ${label}`}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Line
              type="monotone"
              dataKey="nps"
              stroke="hsl(var(--primary))"
              strokeWidth={2.5}
              dot={{ r: 3.5, fill: 'hsl(var(--primary))', strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function VisitWeekdayCard({ data }: { data: ReturnType<typeof computeVisitWeekdayNps> }) {
  const hasNegative = data.some((row) => row.nps < 0);

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
          NPS por dia da visita
        </CardTitle>
        <CardDescription>Agrupado pelo dia em que o cliente esteve na casa, para achar padrões da operação.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.map((row) => {
          const tone = toneForNps(row.nps);
          const width = hasNegative ? Math.abs(row.nps) / 2 : Math.max(0, row.nps);
          return (
            <div key={row.weekday} className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.75rem] items-center gap-3 sm:grid-cols-[5rem_minmax(0,1fr)_2.75rem_5.5rem]">
              <span className="text-sm text-foreground">{row.label}</span>
              <div className="relative h-2 rounded-full bg-muted">
                {hasNegative && <span className="absolute inset-y-[-3px] left-1/2 w-px bg-muted-foreground/40" aria-hidden="true" />}
                <div
                  className={cn('absolute inset-y-0 rounded-full', TONE_BAR[tone])}
                  style={hasNegative
                    ? (row.nps >= 0 ? { left: '50%', width: `${width}%` } : { right: '50%', width: `${width}%` })
                    : { left: 0, width: `${width}%` }}
                />
              </div>
              <span className={cn('text-right text-sm font-semibold tabular-nums', TONE_TEXT[tone])}>{formatNpsScore(row.nps)}</span>
              <span className="hidden text-xs text-muted-foreground sm:block">
                {formatInteger(row.responses)} {row.responses === 1 ? 'resposta' : 'respostas'}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function SummaryTab({ summary, reviews, isLoading, fromDate, toDate, onSeeDetractors }: {
  summary: NpsSummary;
  reviews: SubmittedReview[];
  isLoading: boolean;
  fromDate: string;
  toDate: string;
  onSeeDetractors: () => void;
}) {
  const weekly = useMemo(() => computeWeeklyNps(reviews, fromDate, toDate), [reviews, fromDate, toDate]);
  const weekdays = useMemo(
    () => computeVisitWeekdayNps(reviews.map((review) => ({ ...review, visit_date: review.reservations?.date ?? null }))),
    [reviews],
  );

  if (summary.total_submitted === 0) {
    return (
      <SectionEmpty
        icon={MessageSquareQuote}
        title="Nenhuma resposta no período"
        text="Os convites foram gerados, mas nenhum cliente respondeu ainda. Acompanhe quem está aguardando na aba Registros."
      />
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-64 rounded-xl" />)}
      </div>
    );
  }

  const enoughForTrends = summary.total_submitted >= MIN_RESPONSES_FOR_TRENDS;
  const showEvolution = enoughForTrends && weekly.filter((point) => point.nps !== null).length >= 2;
  const showWeekdays = enoughForTrends && weekdays.length >= 2;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NpsCompositionCard summary={summary} />
        <CategoryRatingsCard reviews={reviews} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AttentionCard reviews={reviews} onSeeAll={onSeeDetractors} />
        <CommentsCard reviews={reviews} />
      </div>

      {(showEvolution || showWeekdays) ? (
        <div className={cn('grid grid-cols-1 gap-4', showEvolution && showWeekdays && 'lg:grid-cols-2')}>
          {showEvolution && <NpsEvolutionCard data={weekly} />}
          {showWeekdays && <VisitWeekdayCard data={weekdays} />}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-center text-xs text-muted-foreground">
          A evolução semanal e o NPS por dia da visita aparecem a partir de {MIN_RESPONSES_FOR_TRENDS} respostas no período
          {' '}(agora: {formatInteger(summary.total_submitted)}).
        </p>
      )}
    </div>
  );
}

// ── Registros ────────────────────────────────────────────────────────────────

const RECORDS_GRID = 'lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.8fr)_minmax(0,0.85fr)_minmax(0,1.35fr)_minmax(0,2fr)]';

function RecordStatus({ record }: { record: ReviewRecord }) {
  const status = getEffectiveReviewStatus(record.status, record.expires_at);

  if (status === 'submitted') {
    return <ScoreBadge score={record.recommend_score} category={record.nps_category} showLabel />;
  }

  if (status === 'expired') {
    return (
      <div className="space-y-0.5">
        <span className="inline-flex rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Expirado
        </span>
        {record.expires_at && (
          <p className="text-[11px] text-muted-foreground">venceu em {format(new Date(record.expires_at), 'dd/MM')}</p>
        )}
      </div>
    );
  }

  const daysLeft = record.expires_at ? differenceInCalendarDays(new Date(record.expires_at), new Date()) : null;
  return (
    <div className="space-y-0.5">
      <span className="inline-flex rounded-full border border-warning/35 bg-warning/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
        Aguardando
      </span>
      {daysLeft !== null && (
        <p className="text-[11px] text-muted-foreground">
          {daysLeft <= 0 ? 'expira hoje' : `expira em ${daysLeft} ${daysLeft === 1 ? 'dia' : 'dias'}`}
        </p>
      )}
    </div>
  );
}

function RecordRow({ record }: { record: ReviewRecord }) {
  const name = record.reservations?.guest_name?.trim() || 'Cliente';
  const phone = record.reservations?.guest_phone ?? null;
  const visitDate = formatVisitDate(record.reservations?.date);
  const submitted = record.status === 'submitted';
  const hasRatings = submitted && RATING_FIELDS.some(({ field }) => record[field] !== null);

  return (
    <li className={cn('grid gap-x-4 gap-y-2 py-3.5 lg:items-start', RECORDS_GRID)}>
      <div className="min-w-0 space-y-1">
        <div className="flex items-start justify-between gap-2 lg:block">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <div className="lg:hidden"><RecordStatus record={record} /></div>
        </div>
        {phone && <PhoneWhatsAppLink phone={phone} className="text-xs text-muted-foreground" />}
      </div>

      <div className="text-xs text-muted-foreground lg:text-sm">
        <span className="lg:hidden">Visita </span>
        <span className="text-foreground">{visitDate ?? '—'}</span>
        <p className="text-[11px] text-muted-foreground">
          {submitted && record.submitted_at
            ? `respondeu em ${format(new Date(record.submitted_at), 'dd/MM')}`
            : `convite em ${format(new Date(record.invited_at), 'dd/MM')}`}
        </p>
      </div>

      <div className="hidden lg:block"><RecordStatus record={record} /></div>

      {/* Células vazias somem no celular para não abrir buracos entre as linhas. */}
      <div className={cn('min-w-0', !hasRatings && 'hidden lg:block')}>
        {hasRatings ? <RatingsInline review={record} /> : <span className="text-sm text-muted-foreground">—</span>}
      </div>

      <div className={cn('min-w-0', !record.comment && 'hidden lg:block')}>
        {record.comment
          ? <CommentText comment={record.comment} />
          : <span className="text-sm text-muted-foreground">—</span>}
      </div>
    </li>
  );
}

function RecordsTab({ companyId, summary, fromDate, toDate, filter, onFilterChange }: {
  companyId: string;
  summary: NpsSummary;
  fromDate: string;
  toDate: string;
  filter: RecordFilter;
  onFilterChange: (filter: RecordFilter) => void;
}) {
  const [searchInput, setSearchInput] = useState('');
  const [ratingFilters, setRatingFilters] = useState<Record<RatingField, string>>({
    food_rating: 'all',
    service_rating: 'all',
    ambiance_rating: 'all',
  });
  const search = useDebouncedValue(searchInput.trim());
  const submittedFilter = isSubmittedFilter(filter);
  const activeRatingFilters = submittedFilter
    ? RATING_FIELDS.filter(({ field }) => ratingFilters[field] !== 'all')
    : [];
  const ratingKey = activeRatingFilters.map(({ field }) => `${field}:${ratingFilters[field]}`).join('|');

  const recordsQuery = useInfiniteQuery({
    queryKey: ['nps-records', companyId, fromDate, toDate, filter, search, ratingKey],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const nowIso = new Date().toISOString();
      const reservationEmbed = search
        ? 'reservations!reservation_id!inner(guest_name, guest_phone, date)'
        : 'reservations!reservation_id(guest_name, guest_phone, date)';

      let query = (supabase as any)
        .from('reservation_reviews')
        .select(
          `id, status, submitted_at, invited_at, expires_at, nps_category,
          ambiance_rating, food_rating, service_rating, recommend_score, comment,
          ${reservationEmbed}`,
          { count: 'exact' },
        )
        .eq('company_id', companyId)
        .gte('invited_at', `${fromDate}T00:00:00`)
        .lte('invited_at', `${toDate}T23:59:59`);

      if (filter === 'submitted') {
        query = query.eq('status', 'submitted');
      } else if (filter === 'promoter' || filter === 'passive' || filter === 'detractor') {
        query = query.eq('status', 'submitted').eq('nps_category', filter);
      } else if (filter === 'pending') {
        query = query.eq('status', 'pending').gte('expires_at', nowIso);
      } else if (filter === 'expired') {
        // O banco só grava "expired" quando alguém tenta responder depois do
        // prazo; pendentes vencidos também contam como expirados.
        query = query.or(`status.eq.expired,and(status.eq.pending,expires_at.lt."${nowIso}")`);
      }

      if (search) {
        query = query.ilike('reservations.guest_name', `%${escapeLikePattern(search)}%`);
      }

      activeRatingFilters.forEach(({ field }) => {
        query = query.eq(field, Number(ratingFilters[field]));
      });

      query = submittedFilter
        ? query.order('submitted_at', { ascending: false, nullsFirst: false })
        : query.order('invited_at', { ascending: false });

      const start = pageParam * RECORDS_PAGE_SIZE;
      const { data, error, count } = await query
        .order('id', { ascending: false })
        .range(start, start + RECORDS_PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []) as ReviewRecord[], total: (count ?? 0) as number };
    },
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((acc, page) => acc + page.rows.length, 0);
      return loaded < lastPage.total ? pages.length : undefined;
    },
  });

  const records = recordsQuery.data?.pages.flatMap((page) => page.rows) ?? [];
  const total = recordsQuery.data?.pages[0]?.total ?? 0;
  const remaining = Math.max(0, total - records.length);

  const filterGroups: { value: RecordFilter; label: string; count: number }[][] = [
    [
      { value: 'submitted', label: 'Respondidas', count: summary.total_submitted },
      { value: 'detractor', label: 'Detratores', count: summary.detractors },
      { value: 'passive', label: 'Neutros', count: summary.passives },
      { value: 'promoter', label: 'Promotores', count: summary.promoters },
    ],
    [
      { value: 'pending', label: 'Aguardando', count: summary.total_pending },
      { value: 'expired', label: 'Expiradas', count: summary.total_expired },
      { value: 'all', label: 'Todos os convites', count: summary.total_invited },
    ],
  ];

  const clearRatings = () => setRatingFilters({ food_rating: 'all', service_rating: 'all', ambiance_rating: 'all' });
  const hasFilters = !!search || activeRatingFilters.length > 0;

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="space-y-3 pb-2">
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none">
          {filterGroups.map((group, groupIndex) => (
            <div key={groupIndex} className="flex shrink-0 items-center gap-1.5">
              {groupIndex > 0 && <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />}
              {group.map((option) => (
                <FilterChip
                  key={option.value}
                  active={filter === option.value}
                  onClick={() => onFilterChange(option.value)}
                  label={option.label}
                  count={option.count}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative lg:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              placeholder="Buscar cliente pelo nome"
              aria-label="Buscar cliente pelo nome"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className="h-9 pl-9 pr-8"
            />
            {searchInput && (
              <button
                type="button"
                aria-label="Limpar busca"
                onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {submittedFilter && (
            <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 scrollbar-none lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 lg:pb-0">
              {RATING_FIELDS.map(({ field, label }) => (
                <Select
                  key={field}
                  value={ratingFilters[field]}
                  onValueChange={(value) => setRatingFilters((current) => ({ ...current, [field]: value }))}
                >
                  <SelectTrigger
                    className={cn('h-9 w-auto shrink-0 gap-1.5 text-xs', ratingFilters[field] === 'all' && 'border-dashed')}
                    aria-label={`Filtrar por nota de ${label.toLowerCase()}`}
                  >
                    <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" aria-hidden="true" />
                    <span className="text-muted-foreground">{label}:</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {[5, 4, 3, 2, 1].map((stars) => (
                      <SelectItem key={stars} value={String(stars)}>
                        {stars} {stars === 1 ? 'estrela' : 'estrelas'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ))}
              {activeRatingFilters.length > 0 && (
                <Button type="button" variant="ghost" size="sm" className="h-9 shrink-0 text-xs text-muted-foreground" onClick={clearRatings}>
                  Limpar notas
                </Button>
              )}
            </div>
          )}
        </div>

        {recordsQuery.data && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {formatInteger(total)} {total === 1 ? 'registro' : 'registros'}
            {hasFilters ? ' com os filtros aplicados' : ''}
          </p>
        )}
      </CardHeader>

      <CardContent className="pt-0">
        {recordsQuery.isLoading ? (
          <div className="space-y-3 py-3">
            {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-14 w-full rounded-lg" />)}
          </div>
        ) : recordsQuery.isError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Não foi possível carregar os registros</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>Confira sua conexão e tente novamente.</span>
              <Button variant="outline" size="sm" onClick={() => recordsQuery.refetch()}>Tentar novamente</Button>
            </AlertDescription>
          </Alert>
        ) : records.length === 0 ? (
          <SectionEmpty
            icon={Search}
            title="Nenhum registro encontrado"
            text={hasFilters ? 'Nenhum registro com esses filtros. Tente outra busca ou limpe as notas.' : 'Não há convites nesta situação no período selecionado.'}
          />
        ) : (
          <>
            <div
              className={cn('hidden gap-x-4 border-b border-border pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground lg:grid', RECORDS_GRID)}
              aria-hidden="true"
            >
              <span>Cliente</span>
              <span>Visita</span>
              <span>Nota</span>
              <span>Notas por item</span>
              <span>Comentário</span>
            </div>
            <ul className="divide-y divide-border">
              {records.map((record) => <RecordRow key={record.id} record={record} />)}
            </ul>
            {recordsQuery.hasNextPage && (
              <div className="pt-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => recordsQuery.fetchNextPage()}
                  disabled={recordsQuery.isFetchingNextPage}
                >
                  {recordsQuery.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Carregar mais ({formatInteger(remaining)} restantes)
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── página ───────────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <ReportKpiStripSkeleton count={4} />
      <Skeleton className="h-10 w-48 rounded-lg" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

export default function CompanyNpsReports() {
  const companyContext = useMaybeCompanySlug();
  const companyId = companyContext?.companyId;
  const slug = companyContext?.slug;
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState('30');
  const [activeTab, setActiveTab] = useState<'resumo' | 'registros'>('resumo');
  const [recordFilter, setRecordFilter] = useState<RecordFilter>('submitted');
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);

  const lowResponseDismissKey = `nps-low-response-alert-dismissed:${companyId ?? ''}`;
  const [lowResponseDismissed, setLowResponseDismissed] = useState(() => readDismissed(lowResponseDismissKey));
  useEffect(() => {
    setLowResponseDismissed(readDismissed(lowResponseDismissKey));
  }, [lowResponseDismissKey]);

  const days = Number(period);
  const fromDate = format(subDays(new Date(), days), 'yyyy-MM-dd');
  const toDate = format(new Date(), 'yyyy-MM-dd');
  const prevFromDate = format(subDays(new Date(), days * 2), 'yyyy-MM-dd');
  const prevToDate = format(subDays(new Date(), days + 1), 'yyyy-MM-dd');
  const comparisonLabel = `${days} dias anteriores`;

  const { data: npsConfig, isLoading: npsConfigLoading } = useCompanyNpsActivation(companyId);
  const npsActive = npsConfig?.enabled ?? false;

  const updateNpsActiveMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!companyId) throw new Error('Empresa não encontrada.');

      const { error } = await (supabase as any)
        .from('company_nps_configs')
        .upsert({
          company_id: companyId,
          enabled,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'company_id' });

      if (error) throw error;
    },
    onSuccess: (_, enabled) => {
      queryClient.invalidateQueries({ queryKey: ['company-nps-activation', companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-nps-config', companyId] });
      toast.success(enabled ? 'Avaliações ativadas.' : 'Avaliações desativadas.');
    },
    onError: (error: any) => {
      toast.error(`Não foi possível atualizar as avaliações: ${error.message}`);
    },
  });

  function makeSummaryQuery(from: string, to: string) {
    return {
      queryKey: ['nps-summary', companyId, from, to],
      queryFn: async () => {
        const { data, error } = await (supabase as any).rpc('get_company_nps_summary', {
          _company_id: companyId!, _from: from, _to: to,
        });
        if (error) throw error;
        const rows = data as NpsSummary[];
        return rows.length > 0 ? rows[0] : null;
      },
      enabled: !!companyId,
    };
  }

  const summaryQuery = useQuery<NpsSummary | null>(makeSummaryQuery(fromDate, toDate));
  const { data: prevSummary } = useQuery<NpsSummary | null>(makeSummaryQuery(prevFromDate, prevToDate));
  const summary = summaryQuery.data ?? null;

  // Mesmo recorte do resumo (convites do período), para os cartões baterem com
  // os indicadores do topo.
  const { data: submittedReviews = [], isLoading: reviewsLoading } = useQuery<SubmittedReview[]>({
    queryKey: ['nps-submitted', companyId, fromDate, toDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('reservation_reviews')
        .select(`
          id, submitted_at, recommend_score, nps_category, comment,
          ambiance_rating, food_rating, service_rating,
          reservations!reservation_id (guest_name, guest_phone, date)
        `)
        .eq('company_id', companyId!)
        .eq('status', 'submitted')
        .gte('invited_at', `${fromDate}T00:00:00`)
        .lte('invited_at', `${toDate}T23:59:59`)
        .order('submitted_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as SubmittedReview[];
    },
    enabled: !!companyId && !!summary && summary.total_submitted > 0,
  });

  const hasPrevResponses = !!prevSummary && prevSummary.total_submitted > 0;
  const averageRating = summary ? averageOf([summary.avg_food, summary.avg_service, summary.avg_ambiance]) : null;
  const prevAverageRating = hasPrevResponses
    ? averageOf([prevSummary!.avg_food, prevSummary!.avg_service, prevSummary!.avg_ambiance])
    : null;
  const npsZone = summary ? getNpsZone(summary.nps_score) : null;
  const smallSample = !!summary && summary.total_submitted > 0 && summary.total_submitted < MIN_RESPONSES_FOR_TRENDS;

  const showLowResponseAlert = npsActive
    && !lowResponseDismissed
    && !!summary
    && summary.total_invited >= LOW_RESPONSE_MIN_INVITES
    && Number(summary.response_rate) < LOW_RESPONSE_MAX_RATE;

  const automationsPath = slug ? `/${slug}/admin/automacoes` : null;
  const googleSettingsPath = slug ? `/${slug}/admin/configuracoes/empresa` : null;

  const dismissLowResponseAlert = () => {
    writeDismissed(lowResponseDismissKey);
    setLowResponseDismissed(true);
  };

  const seeDetractors = () => {
    setRecordFilter('detractor');
    setActiveTab('registros');
  };

  const headerActions = (
    <>
      {!npsConfigLoading && !npsActive && (
        <Button
          type="button"
          size="sm"
          className="h-9"
          disabled={updateNpsActiveMutation.isPending}
          onClick={() => updateNpsActiveMutation.mutate(true)}
        >
          {updateNpsActiveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Ativar avaliações
        </Button>
      )}
      <Select value={period} onValueChange={setPeriod}>
        <SelectTrigger className="h-9 w-[170px]" aria-label="Período">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIOD_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label="Mais opções de avaliações">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {automationsPath && (
            <DropdownMenuItem asChild>
              <Link to={automationsPath} className="gap-2">
                <MessageCircle className="h-4 w-4 text-muted-foreground" />
                Mensagem de pós-visita
              </Link>
            </DropdownMenuItem>
          )}
          {googleSettingsPath && (
            <DropdownMenuItem asChild>
              <Link to={googleSettingsPath} className="gap-2">
                <Star className="h-4 w-4 text-muted-foreground" />
                Link de avaliação no Google
              </Link>
            </DropdownMenuItem>
          )}
          {npsActive && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-destructive focus:text-destructive"
                disabled={updateNpsActiveMutation.isPending}
                onSelect={() => setConfirmDisableOpen(true)}
              >
                <Power className="h-4 w-4" />
                Desativar avaliações
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <ReportShell
      title="Avaliações"
      description="NPS e satisfação dos clientes pós-visita."
      icon={MessageSquareQuote}
      eyebrow="Pós-visita"
      actions={headerActions}
      ariaBusy={summaryQuery.isFetching}
    >
      {!npsConfigLoading && !npsActive && (
        <Alert className="border-warning/35 bg-warning/5">
          <PauseCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Coleta de avaliações desativada</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Novos check-ins não geram links e a variável fica indisponível nas automações. O pós-visita sem avaliação continua funcionando.
          </AlertDescription>
        </Alert>
      )}

      {summaryQuery.isLoading || !companyId ? (
        <PageSkeleton />
      ) : summaryQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Não foi possível carregar as avaliações</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Confira sua conexão e tente novamente.</span>
            <Button variant="outline" size="sm" onClick={() => summaryQuery.refetch()}>Tentar novamente</Button>
          </AlertDescription>
        </Alert>
      ) : !summary || summary.total_invited === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 rounded-full bg-muted/50 p-5">
            <MessageSquareQuote className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold">Nenhuma avaliação ainda</h3>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            As avaliações aparecerão aqui depois que os clientes responderem ao link enviado pós-visita.
          </p>
        </div>
      ) : (
        <>
          {showLowResponseAlert && (
            <Alert className="border-warning/35 bg-warning/5">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Poucas respostas para o volume de convites</AlertTitle>
              <AlertDescription className="flex flex-col gap-3 text-muted-foreground lg:flex-row lg:items-center lg:justify-between">
                <span>
                  {formatInteger(summary.total_submitted)} de {formatInteger(summary.total_invited)} convites do período foram respondidos.
                  Confira se a mensagem de pós-visita inclui o link da avaliação.
                </span>
                <span className="flex shrink-0 gap-2">
                  {automationsPath && (
                    <Button asChild variant="outline" size="sm" className="bg-background">
                      <Link to={automationsPath}>Revisar pós-visita</Link>
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" onClick={dismissLowResponseAlert}>Ocultar</Button>
                </span>
              </AlertDescription>
            </Alert>
          )}

          <ReportKpiStrip aria-label="Indicadores de avaliação">
            <ReportKpiTile
              label="NPS"
              icon={TrendingUp}
              value={summary.total_submitted > 0
                ? <span className={cn(npsZone && TONE_TEXT[npsZone.tone])}>{formatNpsScore(summary.nps_score)}</span>
                : '—'}
              comparison={summary.total_submitted > 0 && hasPrevResponses
                ? (
                  <ReportKpiDelta
                    current={summary.nps_score}
                    previous={prevSummary!.nps_score}
                    absoluteUnit="pts"
                    fractionDigits={0}
                    comparisonLabel={comparisonLabel}
                  />
                )
                : null}
              detail={summary.total_submitted === 0
                ? 'Sem respostas no período'
                : smallSample
                  ? <>{npsZone?.label} · <span className="text-amber-700 dark:text-amber-300">amostra pequena</span></>
                  : npsZone?.label}
              explanation="Percentual de promotores (notas 9 e 10) menos o de detratores (notas 0 a 6). Vai de −100 a +100."
            />
            <ReportKpiTile
              label="Respostas"
              icon={Users}
              value={formatInteger(summary.total_submitted)}
              comparison={prevSummary && prevSummary.total_invited > 0
                ? (
                  <ReportKpiDelta
                    current={Number(summary.response_rate)}
                    previous={Number(prevSummary.response_rate)}
                    percentagePoints
                    comparisonLabel={comparisonLabel}
                  />
                )
                : null}
              detail={`de ${formatInteger(summary.total_invited)} convites · ${percentFormatter.format(Number(summary.response_rate))}% de resposta`}
              explanation="Avaliações respondidas entre os convites gerados nos check-ins do período. O convite só chega ao cliente quando o link vai na mensagem de pós-visita ou é enviado pela equipe."
            />
            <ReportKpiTile
              label="Nota média"
              icon={Star}
              value={averageRating !== null
                ? <>{formatDecimal(averageRating)}<span className="ml-0.5 text-base font-normal text-muted-foreground">/5</span></>
                : '—'}
              comparison={averageRating !== null && prevAverageRating !== null
                ? (
                  <ReportKpiDelta
                    current={averageRating}
                    previous={prevAverageRating}
                    absoluteUnit=""
                    comparisonLabel={comparisonLabel}
                  />
                )
                : null}
              detail="Comida, atendimento e ambiente"
              explanation="Média das notas de 1 a 5 estrelas das categorias perguntadas na avaliação."
            />
            <ReportKpiTile
              label="Detratores"
              icon={ThumbsDown}
              value={formatInteger(summary.detractors)}
              comparison={hasPrevResponses
                ? (
                  <ReportKpiDelta
                    current={summary.detractors}
                    previous={prevSummary!.detractors}
                    higherIsBetter={false}
                    comparisonLabel={comparisonLabel}
                  />
                )
                : null}
              detail={`${formatInteger(summary.passives)} neutros · ${formatInteger(summary.promoters)} promotores`}
              explanation="Clientes que deram nota de 0 a 6 para a recomendação. Vale entrar em contato com cada um."
            />
          </ReportKpiStrip>

          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'resumo' | 'registros')}>
            <TabsList>
              <TabsTrigger value="resumo">Resumo</TabsTrigger>
              <TabsTrigger value="registros">Registros</TabsTrigger>
            </TabsList>

            <TabsContent value="resumo" className="mt-4">
              <SummaryTab
                summary={summary}
                reviews={submittedReviews}
                isLoading={reviewsLoading}
                fromDate={fromDate}
                toDate={toDate}
                onSeeDetractors={seeDetractors}
              />
            </TabsContent>

            <TabsContent value="registros" className="mt-4">
              <RecordsTab
                companyId={companyId}
                summary={summary}
                fromDate={fromDate}
                toDate={toDate}
                filter={recordFilter}
                onFilterChange={setRecordFilter}
              />
            </TabsContent>
          </Tabs>
        </>
      )}

      <AlertDialog open={confirmDisableOpen} onOpenChange={setConfirmDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desativar avaliações?</AlertDialogTitle>
            <AlertDialogDescription>
              Novos check-ins deixam de gerar links e a variável fica indisponível nas automações. As avaliações já recebidas continuam nesta tela.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => updateNpsActiveMutation.mutate(false)}
            >
              Desativar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ReportShell>
  );
}
