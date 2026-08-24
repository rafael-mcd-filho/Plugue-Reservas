import { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  BadgeCheck,
  GitCompareArrows,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getAdsAttributionComparisonTotals,
  type AdsAttributionComparisonPoint,
  useAdsAttributionComparison,
} from '@/hooks/useAdsAttributionComparison';
import { cn } from '@/lib/utils';

const LEGACY_COLOR = 'hsl(28, 85%, 55%)';
const JOURNEY_COLOR = 'hsl(172, 66%, 36%)';
const DELTA_COLOR = 'hsl(215, 28%, 24%)';

function formatCount(value: number) {
  return value.toLocaleString('pt-BR');
}

function formatSignedCount(value: number) {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${formatCount(value)}`;
}

function Metric({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'legacy' | 'journey' | 'positive' | 'negative' | 'neutral';
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-background px-4 py-3.5">
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          tone === 'legacy' && 'bg-[hsl(28,85%,55%)]',
          tone === 'journey' && 'bg-[hsl(172,66%,36%)]',
          tone === 'positive' && 'bg-emerald-500',
          tone === 'negative' && 'bg-rose-500',
          tone === 'neutral' && 'bg-muted-foreground/30',
        )}
        aria-hidden="true"
      />
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function ComparisonTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: AdsAttributionComparisonPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="min-w-[240px] rounded-xl border border-border bg-background/95 p-3.5 shadow-xl backdrop-blur-sm">
      <div className="border-b border-border/70 pb-2">
        <p className="text-sm font-semibold text-foreground">{point.label}</p>
        <p className="text-xs text-muted-foreground">
          {formatCount(point.totalReservations)} reservas na data
        </p>
      </div>
      <div className="mt-2.5 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-5">
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LEGACY_COLOR }} />
            Método atual
          </span>
          <strong className="tabular-nums text-foreground">{formatCount(point.legacyAds)}</strong>
        </div>
        <div className="flex items-center justify-between gap-5">
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: JOURNEY_COLOR }} />
            Jornada V2
          </span>
          <strong className="tabular-nums text-foreground">{formatCount(point.journeyAds)}</strong>
        </div>
        <div className="flex items-center justify-between gap-5 border-t border-border/70 pt-2">
          <span className="text-muted-foreground">Diferença</span>
          <strong className={cn(
            'tabular-nums',
            point.delta > 0 && 'text-emerald-600',
            point.delta < 0 && 'text-rose-600',
            point.delta === 0 && 'text-foreground',
          )}>
            {formatSignedCount(point.delta)}
          </strong>
        </div>
        <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
          {formatCount(point.bothAds)} em ambos · {formatCount(point.legacyOnlyAds)} somente atual ·{' '}
          {formatCount(point.journeyOnlyAds)} somente V2
        </p>
      </div>
    </div>
  );
}

export default function AdsAttributionShadowComparison({
  companyId,
  startDate,
  endDate,
}: {
  companyId: string | undefined;
  startDate: Date;
  endDate: Date;
}) {
  const comparisonQuery = useAdsAttributionComparison(companyId, startDate, endDate, true);
  const points = useMemo(() => comparisonQuery.data ?? [], [comparisonQuery.data]);
  const totals = useMemo(() => getAdsAttributionComparisonTotals(points), [points]);
  const hasEvaluatedData = totals.evaluatedReservations > 0;
  const deltaTone = totals.delta > 0 ? 'positive' : totals.delta < 0 ? 'negative' : 'neutral';

  return (
    <Card className="overflow-hidden border border-border shadow-sm">
      <CardHeader className="border-b border-border/70 bg-gradient-to-r from-muted/45 via-background to-emerald-50/40 pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <GitCompareArrows className="h-4 w-4 text-emerald-600" />
                Ads: método atual × jornada
              </CardTitle>
              <Badge variant="outline" className="gap-1 border-emerald-600/30 bg-emerald-50 text-emerald-800">
                <Activity className="h-3 w-3" />
                Modo sombra
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <ShieldCheck className="h-3 w-3" />
                Somente superadmin
              </Badge>
            </div>
            <CardDescription className="mt-1.5 max-w-3xl leading-relaxed">
              Compara diariamente o classificador atual com a memória de Ads de 30 dias.
              A visão das empresas continua usando exclusivamente o método atual.
            </CardDescription>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/75 px-3 py-2 text-xs text-muted-foreground">
            Agrupado pela data da reserva
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-5">
        {comparisonQuery.isLoading ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-[104px] animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
            <div className="h-[320px] animate-pulse rounded-xl bg-muted" />
          </div>
        ) : comparisonQuery.isError && points.length === 0 ? (
          <div className="flex gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">Não foi possível carregar o comparativo</p>
              <p className="mt-1 text-xs leading-relaxed text-rose-800/80">
                A migration/RPC pode ainda não estar aplicada, ou o período pode exceder 367 dias.
                O Dashboard atual permanece funcionando normalmente.
              </p>
            </div>
          </div>
        ) : !hasEvaluatedData ? (
          <div className="grid gap-4 rounded-xl border border-dashed border-emerald-700/30 bg-emerald-50/45 p-5 lg:grid-cols-[auto_1fr] lg:items-center">
            <div className="rounded-full bg-background p-3 text-emerald-700 shadow-sm">
              <BadgeCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Modo sombra pronto, aguardando dados V2</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {totals.totalReservations === 0
                  ? 'Não existem reservas no período selecionado. '
                  : `Existem ${formatCount(totals.eligibleReservations)} reservas elegíveis e ${formatCount(totals.insufficientData)} ainda sem avaliação V2. `}
                Depois que a coleta for habilitada para uma empresa, somente as novas reservas serão
                avaliadas. Reservas anteriores não são tratadas como orgânicas.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="Ads pelo método atual"
                value={formatCount(totals.legacyAds)}
                detail="Regra atual aplicada à mesma base avaliada"
                tone="legacy"
              />
              <Metric
                label="Ads pela jornada V2"
                value={formatCount(totals.journeyAds)}
                detail="Paid ou pr_ad em uma cadeia ativa de 30 dias"
                tone="journey"
              />
              <Metric
                label="Diferença líquida"
                value={formatSignedCount(totals.delta)}
                detail={`${formatCount(totals.bothAds)} reservas reconhecidas pelos dois métodos`}
                tone={deltaTone}
              />
              <Metric
                label="Cobertura da V2"
                value={`${totals.coveragePercentage.toLocaleString('pt-BR', {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                })}%`}
                detail={`${formatCount(totals.evaluatedReservations)} de ${formatCount(totals.eligibleReservations)} elegíveis`}
              />
            </div>

            <div className="rounded-xl border border-border bg-background p-3 sm:p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Comparação diária</p>
                  <p className="text-xs text-muted-foreground">
                    Barras agrupadas mostram Ads por método; a linha mostra a diferença V2 − atual.
                  </p>
                </div>
                {totals.insufficientData > 0 && (
                  <Badge variant="outline" className="border-amber-500/30 bg-amber-50 text-amber-800">
                    {formatCount(totals.insufficientData)} sem dados suficientes
                  </Badge>
                )}
              </div>

              <div className="h-[340px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={points} barGap={2} maxBarSize={30}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 12 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" />
                    <RechartsTooltip content={<ComparisonTooltip />} />
                    <Legend />
                    <Bar
                      dataKey="legacyAds"
                      name="Ads — método atual"
                      fill={LEGACY_COLOR}
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="journeyAds"
                      name="Ads — jornada V2"
                      fill={JOURNEY_COLOR}
                      radius={[4, 4, 0, 0]}
                    />
                    <Line
                      type="monotone"
                      dataKey="delta"
                      name="Diferença V2 − atual"
                      stroke={DELTA_COLOR}
                      strokeWidth={2}
                      dot={{ r: 2.5, fill: DELTA_COLOR }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid gap-2 text-xs sm:grid-cols-3">
              <div className="rounded-lg bg-muted/45 px-3 py-2.5 text-muted-foreground">
                <strong className="text-foreground">{formatCount(totals.bothAds)}</strong> reconhecidas pelos dois
              </div>
              <div className="rounded-lg bg-orange-50 px-3 py-2.5 text-orange-900">
                <strong>{formatCount(totals.legacyOnlyAds)}</strong> somente no método atual
              </div>
              <div className="rounded-lg bg-emerald-50 px-3 py-2.5 text-emerald-900">
                <strong>{formatCount(totals.journeyOnlyAds)}</strong> recuperadas somente pela jornada
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
