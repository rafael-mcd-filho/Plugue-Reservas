import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { eachDayOfInterval, endOfDay, format, startOfDay, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Copy,
  Eye,
  Link2,
  Loader2,
  MousePointerClick,
  Pencil,
  Plus,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DateRange } from 'react-day-picker';
import { toast } from 'sonner';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/contexts/AuthContext';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import {
  buildAffiliateLinkUrl,
  generateAffiliateLinkCode,
  isValidAffiliateLinkCode,
  normalizeAffiliateLinkCode,
} from '@/lib/affiliateLinks';
import { normalizeReservationStatus } from '@/lib/reservation-status';

interface AffiliateLinkStatsRow {
  affiliate_link_id: string;
  reference_name: string;
  code: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  visits: number;
  reservations: number;
  party_size_total: number;
  cancelled: number;
  no_show: number;
  conversion_rate: number;
  last_visit_at: string | null;
  last_reservation_at: string | null;
}

interface AffiliateLinkDailyRow {
  day: string;
  affiliate_link_id: string;
  reference_name: string;
  code: string;
  visits: number;
  reservations: number;
  party_size_total: number;
  cancelled: number;
  no_show: number;
}

interface AffiliateReservationRow {
  id: string;
  guest_name: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  created_at: string;
  public_tracking_code: string;
}

interface AffiliateLinkFormState {
  id: string | null;
  reference_name: string;
  code: string;
  notes: string;
  is_active: boolean;
}

const ALL_LINKS_FILTER = 'all';

function createDefaultRange(): DateRange {
  const today = new Date();
  return {
    from: subDays(today, 13),
    to: today,
  };
}

function createFormState(link?: AffiliateLinkStatsRow | null): AffiliateLinkFormState {
  if (!link) {
    return {
      id: null,
      reference_name: '',
      code: generateAffiliateLinkCode(),
      notes: '',
      is_active: true,
    };
  }

  return {
    id: link.affiliate_link_id,
    reference_name: link.reference_name,
    code: link.code,
    notes: link.notes ?? '',
    is_active: link.is_active,
  };
}

