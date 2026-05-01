import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  BadgeCheck,
  Clock3,
  Eye,
  Loader2,
  MousePointerClick,
  RefreshCcw,
  Save,
  Search,
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
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TrackingSettingsForm {
  pixel_id: string;
  access_token: string;
  test_event_code: string;
  capi_enabled: boolean;
  send_page_view: boolean;
  send_initiate_checkout: boolean;
  send_lead: boolean;
}

interface TrackingEventRow {
  id: string;
  session_id: string | null;
  journey_id: string | null;
  reservation_id: string | null;
  anonymous_id: string;
  event_id: string;
  event_name: string;
  tracking_source: string;
  step: string | null;
  occurred_at: string;
  path: string | null;
  page_url: string | null;
  referrer: string | null;
  event_source_url: string | null;
  metadata: Record<string, unknown> | null;
  user_data_snapshot: Record<string, unknown> | null;
  session?: TrackingSessionRow | null;
}

interface TrackingSessionRow {
  id: string;
  anonymous_id: string;
  first_page_url: string | null;
  last_page_url: string | null;
  landing_path: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
  fbp: string | null;
  fbc: string | null;
  ip_address: string | null;
  user_agent: string | null;
  accept_language: string | null;
  started_at: string;
  last_seen_at: string;
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
  queue?: Pick<MetaQueueRow, 'event_name' | 'meta_event_name'> | null;
}

type ClearEventDataScope = 'meta_queue' | 'event_log';

type PeriodPreset = 'all' | 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';

// ─── Constants ───────────────────────────────────────────────────────────────

const EVENT_LOG_LIMIT = 100;
const EVENT_LOG_PAGE_SIZE = 10;
const META_QUEUE_LIMIT = 100;
const META_ATTEMPTS_LIMIT = META_QUEUE_LIMIT * 5;
const META_QUEUE_PAGE_SIZE = 8;
const EVENT_TYPE_FILTER_ALL = 'all';

const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  all: 'Todo o período',
  today: 'Hoje',
  yesterday: 'Ontem',
  this_week: 'Esta semana',
  last_week: 'Semana passada',
  this_month: 'Mês atual',
  last_month: 'Mês anterior',
  custom: 'Personalizado',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function getPresetDateRange(preset: PeriodPreset): { start: Date | null; end: Date | null } {
  const now = new Date();
  switch (preset) {
    case 'all':
      return { start: null, end: null };
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const y = subDays(startOfDay(now), 1);
      return { start: y, end: endOfDay(y) };
    }
    case 'this_week':
      return { start: startOfWeek(now, { weekStartsOn: 0 }), end: endOfDay(now) };
    case 'last_week': {
      const lw = subWeeks(now, 1);
      return { start: startOfWeek(lw, { weekStartsOn: 0 }), end: endOfWeek(lw, { weekStartsOn: 0 }) };
    }
    case 'this_month':
      return { start: startOfMonth(now), end: endOfDay(now) };
    case 'last_month': {
      const lm = subMonths(now, 1);
      return { start: startOfMonth(lm), end: endOfMonth(lm) };
    }
    case 'custom':
      return { start: null, end: null };
  }
}

function formatDateTime(value: string | null) {
  if (!value) return '-';
  return format(new Date(value), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
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

function getRecordText(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function formatEventDisplay(eventName: string) {
  if (eventName === 'page_view') return 'Abriu página pública';
  if (eventName === 'booking_started') return 'Abriu jornada de reserva';
  if (eventName === 'date_select') return 'Escolheu data';
  if (eventName === 'time_select') return 'Escolheu data, pessoas e horário';
  if (eventName === 'form_fill') return 'Chegou no formulário';
  if (eventName === 'reservation_created') return 'Reserva efetivada';
  if (eventName === 'lead_captured') return 'Formulário enviado (legado)';
  return eventName;
}

function formatEventOptionLabel(eventName: string) {
  const display = formatEventDisplay(eventName);
  return display === eventName ? eventName : `${eventName} - ${display}`;
}

function getVisiblePages(currentPage: number, totalPages: number) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages] as const;
  if (currentPage >= totalPages - 3) {
    return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages] as const;
  }
  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages] as const;
}

function getPaginationSummary(totalItems: number, currentPage: number, pageSize: number, label: string) {
  if (totalItems === 0) return `Exibindo 0 de 0 ${label}`;
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);
  return `Exibindo ${start}-${end} de ${totalItems} ${label}`;
}

function formatMetaMapping(eventName: string) {
  if (eventName === 'page_view') return 'PageView';
  if (eventName === 'time_select') return 'InitiateCheckout';
  if (eventName === 'reservation_created') return 'Lead';
  return 'Não envia para Meta';
}

function formatMetaEventOptionLabel(eventName: string) {
  if (eventName === 'PageView') return 'PageView - abertura da pagina publica';
  if (eventName === 'InitiateCheckout') return 'InitiateCheckout - data, pessoas e horario';
  if (eventName === 'Lead') return 'Lead - reserva efetivada';
  return eventName;
}

function getMetaStatusBadgeVariant(status: string) {
  if (status === 'sent') return 'secondary' as const;
  if (status === 'failed') return 'destructive' as const;
  return 'outline' as const;
}

