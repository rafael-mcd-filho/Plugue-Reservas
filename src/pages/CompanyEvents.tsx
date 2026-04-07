import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Activity,
  BadgeCheck,
  Clock3,
  Eye,
  Loader2,
  MousePointerClick,
  RefreshCcw,
  Save,
  Send,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';

interface TrackingSettingsForm {
  pixel_id: string;
  access_token: string;
  test_event_code: string;
  capi_enabled: boolean;
  send_page_view: boolean;
  send_initiate_checkout: boolean;
  send_lead: boolean;
}

interface DashboardMetricCard {
  label: string;
  value: number;
  description: string;
}

interface TrackingEventRow {
  id: string;
  reservation_id: string | null;
  event_name: string;
  tracking_source: string;
  occurred_at: string;
  path: string | null;
  page_url: string | null;
  metadata: Record<string, unknown> | null;
}

interface MetaQueueRow {
  id: string;
  reservation_id: string | null;
  event_name: string;
  meta_event_name: string;
  status: string;
  attempts: number;
  last_response_status: number | null;
  last_error: string | null;
  payload: Record<string, unknown> | null;
  sent_at: string | null;
  created_at: string;
}

interface MetaAttemptRow {
  id: string;
  queue_id: string;
  reservation_id: string | null;
  status: string;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  request_payload: Record<string, unknown> | null;
  created_at: string;
}

type ClearEventDataScope = 'meta_queue' | 'event_log';

function createDefaultSettings(): TrackingSettingsForm {
  return {
    pixel_id: '',
    access_token: '',
    test_event_code: '',
    capi_enabled: false,
    send_page_view: false,
    send_initiate_checkout: true,
    send_lead: true,
  };
}

function formatDateTime(value: string | null) {
  if (!value) return '-';
  return format(new Date(value), "dd/MM/yyyy 'as' HH:mm", { locale: ptBR });
}

function formatMetaStatus(status: string) {
  if (status === 'sent') return 'Sucesso';
  if (status === 'failed') return 'Erro';
  if (status === 'processing') return 'Processando';
  return 'Pendente';
}

