import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { FunnelAdsDebugData } from '@/hooks/useFunnelData';
import { FUNNEL_STEPS, STEP_LABELS, type FunnelStep } from '@/hooks/useFunnelTracking';

interface FunnelData {
  step: FunnelStep;
  count: number;
}

interface ReservationFunnelChartProps {
  data: FunnelData[];
  adsDebug?: FunnelAdsDebugData | null;
  title?: string;
  description?: string;
  headerActions?: ReactNode;
  measurementLabel?: string;
}

const FUNNEL_COLORS = [
  'hsl(28, 85%, 55%)',
  'hsl(28, 90%, 27%)',
  'hsl(38, 80%, 55%)',
  'hsl(0, 0%, 25%)',
  'hsl(0, 0%, 50%)',
];

function formatMatchedViaLabel(value: 'tracking_session' | 'reservation_snapshot') {
  return value === 'tracking_session' ? 'Via sessao' : 'Via snapshot da reserva';
}

function formatDebugDate(value: string | null) {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('pt-BR');
}

export default function ReservationFunnelChart({
  data,
  adsDebug = null,
  title = 'Funil de Reservas',
  description = 'Conversao por etapa do processo de reserva',
  headerActions,
  measurementLabel = 'Sessoes',
}: ReservationFunnelChartProps) {
  const [showAdsDebug, setShowAdsDebug] = useState(false);

  const chartData = useMemo(() => {
    return FUNNEL_STEPS.map((step, index) => {
      const found = data.find((item) => item.step === step);
      const count = found?.count ?? 0;
      const firstCount = data.find((item) => item.step === 'page_view')?.count ?? 1;
      const rate = firstCount > 0 ? Math.round((count / firstCount) * 100) : 0;

      return {
        step: STEP_LABELS[step],
        count,
        rate,
        fill: FUNNEL_COLORS[index],
      };
    });
  }, [data]);

  useEffect(() => {
    if (!adsDebug) {
      setShowAdsDebug(false);
    }
  }, [adsDebug]);

  const overallConversion = chartData[0].count > 0
    ? ((chartData[chartData.length - 1].count / chartData[0].count) * 100).toFixed(1)
    : '0';
  const completedStepCount = chartData[chartData.length - 1]?.count ?? 0;
  const visibleCompletedRows = adsDebug?.completedRows.slice(0, 12) ?? [];
  const hiddenCompletedRowsCount = Math.max((adsDebug?.completedRows.length ?? 0) - visibleCompletedRows.length, 0);

  return (
    <Card className="min-w-0 border border-border shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-1.5">
                <span>{title}</span>
                <InfoTooltip
                  content={`Mostra quantas ${measurementLabel.toLowerCase()} avancaram em cada etapa do processo de reserva online.`}
                  ariaLabel={`Entender o grafico ${title}`}
                />
              </span>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {headerActions}
        </div>
      </CardHeader>
      <CardContent className="min-w-0 pb-5 sm:pb-4">
        <div className="h-[280px] sm:h-[300px]">
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
                  `${value} ${measurementLabel.toLowerCase()} (${props.payload.rate}%)`,
                  measurementLabel,
                ]}
              />
              <Bar dataKey="count" name={measurementLabel} radius={[0, 4, 4, 0]}>
                {chartData.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
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
          Taxa de conversao geral: <span className="font-semibold text-foreground">{overallConversion}%</span>
        </p>

        {adsDebug && (
          <div className="mt-4 rounded-2xl border border-amber-200/70 bg-amber-50/55 p-4 text-sm shadow-sm dark:border-amber-800/60 dark:bg-amber-950/15">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p className="font-medium text-foreground">Debug da origem Ads</p>
                <p className="text-xs text-muted-foreground">
                  O funil considera Ads pela sessao de tracking e, quando nao existe sessao no evento, pelo snapshot salvo na reserva.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setShowAdsDebug((current) => !current)}
              >
                {showAdsDebug ? 'Ocultar debug Ads' : 'Mostrar debug Ads'}
              </Button>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-border/70 bg-background/85 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Sessoes Ads</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{adsDebug.adsSessions.length}</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/85 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Reservas Ads</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{adsDebug.adsReservations.length}</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/85 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Eventos filtrados</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{adsDebug.matchedRowCount}</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/85 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Conversoes no grafico</p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {completedStepCount} {measurementLabel.toLowerCase()}
                </p>
              </div>
            </div>

            {showAdsDebug && (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Reservas finalizadas contadas como Ads
                  </p>
                  {visibleCompletedRows.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Nenhuma conversao final foi encontrada com a regra atual de Ads para este periodo.
                    </p>
                  ) : (
                    <div className="mt-2 grid gap-3">
                      {visibleCompletedRows.map((entry) => (
                        <div
                          key={`${entry.reservation_id ?? 'no-reservation'}-${entry.session_id ?? 'no-session'}-${entry.anonymous_id}`}
                          className="rounded-xl border border-border/70 bg-background/90 p-3"
                        >
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                              {formatMatchedViaLabel(entry.matched_via)}
                            </span>
                            <span className="text-muted-foreground">{entry.event_name}</span>
                            {entry.occurred_at && (
                              <span className="text-muted-foreground">{formatDebugDate(entry.occurred_at)}</span>
                            )}
                          </div>

                          <div className="mt-3 grid gap-2 md:grid-cols-2">
                            <div>
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Reservation ID</p>
                              <p className="mt-1 break-all font-mono text-xs text-foreground">{entry.reservation_id ?? 'sem reservation_id'}</p>
                            </div>
                            <div>
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Session ID</p>
                              <p className="mt-1 break-all font-mono text-xs text-foreground">{entry.session_id ?? 'sem session_id'}</p>
                            </div>
                            <div>
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Anonymous ID</p>
                              <p className="mt-1 break-all font-mono text-xs text-foreground">{entry.anonymous_id}</p>
                            </div>
                            <div>
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">UTM medium observado</p>
                              <p className="mt-1 text-xs text-foreground">
                                {entry.matched_via === 'tracking_session'
                                  ? entry.session_utm_medium ?? 'vazio'
                                  : entry.reservation_utm_medium ?? 'vazio'}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {hiddenCompletedRowsCount > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Mostrando 12 de {adsDebug.completedRows.length} conversoes finais encontradas.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