function getMetaLastResponseText(item: MetaQueueRow, attempts: MetaAttemptRow[]) {
  const latestAttempt = attempts[0] ?? null;
  const httpStatus = latestAttempt?.response_status ?? item.last_response_status;
  const summary = latestAttempt?.error_message ?? latestAttempt?.response_body ?? item.last_error;
  if (httpStatus && summary) return `HTTP ${httpStatus} · ${summary}`;
  if (httpStatus) return `HTTP ${httpStatus}`;
  return summary ?? '-';
}

function buildMetaQueueDetailContent(item: MetaQueueRow, attempts: MetaAttemptRow[]) {
  const queueSummary = {
    queue_id: item.id,
    reservation_id: item.reservation_id,
    event_name: item.event_name,
    meta_event_name: item.meta_event_name,
    status: item.status,
    attempts: item.attempts,
    last_response_status: item.last_response_status,
    last_error: item.last_error,
    created_at: item.created_at,
    sent_at: item.sent_at,
  };
  const attemptsContent = attempts.length > 0
    ? attempts.map((attempt, index) => [
      `TENTATIVA ${index + 1} - ${formatMetaStatus(attempt.status)} - ${formatDateTime(attempt.created_at)}`,
      `HTTP: ${attempt.response_status ?? '-'}`,
      `Resumo: ${attempt.error_message ?? attempt.response_body ?? '-'}`,
      '',
      'REQUEST',
      buildPayloadPreview(attempt.request_payload) ?? '{}',
      '',
      'RESPONSE',
      attempt.response_body ?? attempt.error_message ?? '-',
    ].join('\n')).join('\n\n---\n\n')
    : 'Nenhuma tentativa registrada para este evento.';
  return [
    'STATUS ATUAL DA FILA',
    buildPayloadPreview(queueSummary) ?? '{}',
    '',
    'PAYLOAD ORIGINAL DA FILA',
    buildPayloadPreview(item.payload) ?? '{}',
    '',
    `TENTATIVAS (${attempts.length})`,
    attemptsContent,
  ].join('\n');
}

function getSessionAttributionValue(event: TrackingEventRow, key: keyof TrackingSessionRow) {
  const sessionValue = event.session?.[key];
  if (typeof sessionValue === 'string' && sessionValue.trim()) return sessionValue;
  return getRecordText(event.metadata, key);
}

function formatLocationFromUserData(userData: Record<string, unknown> | null | undefined) {
  const city = getRecordText(userData, 'city');
  const state = getRecordText(userData, 'state');
  const country = getRecordText(userData, 'country');
  const zip = getRecordText(userData, 'zip');
  const location = [city, state, country].filter(Boolean).join(', ');
  if (location && zip) return `${location} - ${zip}`;
  if (location) return location;
  if (zip) return zip;
  return 'Não coletada automaticamente';
}

function matchesSearch(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle);
}

