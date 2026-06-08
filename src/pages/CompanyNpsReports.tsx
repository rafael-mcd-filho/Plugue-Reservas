import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer,
  LineChart, Line, ReferenceLine,
} from 'recharts';
import {
  MessageSquareQuote, Star, TrendingUp, Users,
  ArrowUp, ArrowDown, Minus, CalendarDays, Heart,
  Search, Copy, MessageCircle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { format, subDays, eachWeekOfInterval, endOfWeek, getDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';

const PERIOD_OPTIONS = [
  { value: '30', label: 'Últimos 30 dias' },
  { value: '60', label: 'Últimos 60 dias' },
  { value: '90', label: 'Últimos 3 meses' },
  { value: '180', label: 'Últimos 6 meses' },
];

const CHART_COLORS = {
  promoter: 'hsl(var(--success))',
  passive: 'hsl(var(--warning))',
  detractor: 'hsl(var(--destructive))',
  primary: 'hsl(var(--primary))',
};

// ── interfaces ────────────────────────────────────────────────────────────────

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

interface ReviewComment {
  id: string;
  submitted_at: string;
  recommend_score: number;
  nps_category: 'promoter' | 'passive' | 'detractor';
  comment: string;
}

interface RawReview {
  submitted_at: string;
  ambiance_rating: number | null;
  food_rating: number | null;
  service_rating: number | null;
  nps_category: 'promoter' | 'passive' | 'detractor' | null;
}

interface ReviewDetail {
  id: string;
  status: 'pending' | 'submitted' | 'expired';
  submitted_at: string | null;
  invited_at: string;
  nps_category: 'promoter' | 'passive' | 'detractor' | null;
  ambiance_rating: number | null;
  food_rating: number | null;
  service_rating: number | null;
  recommend_score: number | null;
  comment: string | null;
  reservations: {
    guest_name: string;
    guest_phone: string | null;
    date: string;
  } | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function computeWeeklyNps(reviews: RawReview[], fromDate: string, toDate: string) {
  if (!reviews.length) return [];
  const start = new Date(`${fromDate}T00:00:00`);
  const end   = new Date(`${toDate}T23:59:59`);
  const weeks = eachWeekOfInterval({ start, end }, { weekStartsOn: 1 });
  return weeks.map(ws => {
    const we = endOfWeek(ws, { weekStartsOn: 1 });
    const wr = reviews.filter(r => { const d = new Date(r.submitted_at); return d >= ws && d <= we; });
    if (!wr.length) return null;
    const p = wr.filter(r => r.nps_category === 'promoter').length;
    const d = wr.filter(r => r.nps_category === 'detractor').length;
    return { semana: format(ws, 'dd/MM', { locale: ptBR }), nps: Math.round((p - d) / wr.length * 100), respostas: wr.length };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
}

function computeStarDist(reviews: RawReview[], field: 'ambiance_rating' | 'food_rating' | 'service_rating') {
  const counts = [0, 0, 0, 0, 0];
  reviews.forEach(r => { const v = r[field]; if (v && v >= 1 && v <= 5) counts[v - 1]++; });
  const total = counts.reduce((a, b) => a + b, 0);
  return [5, 4, 3, 2, 1].map(star => ({
    star,
    count: counts[star - 1],
    pct: total > 0 ? Math.round(counts[star - 1] / total * 100) : 0,
  }));
}

const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function computeDowNps(reviews: RawReview[]) {
  return DOW_LABELS.map((day, dow) => {
    const dr = reviews.filter(r => getDay(new Date(r.submitted_at)) === dow);
    if (!dr.length) return { day, nps: null as number | null, count: 0 };
    const p = dr.filter(r => r.nps_category === 'promoter').length;
    const d = dr.filter(r => r.nps_category === 'detractor').length;
    return { day, nps: Math.round((p - d) / dr.length * 100), count: dr.length };
  }).filter(d => d.count > 0);
}

function fmtDelta(delta: number): string {
  const abs = Math.abs(delta);
  const rounded = Math.round(abs * 10) / 10;
  return rounded % 1 === 0 ? String(Math.round(abs)) : abs.toFixed(1);
}

function buildWhatsAppUrl(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  const normalized = digits.startsWith('55') ? digits : `55${digits}`;
  return `https://wa.me/${normalized}`;
}

// ── sub-components ────────────────────────────────────────────────────────────

function DeltaBadge({ current, prev, unit = '' }: { current: number | null; prev: number | null; unit?: string }) {
  if (current === null || prev === null) return <span className="text-xs text-muted-foreground/40">—</span>;
  const delta = current - prev;
  if (Math.abs(delta) < 0.05) return (
    <span className="text-xs text-muted-foreground flex items-center gap-0.5">
      <Minus className="h-3 w-3" /> igual
    </span>
  );
  const pos = delta > 0;
  return (
    <span className={`text-xs flex items-center gap-0.5 font-medium ${pos ? 'text-success' : 'text-destructive'}`}>
      {pos ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {pos ? '+' : '-'}{fmtDelta(delta)}{unit}
    </span>
  );
}

function NpsCategoryBadge({ category }: { category: 'promoter' | 'passive' | 'detractor' }) {
  const map = {
    promoter: { label: 'Promotor',  className: 'bg-success/10 text-success border-success/20' },
    passive:  { label: 'Neutro',    className: 'bg-warning/10 text-warning border-warning/20' },
    detractor:{ label: 'Detrator',  className: 'bg-destructive/10 text-destructive border-destructive/20' },
  };
  const { label, className } = map[category];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: 'pending' | 'expired' }) {
  const map = {
    pending: { label: 'Aguardando', className: 'bg-muted/60 text-muted-foreground border-border' },
    expired: { label: 'Expirou',    className: 'bg-destructive/5 text-destructive/70 border-destructive/20' },
  };
  const { label, className } = map[status];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

type HighlightColor = 'success' | 'warning' | 'destructive';
const highlightClass: Record<HighlightColor, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

function KpiCell({
  icon: Icon, title, value, delta, note, highlight,
}: {
  icon: typeof Star; title: string; value: string;
  delta?: React.ReactNode; note?: string; highlight?: HighlightColor;
}) {
  return (
    <div className="flex-1 px-5 py-4 min-w-[110px] space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground truncate">{title}</p>
      </div>
      <p className={`text-2xl font-bold leading-none ${highlight ? highlightClass[highlight] : 'text-foreground'}`}>
        {value}
      </p>
      {delta && <div>{delta}</div>}
      {note  && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function StarDistCard({ title, data, avg }: {
  title: string;
  data: { star: number; count: number; pct: number }[];
  avg: number | null;
}) {
  return (
    <Card className="border border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-1.5 mb-4">
          {avg !== null ? (
            <>
              <Star className="h-4 w-4 fill-amber-400 text-amber-400 self-center" />
              <span className="text-2xl font-bold">{avg.toFixed(1)}</span>
              <span className="text-sm text-muted-foreground">/5</span>
            </>
          ) : <span className="text-2xl text-muted-foreground">—</span>}
        </div>
        <div className="space-y-2">
          {data.map(({ star, count, pct }) => (
            <div key={star} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-3 shrink-0 text-right">{star}</span>
              <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />
              <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                <div className="bg-amber-400 h-full rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs text-muted-foreground w-6 text-right shrink-0">{count}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewDetailCard({ review }: { review: ReviewDetail }) {
  const [expanded, setExpanded] = useState(false);
  const name    = review.reservations?.guest_name ?? 'Cliente';
  const phone   = review.reservations?.guest_phone ?? null;
  const resDate = review.reservations?.date;
  const waUrl   = buildWhatsAppUrl(phone);

  function copyPhone() {
    if (!phone) return;
    navigator.clipboard.writeText(phone);
    toast.success('Telefone copiado');
  }

  const ratings: { label: string; value: number | null }[] = [
    { label: 'Ambiente',    value: review.ambiance_rating },
    { label: 'Comida',      value: review.food_rating     },
    { label: 'Atendimento', value: review.service_rating  },
  ];

  const hasComment = !!review.comment;
  const longComment = hasComment && review.comment!.length > 140;

  return (
    <div className="py-4 space-y-2.5">
      {/* row 1: name + badges + contact */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{name}</span>
            {review.nps_category && <NpsCategoryBadge category={review.nps_category} />}
            {review.status !== 'submitted' && <StatusBadge status={review.status} />}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {resDate && (
              <span>Reserva: {format(new Date(resDate + 'T12:00:00'), 'dd/MM/yyyy')}</span>
            )}
            {review.submitted_at && (
              <span>Avaliou: {format(new Date(review.submitted_at), 'dd/MM/yyyy')}</span>
            )}
            {review.status === 'submitted' && review.recommend_score !== null && (
              <span>NPS: <strong>{review.recommend_score}/10</strong></span>
            )}
          </div>
        </div>

        {/* contact buttons */}
        {phone && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={copyPhone}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted transition-colors"
            >
              <Copy className="h-3.5 w-3.5" />
              {phone}
            </button>
            {waUrl && (
              <a
                href={waUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted transition-colors"
                title="Abrir no WhatsApp"
              >
                <MessageCircle className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
      </div>

      {/* row 2: star ratings */}
      {review.status === 'submitted' && ratings.some(r => r.value !== null) && (
        <div className="flex flex-wrap gap-3">
          {ratings.map(r => r.value !== null && (
            <span key={r.label} className="flex items-center gap-1 text-xs text-muted-foreground">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {r.label}: <strong className="text-foreground">{r.value}/5</strong>
            </span>
          ))}
        </div>
      )}

      {/* row 3: comment */}
      {hasComment && (
        <div className="text-sm leading-relaxed text-muted-foreground">
          {!longComment || expanded ? (
            <span>{review.comment}</span>
          ) : (
            <span>
              {review.comment!.slice(0, 140)}
              <button
                className="ml-1 inline-flex items-center gap-0.5 text-primary text-xs font-medium"
                onClick={() => setExpanded(true)}
              >
                ver mais <ChevronDown className="h-3 w-3" />
              </button>
            </span>
          )}
          {expanded && (
            <button
              className="ml-1 inline-flex items-center gap-0.5 text-primary text-xs font-medium"
              onClick={() => setExpanded(false)}
            >
              ver menos <ChevronUp className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 rounded-full bg-muted/50 p-5">
        <MessageSquareQuote className="h-10 w-10 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold">Nenhuma avaliação ainda</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        As avaliações aparecerão aqui depois que os clientes responderem ao link enviado pós-visita.
      </p>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

type CommentCat   = 'all' | 'promoter' | 'passive' | 'detractor';
type DetailFilter = 'all' | 'promoter' | 'passive' | 'detractor' | 'pending' | 'expired';

export default function CompanyNpsReports() {
  const { companyId } = useMaybeCompanySlug() ?? {};

  const [period,        setPeriod]        = useState('30');
  const [activeTab,     setActiveTab]     = useState<'resumo' | 'registros'>('resumo');
  const [commentCat,    setCommentCat]    = useState<CommentCat>('all');
  const [searchQuery,   setSearchQuery]   = useState('');
  const [detailFilter,  setDetailFilter]  = useState<DetailFilter>('all');
  const [ambFilter,     setAmbFilter]     = useState<string>('all');
  const [foodFilter,    setFoodFilter]    = useState<string>('all');
  const [serviceFilter, setServiceFilter] = useState<string>('all');

  const fromDate     = format(subDays(new Date(), Number(period)),     'yyyy-MM-dd');
  const toDate       = format(new Date(),                               'yyyy-MM-dd');
  const prevFromDate = format(subDays(new Date(), Number(period) * 2), 'yyyy-MM-dd');
  const prevToDate   = format(subDays(new Date(), Number(period) + 1), 'yyyy-MM-dd');

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

  const { data: summary,     isLoading: summaryLoading } = useQuery<NpsSummary | null>(makeSummaryQuery(fromDate, toDate));
  const { data: prevSummary }                             = useQuery<NpsSummary | null>(makeSummaryQuery(prevFromDate, prevToDate));

  const { data: rawReviews = [] } = useQuery<RawReview[]>({
    queryKey: ['nps-raw', companyId, fromDate, toDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('reservation_reviews')
        .select('submitted_at, ambiance_rating, food_rating, service_rating, nps_category')
        .eq('company_id', companyId!)
        .eq('status', 'submitted')
        .gte('submitted_at', `${fromDate}T00:00:00`)
        .lte('submitted_at', `${toDate}T23:59:59`);
      if (error) throw error;
      return (data ?? []) as RawReview[];
    },
    enabled: !!companyId && activeTab === 'resumo',
  });

  const { data: comments = [], isLoading: commentsLoading } = useQuery<ReviewComment[]>({
    queryKey: ['nps-comments', companyId, fromDate, toDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('reservation_reviews')
        .select('id, submitted_at, recommend_score, nps_category, comment')
        .eq('company_id', companyId!)
        .eq('status', 'submitted')
        .not('comment', 'is', null)
        .gte('submitted_at', `${fromDate}T00:00:00`)
        .lte('submitted_at', `${toDate}T23:59:59`)
        .order('submitted_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as ReviewComment[];
    },
    enabled: !!companyId && activeTab === 'resumo',
  });

  const { data: reviewDetails = [], isLoading: detailsLoading } = useQuery<ReviewDetail[]>({
    queryKey: ['nps-details', companyId, fromDate, toDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('reservation_reviews')
        .select(`
          id, status, submitted_at, invited_at,
          nps_category, ambiance_rating, food_rating, service_rating,
          recommend_score, comment,
          reservations!reservation_id (guest_name, guest_phone, date)
        `)
        .eq('company_id', companyId!)
        .gte('invited_at', `${fromDate}T00:00:00`)
        .lte('invited_at', `${toDate}T23:59:59`)
        .order('invited_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as ReviewDetail[];
    },
    enabled: !!companyId && activeTab === 'registros',
  });

  const weeklyNps    = useMemo(() => computeWeeklyNps(rawReviews, fromDate, toDate), [rawReviews, fromDate, toDate]);
  const starAmbiance = useMemo(() => computeStarDist(rawReviews, 'ambiance_rating'), [rawReviews]);
  const starFood     = useMemo(() => computeStarDist(rawReviews, 'food_rating'),     [rawReviews]);
  const starService  = useMemo(() => computeStarDist(rawReviews, 'service_rating'),  [rawReviews]);
  const dowNps       = useMemo(() => computeDowNps(rawReviews),                      [rawReviews]);

  const filteredComments = useMemo(
    () => commentCat === 'all' ? comments : comments.filter(c => c.nps_category === commentCat),
    [comments, commentCat],
  );

  const filteredDetails = useMemo(() => {
    let list = reviewDetails;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(r => r.reservations?.guest_name?.toLowerCase().includes(q));
    }
    if (detailFilter !== 'all') {
      if (detailFilter === 'pending')  list = list.filter(r => r.status === 'pending');
      else if (detailFilter === 'expired') list = list.filter(r => r.status === 'expired');
      else list = list.filter(r => r.nps_category === detailFilter);
    }
    if (ambFilter     !== 'all') list = list.filter(r => r.ambiance_rating === Number(ambFilter));
    if (foodFilter    !== 'all') list = list.filter(r => r.food_rating     === Number(foodFilter));
    if (serviceFilter !== 'all') list = list.filter(r => r.service_rating  === Number(serviceFilter));
    return list;
  }, [reviewDetails, searchQuery, detailFilter, ambFilter, foodFilter, serviceFilter]);

  const npsDistData = summary ? [
    { name: 'Detratores', value: summary.detractors, fill: CHART_COLORS.detractor },
    { name: 'Neutros',    value: summary.passives,   fill: CHART_COLORS.passive   },
    { name: 'Promotores', value: summary.promoters,  fill: CHART_COLORS.promoter  },
  ] : [];

  const hasData      = summary && summary.total_submitted > 0;
  const npsHighlight: HighlightColor | undefined = summary
    ? (summary.nps_score >= 50 ? 'success' : summary.nps_score >= 0 ? 'warning' : 'destructive')
    : undefined;
  const catCount = (cat: Exclude<CommentCat, 'all'>) => comments.filter(c => c.nps_category === cat).length;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Avaliações</h1>
          <p className="text-sm text-muted-foreground">NPS e satisfação dos clientes pós-visita.</p>
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-full sm:w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {summaryLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-60 w-full rounded-lg" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-48 rounded-lg" />
            <Skeleton className="h-48 rounded-lg" />
          </div>
        </div>
      ) : !hasData ? (
        <EmptyState />
      ) : (
        <>
          {/* ── Compact KPI band (shared between tabs) ── */}
          <Card className="border border-border overflow-hidden">
            <div className="overflow-x-auto scrollbar-none">
              <div className="flex divide-x divide-border min-w-max">
                <KpiCell
                  icon={TrendingUp}
                  title="NPS"
                  value={`${summary!.nps_score > 0 ? '+' : ''}${summary!.nps_score}`}
                  delta={<DeltaBadge current={summary!.nps_score} prev={prevSummary?.nps_score ?? null} unit=" pts" />}
                  highlight={npsHighlight}
                />
                <KpiCell
                  icon={Users}
                  title="Resposta"
                  value={`${summary!.response_rate.toFixed(0)}%`}
                  delta={<DeltaBadge current={summary!.response_rate} prev={prevSummary?.response_rate ?? null} unit="%" />}
                  note={`${summary!.total_submitted} resp · ${summary!.total_pending} pend`}
                />
                <KpiCell
                  icon={Star}
                  title="Ambiente"
                  value={summary!.avg_ambiance !== null ? `${summary!.avg_ambiance.toFixed(1)}/5` : '—'}
                  delta={<DeltaBadge current={summary!.avg_ambiance} prev={prevSummary?.avg_ambiance ?? null} />}
                />
                <KpiCell
                  icon={Star}
                  title="Comida"
                  value={summary!.avg_food !== null ? `${summary!.avg_food.toFixed(1)}/5` : '—'}
                  delta={<DeltaBadge current={summary!.avg_food} prev={prevSummary?.avg_food ?? null} />}
                />
                <KpiCell
                  icon={Heart}
                  title="Atendimento"
                  value={summary!.avg_service !== null ? `${summary!.avg_service.toFixed(1)}/5` : '—'}
                  delta={<DeltaBadge current={summary!.avg_service} prev={prevSummary?.avg_service ?? null} />}
                />
              </div>
            </div>
          </Card>
          <p className="text-xs text-muted-foreground -mt-4">
            Setas indicam variação em relação ao período anterior equivalente.
          </p>

          {/* ── Main tabs ── */}
          <Tabs value={activeTab} onValueChange={v => setActiveTab(v as 'resumo' | 'registros')}>
            <TabsList>
              <TabsTrigger value="resumo">Resumo</TabsTrigger>
              <TabsTrigger value="registros">Registros</TabsTrigger>
            </TabsList>

            {/* ── RESUMO tab ── */}
            <TabsContent value="resumo" className="mt-6 space-y-6">
              {/* Evolution + NPS distribution */}
              <div className="grid gap-6 xl:grid-cols-3">
                <Card className="border border-border xl:col-span-2">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Evolução do NPS</CardTitle>
                    <CardDescription>NPS calculado por semana no período selecionado</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {weeklyNps.length < 2 ? (
                      <p className="text-sm text-muted-foreground py-10 text-center">
                        São necessárias respostas em ao menos 2 semanas para exibir a evolução.
                      </p>
                    ) : (
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={weeklyNps}>
                          <CartesianGrid vertical={false} stroke="rgba(0,0,0,0.06)" />
                          <XAxis dataKey="semana" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                          <YAxis domain={[-100, 100]} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={30} />
                          <ReferenceLine y={0} stroke="rgba(0,0,0,0.2)" strokeDasharray="4 4" />
                          <RechartsTooltip
                            formatter={(val: number, _: string, item: any) => [
                              `${val >= 0 ? '+' : ''}${val} (${item.payload.respostas} resp.)`, 'NPS',
                            ]}
                            contentStyle={{ fontSize: 12, borderRadius: 8 }}
                          />
                          <Line
                            type="monotone"
                            dataKey="nps"
                            stroke={CHART_COLORS.primary}
                            strokeWidth={2.5}
                            dot={{ r: 4, fill: CHART_COLORS.primary, strokeWidth: 0 }}
                            activeDot={{ r: 5 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </CardContent>
                </Card>

                <Card className="border border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Distribuição NPS</CardTitle>
                    <CardDescription>
                      {summary!.promoters} promotores · {summary!.passives} neutros · {summary!.detractors} detratores
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={npsDistData} barSize={40}>
                        <CartesianGrid vertical={false} stroke="rgba(0,0,0,0.06)" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <RechartsTooltip
                          cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                          contentStyle={{ fontSize: 12, borderRadius: 8 }}
                          formatter={(val: number, _: string, item: any) => [val, item.payload.name]}
                        />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {npsDistData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>

              {/* Star distributions */}
              <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                <StarDistCard title="Ambiente"    data={starAmbiance} avg={summary!.avg_ambiance} />
                <StarDistCard title="Comida"      data={starFood}     avg={summary!.avg_food}     />
                <StarDistCard title="Atendimento" data={starService}  avg={summary!.avg_service}  />
              </div>

              {/* NPS por dia da semana */}
              {dowNps.length >= 2 && (
                <Card className="border border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <CalendarDays className="h-4 w-4" />
                      NPS por dia da semana
                    </CardTitle>
                    <CardDescription>Identifique padrões operacionais por dia</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(140, dowNps.length * 36)}>
                      <BarChart data={dowNps} layout="vertical" barSize={18} margin={{ left: 0, right: 8 }}>
                        <CartesianGrid horizontal={false} stroke="rgba(0,0,0,0.06)" />
                        <XAxis type="number" domain={[-100, 100]} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis type="category" dataKey="day" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} width={30} />
                        <ReferenceLine x={0} stroke="rgba(0,0,0,0.2)" strokeDasharray="4 4" />
                        <RechartsTooltip
                          formatter={(val: number, _: string, item: any) => [
                            `${val >= 0 ? '+' : ''}${val} (${item.payload.count} resp.)`, 'NPS',
                          ]}
                          contentStyle={{ fontSize: 12, borderRadius: 8 }}
                        />
                        <Bar dataKey="nps" radius={[0, 4, 4, 0]}>
                          {dowNps.map((entry, i) => (
                            <Cell
                              key={i}
                              fill={entry.nps === null ? 'hsl(var(--muted))' : entry.nps >= 0 ? CHART_COLORS.promoter : CHART_COLORS.detractor}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* Comments with category filter */}
              {!commentsLoading && comments.length > 0 && (
                <Card className="border border-border">
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base flex items-center gap-2">
                          <MessageSquareQuote className="h-4 w-4" />
                          Comentários
                        </CardTitle>
                        <CardDescription>Avaliações anônimas dos clientes</CardDescription>
                      </div>
                      <Tabs value={commentCat} onValueChange={v => setCommentCat(v as CommentCat)}>
                        <TabsList>
                          <TabsTrigger value="all"       className="text-xs">Todos ({comments.length})</TabsTrigger>
                          <TabsTrigger value="promoter"  className="text-xs">Prom. ({catCount('promoter')})</TabsTrigger>
                          <TabsTrigger value="passive"   className="text-xs">Neut. ({catCount('passive')})</TabsTrigger>
                          <TabsTrigger value="detractor" className="text-xs">Detr. ({catCount('detractor')})</TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {filteredComments.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-6 text-center">Nenhum comentário nesta categoria.</p>
                    ) : (
                      <div className="divide-y divide-border">
                        {filteredComments.map(c => (
                          <div key={c.id} className="py-4 space-y-1.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <NpsCategoryBadge category={c.nps_category} />
                              <span className="text-xs text-muted-foreground">
                                Nota {c.recommend_score} · {format(new Date(c.submitted_at), "dd 'de' MMM", { locale: ptBR })}
                              </span>
                            </div>
                            <p className="text-sm leading-relaxed text-foreground">{c.comment}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* ── REGISTROS tab ── */}
            <TabsContent value="registros" className="mt-6">
              <Card className="border border-border">
                <CardHeader className="pb-3">
                  {/* Filters */}
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                        <Input
                          placeholder="Buscar por nome..."
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                          className="pl-9"
                        />
                      </div>
                      <Select value={detailFilter} onValueChange={v => setDetailFilter(v as DetailFilter)}>
                        <SelectTrigger className="w-full sm:w-[200px]">
                          <SelectValue placeholder="Filtrar por..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Todos os registros</SelectItem>
                          <SelectItem value="promoter">Promotores</SelectItem>
                          <SelectItem value="passive">Neutros</SelectItem>
                          <SelectItem value="detractor">Detratores</SelectItem>
                          <SelectItem value="pending">Aguardando resposta</SelectItem>
                          <SelectItem value="expired">Expirados</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Rating filters */}
                    <div className="flex flex-wrap gap-2">
                      {([
                        { label: 'Ambiente',    value: ambFilter,     set: setAmbFilter     },
                        { label: 'Comida',      value: foodFilter,    set: setFoodFilter    },
                        { label: 'Atendimento', value: serviceFilter, set: setServiceFilter },
                      ] as const).map(f => (
                        <Select key={f.label} value={f.value} onValueChange={f.set}>
                          <SelectTrigger className="h-8 w-auto gap-1.5 text-xs border-dashed">
                            <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />
                            <span className="text-muted-foreground">{f.label}:</span>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Qualquer nota</SelectItem>
                            {[1, 2, 3, 4, 5].map(n => (
                              <SelectItem key={n} value={String(n)}>{'★'.repeat(n)}{'☆'.repeat(5 - n)} — {n}/5</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ))}
                      {(ambFilter !== 'all' || foodFilter !== 'all' || serviceFilter !== 'all') && (
                        <button
                          onClick={() => { setAmbFilter('all'); setFoodFilter('all'); setServiceFilter('all'); }}
                          className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Limpar notas
                        </button>
                      )}
                    </div>
                  </div>
                  {filteredDetails.length > 0 && (
                    <p className="text-xs text-muted-foreground pt-1">
                      {filteredDetails.length} registro{filteredDetails.length !== 1 ? 's' : ''} encontrado{filteredDetails.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="pt-0">
                  {detailsLoading ? (
                    <div className="space-y-3 py-4">
                      {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
                    </div>
                  ) : filteredDetails.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-10 text-center">
                      {searchQuery || detailFilter !== 'all'
                        ? 'Nenhum registro encontrado para este filtro.'
                        : 'Nenhum convite enviado neste período.'}
                    </p>
                  ) : (
                    <div className="divide-y divide-border">
                      {filteredDetails.map(r => (
                        <ReviewDetailCard key={r.id} review={r} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
