import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { subDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from 'recharts';
import {
  CalendarCheck, Users, Clock, TrendingUp, XCircle, UserX, CalendarIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { getMockDashboardData, getMockCompanies, type DailyStats } from '@/data/dashboardMock';
import { supabase } from '@/integrations/supabase/client';
import { useFunnelData } from '@/hooks/useFunnelData';
import ReservationFunnelChart from '@/components/ReservationFunnelChart';

const PERIOD_OPTIONS = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '15', label: 'Últimos 15 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 3 meses' },
  { value: 'custom', label: 'Personalizado' },
];

const PIE_COLORS = [
  'hsl(15, 80%, 50%)',   // primary
  'hsl(145, 45%, 42%)',  // accent/success
  'hsl(38, 92%, 50%)',   // warning
  'hsl(0, 72%, 51%)',    // destructive
];

export default function Dashboard() {
  const { slug } = useParams<{ slug: string }>();
  const companies = getMockCompanies();
  const isCompanyContext = !!slug;

  // In company context, find the matching company and lock to it
  const companyFromSlug = isCompanyContext
    ? companies.find(c => c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') === slug
        || c.id === slug) || companies[0]
    : null;

  const [companyId, setCompanyId] = useState<string>('all');
  const [period, setPeriod] = useState('30');
  const [customStart, setCustomStart] = useState<Date | undefined>();
  const [customEnd, setCustomEnd] = useState<Date | undefined>();

  // Fetch real company ID from slug for funnel data
  const { data: realCompany } = useQuery({
    queryKey: ['company-id-from-slug', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('id')
        .eq('slug', slug!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!slug,
  });

  const { startDate, endDate } = useMemo(() => {
    if (period === 'custom' && customStart && customEnd) {
      return { startDate: customStart, endDate: customEnd };
    }
    const days = parseInt(period) || 30;
    return { startDate: subDays(new Date(), days - 1), endDate: new Date() };
  }, [period, customStart, customEnd]);

  const effectiveCompanyId = isCompanyContext && companyFromSlug ? companyFromSlug.id : companyId;

  // Funnel data - use real company ID for company context, or 'all' for superadmin
  const funnelCompanyId = isCompanyContext ? realCompany?.id : (companyId !== 'all' ? companyId : undefined);
  const { data: funnelData = [] } = useFunnelData(funnelCompanyId, startDate, endDate);

  const data = useMemo(
    () => getMockDashboardData(effectiveCompanyId, startDate, endDate),
    [effectiveCompanyId, startDate, endDate],
  );

  const totals = useMemo(() => {
    return data.reduce(
      (acc, d) => ({
        reservations: acc.reservations + d.reservations,
        visits: acc.visits + d.visits,
        waitlist: acc.waitlist + d.waitlist,
        cancellations: acc.cancellations + d.cancellations,
        noShows: acc.noShows + d.noShows,
      }),
      { reservations: 0, visits: 0, waitlist: 0, cancellations: 0, noShows: 0 },
    );
  }, [data]);

  const avgPerDay = data.length > 0 ? Math.round(totals.reservations / data.length) : 0;
  const conversionRate = totals.reservations > 0
    ? Math.round((totals.visits / totals.reservations) * 100)
    : 0;

  const pieData = [
    { name: 'Visitas', value: totals.visits },
    { name: 'Fila de espera', value: totals.waitlist },
    { name: 'Cancelamentos', value: totals.cancellations },
    { name: 'No-shows', value: totals.noShows },
  ].filter(d => d.value > 0);

  const stats = [
    { label: 'Total Reservas', value: totals.reservations, icon: CalendarCheck, color: 'text-primary' },
    { label: 'Visitas Realizadas', value: totals.visits, icon: Users, color: 'text-accent' },
    { label: 'Fila de Espera', value: totals.waitlist, icon: Clock, color: 'text-[hsl(var(--warning))]' },
    { label: 'Cancelamentos', value: totals.cancellations, icon: XCircle, color: 'text-destructive' },
    { label: 'No-Shows', value: totals.noShows, icon: UserX, color: 'text-muted-foreground' },
    { label: 'Média/Dia', value: avgPerDay, icon: TrendingUp, color: 'text-primary' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Análise de reservas, visitas e fila de espera</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {!isCompanyContext && (
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Todas as unidades" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as unidades</SelectItem>
                {companies.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {period === 'custom' && (
            <div className="flex gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[140px] justify-start text-left text-sm", !customStart && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customStart ? format(customStart, 'dd/MM/yyyy') : 'Início'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customStart} onSelect={setCustomStart} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[140px] justify-start text-left text-sm", !customEnd && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customEnd ? format(customEnd, 'dd/MM/yyyy') : 'Fim'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customEnd} onSelect={setCustomEnd} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {stats.map(stat => (
          <Card key={stat.label} className="border-none shadow-sm">
            <CardContent className="flex items-center gap-3 pt-5 pb-4">
              <div className={`p-2.5 rounded-xl bg-muted ${stat.color}`}>
                <stat.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xl font-bold">{stat.value.toLocaleString('pt-BR')}</p>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts Row 1 */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="border-none shadow-sm lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reservas vs Visitas</CardTitle>
            <CardDescription>Comparativo diário no período selecionado</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                  <defs>
                    <linearGradient id="colorRes" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(15, 80%, 50%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(15, 80%, 50%)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorVis" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(145, 45%, 42%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(145, 45%, 42%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(30, 15%, 88%)" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(20, 10%, 48%)" />
                  <YAxis tick={{ fontSize: 12 }} stroke="hsl(20, 10%, 48%)" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(30, 20%, 99%)',
                      border: '1px solid hsl(30, 15%, 88%)',
                      borderRadius: '0.5rem',
                      fontSize: '0.875rem',
                    }}
                  />
                  <Legend />
                  <Area type="monotone" dataKey="reservations" name="Reservas" stroke="hsl(15, 80%, 50%)" fill="url(#colorRes)" strokeWidth={2} />
                  <Area type="monotone" dataKey="visits" name="Visitas" stroke="hsl(145, 45%, 42%)" fill="url(#colorVis)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Distribuição</CardTitle>
            <CardDescription>Resultado das reservas</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={3}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 text-center">
              <p className="text-sm text-muted-foreground">
                Taxa de conversão: <span className="font-semibold text-foreground">{conversionRate}%</span>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row 2 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Fila de Espera</CardTitle>
            <CardDescription>Quantidade diária de clientes na fila</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(30, 15%, 88%)" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(20, 10%, 48%)" />
                  <YAxis tick={{ fontSize: 12 }} stroke="hsl(20, 10%, 48%)" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(30, 20%, 99%)',
                      border: '1px solid hsl(30, 15%, 88%)',
                      borderRadius: '0.5rem',
                      fontSize: '0.875rem',
                    }}
                  />
                  <Bar dataKey="waitlist" name="Fila de Espera" fill="hsl(38, 92%, 50%)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Cancelamentos e No-Shows</CardTitle>
            <CardDescription>Acompanhamento diário de perdas</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(30, 15%, 88%)" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(20, 10%, 48%)" />
                  <YAxis tick={{ fontSize: 12 }} stroke="hsl(20, 10%, 48%)" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(30, 20%, 99%)',
                      border: '1px solid hsl(30, 15%, 88%)',
                      borderRadius: '0.5rem',
                      fontSize: '0.875rem',
                    }}
                  />
                  <Legend />
                  <Bar dataKey="cancellations" name="Cancelamentos" fill="hsl(0, 72%, 51%)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="noShows" name="No-Shows" fill="hsl(20, 10%, 48%)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
