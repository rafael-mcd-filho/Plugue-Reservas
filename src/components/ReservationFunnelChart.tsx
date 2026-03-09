import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { FUNNEL_STEPS, STEP_LABELS, type FunnelStep } from '@/hooks/useFunnelTracking';

interface FunnelData {
  step: FunnelStep;
  count: number;
}

interface ReservationFunnelChartProps {
  data: FunnelData[];
  title?: string;
  description?: string;
}

const FUNNEL_COLORS = [
  'hsl(28, 85%, 55%)',
  'hsl(28, 90%, 27%)',
  'hsl(38, 80%, 55%)',
  'hsl(0, 0%, 25%)',
  'hsl(0, 0%, 50%)',
];

export default function ReservationFunnelChart({
  data,
  title = 'Funil de Reservas',
  description = 'Conversão por etapa do processo de reserva',
}: ReservationFunnelChartProps) {
  const chartData = useMemo(() => {
    return FUNNEL_STEPS.map((step, i) => {
      const found = data.find(d => d.step === step);
      const count = found?.count ?? 0;
      const firstCount = data.find(d => d.step === 'page_view')?.count ?? 1;
      const rate = firstCount > 0 ? Math.round((count / firstCount) * 100) : 0;
      return {
        step: STEP_LABELS[step],
        count,
        rate,
        fill: FUNNEL_COLORS[i],
      };
    });
  }, [data]);

  const overallConversion = chartData[0].count > 0
    ? ((chartData[chartData.length - 1].count / chartData[0].count) * 100).toFixed(1)
    : '0';

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
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
                formatter={(value: number, _name: string, props: any) =>
                  [`${value} visitantes (${props.payload.rate}%)`, 'Visitantes']
                }
              />
              <Bar dataKey="count" name="Visitantes" radius={[0, 4, 4, 0]}>
                {chartData.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
                ))}
                <LabelList dataKey="rate" position="right" formatter={(v: number) => `${v}%`} style={{ fontSize: 12, fill: 'hsl(20, 10%, 48%)' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-center text-sm text-muted-foreground mt-2">
          Taxa de conversão geral: <span className="font-semibold text-foreground">{overallConversion}%</span>
        </p>
      </CardContent>
    </Card>
  );
}