function DetailItem({ label, value, mono = false }: { label: string; value: string | number | null | undefined; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-xs text-foreground' : 'break-words text-sm text-foreground'}>
        {value || '-'}
      </p>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CompanyEvents() {
  const { companyId, companyName } = useCompanySlug();
  const queryClient = useQueryClient();
  const [settingsForm, setSettingsForm] = useState<TrackingSettingsForm>(createDefaultSettings);
  const [selectedPayload, setSelectedPayload] = useState<{ title: string; content: string } | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TrackingEventRow | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);

  // Event log filters
  const [eventTypeFilter, setEventTypeFilter] = useState(EVENT_TYPE_FILTER_ALL);
  const [eventPeriodPreset, setEventPeriodPreset] = useState<PeriodPreset>('all');
  const [eventCustomStart, setEventCustomStart] = useState('');
  const [eventCustomEnd, setEventCustomEnd] = useState('');
  const [eventSearch, setEventSearch] = useState('');
  const [eventLogPage, setEventLogPage] = useState(1);

  // Meta queue filters
  const [metaQueueTypeFilter, setMetaQueueTypeFilter] = useState(EVENT_TYPE_FILTER_ALL);
  const [metaQueuePeriodPreset, setMetaQueuePeriodPreset] = useState<PeriodPreset>('all');
  const [metaQueueCustomStart, setMetaQueueCustomStart] = useState('');
  const [metaQueueCustomEnd, setMetaQueueCustomEnd] = useState('');
  const [metaQueueSearch, setMetaQueueSearch] = useState('');
  const [metaQueuePage, setMetaQueuePage] = useState(1);

  const hasInvalidEventDateRange = eventPeriodPreset === 'custom'
    && !!eventCustomStart && !!eventCustomEnd && eventCustomStart > eventCustomEnd;

  const hasInvalidMetaQueueDateRange = metaQueuePeriodPreset === 'custom'
    && !!metaQueueCustomStart && !!metaQueueCustomEnd && metaQueueCustomStart > metaQueueCustomEnd;

  const { data: settings } = useQuery({
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
    if (!settings) { setSettingsForm(createDefaultSettings()); return; }
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

  const { data: eventTypeOptions = [] } = useQuery({
    queryKey: ['company-event-types', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tracking_events' as any)
        .select('event_name')
        .eq('company_id', companyId)
        .order('occurred_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return Array.from(new Set(
        (((data as Pick<TrackingEventRow, 'event_name'>[]) ?? [])
          .map((e) => e.event_name)
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)),
      )).sort((a, b) => a.localeCompare(b));
    },
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const { data: metaEventTypeOptions = [] } = useQuery({
    queryKey: ['company-meta-event-types', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('meta_event_queue' as any)
        .select('meta_event_name')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return Array.from(new Set(
        (((data as Array<{ meta_event_name?: string | null }>) ?? [])
          .map((e) => e.meta_event_name)
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)),
      )).sort((a, b) => a.localeCompare(b));
    },
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const { data: eventLog = [], isLoading: eventLogLoading } = useQuery({
    queryKey: ['company-event-log', companyId, eventTypeFilter, eventPeriodPreset, eventCustomStart, eventCustomEnd],
    queryFn: async () => {
      const range = eventPeriodPreset === 'custom'
        ? {
            start: eventCustomStart ? startOfDay(parseISO(eventCustomStart)) : null,
            end: eventCustomEnd ? endOfDay(parseISO(eventCustomEnd)) : null,
          }
        : getPresetDateRange(eventPeriodPreset);

      let query = supabase
        .from('tracking_events' as any)
        .select('id, session_id, journey_id, reservation_id, anonymous_id, event_id, event_name, tracking_source, step, occurred_at, path, page_url, referrer, event_source_url, metadata, user_data_snapshot')
        .eq('company_id', companyId)
        .order('occurred_at', { ascending: false })
        .limit(EVENT_LOG_LIMIT);

      if (eventTypeFilter !== EVENT_TYPE_FILTER_ALL) query = query.eq('event_name', eventTypeFilter);
      if (range.start) query = query.gte('occurred_at', range.start.toISOString());
      if (range.end) query = query.lte('occurred_at', range.end.toISOString());

      const { data, error } = await query;
      if (error) throw error;

      const events = (data as TrackingEventRow[]) ?? [];
      const sessionIds = Array.from(new Set(
        events.map((e) => e.session_id).filter((v): v is string => !!v),
      ));
      const sessionDetailsResult = sessionIds.length > 0
        ? await supabase
          .from('tracking_sessions' as any)
          .select('id, anonymous_id, first_page_url, last_page_url, landing_path, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, fbp, fbc, ip_address, user_agent, accept_language, started_at, last_seen_at')
          .eq('company_id', companyId)
          .in('id', sessionIds)
        : { data: [], error: null };

      if (sessionDetailsResult.error) throw sessionDetailsResult.error;

      const sessionsById = new Map(
        ((sessionDetailsResult.data as TrackingSessionRow[]) ?? []).map((s) => [s.id, s]),
      );

      return events.map((event) => ({
        ...event,
        session: event.session_id ? sessionsById.get(event.session_id) ?? null : null,
      }));
    },
    enabled: !!companyId && !hasInvalidEventDateRange,
    placeholderData: (previousData) => previousData,
    refetchInterval: 30_000,
  });

  const { data: metaQueue = [], isLoading: metaQueueLoading } = useQuery({
    queryKey: ['company-meta-queue', companyId, metaQueueTypeFilter, metaQueuePeriodPreset, metaQueueCustomStart, metaQueueCustomEnd],
    queryFn: async () => {
      const range = metaQueuePeriodPreset === 'custom'
        ? {
            start: metaQueueCustomStart ? startOfDay(parseISO(metaQueueCustomStart)) : null,
            end: metaQueueCustomEnd ? endOfDay(parseISO(metaQueueCustomEnd)) : null,
          }
        : getPresetDateRange(metaQueuePeriodPreset);

      let query = supabase
        .from('meta_event_queue' as any)
        .select('id, reservation_id, event_name, meta_event_name, status, attempts, last_response_status, last_error, payload, sent_at, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(META_QUEUE_LIMIT);

      if (metaQueueTypeFilter !== EVENT_TYPE_FILTER_ALL) query = query.eq('meta_event_name', metaQueueTypeFilter);
      if (range.start) query = query.gte('created_at', range.start.toISOString());
      if (range.end) query = query.lte('created_at', range.end.toISOString());

      const { data, error } = await query;
      if (error) throw error;
      return (data as MetaQueueRow[]) ?? [];
    },
    enabled: !!companyId && !hasInvalidMetaQueueDateRange,
    placeholderData: (previousData) => previousData,
    refetchInterval: 30_000,
  });

  const metaQueueIds = useMemo(() => metaQueue.map((item) => item.id), [metaQueue]);

  const { data: metaAttempts = [], isLoading: metaAttemptsLoading } = useQuery({
    queryKey: ['company-meta-attempts', companyId, metaQueueIds],
    queryFn: async () => {
      if (metaQueueIds.length === 0) return [];
      const { data, error } = await supabase
        .from('meta_event_attempts' as any)
        .select('id, queue_id, reservation_id, status, response_status, response_body, error_message, request_payload, created_at, queue:meta_event_queue!inner(event_name, meta_event_name)')
        .eq('company_id', companyId)
        .in('queue_id', metaQueueIds)
        .order('created_at', { ascending: false })
        .limit(META_ATTEMPTS_LIMIT);
      if (error) throw error;
      return (data as MetaAttemptRow[]) ?? [];
    },
    enabled: !!companyId && !hasInvalidMetaQueueDateRange,
    refetchInterval: 30_000,
  });

  // ── Search filtering (client-side) ─────────────────────────────────────────

  const filteredEventLog = useMemo(() => {
    const q = eventSearch.trim().toLowerCase();
    if (!q) return eventLog;
    return eventLog.filter((event) => {
      if (matchesSearch(event.reservation_id, q)) return true;
      if (matchesSearch(event.anonymous_id, q)) return true;
      const snapshot = event.user_data_snapshot;
      if (snapshot) {
        const serialized = JSON.stringify(snapshot).toLowerCase();
        if (serialized.includes(q)) return true;
      }
      const meta = event.metadata;
      if (meta) {
        const serialized = JSON.stringify(meta).toLowerCase();
        if (serialized.includes(q)) return true;
      }
      return false;
    });
  }, [eventLog, eventSearch]);

  const filteredMetaQueue = useMemo(() => {
    const q = metaQueueSearch.trim().toLowerCase();
    if (!q) return metaQueue;
    return metaQueue.filter((item) => {
      if (matchesSearch(item.reservation_id, q)) return true;
      if (item.payload) {
        const serialized = JSON.stringify(item.payload).toLowerCase();
        if (serialized.includes(q)) return true;
      }
      return false;
    });
  }, [metaQueue, metaQueueSearch]);

  // ── Mutations ──────────────────────────────────────────────────────────────

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
      toast.success('Configurações de tracking salvas.');
    },
    onError: (error: any) => toast.error(`Erro ao salvar configurações: ${error.message}`),
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
      queryClient.invalidateQueries({ queryKey: ['company-meta-queue', companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-meta-attempts', companyId] });
      toast.success(
        `Fila processada. Processados: ${result.processed ?? 0}, enviados: ${result.sent ?? 0}, falhas: ${result.failed ?? 0}, ignorados: ${result.skipped ?? 0}.`,
      );
    },
    onError: (error: any) => toast.error(`Erro ao processar fila: ${error.message}`),
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
      queryClient.invalidateQueries({ queryKey: ['company-event-log', companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-event-types', companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-meta-event-types', companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-meta-queue', companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-meta-attempts', companyId] });
      const total = Object.values(result ?? {}).reduce((sum, v) => sum + Number(v || 0), 0);
      if (scope === 'event_log') {
        setSelectedEvent(null);
        setEventTypeFilter(EVENT_TYPE_FILTER_ALL);
        setEventPeriodPreset('all');
        setEventCustomStart('');
        setEventCustomEnd('');
        setEventSearch('');
      }
      toast.success(scope === 'meta_queue'
        ? `Fila Meta limpa. ${total} registro(s) removido(s).`
        : `Log de eventos limpo. ${total} registro(s) removido(s).`,
      );
    },
    onError: (error: any) => toast.error(`Erro ao limpar eventos: ${error.message}`),
  });

  // ── Derived values ─────────────────────────────────────────────────────────

  const metaConfigured = settingsForm.capi_enabled && !!settingsForm.pixel_id.trim() && !!settingsForm.access_token.trim();

  const hasEventLogFiltersActive = eventTypeFilter !== EVENT_TYPE_FILTER_ALL
    || eventPeriodPreset !== 'all'
    || !!eventSearch.trim();

  const hasMetaQueueFiltersActive = metaQueueTypeFilter !== EVENT_TYPE_FILTER_ALL
    || metaQueuePeriodPreset !== 'all'
    || !!metaQueueSearch.trim();

  const selectableEventTypes = useMemo(() => {
    if (eventTypeFilter === EVENT_TYPE_FILTER_ALL || eventTypeOptions.includes(eventTypeFilter)) return eventTypeOptions;
    return [eventTypeFilter, ...eventTypeOptions];
  }, [eventTypeFilter, eventTypeOptions]);

  const selectableMetaQueueEventTypes = useMemo(() => {
    if (metaQueueTypeFilter === EVENT_TYPE_FILTER_ALL || metaEventTypeOptions.includes(metaQueueTypeFilter)) return metaEventTypeOptions;
    return [metaQueueTypeFilter, ...metaEventTypeOptions];
  }, [metaEventTypeOptions, metaQueueTypeFilter]);

  const attemptsByQueueId = useMemo(() => {
    const grouped = new Map<string, MetaAttemptRow[]>();
    for (const attempt of metaAttempts) {
      const current = grouped.get(attempt.queue_id) ?? [];
      current.push(attempt);
      grouped.set(attempt.queue_id, current);
    }
    return grouped;
  }, [metaAttempts]);

  const eventLogCountLabel = `${filteredEventLog.length} ${filteredEventLog.length === 1 ? 'resultado' : 'resultados'}`;
  const metaQueueCountLabel = `${filteredMetaQueue.length} ${filteredMetaQueue.length === 1 ? 'evento' : 'eventos'} · ${metaAttempts.length} ${metaAttempts.length === 1 ? 'tentativa' : 'tentativas'}`;

  const eventLogEmptyMessage = hasInvalidEventDateRange
    ? 'Data inicial não pode ser maior que a data final.'
    : hasEventLogFiltersActive
      ? 'Nenhum evento encontrado para os filtros informados.'
      : 'Nenhum evento registrado ainda.';

  const metaQueueEmptyMessage = hasInvalidMetaQueueDateRange
    ? 'Data inicial não pode ser maior que a data final.'
    : hasMetaQueueFiltersActive
      ? 'Nenhum item encontrado para os filtros informados.'
      : 'Nenhum item na fila ainda.';

  const hasAnyEventLogEntries = eventLog.length > 0 || eventTypeOptions.length > 0;
  const eventLogTotalPages = Math.max(1, Math.ceil(filteredEventLog.length / EVENT_LOG_PAGE_SIZE));
  const metaQueueTotalPages = Math.max(1, Math.ceil(filteredMetaQueue.length / META_QUEUE_PAGE_SIZE));

  const paginatedEventLog = useMemo(() => {
    const start = (eventLogPage - 1) * EVENT_LOG_PAGE_SIZE;
    return filteredEventLog.slice(start, start + EVENT_LOG_PAGE_SIZE);
  }, [filteredEventLog, eventLogPage]);

  const paginatedMetaQueue = useMemo(() => {
    const start = (metaQueuePage - 1) * META_QUEUE_PAGE_SIZE;
    return filteredMetaQueue.slice(start, start + META_QUEUE_PAGE_SIZE);
  }, [filteredMetaQueue, metaQueuePage]);

  const eventLogPageSummary = useMemo(
    () => getPaginationSummary(filteredEventLog.length, eventLogPage, EVENT_LOG_PAGE_SIZE, 'eventos'),
    [filteredEventLog.length, eventLogPage],
  );

  const metaQueuePageSummary = useMemo(
    () => getPaginationSummary(filteredMetaQueue.length, metaQueuePage, META_QUEUE_PAGE_SIZE, 'itens da fila'),
    [filteredMetaQueue.length, metaQueuePage],
  );

  const eventLogVisiblePages = useMemo(() => getVisiblePages(eventLogPage, eventLogTotalPages), [eventLogPage, eventLogTotalPages]);
  const metaQueueVisiblePages = useMemo(() => getVisiblePages(metaQueuePage, metaQueueTotalPages), [metaQueuePage, metaQueueTotalPages]);

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => { setEventLogPage(1); }, [eventTypeFilter, eventPeriodPreset, eventCustomStart, eventCustomEnd, eventSearch]);
  useEffect(() => { setMetaQueuePage(1); }, [metaQueueTypeFilter, metaQueuePeriodPreset, metaQueueCustomStart, metaQueueCustomEnd, metaQueueSearch]);
  useEffect(() => { if (eventLogPage > eventLogTotalPages) setEventLogPage(eventLogTotalPages); }, [eventLogPage, eventLogTotalPages]);
  useEffect(() => { if (metaQueuePage > metaQueueTotalPages) setMetaQueuePage(metaQueueTotalPages); }, [metaQueuePage, metaQueueTotalPages]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['company-event-log', companyId] });
    queryClient.invalidateQueries({ queryKey: ['company-event-types', companyId] });
    queryClient.invalidateQueries({ queryKey: ['company-meta-event-types', companyId] });
    queryClient.invalidateQueries({ queryKey: ['company-meta-queue', companyId] });
    queryClient.invalidateQueries({ queryKey: ['company-meta-attempts', companyId] });
  };

  const handleResetEventFilters = () => {
    setEventTypeFilter(EVENT_TYPE_FILTER_ALL);
    setEventPeriodPreset('all');
    setEventCustomStart('');
    setEventCustomEnd('');
    setEventSearch('');
  };

  const handleResetMetaQueueFilters = () => {
    setMetaQueueTypeFilter(EVENT_TYPE_FILTER_ALL);
    setMetaQueuePeriodPreset('all');
    setMetaQueueCustomStart('');
    setMetaQueueCustomEnd('');
    setMetaQueueSearch('');
  };

  const handleClearEventData = (scope: ClearEventDataScope) => {
    const confirmed = window.confirm(
      scope === 'meta_queue'
        ? 'Limpar todos os itens da fila Meta desta empresa?'
        : 'Limpar o log de eventos desta empresa? As métricas do período podem mudar.',
    );
    if (confirmed) clearEventDataMutation.mutate(scope);
  };

  const selectedEventSession = selectedEvent?.session ?? null;
  const selectedEventUserData = selectedEvent?.user_data_snapshot ?? null;
  const selectedEventMetadata = selectedEvent?.metadata ?? null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Eventos</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Tracking persistido no banco, histórico do funil e operação da Meta CAPI para {companyName}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="gap-2" onClick={handleRefresh}>
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

        {/* Meta CAPI settings */}
        <Card>
          <CardHeader>
            <CardTitle>Meta CAPI</CardTitle>
            <CardDescription>Configure o Pixel, token e os tipos de evento que podem entrar na fila da Meta.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {!metaConfigured && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Eventos internos continuam alimentando o funil, mas nada deve entrar na fila Meta enquanto Pixel ID,
                Access Token e Meta CAPI habilitada não estiverem configurados.
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Visita</p>
                <p className="mt-1 text-sm font-medium text-foreground"><code>page_view</code> {'->'} <code>PageView</code></p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Data e horário</p>
                <p className="mt-1 text-sm font-medium text-foreground"><code>time_select</code> {'->'} <code>InitiateCheckout</code></p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Conversão final</p>
                <p className="mt-1 text-sm font-medium text-foreground"><code>reservation_created</code> {'->'} <code>Lead</code></p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Schedule não é mais usado neste funil. A conversão final da reserva é enviada para a Meta como Lead.
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="meta-pixel-id">Pixel ID</Label>
                <Input
                  id="meta-pixel-id"
                  value={settingsForm.pixel_id}
                  onChange={(e) => setSettingsForm((c) => ({ ...c, pixel_id: e.target.value }))}
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
                  onChange={(e) => setSettingsForm((c) => ({ ...c, test_event_code: e.target.value }))}
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
                  onChange={(e) => setSettingsForm((c) => ({ ...c, access_token: e.target.value }))}
                  placeholder="EAAB..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="button" variant="outline" onClick={() => setTokenVisible((v) => !v)}>
                  {tokenVisible ? 'Ocultar' : 'Ver'}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {[
                { key: 'capi_enabled' as const, label: 'CAPI habilitada', desc: 'Ativa o envio pela fila.' },
                { key: 'send_page_view' as const, label: 'PageView', desc: 'Abertura da página pública.' },
                { key: 'send_initiate_checkout' as const, label: 'InitiateCheckout', desc: 'Data, pessoas e horário escolhidos.' },
                { key: 'send_lead' as const, label: 'Lead', desc: 'Reserva efetivada.' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="rounded-lg border border-border bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{label}</p>
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                    <Switch
                      checked={settingsForm[key]}
                      onCheckedChange={(checked) => setSettingsForm((c) => ({ ...c, [key]: checked }))}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                className="gap-2"
                onClick={() => saveSettingsMutation.mutate()}
                disabled={saveSettingsMutation.isPending}
              >
                {saveSettingsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Salvar configurações
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6">
          {/* Event log */}
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <MousePointerClick className="h-4 w-4" />
                  Log de eventos
                </CardTitle>
                <CardDescription>Últimos eventos persistidos do site e das reservas, com filtro por tipo e período.</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full gap-2 sm:w-auto"
                onClick={() => handleClearEventData('event_log')}
                disabled={clearEventDataMutation.isPending || !hasAnyEventLogEntries}
              >
                <Trash2 className="h-4 w-4" />
                Limpar
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {/* Search */}
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="event-search">Pesquisar</Label>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="event-search"
                        className="h-9 pl-8"
                        placeholder="Nome, telefone ou ID da reserva..."
                        value={eventSearch}
                        onChange={(e) => setEventSearch(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Type filter */}
                  <div className="space-y-2">
                    <Label htmlFor="event-type-filter">Tipo de evento</Label>
                    <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
                      <SelectTrigger id="event-type-filter" className="h-9">
                        <SelectValue placeholder="Todos os tipos" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={EVENT_TYPE_FILTER_ALL}>Todos os tipos</SelectItem>
                        {selectableEventTypes.map((name) => (
                          <SelectItem key={name} value={name}>{formatEventOptionLabel(name)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Period preset */}
                  <div className="space-y-2">
                    <Label htmlFor="event-period">Período</Label>
                    <Select value={eventPeriodPreset} onValueChange={(v) => setEventPeriodPreset(v as PeriodPreset)}>
                      <SelectTrigger id="event-period" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(PERIOD_PRESET_LABELS) as PeriodPreset[]).map((key) => (
                          <SelectItem key={key} value={key}>{PERIOD_PRESET_LABELS[key]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Custom date inputs */}
                  {eventPeriodPreset === 'custom' && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="event-start-date">Data inicial</Label>
                        <Input
                          id="event-start-date"
                          type="date"
                          className="h-9"
                          value={eventCustomStart}
                          max={eventCustomEnd || undefined}
                          onChange={(e) => setEventCustomStart(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="event-end-date">Data final</Label>
                        <Input
                          id="event-end-date"
                          type="date"
                          className="h-9"
                          value={eventCustomEnd}
                          min={eventCustomStart || undefined}
                          onChange={(e) => setEventCustomEnd(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  <div className="flex items-end sm:col-span-2 sm:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 w-full sm:w-auto"
                      onClick={handleResetEventFilters}
                      disabled={!hasEventLogFiltersActive}
                    >
                      Limpar filtros
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className={`text-xs ${hasInvalidEventDateRange ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {hasInvalidEventDateRange
                      ? 'Data inicial não pode ser maior que a data final.'
                      : `Exibindo até ${EVENT_LOG_LIMIT} eventos mais recentes para o recorte atual.`}
                  </p>
                  <Badge variant="outline" className="self-start sm:self-auto">{eventLogCountLabel}</Badge>
                </div>
              </div>

              <div className="overflow-x-auto">
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
                    {eventLogLoading && eventLog.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground">Carregando eventos...</TableCell>
                      </TableRow>
                    ) : filteredEventLog.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground">{eventLogEmptyMessage}</TableCell>
                      </TableRow>
                    ) : (
                      paginatedEventLog.map((event) => (
                        <TableRow
                          key={event.id}
                          role="button"
                          tabIndex={0}
                          className="cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title="Ver detalhes do evento"
                          onClick={() => setSelectedEvent(event)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedEvent(event); }
                          }}
                        >
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {formatDateTime(event.occurred_at)}
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge variant="secondary">{event.event_name}</Badge>
                                <Badge variant="outline">{event.tracking_source}</Badge>
                              </div>
                              <p className="text-xs text-muted-foreground">{formatEventDisplay(event.event_name)}</p>
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
              </div>

              {filteredEventLog.length > 0 && (
                <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-muted-foreground">
                    {eventLogPageSummary} · Página {eventLogPage} de {eventLogTotalPages}
                  </div>
                  {eventLogTotalPages > 1 && (
                    <Pagination className="justify-start sm:justify-end">
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            href="#"
                            onClick={(e) => { e.preventDefault(); if (eventLogPage > 1) setEventLogPage(eventLogPage - 1); }}
                            className={cn(eventLogPage === 1 && 'pointer-events-none opacity-50')}
                          />
                        </PaginationItem>
                        {eventLogVisiblePages.map((page, index) => (
                          <PaginationItem key={`event-log-${page}-${index}`}>
                            {page === 'ellipsis' ? <PaginationEllipsis /> : (
                              <PaginationLink
                                href="#"
                                isActive={page === eventLogPage}
                                onClick={(e) => { e.preventDefault(); setEventLogPage(page); }}
                              >
                                {page}
                              </PaginationLink>
                            )}
                          </PaginationItem>
                        ))}
                        <PaginationItem>
                          <PaginationNext
                            href="#"
                            onClick={(e) => { e.preventDefault(); if (eventLogPage < eventLogTotalPages) setEventLogPage(eventLogPage + 1); }}
                            className={cn(eventLogPage === eventLogTotalPages && 'pointer-events-none opacity-50')}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Meta queue */}
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
            <CardContent className="space-y-4">
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {/* Search */}
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="meta-search">Pesquisar</Label>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="meta-search"
                        className="h-9 pl-8"
                        placeholder="Nome, telefone ou ID da reserva..."
                        value={metaQueueSearch}
                        onChange={(e) => setMetaQueueSearch(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Type filter */}
                  <div className="space-y-2">
                    <Label htmlFor="meta-queue-type-filter">Tipo de evento</Label>
                    <Select value={metaQueueTypeFilter} onValueChange={setMetaQueueTypeFilter}>
                      <SelectTrigger id="meta-queue-type-filter" className="h-9">
                        <SelectValue placeholder="Todos os tipos" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={EVENT_TYPE_FILTER_ALL}>Todos os tipos</SelectItem>
                        {selectableMetaQueueEventTypes.map((name) => (
                          <SelectItem key={name} value={name}>{formatMetaEventOptionLabel(name)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Period preset */}
                  <div className="space-y-2">
                    <Label htmlFor="meta-queue-period">Período</Label>
                    <Select value={metaQueuePeriodPreset} onValueChange={(v) => setMetaQueuePeriodPreset(v as PeriodPreset)}>
                      <SelectTrigger id="meta-queue-period" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(PERIOD_PRESET_LABELS) as PeriodPreset[]).map((key) => (
                          <SelectItem key={key} value={key}>{PERIOD_PRESET_LABELS[key]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Custom date inputs */}
                  {metaQueuePeriodPreset === 'custom' && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="meta-queue-start-date">Data inicial</Label>
                        <Input
                          id="meta-queue-start-date"
                          type="date"
                          className="h-9"
                          value={metaQueueCustomStart}
                          max={metaQueueCustomEnd || undefined}
                          onChange={(e) => setMetaQueueCustomStart(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="meta-queue-end-date">Data final</Label>
                        <Input
                          id="meta-queue-end-date"
                          type="date"
                          className="h-9"
                          value={metaQueueCustomEnd}
                          min={metaQueueCustomStart || undefined}
                          onChange={(e) => setMetaQueueCustomEnd(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  <div className="flex items-end sm:col-span-2 sm:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 w-full sm:w-auto"
                      onClick={handleResetMetaQueueFilters}
                      disabled={!hasMetaQueueFiltersActive}
                    >
                      Limpar filtros
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className={`text-xs ${hasInvalidMetaQueueDateRange ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {hasInvalidMetaQueueDateRange
                      ? 'Data inicial não pode ser maior que a data final.'
                      : `Exibindo até ${META_QUEUE_LIMIT} itens mais recentes para o recorte atual.`}
                  </p>
                  <Badge variant="outline" className="self-start sm:self-auto">{metaQueueCountLabel}</Badge>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Evento</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead>Status atual</TableHead>
                    <TableHead>Tentativas</TableHead>
                    <TableHead>Última resposta</TableHead>
                    <TableHead className="text-right">Detalhes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metaQueueLoading && metaQueue.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">Carregando envios Meta...</TableCell>
                    </TableRow>
                  ) : filteredMetaQueue.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">{metaQueueEmptyMessage}</TableCell>
                    </TableRow>
                  ) : (
                    paginatedMetaQueue.map((item) => {
                      const itemAttempts = attemptsByQueueId.get(item.id) ?? [];
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div className="space-y-1">
                              <p className="font-medium text-foreground">{item.meta_event_name}</p>
                              <p className="text-xs text-muted-foreground">{formatDateTime(item.created_at)}</p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="min-w-[160px] space-y-1">
                              <p className="text-sm text-foreground">{formatEventDisplay(item.event_name)}</p>
                              <p className="font-mono text-xs text-muted-foreground">{item.event_name}</p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {item.status === 'sent' ? (
                                <BadgeCheck className="h-4 w-4 text-emerald-600" />
                              ) : item.status === 'failed' ? (
                                <ShieldAlert className="h-4 w-4 text-destructive" />
                              ) : (
                                <Clock3 className="h-4 w-4 text-muted-foreground" />
                              )}
                              <Badge variant={getMetaStatusBadgeVariant(item.status)}>
                                {formatMetaStatus(item.status)}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <p className="font-medium text-foreground">{item.attempts}</p>
                              <p className="text-xs text-muted-foreground">
                                {metaAttemptsLoading ? 'Carregando logs...' : `${itemAttempts.length} log(s)`}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[300px] truncate text-xs text-muted-foreground">
                            {getMetaLastResponseText(item, itemAttempts)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-2"
                              onClick={() => setSelectedPayload({
                                title: `${item.meta_event_name} · ${formatMetaStatus(item.status)}`,
                                content: buildMetaQueueDetailContent(item, itemAttempts),
                              })}
                            >
                              <Eye className="h-4 w-4" />
                              Detalhes
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>

              {filteredMetaQueue.length > 0 && (
                <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-muted-foreground">
                    {metaQueuePageSummary} · Página {metaQueuePage} de {metaQueueTotalPages}
                  </div>
                  {metaQueueTotalPages > 1 && (
                    <Pagination className="justify-start sm:justify-end">
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            href="#"
                            onClick={(e) => { e.preventDefault(); if (metaQueuePage > 1) setMetaQueuePage(metaQueuePage - 1); }}
                            className={cn(metaQueuePage === 1 && 'pointer-events-none opacity-50')}
                          />
                        </PaginationItem>
                        {metaQueueVisiblePages.map((page, index) => (
                          <PaginationItem key={`meta-queue-${page}-${index}`}>
                            {page === 'ellipsis' ? <PaginationEllipsis /> : (
                              <PaginationLink
                                href="#"
                                isActive={page === metaQueuePage}
                                onClick={(e) => { e.preventDefault(); setMetaQueuePage(page); }}
                              >
                                {page}
                              </PaginationLink>
                            )}
                          </PaginationItem>
                        ))}
                        <PaginationItem>
                          <PaginationNext
                            href="#"
                            onClick={(e) => { e.preventDefault(); if (metaQueuePage < metaQueueTotalPages) setMetaQueuePage(metaQueuePage + 1); }}
                            className={cn(metaQueuePage === metaQueueTotalPages && 'pointer-events-none opacity-50')}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Event detail dialog */}
      <Dialog open={!!selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto overflow-x-hidden sm:max-w-[min(90vw,56rem)]">
          {selectedEvent && (
            <>
              <DialogHeader>
                <DialogTitle>Detalhes do evento</DialogTitle>
              </DialogHeader>
              <div className="min-w-0 space-y-4">
                <div className="rounded-lg border border-border bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{selectedEvent.event_name}</Badge>
                    <Badge variant="outline">{selectedEvent.tracking_source}</Badge>
                    <Badge variant={formatMetaMapping(selectedEvent.event_name) === 'Não envia para Meta' ? 'outline' : 'default'}>
                      Meta: {formatMetaMapping(selectedEvent.event_name)}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{formatEventDisplay(selectedEvent.event_name)}</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-border p-4">
                    <h3 className="text-sm font-semibold text-foreground">Evento</h3>
                    <div className="mt-3 grid gap-3">
                      <DetailItem label="Quando" value={formatDateTime(selectedEvent.occurred_at)} />
                      <DetailItem label="Etapa interna" value={selectedEvent.step ?? selectedEvent.event_name} />
                      <DetailItem label="ID do evento" value={selectedEvent.event_id} mono />
                      <DetailItem label="Reserva" value={selectedEvent.reservation_id} mono />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border p-4">
                    <h3 className="text-sm font-semibold text-foreground">Sessão e dispositivo</h3>
                    <div className="mt-3 grid gap-3">
                      <DetailItem label="Visitor ID" value={selectedEvent.anonymous_id} mono />
                      <DetailItem label="Sessão" value={selectedEvent.session_id} mono />
                      <DetailItem label="IP" value={selectedEventSession?.ip_address} mono />
                      <DetailItem label="Idioma" value={selectedEventSession?.accept_language} />
                      <DetailItem label="Navegador" value={selectedEventSession?.user_agent} />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border p-4">
                    <h3 className="text-sm font-semibold text-foreground">Origem</h3>
                    <div className="mt-3 grid gap-3">
                      <DetailItem label="Página do evento" value={selectedEvent.path ?? selectedEvent.page_url} mono />
                      <DetailItem label="URL completa" value={selectedEvent.event_source_url ?? selectedEvent.page_url} mono />
                      <DetailItem label="Primeira página da sessão" value={selectedEventSession?.first_page_url} mono />
                      <DetailItem label="Referenciador" value={selectedEvent.referrer ?? selectedEventSession?.referrer} mono />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border p-4">
                    <h3 className="text-sm font-semibold text-foreground">Campanha e local</h3>
                    <div className="mt-3 grid gap-3">
                      <DetailItem label="UTM source" value={getSessionAttributionValue(selectedEvent, 'utm_source')} />
                      <DetailItem label="UTM medium" value={getSessionAttributionValue(selectedEvent, 'utm_medium')} />
                      <DetailItem label="UTM campaign" value={getSessionAttributionValue(selectedEvent, 'utm_campaign')} />
                      <DetailItem label="fbclid" value={getSessionAttributionValue(selectedEvent, 'fbclid')} mono />
                      <DetailItem label="Localização" value={formatLocationFromUserData(selectedEventUserData)} />
                    </div>
                  </div>
                </div>

                <div className="min-w-0 rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold text-foreground">Dados brutos</h3>
                  <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-muted/30 p-3 text-xs text-foreground whitespace-pre-wrap break-all">
                    {buildPayloadPreview({
                      metadata: selectedEventMetadata,
                      user_data_snapshot: selectedEventUserData,
                      session: selectedEventSession,
                    }) ?? '{}'}
                  </pre>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Payload detail dialog */}
      <Dialog open={!!selectedPayload} onOpenChange={(open) => !open && setSelectedPayload(null)}>
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