function formatDateTime(value: string | null) {
  if (!value) return '—';
  return format(new Date(value), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
}

function formatReservationDate(date: string, time: string) {
  const dateLabel = format(new Date(`${date}T12:00:00`), 'dd/MM/yyyy', { locale: ptBR });
  return `${dateLabel} · ${time.slice(0, 5)}`;
}

function formatPercent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%`;
}

function formatShortNumber(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value);
}

function buildChartData(range: DateRange, rows: AffiliateLinkDailyRow[]) {
  if (!range.from || !range.to) return [];

  const byDay = rows.reduce<Record<string, { reservations: number; people: number }>>((acc, row) => {
    const dayKey = row.day;
    if (!acc[dayKey]) {
      acc[dayKey] = { reservations: 0, people: 0 };
    }

    acc[dayKey].reservations += row.reservations;
    acc[dayKey].people += row.party_size_total;
    return acc;
  }, {});

  return eachDayOfInterval({
    start: startOfDay(range.from),
    end: endOfDay(range.to),
  }).map((day) => {
    const dayKey = format(day, 'yyyy-MM-dd');
    const found = byDay[dayKey];

    return {
      dayKey,
      label: format(day, 'dd/MM'),
      reservations: found?.reservations ?? 0,
      people: found?.people ?? 0,
    };
  });
}

export default function Affiliates() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { companyId, companyName, slug } = useCompanySlug();
  const [activeTab, setActiveTab] = useState<'links' | 'reports'>('links');
  const [reportRange, setReportRange] = useState<DateRange | undefined>(createDefaultRange);
  const [reportLinkFilter, setReportLinkFilter] = useState<string>(ALL_LINKS_FILTER);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [formState, setFormState] = useState<AffiliateLinkFormState>(createFormState());
  const [selectedLink, setSelectedLink] = useState<AffiliateLinkStatsRow | null>(null);

  const effectiveReportRange = useMemo(() => {
    if (!reportRange?.from) return undefined;
    return {
      from: reportRange.from,
      to: reportRange.to ?? reportRange.from,
    };
  }, [reportRange]);

  const rangeStartAt = effectiveReportRange?.from ? startOfDay(effectiveReportRange.from).toISOString() : null;
  const rangeEndAt = effectiveReportRange?.to ? endOfDay(effectiveReportRange.to).toISOString() : null;

  const { data: linkStats = [], isLoading } = useQuery({
    queryKey: ['affiliate-link-stats', companyId, rangeStartAt, rangeEndAt],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_affiliate_link_stats', {
        _company_id: companyId,
        _start_at: rangeStartAt,
        _end_at: rangeEndAt,
      });

      if (error) throw error;
      return ((data ?? []) as AffiliateLinkStatsRow[]).map((row) => ({
        ...row,
        visits: Number(row.visits ?? 0),
        reservations: Number(row.reservations ?? 0),
        party_size_total: Number(row.party_size_total ?? 0),
        cancelled: Number(row.cancelled ?? 0),
        no_show: Number(row.no_show ?? 0),
        conversion_rate: Number(row.conversion_rate ?? 0),
      }));
    },
    enabled: !!companyId,
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: dailyStats = [] } = useQuery({
    queryKey: ['affiliate-link-daily-stats', companyId, rangeStartAt, rangeEndAt, reportLinkFilter],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_affiliate_link_daily_stats', {
        _company_id: companyId,
        _start_at: rangeStartAt,
        _end_at: rangeEndAt,
        _affiliate_link_id: reportLinkFilter === ALL_LINKS_FILTER ? null : reportLinkFilter,
      });

      if (error) throw error;
      return ((data ?? []) as AffiliateLinkDailyRow[]).map((row) => ({
        ...row,
        visits: Number(row.visits ?? 0),
        reservations: Number(row.reservations ?? 0),
        party_size_total: Number(row.party_size_total ?? 0),
        cancelled: Number(row.cancelled ?? 0),
        no_show: Number(row.no_show ?? 0),
      }));
    },
    enabled: !!companyId && !!effectiveReportRange?.from && !!effectiveReportRange?.to,
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: selectedLinkReservations = [], isLoading: reservationsLoading } = useQuery({
    queryKey: ['affiliate-link-reservations', companyId, selectedLink?.affiliate_link_id, rangeStartAt, rangeEndAt],
    queryFn: async () => {
      const query = supabase
        .from('reservations' as any)
        .select('id, guest_name, date, time, party_size, status, created_at, public_tracking_code')
        .eq('company_id', companyId)
        .eq('origin_affiliate_link_id', selectedLink!.affiliate_link_id)
        .order('created_at', { ascending: false })
        .limit(40);

      const withStart = rangeStartAt ? query.gte('created_at', rangeStartAt) : query;
      const { data, error } = rangeEndAt
        ? await withStart.lte('created_at', rangeEndAt)
        : await withStart;

      if (error) throw error;
      return (data ?? []) as AffiliateReservationRow[];
    },
    enabled: !!companyId && !!selectedLink?.affiliate_link_id,
  });

  const saveLinkMutation = useMutation({
    mutationFn: async () => {
      const normalizedCode = normalizeAffiliateLinkCode(formState.code);

      if (!formState.reference_name.trim()) {
        throw new Error('Informe o nome de referência do filiado.');
      }

      if (!isValidAffiliateLinkCode(normalizedCode)) {
        throw new Error('Use um código de 3 a 40 caracteres com letras, números ou hífen.');
      }

      const payload = {
        reference_name: formState.reference_name.trim(),
        notes: formState.notes.trim() || null,
        is_active: formState.is_active,
        updated_at: new Date().toISOString(),
      };

      if (formState.id) {
        const { error } = await supabase
          .from('affiliate_links' as any)
          .update(payload as any)
          .eq('id', formState.id);

        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from('affiliate_links' as any)
        .insert({
          ...payload,
          company_id: companyId,
          created_by: user?.id ?? null,
          code: normalizedCode,
        } as any);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['affiliate-link-stats', companyId] });
      queryClient.invalidateQueries({ queryKey: ['affiliate-link-daily-stats', companyId] });
      toast.success(formState.id ? 'Link atualizado.' : 'Link criado.');
      setFormDialogOpen(false);
      setFormState(createFormState());
    },
    onError: (error: any) => {
      const message = String(error?.message ?? '');
      const duplicate = error?.code === '23505' || message.toLowerCase().includes('idx_affiliate_links_company_code_unique');
      const immutableCode = message.toLowerCase().includes('código do link não pode ser alterado');
      toast.error(
        duplicate
          ? 'Já existe um link com esse código nesta unidade.'
          : immutableCode
            ? 'O código do link não pode ser alterado após a criação.'
            : message || 'Não foi possível salvar o link.',
      );
    },
  });

  const toggleLinkMutation = useMutation({
    mutationFn: async (payload: { affiliateLinkId: string; isActive: boolean }) => {
      const { error } = await supabase
        .from('affiliate_links' as any)
        .update({
          is_active: payload.isActive,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', payload.affiliateLinkId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['affiliate-link-stats', companyId] });
      toast.success('Status do link atualizado.');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Não foi possível atualizar o status do link.');
    },
  });

  const sortedLinks = useMemo(
    () =>
      [...linkStats].sort((left, right) => {
        if (right.reservations !== left.reservations) {
          return right.reservations - left.reservations;
        }

        if (right.visits !== left.visits) {
          return right.visits - left.visits;
        }

        return left.reference_name.localeCompare(right.reference_name);
      }),
    [linkStats],
  );

  const totals = useMemo(() => {
    const totalVisits = linkStats.reduce((sum, row) => sum + row.visits, 0);
    const totalReservations = linkStats.reduce((sum, row) => sum + row.reservations, 0);
    const totalPartySize = linkStats.reduce((sum, row) => sum + row.party_size_total, 0);

    return {
      activeLinks: linkStats.filter((row) => row.is_active).length,
      totalVisits,
      totalReservations,
      totalPartySize,
    };
  }, [linkStats]);

  const chartData = useMemo(
    () => buildChartData(effectiveReportRange ?? createDefaultRange(), dailyStats),
    [dailyStats, effectiveReportRange],
  );
  const selectedLinkName = reportLinkFilter === ALL_LINKS_FILTER
    ? 'Todos os links'
    : sortedLinks.find((row) => row.affiliate_link_id === reportLinkFilter)?.reference_name ?? 'Link selecionado';
  const reportLabel = effectiveReportRange?.from && effectiveReportRange?.to
    ? `${format(effectiveReportRange.from, 'dd/MM', { locale: ptBR })} - ${format(effectiveReportRange.to, 'dd/MM', { locale: ptBR })}`
    : 'período atual';

  const handleCopyLink = async (code: string) => {
    const url = buildAffiliateLinkUrl(window.location.origin, slug, code);
    await navigator.clipboard.writeText(url);
    toast.success('Link copiado.');
  };

  const handleOpenCreate = () => {
    setFormState(createFormState());
    setFormDialogOpen(true);
  };

  const handleOpenEdit = (link: AffiliateLinkStatsRow) => {
    setFormState(createFormState(link));
    setFormDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-3xl border border-border bg-[radial-gradient(circle_at_top_left,rgba(235,94,40,0.18),transparent_35%),linear-gradient(135deg,rgba(20,20,18,1),rgba(32,31,26,1))] p-6 text-white shadow-sm">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.05),transparent)]" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-white/70">
                <Sparkles className="h-3.5 w-3.5" />
                Módulo Filiados
              </div>
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold tracking-tight">{companyName}</h1>
                <p className="max-w-xl text-sm leading-relaxed text-white/72">
                  Crie links de indicação por filiado, acompanhe visitas e veja quais reservas vieram de cada origem sem mexer no fluxo principal de reservas.
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={Link2}
            label="Links ativos"
            value={formatShortNumber(totals.activeLinks)}
            description="Links prontos para distribuir agora."
          />
          <MetricCard
            icon={MousePointerClick}
            label="Visitas no período"
            value={formatShortNumber(totals.totalVisits)}
            description={`Cliques capturados em ${reportLabel}.`}
          />
          <MetricCard
            icon={Users}
            label="Reservas atribuídas"
            value={formatShortNumber(totals.totalReservations)}
            description="Reservas criadas com origem afiliada."
          />
          <MetricCard
            icon={TrendingUp}
            label="Pessoas reservadas"
            value={formatShortNumber(totals.totalPartySize)}
            description="Soma das pessoas em reservas originadas por filiados."
          />
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'links' | 'reports')} className="space-y-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <TabsList className="grid w-full grid-cols-2 sm:w-[320px]">
              <TabsTrigger value="links">Links</TabsTrigger>
              <TabsTrigger value="reports">Relatórios</TabsTrigger>
            </TabsList>

            <DateRangePicker
              value={reportRange}
              onChange={setReportRange}
              placeholder="Selecionar período"
              className="w-full min-w-[220px] justify-between sm:w-[260px]"
            />
          </div>

          <TabsContent value="links" className="space-y-5">
            <div className="rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-base font-semibold">Links de indicação</h2>
                  <p className="text-sm text-muted-foreground">
                    Cada link representa a origem de um filiado. Quando a reserva nasce desse acesso, a origem fica registrada.
                  </p>
                </div>
                <Button variant="outline" className="gap-2" onClick={handleOpenCreate}>
                  <Plus className="h-4 w-4" />
                  Criar link
                </Button>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center">Filiado</TableHead>
                    <TableHead className="w-[110px] text-center">Visitas</TableHead>
                    <TableHead className="w-[110px] text-center">Reservas</TableHead>
                    <TableHead className="w-[110px] text-center">Conversão</TableHead>
                    <TableHead className="w-[170px] text-center">Última reserva</TableHead>
                    <TableHead className="w-[110px] text-center">Status</TableHead>
                    <TableHead className="w-[150px] text-center">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedLinks.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                        Nenhum link criado ainda.
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedLinks.map((link) => {
                      const url = buildAffiliateLinkUrl(window.location.origin, slug, link.code);

                      return (
                        <TableRow key={link.affiliate_link_id}>
                          <TableCell>
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium text-foreground">{link.reference_name}</p>
                                <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 font-mono text-[11px] text-primary">
                                  {link.code}
                                </span>
                              </div>
                              <p className="truncate text-xs text-muted-foreground">{url}</p>
                              {link.notes && (
                                <p className="text-xs text-muted-foreground">{link.notes}</p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-center">{formatShortNumber(link.visits)}</TableCell>
                          <TableCell className="text-center">{formatShortNumber(link.reservations)}</TableCell>
                          <TableCell className="text-center">{formatPercent(link.conversion_rate)}</TableCell>
                          <TableCell className="text-center text-sm text-muted-foreground">
                            {formatDateTime(link.last_reservation_at)}
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex justify-center">
                              <Switch
                                checked={link.is_active}
                                onCheckedChange={(checked) =>
                                  toggleLinkMutation.mutate({
                                    affiliateLinkId: link.affiliate_link_id,
                                    isActive: checked,
                                  })
                                }
                                disabled={toggleLinkMutation.isPending}
                              />
                            </div>
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex justify-center gap-2">
                              <Button type="button" variant="outline" size="icon" onClick={() => void handleCopyLink(link.code)}>
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button type="button" variant="outline" size="icon" onClick={() => setSelectedLink(link)}>
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button type="button" variant="outline" size="icon" onClick={() => handleOpenEdit(link)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="reports" className="space-y-5">
            <div className="rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex flex-col gap-4 border-b border-border px-5 py-4 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <h2 className="text-base font-semibold">Performance por filiado</h2>
                  <p className="text-sm text-muted-foreground">
                    Gráfico diário de reservas e pessoas por link. A origem do relatório é o próprio link do filiado.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  <Select value={reportLinkFilter} onValueChange={setReportLinkFilter}>
                    <SelectTrigger className="w-full sm:w-[220px]">
                      <SelectValue placeholder="Filtrar link" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_LINKS_FILTER}>Todos os links</SelectItem>
                      {sortedLinks.map((link) => (
                        <SelectItem key={link.affiliate_link_id} value={link.affiliate_link_id}>
                          {link.reference_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
                <div className="rounded-2xl border border-border/70 bg-background p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Dia a dia por origem</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedLinkName} · {reportLabel}
                      </p>
                    </div>
                  </div>

                  <div className="h-[320px]">
                    {chartData.length === 0 ? (
                      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                        Sem eventos no período selecionado.
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={chartData} margin={{ left: -10, right: 8, top: 8, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.18)" />
                          <XAxis dataKey="label" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                          <RechartsTooltip
                            contentStyle={{
                              borderRadius: '0.75rem',
                              border: '1px solid hsl(var(--border))',
                              backgroundColor: 'hsl(var(--background))',
                            }}
                            formatter={(value: number, name: string) => [
                              formatShortNumber(value),
                              name === 'people' ? 'Pessoas' : 'Reservas',
                            ]}
                          />
                          <Legend formatter={(value) => (value === 'people' ? 'Pessoas' : 'Reservas')} />
                          <Bar dataKey="people" fill="hsl(var(--muted-foreground) / 0.22)" radius={[8, 8, 0, 0]} />
                          <Line type="monotone" dataKey="reservations" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 3 }} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-border/70 bg-background p-4">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">Ranking do período</p>
                    <p className="text-xs text-muted-foreground">Links mais fortes por reservas atribuídas.</p>
                  </div>

                  <div className="mt-4 space-y-3">
                    {sortedLinks.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                        Crie o primeiro link para começar a medir.
                      </div>
                    ) : (
                      sortedLinks.slice(0, 6).map((link, index) => (
                        <button
                          key={link.affiliate_link_id}
                          type="button"
                          onClick={() => setReportLinkFilter(link.affiliate_link_id)}
                          className="flex w-full items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-muted/35"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-3">
                              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-foreground">{link.reference_name}</p>
                                <p className="truncate text-xs text-muted-foreground">{link.code}</p>
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-foreground">{formatShortNumber(link.reservations)}</p>
                            <p className="text-xs text-muted-foreground">{formatShortNumber(link.party_size_total)} pessoas</p>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={formDialogOpen} onOpenChange={setFormDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{formState.id ? 'Editar link de filiado' : 'Novo link de filiado'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,320px)] sm:items-start">
              <div className="space-y-2">
                <Label htmlFor="affiliate-reference-name">Nome de referência</Label>
                <Input
                  id="affiliate-reference-name"
                  value={formState.reference_name}
                  onChange={(event) => setFormState((current) => ({ ...current, reference_name: event.target.value }))}
                  placeholder="Ex.: João Silva, Influencer Centro, Parceiro Hotel"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="affiliate-code">Código do link</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    id="affiliate-code"
                    value={formState.code}
                    onChange={(event) => setFormState((current) => ({ ...current, code: event.target.value }))}
                    placeholder="vemcomer ou FRTG78"
                    className="min-w-0"
                    readOnly={!!formState.id}
                  />
                  {!formState.id && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setFormState((current) => ({ ...current, code: generateAffiliateLinkCode() }))}
                    >
                      Gerar curto
                    </Button>
                  )}
                </div>
                {formState.id && (
                  <p className="text-xs text-muted-foreground">
                    O código não pode ser alterado após a criação. Para usar outro código, crie um novo link.
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="affiliate-notes">Observações internas</Label>
              <Textarea
                id="affiliate-notes"
                value={formState.notes}
                onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                placeholder="Regras comerciais, observações do parceiro, canal de distribuição..."
                className="min-h-[96px]"
              />
            </div>

            <div className="rounded-2xl border border-border bg-muted/30 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Link final</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {isValidAffiliateLinkCode(formState.code)
                      ? buildAffiliateLinkUrl(window.location.origin, slug, normalizeAffiliateLinkCode(formState.code))
                      : 'Informe um código válido para gerar a URL.'}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3 sm:justify-end">
                  <span className="text-xs text-muted-foreground">{formState.is_active ? 'Ativo' : 'Pausado'}</span>
                  <Switch
                    checked={formState.is_active}
                    onCheckedChange={(checked) => setFormState((current) => ({ ...current, is_active: checked }))}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setFormDialogOpen(false)}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => saveLinkMutation.mutate()} disabled={saveLinkMutation.isPending}>
                {saveLinkMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {formState.id ? 'Salvar alterações' : 'Criar link'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!selectedLink}
        onOpenChange={(open) => {
          if (!open) setSelectedLink(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-4xl">
          {selectedLink && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedLink.reference_name}</DialogTitle>
                <DialogDescription>
                  URL: {buildAffiliateLinkUrl(window.location.origin, slug, selectedLink.code)}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 md:grid-cols-4">
                <MiniMetric label="Visitas" value={formatShortNumber(selectedLink.visits)} />
                <MiniMetric label="Reservas" value={formatShortNumber(selectedLink.reservations)} />
                <MiniMetric label="Pessoas" value={formatShortNumber(selectedLink.party_size_total)} />
                <MiniMetric label="Conversão" value={formatPercent(selectedLink.conversion_rate)} />
              </div>

              <div className="rounded-2xl border border-border">
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Reservas originadas</p>
                    <p className="text-xs text-muted-foreground">Últimas 40 reservas atribuídas a este link.</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyLink(selectedLink.code)}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copiar link
                  </Button>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Reserva</TableHead>
                      <TableHead>Pessoas</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Criada em</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reservationsLoading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                        </TableCell>
                      </TableRow>
                    ) : selectedLinkReservations.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                          Nenhuma reserva originada por este link no período atual.
                        </TableCell>
                      </TableRow>
                    ) : (
                      selectedLinkReservations.map((reservation) => (
                        <TableRow key={reservation.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium text-foreground">{reservation.guest_name}</p>
                              <p className="text-xs text-muted-foreground">{reservation.public_tracking_code}</p>
                            </div>
                          </TableCell>
                          <TableCell>{formatReservationDate(reservation.date, reservation.time)}</TableCell>
                          <TableCell>{reservation.party_size}</TableCell>
                          <TableCell>
                            <ReservationStatusBadge status={normalizeReservationStatus(reservation.status)} />
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {formatDateTime(reservation.created_at)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  description,
}: {
  icon: typeof Link2;
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold tracking-tight text-foreground">{value}</p>
        </div>
        <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/25 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-semibold text-foreground">{value}</p>
    </div>
  );
}
