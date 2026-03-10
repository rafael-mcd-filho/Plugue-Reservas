import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, subDays, startOfDay, endOfDay, parseISO, isWithinInterval } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { BarChart3, Download, Users, XCircle, CheckCircle2, MessageCircle, TrendingUp, Table2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';

const PERIOD_OPTIONS = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 90 dias' },
];

const STATUS_COLORS: Record<string, string> = {
  confirmed: 'hsl(var(--primary))',
  completed: 'hsl(142 71% 45%)',
  cancelled: 'hsl(0 84% 60%)',
  no_show: 'hsl(45 93% 47%)',
};

const STATUS_LABELS: Record<string, string> = {
  confirmed: 'Confirmada',
  completed: 'Compareceu',
  cancelled: 'Cancelada',
  no_show: 'No-show',
};

export default function CompanyReports() {
  const { companyId, companyName } = useCompanySlug();
  const [period, setPeriod] = useState('30');

  const startDate = useMemo(() => format(subDays(new Date(), Number(period)), 'yyyy-MM-dd'), [period]);
  const endDate = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  // Fetch reservations
  const { data: reservations = [], isLoading: loadingRes } = useQuery({
    queryKey: ['report-reservations', companyId, startDate],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select('id, date, time, party_size, status, table_id, guest_name, guest_phone, created_at')
        .eq('company_id', companyId)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  // Fetch tables
  const { data: tables = [] } = useQuery({
    queryKey: ['report-tables', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('id, number, capacity, section')
        .eq('company_id', companyId);
      if (error) throw error;
      return data as any[];
    },
  });

  // Fetch WhatsApp messages
  const { data: messages = [], isLoading: loadingMsg } = useQuery({
    queryKey: ['report-messages', companyId, startDate],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('whatsapp_message_logs' as any)
        .select('id, status, type, created_at')
        .eq('company_id', companyId)
        .gte('created_at', startDate + 'T00:00:00')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const isLoading = loadingRes || loadingMsg;

  // === Metrics ===
  const totalReservations = reservations.length;
  const totalGuests = reservations.reduce((sum, r) => sum + (r.party_size || 0), 0);
  const cancelledCount = reservations.filter(r => r.status === 'cancelled').length;
  const noShowCount = reservations.filter(r => r.status === 'no_show').length;
  const completedCount = reservations.filter(r => r.status === 'completed').length;
  const confirmedCount = reservations.filter(r => r.status === 'confirmed').length;

  const noShowRate = totalReservations > 0 ? ((noShowCount / totalReservations) * 100).toFixed(1) : '0';
  const cancellationRate = totalReservations > 0 ? ((cancelledCount / totalReservations) * 100).toFixed(1) : '0';
  const completionRate = totalReservations > 0 ? ((completedCount / (completedCount + noShowCount || 1)) * 100).toFixed(1) : '0';

  // Status distribution for pie chart
  const statusData = useMemo(() => {
    const counts: Record<string, number> = {};
    reservations.forEach(r => {
      counts[r.status] = (counts[r.status] || 0) + 1;
    });
    return Object.entries(counts).map(([status, count]) => ({
      name: STATUS_LABELS[status] || status,
      value: count,
      color: STATUS_COLORS[status] || 'hsl(var(--muted))',
    }));
  }, [reservations]);

  // Table occupancy
  const tableOccupancy = useMemo(() => {
    const tableCount: Record<string, number> = {};
    reservations.forEach(r => {
      if (r.table_id) tableCount[r.table_id] = (tableCount[r.table_id] || 0) + 1;
    });
    return tables.map(t => ({
      table: `Mesa ${t.number}`,
      section: t.section,
      capacity: t.capacity,
      reservations: tableCount[t.id] || 0,
    })).sort((a, b) => b.reservations - a.reservations);
  }, [reservations, tables]);

  // Daily reservations chart
  const dailyData = useMemo(() => {
    const byDate: Record<string, number> = {};
    reservations.forEach(r => {
      byDate[r.date] = (byDate[r.date] || 0) + 1;
    });
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({
        date: format(parseISO(date), 'dd/MM', { locale: ptBR }),
        reservas: count,
      }));
  }, [reservations]);

  // WhatsApp stats
  const whatsappStats = useMemo(() => {
    const sent = messages.filter(m => m.status === 'sent').length;
    const failed = messages.filter(m => m.status === 'failed').length;
    const total = messages.length;
    return { total, sent, failed, successRate: total > 0 ? ((sent / total) * 100).toFixed(1) : '0' };
  }, [messages]);

  // CSV export
  const exportCSV = () => {
    const headers = ['Data', 'Horário', 'Cliente', 'Telefone', 'Pessoas', 'Status', 'Mesa'];
    const rows = reservations.map(r => {
      const table = tables.find(t => t.id === r.table_id);
      return [
        r.date,
        r.time?.substring(0, 5),
        r.guest_name,
        r.guest_phone,
        r.party_size,
        STATUS_LABELS[r.status] || r.status,
        table ? `Mesa ${table.number}` : '—',
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-${companyName}-${startDate}-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Relatórios</h1>
          <p className="text-muted-foreground mt-1">Análise de desempenho de {companyName}</p>
        </div>
        <div className="flex gap-3">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERIOD_OPTIONS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" className="gap-2" onClick={exportCSV}>
            <Download className="h-4 w-4" /> Exportar CSV
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-primary/10"><BarChart3 className="h-5 w-5 text-primary" /></div>
              <div>
                <p className="text-2xl font-bold">{totalReservations}</p>
                <p className="text-xs text-muted-foreground">Total de Reservas</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-primary/10"><Users className="h-5 w-5 text-primary" /></div>
              <div>
                <p className="text-2xl font-bold">{totalGuests}</p>
                <p className="text-xs text-muted-foreground">Total de Convidados</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-destructive/10"><XCircle className="h-5 w-5 text-destructive" /></div>
              <div>
                <p className="text-2xl font-bold">{noShowRate}%</p>
                <p className="text-xs text-muted-foreground">Taxa de No-show</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-green-500/10"><CheckCircle2 className="h-5 w-5 text-green-600" /></div>
              <div>
                <p className="text-2xl font-bold">{completionRate}%</p>
                <p className="text-xs text-muted-foreground">Taxa de Comparecimento</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Daily chart */}
        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" /> Reservas por Dia
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={dailyData}>
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="reservas" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-muted-foreground py-10">Sem dados no período selecionado</p>
            )}
          </CardContent>
        </Card>

        {/* Status pie chart */}
        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Distribuição por Status</CardTitle>
          </CardHeader>
          <CardContent>
            {statusData.length > 0 ? (
              <div className="flex items-center gap-6">
                <ResponsiveContainer width="50%" height={200}>
                  <PieChart>
                    <Pie data={statusData} dataKey="value" cx="50%" cy="50%" outerRadius={80} innerRadius={40}>
                      {statusData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {statusData.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
                      <span>{s.name}: <strong>{s.value}</strong></span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-10">Sem dados</p>
            )}
          </CardContent>
        </Card>

        {/* Table occupancy */}
        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Table2 className="h-5 w-5 text-primary" /> Ocupação por Mesa
            </CardTitle>
            <CardDescription>Número de reservas por mesa no período</CardDescription>
          </CardHeader>
          <CardContent>
            {tableOccupancy.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Mesa</TableHead>
                    <TableHead>Seção</TableHead>
                    <TableHead>Capacidade</TableHead>
                    <TableHead className="text-right">Reservas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tableOccupancy.slice(0, 10).map((t, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{t.table}</TableCell>
                      <TableCell className="text-muted-foreground capitalize">{t.section}</TableCell>
                      <TableCell>{t.capacity}p</TableCell>
                      <TableCell className="text-right font-semibold">{t.reservations}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-center text-muted-foreground py-6">Nenhuma mesa cadastrada</p>
            )}
          </CardContent>
        </Card>

        {/* WhatsApp stats */}
        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-primary" /> Mensagens WhatsApp
            </CardTitle>
            <CardDescription>Estatísticas de envio no período</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-4 rounded-xl bg-muted/50">
                <p className="text-2xl font-bold">{whatsappStats.total}</p>
                <p className="text-xs text-muted-foreground">Total enviadas</p>
              </div>
              <div className="text-center p-4 rounded-xl bg-muted/50">
                <p className="text-2xl font-bold text-green-600">{whatsappStats.successRate}%</p>
                <p className="text-xs text-muted-foreground">Taxa de sucesso</p>
              </div>
              <div className="text-center p-4 rounded-xl bg-muted/50">
                <p className="text-2xl font-bold">{whatsappStats.sent}</p>
                <p className="text-xs text-muted-foreground">Entregues</p>
              </div>
              <div className="text-center p-4 rounded-xl bg-muted/50">
                <p className="text-2xl font-bold text-destructive">{whatsappStats.failed}</p>
                <p className="text-xs text-muted-foreground">Falhas</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
