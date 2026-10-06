import { useState } from 'react';
import { Link } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import { Building2, CalendarCheck, Users, CheckCircle2, Loader2, ArrowUpRight } from 'lucide-react';
import { useSupportCompanies, useSupportDashboard } from '@/hooks/useSupportAccess';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function SupportDashboard() {
  const [companyId, setCompanyId] = useState('all');
  const [period, setPeriod] = useState('today');
  const companiesQuery = useSupportCompanies();
  const companies = companiesQuery.data ?? [];
  const today = new Date();
  const startDate = format(subDays(today, period === 'week' ? 6 : period === 'month' ? 29 : 0), 'yyyy-MM-dd');
  const endDate = format(today, 'yyyy-MM-dd');
  const effectiveCompanyId = companies.some((company) => company.id === companyId) ? companyId : null;
  const summaryQuery = useSupportDashboard(effectiveCompanyId, startDate, endDate);
  const summary = summaryQuery.data;
  const metrics = [
    { label: 'Empresas autorizadas', value: summary?.companyCount, icon: Building2 },
    { label: 'Reservas no período', value: summary?.reservationCount, icon: CalendarCheck },
    { label: 'Pessoas nas reservas', value: summary?.totalGuests, icon: Users },
    { label: 'Check-ins realizados', value: summary?.checkedInCount, icon: CheckCircle2 },
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-bold tracking-tight">Dashboard</h1><p className="mt-1 text-sm text-muted-foreground">Acompanhe a operação das empresas autorizadas para o seu acesso.</p></div><Button asChild variant="outline"><Link to="/empresas">Acessar uma empresa <ArrowUpRight className="ml-2 h-4 w-4" /></Link></Button></div>
      <div className="flex flex-wrap gap-3"><Select value={effectiveCompanyId ?? 'all'} onValueChange={setCompanyId}><SelectTrigger aria-label="Empresa" className="w-full sm:w-64"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todas as empresas autorizadas</SelectItem>{companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}</SelectContent></Select><Select value={period} onValueChange={setPeriod}><SelectTrigger aria-label="Período" className="w-full sm:w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="today">Hoje</SelectItem><SelectItem value="week">Últimos 7 dias</SelectItem><SelectItem value="month">Últimos 30 dias</SelectItem></SelectContent></Select></div>
      {(summaryQuery.isError || companiesQuery.isError) ? <Card><CardContent role="alert" className="space-y-3 py-8 text-center"><p>Não foi possível carregar o resumo das empresas autorizadas.</p><Button variant="outline" onClick={() => { void companiesQuery.refetch(); void summaryQuery.refetch(); }}>Tentar novamente</Button></CardContent></Card>
        : <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map((metric) => <Card key={metric.label}><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{metric.label}</CardTitle><metric.icon aria-hidden="true" className="h-4 w-4 text-primary" /></CardHeader><CardContent>{summaryQuery.isPending ? <Loader2 aria-label="Carregando indicador" className="h-5 w-5 animate-spin" /> : <p className="text-3xl font-bold tabular-nums">{(metric.value ?? 0).toLocaleString('pt-BR')}</p>}</CardContent></Card>)}</div><Card><CardHeader><CardTitle className="text-base">Situação das reservas</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-3">{[{ label: 'Confirmadas', value: summary?.confirmedCount }, { label: 'Canceladas', value: summary?.cancelledCount }, { label: 'Não compareceram', value: summary?.noShowCount }].map((item) => <div key={item.label}><p className="text-sm text-muted-foreground">{item.label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{summaryQuery.isPending ? '—' : (item.value ?? 0).toLocaleString('pt-BR')}</p></div>)}</CardContent></Card>{!companiesQuery.isPending && companies.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma empresa autorizada. Solicite ao superadmin a seleção das empresas no seu cadastro.</p>}</>}
    </div>
  );
}
