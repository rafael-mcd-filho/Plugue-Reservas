import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
} from 'recharts';
import {
  MessageSquareQuote,
  Star,
  ThumbsUp,
  TrendingUp,
  Users,
} from 'lucide-react';
import { format, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
  muted: 'hsl(var(--muted-foreground))',
};

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
  avg_return: number | null;
}

interface ReviewComment {
  id: string;
  submitted_at: string;
  recommend_score: number;
  nps_category: 'promoter' | 'passive' | 'detractor';
  comment: string;
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  highlight,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: typeof Star;
  highlight?: 'success' | 'warning' | 'destructive';
}) {
  const colorMap = {
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
  };

  return (
    <Card className="border border-border">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className={`text-2xl font-bold ${highlight ? colorMap[highlight] : 'text-foreground'}`}>
              {value}
            </p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <div className="rounded-lg bg-muted/50 p-2 shrink-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function NpsCategoryBadge({ category }: { category: 'promoter' | 'passive' | 'detractor' }) {
  const map = {
    promoter: { label: 'Promotor', className: 'bg-success/10 text-success border-success/20' },
    passive: { label: 'Neutro', className: 'bg-warning/10 text-warning border-warning/20' },
    detractor: { label: 'Detrator', className: 'bg-destructive/10 text-destructive border-destructive/20' },
  };
  const { label, className } = map[category];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function StarDisplay({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex items-center gap-1">
      <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
      <span className="font-semibold">{value.toFixed(1)}</span>
      <span className="text-xs text-muted-foreground">/5</span>
    </span>
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

export default function CompanyNpsReports() {
  const { companyId } = useMaybeCompanySlug() ?? {};
  const [period, setPeriod] = useState('30');

  const fromDate = format(subDays(new Date(), Number(period)), 'yyyy-MM-dd');
  const toDate = format(new Date(), 'yyyy-MM-dd');

  const { data: summary, isLoading: summaryLoading } = useQuery<NpsSummary | null>({
    queryKey: ['nps-summary', companyId, fromDate, toDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_company_nps_summary', {
        _company_id: companyId!,
        _from: fromDate,
        _to: toDate,
      });
      if (error) throw error;
      const rows = data as NpsSummary[];
      return rows.length > 0 ? rows[0] : null;
    },
    enabled: !!companyId,
  });

  const { data: comments, isLoading: commentsLoading } = useQuery<ReviewComment[]>({
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
        .limit(50);
      if (error) throw error;
      return (data ?? []) as ReviewComment[];
    },
    enabled: !!companyId,
  });

  const npsDistributionData = summary
    ? [
        { name: 'Detratores', value: summary.detractors, fill: CHART_COLORS.detractor },
        { name: 'Neutros', value: summary.passives, fill: CHART_COLORS.passive },
        { name: 'Promotores', value: summary.promoters, fill: CHART_COLORS.promoter },
      ]
    : [];

  const hasData = summary && summary.total_submitted > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Avaliações</h1>
          <p className="text-sm text-muted-foreground">
            NPS e satisfação dos clientes pós-visita.
          </p>
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {summaryLoading ? (
        <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : !hasData ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
            <StatCard
              title="NPS"
              value={`${summary!.nps_score > 0 ? '+' : ''}${summary!.nps_score}`}
              subtitle={`${summary!.promoters}P · ${summary!.passives}N · ${summary!.detractors}D`}
              icon={TrendingUp}
              highlight={summary!.nps_score >= 50 ? 'success' : summary!.nps_score >= 0 ? 'warning' : 'destructive'}
            />
            <StatCard
              title="Taxa de resposta"
              value={`${summary!.response_rate.toFixed(0)}%`}
              subtitle={`Responderam: ${summary!.total_submitted} · Aguardando: ${summary!.total_pending} · Expiraram: ${summary!.total_expired}`}
              icon={Users}
            />
            <StatCard
              title="Ambiente"
              value={summary!.avg_ambiance !== null ? `${summary!.avg_ambiance.toFixed(1)}/5` : '—'}
              subtitle="Média de estrelas"
              icon={Star}
            />
            <StatCard
              title="Comida"
              value={summary!.avg_food !== null ? `${summary!.avg_food.toFixed(1)}/5` : '—'}
              subtitle="Média de estrelas"
              icon={Star}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="border border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Distribuição NPS</CardTitle>
                <CardDescription>Detratores, neutros e promotores</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={npsDistributionData} barSize={40}>
                    <CartesianGrid vertical={false} stroke="rgba(0,0,0,0.06)" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <RechartsTooltip
                      cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {npsDistributionData.map((entry, index) => (
                        <Cell key={index} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="border border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Satisfação média</CardTitle>
                <CardDescription>Notas médias por critério</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4 pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Ambiente</span>
                    <StarDisplay value={summary!.avg_ambiance} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Comida</span>
                    <StarDisplay value={summary!.avg_food} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Chance de voltar</span>
                    <span className="flex items-center gap-1">
                      {summary!.avg_return !== null ? (
                        <>
                          <span className="font-semibold">{summary!.avg_return.toFixed(1)}</span>
                          <span className="text-xs text-muted-foreground">/10</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t border-border pt-4">
                    <span className="text-sm font-medium">NPS (indicaria um amigo)</span>
                    <span className="flex items-center gap-1">
                      <span className={`font-bold text-lg ${summary!.nps_score >= 50 ? 'text-success' : summary!.nps_score >= 0 ? 'text-warning' : 'text-destructive'}`}>
                        {summary!.nps_score > 0 ? '+' : ''}{summary!.nps_score}
                      </span>
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {commentsLoading ? (
            <Skeleton className="h-40 w-full rounded-lg" />
          ) : comments && comments.length > 0 ? (
            <Card className="border border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquareQuote className="h-4 w-4" />
                  Comentários
                </CardTitle>
                <CardDescription>Avaliações anônimas dos clientes</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-border">
                  {comments.map((c) => (
                    <div key={c.id} className="py-4 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <NpsCategoryBadge category={c.nps_category} />
                        <span className="text-xs text-muted-foreground">
                          Nota {c.recommend_score} ·{' '}
                          {format(new Date(c.submitted_at), "dd 'de' MMM", { locale: ptBR })}
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed text-foreground">{c.comment}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