function buildPayloadPreview(value: unknown) {
  if (!value) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function CompanyEvents() {
  const { companyId, companyName } = useCompanySlug();
  const queryClient = useQueryClient();
  const [settingsForm, setSettingsForm] = useState<TrackingSettingsForm>(createDefaultSettings);
  const [selectedPayload, setSelectedPayload] = useState<{ title: string; content: string } | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);

  const since = useMemo(() => subDays(new Date(), 7).toISOString(), []);

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['company-tracking-settings', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_tracking_settings' as any)
        .select('*')
        .eq('company_id', companyId)
        .maybeSingle();

      if (error) throw error;
      return (data as Partial<TrackingSettingsForm> | null) ?? null;
    },
    enabled: !!companyId,
  });

  useEffect(() => {
    if (!settings) {
      setSettingsForm(createDefaultSettings());
      return;
    }

    setSettingsForm({
      pixel_id: settings.pixel_id ?? '',
      access_token: settings.access_token ?? '',
      test_event_code: settings.test_event_code ?? '',
      capi_enabled: !!settings.capi_enabled,
      send_page_view: !!settings.send_page_view,
      send_initiate_checkout: settings.send_initiate_checkout ?? true,
      send_lead: settings.send_lead ?? true,
    });
  }, [settings]);

  const { data: eventsDashboard, isLoading: dashboardLoading } = useQuery({
    queryKey: ['company-events-dashboard', companyId, since],
    queryFn: async () => {
      const [
        sessionsResult,
        pageViewsResult,
        initiateCheckoutResult,
        reservationsResult,
        metaSentResult,
        metaFailedResult,
        recentEventsResult,
        metaQueueResult,
        metaAttemptsResult,
      ] = await Promise.all([
        supabase
          .from('tracking_sessions' as any)
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .gte('started_at', since),
        supabase
          .from('tracking_events' as any)
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('tracking_source', 'public')
          .eq('event_name', 'page_view')
          .gte('occurred_at', since),
        supabase
          .from('tracking_events' as any)
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('tracking_source', 'public')
          .eq('event_name', 'time_select')
          .gte('occurred_at', since),
        supabase
          .from('tracking_events' as any)
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('tracking_source', 'public')
          .eq('event_name', 'reservation_created')
          .gte('occurred_at', since),
        supabase
          .from('meta_event_queue' as any)
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'sent')
          .gte('created_at', since),
        supabase
          .from('meta_event_queue' as any)
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'failed')
          .gte('created_at', since),
        supabase
          .from('tracking_events' as any)
          .select('id, reservation_id, event_name, tracking_source, occurred_at, path, page_url, metadata')
          .eq('company_id', companyId)
          .order('occurred_at', { ascending: false })
          .limit(30),
        supabase
          .from('meta_event_queue' as any)
          .select('id, reservation_id, event_name, meta_event_name, status, attempts, last_response_status, last_error, payload, sent_at, created_at')
          .eq('company_id', companyId)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('meta_event_attempts' as any)
          .select('id, queue_id, reservation_id, status, response_status, response_body, error_message, request_payload, created_at')
          .eq('company_id', companyId)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      const results = [
        sessionsResult,
        pageViewsResult,
        initiateCheckoutResult,
        reservationsResult,
        metaSentResult,
        metaFailedResult,
        recentEventsResult,
        metaQueueResult,
        metaAttemptsResult,
      ];

      const firstError = results.find((result) => result.error)?.error;
      if (firstError) throw firstError;

      const metrics: DashboardMetricCard[] = [
        {
          label: 'Sessoes',
          value: sessionsResult.count ?? 0,
          description: 'Visitas registradas nos ultimos 7 dias.',
        },
        {
          label: 'Page views',
          value: pageViewsResult.count ?? 0,
          description: 'Visualizacoes publicas persistidas no banco.',
        },
        {
          label: 'InitiateCheckout',
          value: initiateCheckoutResult.count ?? 0,
          description: 'Sessoes que escolheram data, pessoas e horario.',
        },
        {
          label: 'Lead',
          value: reservationsResult.count ?? 0,
          description: 'Reservas efetivadas e tratadas como conversao final na Meta.',
        },
        {
          label: 'Meta enviados',
          value: metaSentResult.count ?? 0,
          description: 'Eventos enviados com sucesso para a Meta.',
        },
        {
          label: 'Meta com erro',
          value: metaFailedResult.count ?? 0,
          description: 'Eventos que falharam e exigem revisao.',
        },
      ];

      return {
        metrics,
        recentEvents: ((recentEventsResult.data as TrackingEventRow[]) ?? []),
        metaQueue: ((metaQueueResult.data as MetaQueueRow[]) ?? []),
        metaAttempts: ((metaAttemptsResult.data as MetaAttemptRow[]) ?? []),
      };
    },
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      const pixelId = settingsForm.pixel_id.trim();
      const accessToken = settingsForm.access_token.trim();

      if (settingsForm.capi_enabled && (!pixelId || !accessToken)) {
        throw new Error('Informe Pixel ID e Access Token antes de habilitar a Meta CAPI.');
      }

      const payload = {
        company_id: companyId,
        ...settingsForm,
        send_schedule: false,
        pixel_id: pixelId || null,
        access_token: accessToken || null,
        test_event_code: settingsForm.test_event_code.trim() || null,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('company_tracking_settings' as any)
        .upsert(payload, { onConflict: 'company_id' });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company-tracking-settings', companyId] });
      toast.success('Configuracoes de tracking salvas.');
    },
    onError: (error: any) => {
      toast.error(`Erro ao salvar configuracoes: ${error.message}`);
    },
  });

  const processQueueMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('process-meta-event-queue', {
        body: { company_id: companyId },
      });

      if (error) throw error;
      return (data ?? {}) as { processed?: number; sent?: number; failed?: number; skipped?: number };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['company-events-dashboard', companyId, since] });
      toast.success(
        `Fila processada. Processados: ${result.processed ?? 0}, enviados: ${result.sent ?? 0}, falhas: ${result.failed ?? 0}, ignorados: ${result.skipped ?? 0}.`,
      );
    },
    onError: (error: any) => {
      toast.error(`Erro ao processar fila: ${error.message}`);
    },
  });

  const clearEventDataMutation = useMutation({
    mutationFn: async (scope: ClearEventDataScope) => {
      const { data, error } = await supabase.rpc('clear_company_event_data' as any, {
        _company_id: companyId,
        _scope: scope,
      });

      if (error) throw error;
      return data as Record<string, number>;
    },
    onSuccess: (result, scope) => {
      queryClient.invalidateQueries({ queryKey: ['company-events-dashboard', companyId, since] });
      const total = Object.values(result ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
      toast.success(scope === 'meta_queue'
        ? `Fila Meta limpa. ${total} registro(s) removido(s).`
        : `Log de eventos limpo. ${total} registro(s) removido(s).`,
      );
    },
    onError: (error: any) => {
      toast.error(`Erro ao limpar eventos: ${error.message}`);
    },
  });

  const recentEvents = eventsDashboard?.recentEvents ?? [];
  const metaQueue = eventsDashboard?.metaQueue ?? [];
  const metaAttempts = eventsDashboard?.metaAttempts ?? [];
  const metaConfigured = settingsForm.capi_enabled && !!settingsForm.pixel_id.trim() && !!settingsForm.access_token.trim();

  const handleClearEventData = (scope: ClearEventDataScope) => {
    const confirmed = window.confirm(
      scope === 'meta_queue'
        ? 'Limpar todos os itens da fila Meta desta empresa?'
        : 'Limpar o log de eventos desta empresa? As metricas do periodo podem mudar.',
    );

    if (confirmed) {
      clearEventDataMutation.mutate(scope);
    }
  };

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Eventos</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Tracking persistido no banco, historico do funil e operacao da Meta CAPI para {companyName}.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['company-events-dashboard', companyId, since] })}
            >
              <RefreshCcw className="h-4 w-4" />
              Atualizar
            </Button>
            <Button
              type="button"
              className="gap-2"
              onClick={() => processQueueMutation.mutate()}
              disabled={processQueueMutation.isPending || !metaConfigured}
              title={!metaConfigured ? 'Informe Pixel ID, Access Token e habilite a Meta CAPI antes de processar a fila.' : undefined}
            >
              {processQueueMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Processar fila Meta
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(eventsDashboard?.metrics ?? []).map((metric) => (
            <Card key={metric.label}>
              <CardHeader className="pb-2">
                <CardDescription>{metric.label}</CardDescription>
                <CardTitle className="text-3xl">{metric.value}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{metric.description}</p>
              </CardContent>
            </Card>
          ))}

          {(dashboardLoading || settingsLoading) && !eventsDashboard && (
            Array.from({ length: 3 }).map((_, index) => (
              <Card key={index}>
                <CardHeader className="pb-2">
                  <CardDescription>Carregando</CardDescription>
                  <CardTitle className="text-3xl">...</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Sincronizando dados de tracking.</p>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Meta CAPI</CardTitle>
            <CardDescription>
              Configure o Pixel, token e os tipos de evento que podem entrar na fila da Meta.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {!metaConfigured && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Eventos internos continuam alimentando o funil, mas nada deve entrar na fila Meta enquanto Pixel ID,
                Access Token e Meta CAPI habilitada nao estiverem configurados.
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Visita</p>
                <p className="mt-1 text-sm font-medium text-foreground"><code>page_view</code> {'->'} <code>PageView</code></p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Data e horario</p>
                <p className="mt-1 text-sm font-medium text-foreground"><code>time_select</code> {'->'} <code>InitiateCheckout</code></p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Conversao final</p>
                <p className="mt-1 text-sm font-medium text-foreground"><code>reservation_created</code> {'->'} <code>Lead</code></p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="meta-pixel-id">Pixel ID</Label>
                <Input
                  id="meta-pixel-id"
                  value={settingsForm.pixel_id}
                  onChange={(event) => setSettingsForm((current) => ({ ...current, pixel_id: event.target.value }))}
                  placeholder="123456789012345"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="meta-test-event-code">Test Event Code</Label>
                <Input
                  id="meta-test-event-code"
                  value={settingsForm.test_event_code}
                  onChange={(event) => setSettingsForm((current) => ({ ...current, test_event_code: event.target.value }))}
                  placeholder="TEST12345"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="meta-access-token">Access Token</Label>
              <div className="flex gap-2">
                <Input
                  id="meta-access-token"
                  type={tokenVisible ? 'text' : 'password'}
                  value={settingsForm.access_token}
                  onChange={(event) => setSettingsForm((current) => ({ ...current, access_token: event.target.value }))}
                  placeholder="EAAB..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="button" variant="outline" onClick={() => setTokenVisible((current) => !current)}>
                  {tokenVisible ? 'Ocultar' : 'Ver'}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">CAPI habilitada</p>
                    <p className="text-xs text-muted-foreground">Ativa o envio pela fila.</p>
                  </div>
                  <Switch
                    checked={settingsForm.capi_enabled}
                    onCheckedChange={(checked) => setSettingsForm((current) => ({ ...current, capi_enabled: checked }))}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">PageView</p>
                    <p className="text-xs text-muted-foreground">Preparado para uso futuro.</p>
                  </div>
                  <Switch
                    checked={settingsForm.send_page_view}
                    onCheckedChange={(checked) => setSettingsForm((current) => ({ ...current, send_page_view: checked }))}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">InitiateCheckout</p>
                    <p className="text-xs text-muted-foreground">Abertura da jornada de reserva.</p>
                  </div>
                  <Switch
                    checked={settingsForm.send_initiate_checkout}
                    onCheckedChange={(checked) => setSettingsForm((current) => ({ ...current, send_initiate_checkout: checked }))}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Lead</p>
                    <p className="text-xs text-muted-foreground">Reserva efetivada.</p>
                  </div>
                  <Switch
                    checked={settingsForm.send_lead}
                    onCheckedChange={(checked) => setSettingsForm((current) => ({ ...current, send_lead: checked }))}
                  />
                </div>
              </div>

            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                className="gap-2"
                onClick={() => saveSettingsMutation.mutate()}
                disabled={saveSettingsMutation.isPending}
              >
                {saveSettingsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Salvar configuracoes
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <MousePointerClick className="h-4 w-4" />
                  Log de eventos
                </CardTitle>
                <CardDescription>Ultimos eventos persistidos do site e das reservas.</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => handleClearEventData('event_log')}
                disabled={clearEventDataMutation.isPending || recentEvents.length === 0}
              >
                <Trash2 className="h-4 w-4" />
                Limpar
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Reserva</TableHead>
                    <TableHead>Detalhe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentEvents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        Nenhum evento registrado ainda.
                      </TableCell>
                    </TableRow>
                  ) : (
                    recentEvents.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(event.occurred_at)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary">{event.event_name}</Badge>
                            <Badge variant="outline">{event.tracking_source}</Badge>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {event.reservation_id ? event.reservation_id.slice(0, 8) : '-'}
                        </TableCell>
                        <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">
                          {event.path ?? event.page_url ?? '-'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Send className="h-4 w-4" />
                  Fila de envio Meta
                </CardTitle>
                <CardDescription>Status atual dos eventos prontos para envio via CAPI.</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => handleClearEventData('meta_queue')}
                disabled={clearEventDataMutation.isPending || metaQueue.length === 0}
              >
                <Trash2 className="h-4 w-4" />
                Limpar
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Evento</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tentativas</TableHead>
                    <TableHead>Resposta</TableHead>
                    <TableHead className="text-right">Payload</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metaQueue.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        Nenhum item na fila ainda.
                      </TableCell>
                    </TableRow>
                  ) : (
                    metaQueue.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="space-y-1">
                            <p className="font-medium text-foreground">{item.meta_event_name}</p>
                            <p className="text-xs text-muted-foreground">{formatDateTime(item.created_at)}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.status === 'sent' ? 'secondary' : item.status === 'failed' ? 'destructive' : 'outline'}>
                            {formatMetaStatus(item.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>{item.attempts}</TableCell>
                        <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                          {item.last_response_status ? `HTTP ${item.last_response_status}` : item.last_error ?? '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setSelectedPayload({
                                title: `${item.meta_event_name} (${formatMetaStatus(item.status)})`,
                                content: buildPayloadPreview(item.payload) ?? '{}',
                              })
                            }
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Historico de tentativas Meta
            </CardTitle>
            <CardDescription>
              Request payload, status HTTP e respostas recebidas da API de Conversoes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Resumo</TableHead>
                  <TableHead className="text-right">Detalhes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metaAttempts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      Nenhuma tentativa registrada ainda.
                    </TableCell>
                  </TableRow>
                ) : (
                  metaAttempts.map((attempt) => (
                    <TableRow key={attempt.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(attempt.created_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {attempt.status === 'sent' ? (
                            <BadgeCheck className="h-4 w-4 text-emerald-600" />
                          ) : (
                            <ShieldAlert className="h-4 w-4 text-destructive" />
                          )}
                          <span>{formatMetaStatus(attempt.status)}</span>
                        </div>
                      </TableCell>
                      <TableCell>{attempt.response_status ?? '-'}</TableCell>
                      <TableCell className="max-w-[420px] truncate text-sm text-muted-foreground">
                        {attempt.error_message ?? attempt.response_body ?? '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setSelectedPayload({
                              title: `Tentativa ${formatMetaStatus(attempt.status)} em ${formatDateTime(attempt.created_at)}`,
                              content: [
                                'REQUEST',
                                buildPayloadPreview(attempt.request_payload) ?? '{}',
                                '',
                                'RESPONSE',
                                attempt.response_body ?? attempt.error_message ?? '',
                              ].join('\n'),
                            })
                          }
                        >
                          Ver log
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 text-foreground">
            <Clock3 className="h-4 w-4" />
            Janela de metricas
          </div>
          <p className="mt-2">
            Os cards desta tela mostram os ultimos 7 dias. Os logs abaixo exibem os registros mais recentes gravados no banco.
          </p>
        </div>
      </div>

      <Dialog open={!!selectedPayload} onOpenChange={(nextOpen) => !nextOpen && setSelectedPayload(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selectedPayload?.title ?? 'Detalhes'}</DialogTitle>
          </DialogHeader>
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/20 p-4 text-xs text-foreground">
            {selectedPayload?.content ?? ''}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
