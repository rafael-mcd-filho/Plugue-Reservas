import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { FunnelPresentationState } from '@/hooks/useFunnelData';
import { FUNNEL_STEPS, STEP_LABELS, type FunnelStep } from '@/hooks/useFunnelTracking';

interface FunnelData {
  step: FunnelStep;
  count: number;
}

interface ReservationFunnelChartProps {
  data: FunnelData[];
  title?: string;
  description?: string;
  headerActions?: ReactNode;
  measurementLabel?: string;
  state?: FunnelPresentationState;
  errorMessage?: string;
  onRetry?: () => void;
  isShowingPreviousData?: boolean;
  previousDataLabel?: string;
}

const FUNNEL_COLORS = [
  'hsl(28, 85%, 55%)',
  'hsl(28, 90%, 27%)',
  'hsl(38, 80%, 55%)',
  'hsl(0, 0%, 25%)',
  'hsl(0, 0%, 50%)',
];

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => (
    typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updatePreference);
      return () => mediaQuery.removeEventListener('change', updatePreference);
    }

    mediaQuery.addListener(updatePreference);
    return () => mediaQuery.removeListener(updatePreference);
  }, []);

  return prefersReducedMotion;
}

function FunnelLoadingState() {
  return (
    <div
      className="space-y-5 py-5"
      role="status"
      aria-live="polite"
      aria-label="Carregando dados do funil de reservas"
    >
      <span className="sr-only">Carregando dados do funil de reservas.</span>
      {FUNNEL_STEPS.map((step, index) => (
        <div key={step} className="grid grid-cols-[7.5rem_1fr] items-center gap-4 sm:grid-cols-[9rem_1fr]">
          <div className="h-3 rounded-full bg-muted motion-safe:animate-pulse motion-reduce:animate-none" />
          <div
            className="h-7 rounded-r-md bg-muted motion-safe:animate-pulse motion-reduce:animate-none"
            style={{ width: `${Math.max(34, 94 - index * 13)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function FunnelMessageState({
  kind,
  message,
  onRetry,
}: {
  kind: 'error' | 'empty';
  message?: string;
  onRetry?: () => void;
}) {
  const isError = kind === 'error';

  return (
    <div
      className="flex min-h-[250px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/10 px-6 py-10 text-center"
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      <div className={isError
        ? 'mb-4 rounded-full bg-destructive/10 p-3 text-destructive'
        : 'mb-4 rounded-full bg-primary/10 p-3 text-primary'}
      >
        {isError ? <AlertTriangle className="h-5 w-5" /> : <BarChart3 className="h-5 w-5" />}
      </div>
      <p className="font-medium text-foreground">
        {isError ? 'Não foi possível carregar o funil' : 'Nenhuma jornada pública no período'}
      </p>
      <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted-foreground">
        {message ?? (isError
          ? 'Tente atualizar os dados novamente.'
          : 'Não houve navegação pública registrada nas datas selecionadas. Reservas criadas no painel ou convertidas da fila não entram neste funil.')}
      </p>
      {isError && onRetry && (
        <Button type="button" variant="outline" size="sm" className="mt-5 gap-2" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

export default function ReservationFunnelChart({
  data,
  title = 'Funil de Reservas',
  description = 'Conversão por etapa do processo de reserva',
  headerActions,
  measurementLabel = 'Sessões',
  state = 'ready',
  errorMessage,
  onRetry,
  isShowingPreviousData = false,
  previousDataLabel,
}: ReservationFunnelChartProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const normalizedMeasurementLabel = measurementLabel.toLowerCase();
  const chartData = useMemo(() => {
    const firstCount = data.find((item) => item.step === 'page_view')?.count ?? 0;
    return FUNNEL_STEPS.map((step, index) => {
      const found = data.find((item) => item.step === step);
      const count = found?.count ?? 0;
      const rate = firstCount > 0 ? Math.round((count / firstCount) * 100) : 0;

      return {
        step: STEP_LABELS[step],
        count,
        rate,
        fill: FUNNEL_COLORS[index],
      };
    });
  }, [data]);

  const overallConversion = chartData[0].count > 0
    ? ((chartData[chartData.length - 1].count / chartData[0].count) * 100).toFixed(1).replace('.', ',')
    : '0';

  const showChart = state === 'ready' || state === 'refreshing' || state === 'stale-error';

  return (
    <Card
      className="min-w-0 border border-border shadow-sm"
      aria-busy={state === 'loading' || state === 'refreshing'}
    >
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-1.5">
                <span>{title}</span>
                <InfoTooltip
                  content={`Mostra a quantidade de ${normalizedMeasurementLabel} que avançou em cada etapa da reserva pública, considerando a data da navegação. Reservas criadas no painel ou vindas da fila não entram neste funil.`}
                  ariaLabel={`Entender o gráfico ${title}`}
                />
              </span>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {headerActions}
        </div>
      </CardHeader>
      <CardContent className="min-w-0 pb-5 sm:pb-4">
        {state === 'loading' && <FunnelLoadingState />}
        {state === 'error' && (
          <FunnelMessageState kind="error" message={errorMessage} onRetry={onRetry} />
        )}
        {state === 'valid-empty' && <FunnelMessageState kind="empty" />}

        {showChart && (
          <>
            {state === 'refreshing' && (
              <div
                className="mb-3 flex items-center gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-primary"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span>
                  {isShowingPreviousData
                    ? `Atualizando o período selecionado. Exibindo temporariamente os dados de ${previousDataLabel ?? 'outro período'}.`
                    : 'Atualizando os dados do funil…'}
                </span>
              </div>
            )}

            {state === 'stale-error' && (
              <div
                className="mb-3 flex flex-col gap-3 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
                role="alert"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {errorMessage ?? 'A atualização falhou. Os últimos dados válidos continuam visíveis.'}
                  </span>
                </div>
                {onRetry && (
                  <Button type="button" variant="outline" size="sm" className="shrink-0 gap-2" onClick={onRetry}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Tentar novamente
                  </Button>
                )}
              </div>
            )}

            <div
              className="h-[280px] sm:h-[300px]"
              role="img"
              aria-label={`${title}. ${chartData.map((item) => `${item.step}: ${item.count}`).join('; ')}. Conversão geral: ${overallConversion}%.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(30, 15%, 88%)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 12 }} stroke="hsl(20, 10%, 48%)" />
                  <YAxis
                    type="category"
                    dataKey="step"
                    tick={{ fontSize: 12 }}
                    stroke="hsl(20, 10%, 48%)"
                    width={130}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(30, 20%, 99%)',
                      border: '1px solid hsl(30, 15%, 88%)',
                      borderRadius: '0.5rem',
                      fontSize: '0.875rem',
                    }}
                    formatter={(value: number, _name: string, props: { payload: { rate: number } }) => [
                      `${value} ${normalizedMeasurementLabel} (${props.payload.rate}%)`,
                      measurementLabel,
                    ]}
                  />
                  <Bar
                    dataKey="count"
                    name={measurementLabel}
                    radius={[0, 4, 4, 0]}
                    isAnimationActive={!prefersReducedMotion && state === 'ready'}
                  >
                    {chartData.map((entry) => (
                      <Cell key={entry.step} fill={entry.fill} />
                    ))}
                    <LabelList
                      dataKey="rate"
                      position="right"
                      formatter={(value: number) => `${value}%`}
                      style={{ fontSize: 12, fill: 'hsl(20, 10%, 48%)' }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <p className="mt-3 pb-1 text-center text-sm text-muted-foreground">
              Taxa de conversão geral: <span className="font-semibold text-foreground">{overallConversion}%</span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
