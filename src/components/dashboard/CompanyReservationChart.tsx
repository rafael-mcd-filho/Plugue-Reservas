import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllSupabasePages } from '@/lib/supabase-pagination';
import { buildCompanyReservationSeries, type CompanyReservationFact } from '@/lib/company-reservation-series';
import type { ReportGranularity } from '@/lib/report-filters';

interface Props {
  companies: Array<{ id: string; name: string }>;
  startDate: Date;
  endDate: Date;
  companiesLoading: boolean;
  companiesError: boolean;
  onRetryCompanies: () => void;
}

const COLORS = ['#bf8039', '#297aab', '#37826c', '#ba5368', '#7663a8', '#91733a', '#467c91', '#af6248'];

export default function CompanyReservationChart({ companies, startDate, endDate, companiesLoading, companiesError, onRetryCompanies }: Props) {
  const [granularity, setGranularity] = useState<ReportGranularity>('day');
  const [metric, setMetric] = useState<'reservations' | 'people'>('reservations');
  const start = format(startDate, 'yyyy-MM-dd');
  const end = format(endDate, 'yyyy-MM-dd');
  const ids = companies.map((company) => company.id);
  const query = useQuery({
    queryKey: ['superadmin-company-reservations', ids, start, end],
    queryFn: () => fetchAllSupabasePages<CompanyReservationFact>((from, to) => supabase
      .from('reservations')
      .select('id, company_id, date, status, party_size')
      .in('company_id', ids)
      .gte('date', start).lte('date', end)
      .order('date').order('id').range(from, to)),
    enabled: ids.length > 0 && !companiesLoading && !companiesError,
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const data = useMemo(() => buildCompanyReservationSeries(companies, query.data ?? [], start, end, granularity, metric),
    [companies, query.data, start, end, granularity, metric]);
  const label = (period: string) => granularity === 'month'
    ? format(parseISO(period), 'MMM/yy', { locale: ptBR })
    : `${granularity === 'week' ? 'Semana de ' : ''}${format(parseISO(period), 'dd/MM/yy')}`;
  const loading = companiesLoading || (ids.length > 0 && query.isPending);
  const hasData = data.some((point) => Object.values(point.values).some((value) => value > 0));

  return <Card className="border border-border shadow-sm">
    <CardHeader className="gap-3 pb-3">
      <div>
        <CardTitle className="text-base">Reservas por empresa</CardTitle>
        <CardDescription className="mt-1">Uma linha por empresa ativa, pela data da visita. Inclui reservas confirmadas e com check-in.</CardDescription>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Granularidade das reservas por empresa">
          {([{ key: 'day', label: 'Diário' }, { key: 'week', label: 'Semanal' }, { key: 'month', label: 'Mensal' }] as const).map((option) =>
            <Button key={option.key} size="sm" variant={granularity === option.key ? 'default' : 'outline'}
              aria-pressed={granularity === option.key} onClick={() => setGranularity(option.key)}>{option.label}</Button>)}
        </div>
        <div className="flex gap-1" role="group" aria-label="Métrica das reservas por empresa">
          {(['reservations', 'people'] as const).map((option) => <Button key={option} size="sm"
            variant={metric === option ? 'secondary' : 'ghost'} aria-pressed={metric === option}
            onClick={() => setMetric(option)}>{option === 'people' ? 'Pessoas' : 'Reservas'}</Button>)}
        </div>
      </div>
    </CardHeader>
    <CardContent>
      {companiesError || query.isError ? <div role="alert" className="flex min-h-[200px] flex-col items-center justify-center gap-3">
        <p className="text-sm">Não foi possível carregar as reservas por empresa.</p>
        <Button variant="outline" onClick={() => companiesError ? onRetryCompanies() : void query.refetch()}>Tentar novamente</Button>
      </div> : loading ? <div role="status" aria-label="Carregando reservas por empresa" className="h-[320px] animate-pulse rounded-lg bg-muted/40 motion-reduce:animate-none" />
        : !hasData ? <p role="status" className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">Nenhuma reserva ativa nas empresas selecionadas neste período.</p>
          : <>
            <div className="h-[340px]" aria-label="Evolução das reservas por empresa">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} accessibilityLayer margin={{ top: 8, right: 16, bottom: 8, left: -12 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="period" tickFormatter={label} minTickGap={32} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip itemSorter={(item) => -Number(item.value ?? 0)} labelFormatter={(value) => label(String(value))} formatter={(value: number, name: string) => [value.toLocaleString('pt-BR'), name]}
                    contentStyle={{ borderRadius: 12, background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  {companies.map((company, index) => <Line key={company.id} name={company.name}
                    dataKey={(point) => point.values[company.id]} type="linear" stroke={COLORS[index % COLORS.length]}
                    strokeDasharray={index >= COLORS.length ? '6 3' : undefined} strokeWidth={2}
                    dot={data.length <= 31 ? { r: 2 } : false} activeDot={{ r: 5 }} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <table className="sr-only">
              <caption>{metric === 'people' ? 'Pessoas' : 'Reservas'} por empresa e período</caption>
              <thead><tr><th scope="col">Período</th>{companies.map((company) => <th key={company.id} scope="col">{company.name}</th>)}</tr></thead>
              <tbody>{data.map((point) => <tr key={point.period}><th scope="row">{label(point.period)}</th>
                {companies.map((company) => <td key={company.id}>{point.values[company.id]}</td>)}</tr>)}</tbody>
            </table>
          </>}
    </CardContent>
  </Card>;
}
