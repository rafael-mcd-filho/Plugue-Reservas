import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Table2,
} from 'lucide-react';
import { toast } from 'sonner';
import PhoneWhatsAppLink from '@/components/PhoneWhatsAppLink';
import ReservationDetailsDialog from '@/components/ReservationDetailsDialog';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import { getReservationStatusLabel, normalizeReservationStatus } from '@/lib/reservation-status';
import {
  formatBrazilPhone,
  getEmailValidationMessage,
  getPhoneValidationMessage,
  normalizeBrazilPhoneDigits,
  normalizeEmail,
} from '@/lib/validation';
import { cn } from '@/lib/utils';
import type { ReservationStatus } from '@/types/restaurant';

const DEFAULT_RESERVATION_DURATION_MINUTES = 30;
const EDITABLE_STATUS_VALUES: ReservationStatus[] = ['confirmed', 'checked_in', 'cancelled', 'no-show'];

type ReservationAvailabilityMode = 'tables' | 'capacity';
type PublicReservationScheduleSource = 'blocked' | 'date_specific' | 'date_range' | 'weekly' | 'default';
type SlotHealth = 'available' | 'near_full' | 'full' | 'over_capacity' | 'blocked' | 'configuration';
type CalendarMetricMode = 'guests' | 'reservations';

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

interface ReservationPaymentInfo {
  id: string;
  status: string;
  paid_at: string | null;
  billing_type: string | null;
  expires_at?: string | null;
}

interface Reservation {
  id: string;
  company_id: string;
  table_id: string | null;
  source: string | null;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number;
  public_tracking_code: string;
  status: ReservationStatus;
  occasion: string | null;
  notes: string | null;
  checked_in_at: string | null;
  checked_in_party_size: number | null;
  created_at: string;
  updated_at: string;
  duration_minutes: number | null;
  created_in_mode: ReservationAvailabilityMode | string | null;
  reservation_payments?: ReservationPaymentInfo[] | null;
}

interface ReservationEditForm {
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  date: string;
  time: string;
  party_size: string;
  occasion: string;
  notes: string;
}

interface RestaurantTableRow {
  id: string;
  number: number;
  capacity: number;
  section: string | null;
  status: string | null;
  table_map_id: string | null;
}

interface TableMapRow {
  id: string;
  name: string;
  is_default: boolean;
  is_enabled: boolean;
  active_from: string | null;
  active_to: string | null;
  priority: number;
}

interface PublicReservationSchedule {
  source: PublicReservationScheduleSource;
  rule_id: string | null;
  rule_name: string | null;
  block_id: string | null;
  block_name: string | null;
  slots: string[];
  max_party_size_per_reservation: number | null;
  availability_mode: ReservationAvailabilityMode;
  default_duration_minutes: number | null;
}

interface SlotReservation {
  reservation: Reservation;
  table: RestaurantTableRow | null;
  isArrival: boolean;
  isOccupying: boolean;
  countsCapacity: boolean;
  occupancyGuests: number;
}

interface CalendarCapacitySlot {
  time: string;
  endTime: string;
  durationMinutes: number;
  availabilityMode: ReservationAvailabilityMode;
  capacityLimit: number | null;
  occupiedGuests: number;
  arrivalGuests: number;
  remainingCapacity: number | null;
  arrivalRemainingCapacity: number | null;
  fillPercent: number;
  arrivalFillPercent: number;
  arrivalReservationCount: number;
  occupyingReservationCount: number;
  totalTableCount: number;
  occupiedTableCount: number;
  availableTableCount: number;
  unassignedReservationCount: number;
  reservationLimit: number | null;
  unavailableReason: string | null;
  activeTableMap: TableMapRow | null;
  health: SlotHealth;
  reservations: SlotReservation[];
}

function toTimeKey(value: string | null | undefined) {
  if (!value) return '';

  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return '';

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function sortReservationScheduleSlots(slots: string[]) {
  return Array.from(new Set(slots.map(toTimeKey).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function getDateKey(date: Date) {
  return format(date, 'yyyy-MM-dd');
}

function getCalendarMonthDays(month: Date) {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  return eachDayOfInterval({
    start: startOfWeek(monthStart, { weekStartsOn: 0 }),
    end: endOfWeek(monthEnd, { weekStartsOn: 0 }),
  });
}

function timeToMinutes(value: string) {
  const [hours, minutes] = toTimeKey(value).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes: number) {
  const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getPaidReservationPayment(reservation: Reservation) {
  return reservation.reservation_payments?.find((payment) => payment.status === 'paid') ?? null;
}

function ReservationPaymentPaidBadge({ payment }: { payment: ReservationPaymentInfo }) {
  const method = payment.billing_type === 'PIX'
    ? 'Pix'
    : payment.billing_type === 'CREDIT_CARD'
      ? 'Cartao'
      : null;

  return (
    <span
      className="inline-flex items-center rounded-full border border-success/20 bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success"
      title={method ? `Pagamento confirmado via ${method}` : 'Pagamento confirmado'}
    >
      Pago
    </span>
  );
}

function normalizeReservationRecord(reservation: Reservation) {
  return {
    ...reservation,
    status: normalizeReservationStatus(reservation.status),
    duration_minutes: reservation.duration_minutes ?? DEFAULT_RESERVATION_DURATION_MINUTES,
  };
}

function createReservationEditForm(reservation: Reservation): ReservationEditForm {
  return {
    guest_name: reservation.guest_name,
    guest_phone: formatBrazilPhone(reservation.guest_phone),
    guest_email: reservation.guest_email ?? '',
    date: reservation.date,
    time: reservation.time.slice(0, 5),
    party_size: String(reservation.party_size),
    occasion: reservation.occasion ?? '',
    notes: reservation.notes ?? '',
  };
}

async function getPublicReservationSchedule(companyId: string, date: string): Promise<PublicReservationSchedule> {
  const { data, error } = await (supabase.rpc as any)('get_public_reservation_schedule', {
    _company_id: companyId,
    _date: date,
  });

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    source: row?.source ?? 'default',
    rule_id: row?.rule_id ?? null,
    rule_name: row?.rule_name ?? null,
    block_id: row?.block_id ?? null,
    block_name: row?.block_name ?? null,
    slots: sortReservationScheduleSlots(Array.isArray(row?.slots) ? row.slots : []),
    max_party_size_per_reservation: row?.max_party_size_per_reservation == null
      ? null
      : Number(row.max_party_size_per_reservation),
    availability_mode: row?.availability_mode === 'capacity' ? 'capacity' : 'tables',
    default_duration_minutes: row?.default_duration_minutes == null ? null : Number(row.default_duration_minutes),
  };
}

function getReservationOccupancyGuests(reservation: Reservation) {
  if (reservation.status === 'checked_in' && reservation.checked_in_party_size != null) {
    return Math.max(Number(reservation.checked_in_party_size) || 0, 0);
  }

  return Math.max(Number(reservation.party_size) || 0, 0);
}

function getTableLabel(table: RestaurantTableRow | null) {
  if (!table) return 'Sem mesa definida';
  return table.section ? `Mesa ${table.number} - ${table.section}` : `Mesa ${table.number}`;
}

function getUnavailableReasonLabel(reason: string | null) {
  if (!reason) return null;

  const labels: Record<string, string> = {
    blocked: 'Bloqueado',
    party_size_limit: 'Limite por reserva',
    reservation_limit: 'Limite de reservas',
    guest_limit: 'Limite de pessoas',
    no_table: 'Sem mesa livre',
  };

  return labels[reason] ?? reason.replace(/_/g, ' ');
}

function getSlotHealthLabel(slot: CalendarCapacitySlot) {
  if (slot.health === 'blocked') return 'Bloqueado';
  if (slot.health === 'configuration') return 'Sem capacidade';
  if (slot.health === 'over_capacity') return 'Acima do limite';
  if (slot.health === 'full') return getUnavailableReasonLabel(slot.unavailableReason) ?? 'Lotado';
  if (slot.health === 'near_full') return 'Alta ocupação';
  return 'Com vagas';
}

function getSlotHealthClassName(slot: CalendarCapacitySlot) {
  if (slot.health === 'blocked') return 'border-slate-300 bg-slate-100 text-slate-700';
  if (slot.health === 'configuration') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (slot.health === 'over_capacity') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (slot.health === 'full') return 'border-rose-200 bg-rose-50 text-rose-700';
  if (slot.health === 'near_full') return 'border-orange-200 bg-orange-50 text-orange-700';
  return 'border-emerald-200 bg-emerald-50 text-emerald-700';
}

function getSlotFillClassName(slot: CalendarCapacitySlot) {
  if (slot.health === 'blocked') return 'bg-slate-400';
  if (slot.health === 'configuration') return 'bg-amber-500';
  if (slot.health === 'over_capacity' || slot.health === 'full') return 'bg-rose-500';
  if (slot.health === 'near_full') return 'bg-amber-500';
  return 'bg-emerald-500';
}

function getSlotTrackClassName(slot: CalendarCapacitySlot) {
  if (slot.health === 'blocked') return 'bg-slate-100';
  if (slot.health === 'configuration') return 'bg-amber-100';
  if (slot.health === 'over_capacity' || slot.health === 'full') return 'bg-rose-100';
  if (slot.health === 'near_full') return 'bg-amber-100';
  return 'bg-emerald-100';
}

function formatCapacity(value: number | null) {
  return value == null ? '--' : String(value);
}

function formatCountLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatReservationCountLabel(count: number) {
  return formatCountLabel(count, 'reserva', 'reservas');
}

function formatGuestCountLabel(count: number) {
  return formatCountLabel(count, 'pessoa', 'pessoas');
}

function shouldShowCalendarSlotWhenHidingEmpty(slot: CalendarCapacitySlot) {
  return slot.reservations.length > 0
    || slot.occupiedGuests > 0
    || slot.health !== 'available'
    || slot.unassignedReservationCount > 0;
}

function isNowWithinCalendarSlot(slot: CalendarCapacitySlot, selectedDate: Date | undefined, now = new Date()) {
  if (!selectedDate || !isSameDay(selectedDate, now)) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const slotStart = timeToMinutes(slot.time);
  return currentMinutes >= slotStart && currentMinutes < slotStart + slot.durationMinutes;
}

function isEditableStatus(status: ReservationStatus) {
  return EDITABLE_STATUS_VALUES.includes(status);
}

// --- Fase 1: integracao com get_admin_reservation_day_capacity ---
// O calculo de capacidade por horario passou a ser feito no banco. Aqui apenas
// mapeamos o retorno da RPC para as mesmas estruturas que a UI ja consome.

interface AdminCapacityReservationJson {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number | string;
  duration_minutes: number | string | null;
  status: string;
  source: string | null;
  checked_in_at: string | null;
  checked_in_party_size: number | string | null;
  public_tracking_code: string | null;
  table_id: string | null;
  table_number: number | string | null;
  table_capacity: number | string | null;
  table_section: string | null;
  created_in_mode: string | null;
  occasion: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  reservation_payments: ReservationPaymentInfo[] | null;
  is_arrival: boolean;
  is_occupying: boolean;
}

interface AdminCapacityRow {
  time_slot: string | null;
  slot_label: string | null;
  source: string | null;
  availability_mode: string | null;
  active_table_map_id: string | null;
  active_table_map_name: string | null;
  duration_minutes: number | string | null;
  capacity_limit: number | string | null;
  occupying_guest_count: number | string | null;
  arrival_guest_count: number | string | null;
  checked_in_guest_count: number | string | null;
  remaining_capacity: number | string | null;
  arrival_reservation_count: number | string | null;
  occupying_reservation_count: number | string | null;
  total_tables: number | string | null;
  occupied_tables: number | string | null;
  available_tables: number | string | null;
  unassigned_reservation_count: number | string | null;
  reservation_limit: number | string | null;
  blocked: boolean | null;
  configuration_issue: string | null;
  status: string | null;
  reservations: AdminCapacityReservationJson[] | null;
}

function normalizeSlotHealth(status: string | null): SlotHealth {
  switch (status) {
    case 'near_full':
    case 'full':
    case 'over_capacity':
    case 'blocked':
    case 'configuration':
      return status;
    case 'missing_capacity':
      return 'configuration';
    default:
      return 'available';
  }
}

function mapCapacityReservation(raw: AdminCapacityReservationJson): Reservation {
  return normalizeReservationRecord({
    id: raw.id,
    company_id: raw.company_id,
    table_id: raw.table_id ?? null,
    source: raw.source ?? null,
    guest_name: raw.guest_name,
    guest_phone: raw.guest_phone,
    guest_email: raw.guest_email ?? null,
    date: raw.date,
    time: raw.time,
    party_size: Number(raw.party_size) || 0,
    public_tracking_code: raw.public_tracking_code ?? '',
    status: raw.status as ReservationStatus,
    occasion: raw.occasion ?? null,
    notes: raw.notes ?? null,
    checked_in_at: raw.checked_in_at ?? null,
    checked_in_party_size: raw.checked_in_party_size == null ? null : Number(raw.checked_in_party_size),
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    duration_minutes: raw.duration_minutes == null ? null : Number(raw.duration_minutes),
    created_in_mode: raw.created_in_mode ?? null,
    reservation_payments: raw.reservation_payments ?? null,
  });
}

function mapCapacitySlotReservation(raw: AdminCapacityReservationJson): SlotReservation {
  const reservation = mapCapacityReservation(raw);
  const table: RestaurantTableRow | null = raw.table_id
    ? {
        id: raw.table_id,
        number: Number(raw.table_number) || 0,
        capacity: Number(raw.table_capacity) || 0,
        section: raw.table_section ?? null,
        status: 'available',
        table_map_id: null,
      }
    : null;
  const isArrival = Boolean(raw.is_arrival);
  const isOccupying = Boolean(raw.is_occupying);
  const countsCapacity = isOccupying;

  return {
    reservation,
    table,
    isArrival,
    isOccupying,
    countsCapacity,
    occupancyGuests: countsCapacity ? getReservationOccupancyGuests(reservation) : 0,
  };
}

function mapCapacityRowToSlot(row: AdminCapacityRow): CalendarCapacitySlot {
  const time = toTimeKey(row.time_slot ?? '') || (row.time_slot ?? '').slice(0, 5);
  const durationMinutes = Number(row.duration_minutes) || DEFAULT_RESERVATION_DURATION_MINUTES;
  const rawCapacityLimit = row.capacity_limit == null ? null : Number(row.capacity_limit);
  const capacityLimit = rawCapacityLimit && rawCapacityLimit > 0 ? rawCapacityLimit : null;
  const occupiedGuests = Number(row.occupying_guest_count) || 0;
  const arrivalGuests = Number(row.arrival_guest_count) || 0;
  const remainingCapacity = row.remaining_capacity == null ? null : Number(row.remaining_capacity);
  const fillPercent = capacityLimit ? Math.min(Math.round((occupiedGuests / capacityLimit) * 100), 999) : 0;
  const arrivalFillPercent = capacityLimit ? Math.min(Math.round((arrivalGuests / capacityLimit) * 100), 999) : 0;
  const availabilityMode: ReservationAvailabilityMode = row.availability_mode === 'capacity' ? 'capacity' : 'tables';

  return {
    time,
    endTime: minutesToTime(timeToMinutes(time) + durationMinutes),
    durationMinutes,
    availabilityMode,
    capacityLimit,
    occupiedGuests,
    arrivalGuests,
    remainingCapacity,
    arrivalRemainingCapacity: capacityLimit ? Math.max(capacityLimit - arrivalGuests, 0) : null,
    fillPercent,
    arrivalFillPercent,
    arrivalReservationCount: Number(row.arrival_reservation_count) || 0,
    occupyingReservationCount: Number(row.occupying_reservation_count) || 0,
    totalTableCount: Number(row.total_tables) || 0,
    occupiedTableCount: Number(row.occupied_tables) || 0,
    availableTableCount: Number(row.available_tables) || 0,
    unassignedReservationCount: Number(row.unassigned_reservation_count) || 0,
    reservationLimit: row.reservation_limit == null ? null : Number(row.reservation_limit),
    unavailableReason: row.configuration_issue ?? null,
    activeTableMap: row.active_table_map_id
      ? {
          id: row.active_table_map_id,
          name: row.active_table_map_name ?? '',
          is_default: false,
          is_enabled: true,
          active_from: null,
          active_to: null,
          priority: 0,
        }
      : null,
    health: normalizeSlotHealth(row.status),
    reservations: (row.reservations ?? []).map(mapCapacitySlotReservation),
  };
}

const ACTIVE_CALENDAR_BADGE_STATUSES = new Set<string>(['confirmed', 'checked_in', 'pending_payment']);

export default function CalendarView() {
  const { companyId, slug } = useCompanySlug();
  const qc = useQueryClient();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  const [calendarMetricMode, setCalendarMetricMode] = useState<CalendarMetricMode>('guests');
  const [expandedSlotTime, setExpandedSlotTime] = useState<string | null>(null);
  const [hideEmptyCapacitySlots, setHideEmptyCapacitySlots] = useState(false);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [detailsReservation, setDetailsReservation] = useState<Reservation | null>(null);
  const [statusDialogReservation, setStatusDialogReservation] = useState<Reservation | null>(null);
  const [editDialogReservation, setEditDialogReservation] = useState<Reservation | null>(null);
  const [cancelReservation, setCancelReservation] = useState<Reservation | null>(null);
  const [editStatus, setEditStatus] = useState<ReservationStatus>('confirmed');
  const [checkedInPartySize, setCheckedInPartySize] = useState('1');
  const [editForm, setEditForm] = useState<ReservationEditForm | null>(null);

  const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '';

  useEffect(() => {
    setExpandedSlotTime(null);
  }, [selectedDateStr]);

  const invalidateReservationQueries = () => {
    qc.invalidateQueries({ queryKey: ['calendar-day-capacity', companyId] });
    qc.invalidateQueries({ queryKey: ['calendar-month-metrics', companyId] });
    qc.invalidateQueries({ queryKey: ['reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservation-companions'] });
    qc.invalidateQueries({ queryKey: ['reservation-event-history'] });
  };

  const syncReservationInDialogs = (updated: Reservation) => {
    setDetailsReservation((current) => (current?.id === updated.id ? updated : current));
    setStatusDialogReservation((current) => (current?.id === updated.id ? updated : current));
    setEditDialogReservation((current) => (current?.id === updated.id ? updated : current));
  };

  const {
    data: capacityRows = [],
    isLoading: capacityRowsLoading,
    isError: capacityError,
  } = useQuery({
    queryKey: ['calendar-day-capacity', companyId, selectedDateStr],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_admin_reservation_day_capacity', {
        _company_id: companyId,
        _date: selectedDateStr,
      });

      if (error) throw error;
      return ((data as AdminCapacityRow[]) ?? []);
    },
    enabled: !!companyId && !!selectedDateStr,
    refetchInterval: 30000,
  });

  // Metricas leves para os selos do calendario (apenas o mes visivel), no lugar
  // de carregar todas as reservas da empresa.
  const monthRangeKey = format(calendarMonth, 'yyyy-MM');
  const { data: monthMetricRows = [] } = useQuery({
    queryKey: ['calendar-month-metrics', companyId, monthRangeKey],
    queryFn: async () => {
      const monthDays = getCalendarMonthDays(calendarMonth);
      const start = getDateKey(monthDays[0]);
      const end = getDateKey(monthDays[monthDays.length - 1]);

      const { data, error } = await supabase
        .from('reservations' as any)
        .select('date, party_size, status')
        .eq('company_id', companyId)
        .gte('date', start)
        .lte('date', end);

      if (error) throw error;
      return ((data as any[]) ?? []) as Array<{ date: string; party_size: number; status: string }>;
    },
    enabled: !!companyId,
    staleTime: 30 * 1000,
  });

  const { data: publicSchedule, isLoading: scheduleLoading, isError: scheduleError } = useQuery({
    queryKey: ['calendar-public-schedule', companyId, selectedDateStr],
    queryFn: async () => {
      if (!companyId || !selectedDateStr) throw new Error('Data não selecionada.');
      return getPublicReservationSchedule(companyId, selectedDateStr);
    },
    enabled: !!companyId && !!selectedDateStr,
    staleTime: 30 * 1000,
  });

  const updateReservationMutation = useMutation({
    mutationFn: async () => {
      if (!editDialogReservation || !editForm) {
        throw new Error('Reserva não selecionada.');
      }

      const parsedPartySize = Number.parseInt(editForm.party_size, 10);

      // Fase 5: edicao via RPC segura (revalida capacidade/mesa) em vez de
      // gravar direto na tabela reservations.
      const { data, error } = await (supabase.rpc as any)('update_panel_reservation', {
        _reservation_id: editDialogReservation.id,
        _date: editForm.date,
        _time: `${editForm.time}:00`,
        _party_size: parsedPartySize,
        _guest_name: editForm.guest_name.trim(),
        _guest_phone: normalizeBrazilPhoneDigits(editForm.guest_phone),
        _guest_email: normalizeEmail(editForm.guest_email) || null,
        _occasion: editForm.occasion.trim() || null,
        _notes: editForm.notes.trim() || null,
        _keep_table: true,
        _allow_unassigned: true,
      });

      if (error) throw error;
      return normalizeReservationRecord((Array.isArray(data) ? data[0] : data) as Reservation);
    },
    onSuccess: (updated) => {
      invalidateReservationQueries();
      syncReservationInDialogs(updated);
      setEditDialogReservation(null);
      setEditForm(null);
      toast.success('Reserva atualizada.');
    },
    onError: () => {
      toast.error('Não foi possível atualizar a reserva.');
    },
  });

  const saveStatusMutation = useMutation({
    mutationFn: async ({ reservationId, status, checkedInCount }: {
      reservationId: string;
      status: ReservationStatus;
      checkedInCount?: number;
    }) => {
      if (status === 'checked_in') {
        const { data, error } = await (supabase as any).rpc('check_in_reservation', {
          _reservation_id: reservationId,
          _checked_in_party_size: checkedInCount,
          _companions: [],
        });

        if (error) throw error;
        return normalizeReservationRecord((Array.isArray(data) ? data[0] : data) as Reservation);
      }

      const { data, error } = await (supabase as any).rpc('update_reservation_status', {
        _reservation_id: reservationId,
        _status: status,
      });

      if (error) throw error;
      return normalizeReservationRecord((Array.isArray(data) ? data[0] : data) as Reservation);
    },
    onSuccess: (updated) => {
      invalidateReservationQueries();
      syncReservationInDialogs(updated);
      setStatusDialogReservation(null);
      setEditStatus('confirmed');
      setCheckedInPartySize('1');
      toast.success(updated.status === 'checked_in' ? 'Check-in registrado.' : 'Status atualizado.');
    },
    onError: () => {
      toast.error('Não foi possível atualizar a reserva.');
    },
  });

  const calendarMonthDays = useMemo(() => getCalendarMonthDays(calendarMonth), [calendarMonth]);

  const calendarDayMetrics = useMemo(
    () => monthMetricRows.reduce<Record<string, { guests: number; reservations: number }>>((acc, row) => {
      if (!ACTIVE_CALENDAR_BADGE_STATUSES.has(row.status)) return acc;
      const current = acc[row.date] ?? { guests: 0, reservations: 0 };
      current.guests += Number(row.party_size) || 0;
      current.reservations += 1;
      acc[row.date] = current;
      return acc;
    }, {}),
    [monthMetricRows],
  );

  const daySlots = useMemo(
    () => capacityRows
      .filter((row) => row.time_slot !== null)
      .map(mapCapacityRowToSlot),
    [capacityRows],
  );

  const offScheduleReservations = useMemo(() => {
    const offScheduleRow = capacityRows.find((row) => row.time_slot === null);
    return (offScheduleRow?.reservations ?? []).map(mapCapacityReservation);
  }, [capacityRows]);

  const daySummary = useMemo(() => {
    const reservationCount = daySlots.reduce((sum, slot) => sum + slot.arrivalReservationCount, 0)
      + offScheduleReservations.length;
    const arrivalGuests = daySlots.reduce((sum, slot) => sum + slot.arrivalGuests, 0)
      + offScheduleReservations.reduce((sum, reservation) => sum + reservation.party_size, 0);
    const offScheduleGuests = offScheduleReservations.reduce((sum, reservation) => sum + getReservationOccupancyGuests(reservation), 0);
    const avgFill = daySlots.length > 0
      ? Math.round(daySlots.reduce((sum, slot) => sum + Math.min(slot.fillPercent, 100), 0) / daySlots.length)
      : 0;

    return {
      reservationCount,
      arrivalGuests,
      offScheduleGuests,
      avgFill,
    };
  }, [daySlots, offScheduleReservations]);

  const visibleDaySlots = useMemo(
    () => (hideEmptyCapacitySlots
      ? daySlots.filter(shouldShowCalendarSlotWhenHidingEmpty)
      : daySlots),
    [daySlots, hideEmptyCapacitySlots],
  );

  useEffect(() => {
    if (!expandedSlotTime || expandedSlotTime === 'off-schedule') return;

    if (!visibleDaySlots.some((slot) => slot.time === expandedSlotTime)) {
      setExpandedSlotTime(null);
    }
  }, [expandedSlotTime, visibleDaySlots]);

  const capacityLoading = capacityRowsLoading || scheduleLoading;
  const dayEmptyMessage = 'Nenhuma reserva ativa nesta data';
  const scheduleWarningVisible = capacityError || scheduleError;
  const blockedWithoutSlots = publicSchedule?.source === 'blocked' && daySlots.length === 0;

  const openDetails = (reservation: Reservation) => {
    setDetailsReservation(reservation);
    setDetailsDialogOpen(true);
  };

  const openStatusDialog = (reservation: Reservation, status?: ReservationStatus) => {
    setStatusDialogReservation(reservation);
    setEditStatus(status ?? reservation.status);
    setCheckedInPartySize(String(reservation.checked_in_party_size ?? reservation.party_size));
  };

  const openEditDialog = (reservation: Reservation) => {
    setEditDialogReservation(reservation);
    setEditForm(createReservationEditForm(reservation));
  };

  const handleStatusDialogChange = (open: boolean) => {
    if (open) {
      return;
    }

    setStatusDialogReservation(null);
    setEditStatus('confirmed');
    setCheckedInPartySize('1');
  };

  const handleEditDialogChange = (open: boolean) => {
    if (open) {
      return;
    }

    setEditDialogReservation(null);
    setEditForm(null);
  };

  const handleSaveStatus = () => {
    if (!statusDialogReservation) {
      return;
    }

    if (!isEditableStatus(editStatus)) {
      toast.error('Selecione um status operacional antes de salvar.');
      return;
    }

    if (editStatus === 'checked_in') {
      const parsedCheckedInCount = Number.parseInt(checkedInPartySize, 10);

      if (Number.isNaN(parsedCheckedInCount) || parsedCheckedInCount < 1 || parsedCheckedInCount > 50) {
        toast.error('Informe uma quantidade presente válida.');
        return;
      }

      saveStatusMutation.mutate({
        reservationId: statusDialogReservation.id,
        status: editStatus,
        checkedInCount: parsedCheckedInCount,
      });
      return;
    }

    saveStatusMutation.mutate({
      reservationId: statusDialogReservation.id,
      status: editStatus,
    });
  };

  const handleSaveReservation = () => {
    if (!editForm) {
      return;
    }

    if (!editForm.guest_name.trim()) {
      toast.error('Informe o nome do cliente.');
      return;
    }

    const phoneError = getPhoneValidationMessage(editForm.guest_phone, 'o WhatsApp do cliente', true);
    if (phoneError) {
      toast.error(phoneError);
      return;
    }

    const emailError = getEmailValidationMessage(editForm.guest_email, 'o e-mail do cliente');
    if (emailError) {
      toast.error(emailError);
      return;
    }

    const parsedPartySize = Number.parseInt(editForm.party_size, 10);
    if (Number.isNaN(parsedPartySize) || parsedPartySize < 1 || parsedPartySize > 50) {
      toast.error('Informe uma quantidade válida de pessoas.');
      return;
    }

    if (!editForm.date || !editForm.time) {
      toast.error('Informe a data e o horário da reserva.');
      return;
    }

    updateReservationMutation.mutate();
  };

  const handleCalendarDateSelect = (date: Date) => {
    setSelectedDate(date);
    setCalendarMonth(startOfMonth(date));
  };

  const handleCalendarMonthChange = (months: number) => {
    setCalendarMonth((current) => addMonths(current, months));
  };

  if (capacityRowsLoading && capacityRows.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <div className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
          <div className="mt-2 h-5 w-80 max-w-full animate-pulse rounded bg-muted" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <Card className="w-fit border-none shadow-sm">
            <CardContent className="pt-6">
              <div className="h-[330px] w-[310px] animate-pulse rounded-md bg-muted" />
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <div className="h-7 w-72 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-32 animate-pulse rounded-xl bg-muted" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Calendário</h1>
          <p className="mt-1 text-sm text-muted-foreground">Selecione um dia para acompanhar vagas, ocupação e reservas por horário.</p>
        </div>

        <div className="grid gap-4 xl:grid-cols-[430px_minmax(0,1fr)]">
          <div className="space-y-3">
            <Card className="rounded-lg border border-border/60 shadow-sm">
              <CardContent className="p-2.5">
                <div className="mb-2 flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Mês anterior"
                    onClick={() => handleCalendarMonthChange(-1)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <p className="text-sm font-semibold capitalize">
                    {format(calendarMonth, 'MMMM yyyy', { locale: ptBR })}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Próximo mês"
                    onClick={() => handleCalendarMonthChange(1)}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-muted-foreground">
                  {WEEKDAY_LABELS.map((weekday) => (
                    <div key={weekday} className="py-0.5">
                      {weekday}
                    </div>
                  ))}
                </div>

                <div className="mt-1 grid grid-cols-7 gap-1">
                  {calendarMonthDays.map((date) => {
                    const dateKey = getDateKey(date);
                    const metrics = calendarDayMetrics[dateKey] ?? { guests: 0, reservations: 0 };
                    const metricValue = calendarMetricMode === 'guests' ? metrics.guests : metrics.reservations;
                    const hasMetric = metricValue > 0;
                    const isSelected = selectedDate ? isSameDay(date, selectedDate) : false;
                    const isCurrentMonth = isSameMonth(date, calendarMonth);

                    return (
                      <button
                        key={dateKey}
                        type="button"
                        onClick={() => handleCalendarDateSelect(date)}
                        className={cn(
                          'group grid h-[54px] min-w-0 grid-rows-[32px_22px] overflow-hidden rounded-md border text-center outline-none transition',
                          'hover:border-primary/40 hover:bg-primary-soft/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring',
                          isSelected ? 'border-primary bg-primary-soft/40 shadow-sm ring-1 ring-primary/10' : 'border-transparent',
                          !isCurrentMonth && 'opacity-45',
                        )}
                        aria-pressed={isSelected}
                        aria-label={`${format(date, "dd 'de' MMMM", { locale: ptBR })}: ${hasMetric ? metricValue : 0} ${calendarMetricMode === 'guests' ? 'pessoas' : 'reservas'}`}
                      >
                        <span
                          className={cn(
                            'flex items-center justify-center bg-secondary/70 text-xs font-semibold tabular-nums text-foreground',
                            !isCurrentMonth && 'text-muted-foreground',
                            isSelected && 'bg-primary-soft text-primary',
                          )}
                        >
                          {format(date, 'd')}
                        </span>
                        <span
                          className={cn(
                            'flex items-center justify-center text-[11px] font-medium tabular-nums',
                            calendarMetricMode === 'guests' ? 'bg-primary/10 text-primary' : 'bg-success-soft text-success',
                            !hasMetric && 'bg-muted/30 text-muted-foreground',
                            !isCurrentMonth && 'bg-muted/50 text-muted-foreground',
                          )}
                        >
                          {hasMetric ? metricValue : '-'}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-2.5 grid rounded-lg bg-muted p-1 text-xs font-semibold">
                  <div className="grid grid-cols-2">
                    <button
                      type="button"
                      className={cn(
                        'h-8 rounded-md transition',
                        calendarMetricMode === 'guests'
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => setCalendarMetricMode('guests')}
                    >
                      Qtd de Pessoas
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'h-8 rounded-md transition',
                        calendarMetricMode === 'reservations'
                          ? 'bg-success text-success-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => setCalendarMetricMode('reservations')}
                    >
                      Qtd de Reservas
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-md border-0 bg-card/95 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.04]">
              <CardHeader className="px-3 pb-1.5 pt-3">
                <CardTitle className="text-sm font-semibold">Resumo do dia</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 px-3 pb-3 text-sm">
                <div className="flex items-center justify-between rounded bg-muted/20 px-2.5 py-1.5">
                  <span className="text-xs text-muted-foreground">Reservas ativas</span>
                  <span className="font-semibold tabular-nums">{daySummary.reservationCount}</span>
                </div>
                <div className="flex items-center justify-between rounded bg-muted/20 px-2.5 py-1.5">
                  <span className="text-xs text-muted-foreground">Pessoas</span>
                  <span className="font-semibold tabular-nums">{daySummary.arrivalGuests}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="rounded-md border-0 bg-card/95 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.04]">
            <CardHeader className="space-y-0 px-4 pb-3 pt-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-lg">
                      {selectedDate
                        ? `Capacidade em ${format(selectedDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}`
                        : 'Selecione uma data'}
                    </CardTitle>
                    <div className="flex h-7 items-center gap-1.5 rounded bg-muted/20 px-2">
                      <Switch
                        id="hide-empty-capacity-slots"
                        checked={hideEmptyCapacitySlots}
                        onCheckedChange={setHideEmptyCapacitySlots}
                        className="scale-75"
                      />
                      <Label
                        htmlFor="hide-empty-capacity-slots"
                        className="cursor-pointer whitespace-nowrap text-[11px] font-medium text-muted-foreground"
                      >
                        Ocultar vazias
                      </Label>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Horários ativos do dia com ocupação e reservas relacionadas.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
                  <div className="inline-flex min-h-7 items-center gap-1.5 rounded bg-muted/30 px-2 py-1 text-xs">
                    <span className="text-muted-foreground">Ocupação média</span>
                    <span className="font-semibold tabular-nums text-foreground">{daySummary.avgFill}%</span>
                  </div>
                  <div className="inline-flex min-h-7 items-center gap-1.5 rounded bg-muted/30 px-2 py-1 text-xs">
                    <span className="text-muted-foreground">Faixas</span>
                    <span className="font-semibold tabular-nums text-foreground">{visibleDaySlots.length}/{daySlots.length}</span>
                  </div>
                  {daySummary.offScheduleGuests > 0 && (
                    <div className="inline-flex min-h-7 items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span className="text-[11px]">Fora dos horários</span>
                      <span className="text-xs font-semibold tabular-nums">{daySummary.offScheduleGuests}</span>
                    </div>
                  )}
                </div>
              </div>
            </CardHeader>

            <CardContent className="px-3 pb-4 sm:px-4">
              {scheduleWarningVisible && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  Não foi possível carregar a capacidade deste dia. Tente novamente em instantes.
                </div>
              )}

              {capacityLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="h-32 animate-pulse rounded-xl bg-muted" />
                  ))}
                </div>
              ) : blockedWithoutSlots ? (
                <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
                  <p className="font-medium text-foreground">Dia bloqueado</p>
                  <p className="mt-1 text-sm text-muted-foreground">Não há horários publicados para esta data.</p>
                </div>
              ) : capacityError ? (
                <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/40 px-6 py-10 text-center">
                  <p className="font-medium text-foreground">Não foi possível carregar a capacidade deste dia</p>
                  <p className="mt-1 text-sm text-muted-foreground">Verifique a conexão e tente novamente em instantes.</p>
                </div>
              ) : daySlots.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
                  <p className="font-medium text-foreground">{dayEmptyMessage}</p>
                  <p className="mt-1 text-sm text-muted-foreground">Quando houver horários configurados ou reservas, eles aparecem aqui.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {offScheduleReservations.length > 0 && (
                    <section className="overflow-hidden rounded-md bg-background/92 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-amber-200/80">
                      <button
                        type="button"
                        aria-expanded={expandedSlotTime === 'off-schedule'}
                        onClick={() => setExpandedSlotTime((current) => (current === 'off-schedule' ? null : 'off-schedule'))}
                        className={cn(
                          'grid w-full gap-2 px-3 py-2 text-left transition sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start',
                          expandedSlotTime === 'off-schedule' ? 'border-b border-amber-200/60 bg-amber-50/70' : 'bg-amber-50/45 hover:bg-amber-50/70',
                        )}
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-stretch gap-2.5">
                            <div className="w-1 min-h-9 rounded-full bg-amber-500" />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-base font-semibold leading-tight tracking-tight text-amber-950">
                                  Fora dos horários configurados
                                </p>
                                <span className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                                  Revisar horário
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-amber-800">
                                {formatReservationCountLabel(offScheduleReservations.length)} · {formatGuestCountLabel(daySummary.offScheduleGuests)}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 sm:justify-self-end">
                          <div className="w-fit rounded border border-amber-200 bg-background/85 px-2 py-1 text-xs font-semibold tabular-nums text-amber-900">
                            {offScheduleReservations.length}
                          </div>
                          <ChevronDown className={cn('h-4 w-4 shrink-0 text-amber-800 transition-transform', expandedSlotTime === 'off-schedule' && 'rotate-180')} />
                        </div>
                      </button>

                      {expandedSlotTime === 'off-schedule' && (
                        <div className="divide-y divide-amber-200/60 bg-background">
                          {offScheduleReservations.map((reservation) => {
                            const paidPayment = getPaidReservationPayment(reservation);

                            return (
                              <div key={reservation.id} className="flex flex-col gap-3 px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold tabular-nums text-amber-800">
                                      {reservation.time.slice(0, 5)}
                                    </span>
                                    <span className="truncate text-sm font-semibold text-foreground">{reservation.guest_name}</span>
                                    <ReservationStatusBadge status={reservation.status} />
                                    {paidPayment && <ReservationPaymentPaidBadge payment={paidPayment} />}
                                  </div>
                                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                    <PhoneWhatsAppLink
                                      phone={reservation.guest_phone}
                                      companyId={reservation.company_id}
                                      slug={slug}
                                      reservation={reservation}
                                      phoneClassName="text-xs text-muted-foreground"
                                      linkMode="button"
                                    />
                                    <span>{formatGuestCountLabel(getReservationOccupancyGuests(reservation))}</span>
                                    <span>{reservation.duration_minutes ?? DEFAULT_RESERVATION_DURATION_MINUTES} min</span>
                                  </div>
                                </div>
                                <Button type="button" variant="outline" size="sm" onClick={() => openDetails(reservation)}>
                                  <Eye className="mr-1.5 h-3.5 w-3.5" />
                                  Detalhes
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  )}

                  {visibleDaySlots.length === 0 && (
                    <div className="rounded-md border border-dashed border-black/[0.08] bg-muted/15 px-4 py-8 text-center">
                      <p className="text-sm font-medium text-foreground">Todas as faixas vazias estão ocultas.</p>
                      <p className="mt-1 text-sm text-muted-foreground">Desative Ocultar vazias para ver todos os horários configurados.</p>
                    </div>
                  )}

                  {visibleDaySlots.map((slot) => {
                    const isExpanded = expandedSlotTime === slot.time;
                    const modeLabel = slot.availabilityMode === 'capacity' ? 'Por capacidade' : 'Por mesas';
                    const progressValue = Math.min(slot.fillPercent, 100);
                    const slotIsCurrent = isNowWithinCalendarSlot(slot, selectedDate);
                    const showSlotHealthBadge = slot.health !== 'available';
                    const hasDifferentOccupancy = slot.occupyingReservationCount !== slot.arrivalReservationCount
                      || slot.occupiedGuests !== slot.arrivalGuests;

                    return (
                      <section
                        key={slot.time}
                        className={cn(
                          'overflow-hidden rounded-md bg-background/92 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.06]',
                          isExpanded && 'ring-primary/25',
                          slotIsCurrent && 'ring-primary/20',
                        )}
                      >
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedSlotTime((current) => (current === slot.time ? null : slot.time))}
                          className={cn(
                            'grid w-full gap-2 px-3 py-2 text-left transition sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start',
                            slotIsCurrent ? 'bg-primary/[0.05]' : 'bg-muted/[0.08]',
                            isExpanded && 'border-b border-black/[0.04]',
                            !isExpanded && 'hover:bg-muted/15',
                          )}
                        >
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-stretch gap-2.5">
                              <div className={cn('w-1 min-h-9 rounded-full', getSlotFillClassName(slot))} />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-base font-semibold leading-tight tracking-tight text-foreground">
                                    {slot.time} - {slot.endTime}
                                  </p>
                                  {slotIsCurrent && (
                                    <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
                                      Agora
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {formatReservationCountLabel(slot.arrivalReservationCount)} na faixa · {formatGuestCountLabel(slot.arrivalGuests)}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="flex w-full min-w-0 items-start gap-2 sm:justify-end">
                            <div className="w-full min-w-0 space-y-1.5 sm:min-w-[15rem]">
                              <div className="flex items-center justify-between gap-3 text-[11px] leading-none text-muted-foreground">
                                <span className="truncate">
                                  <span className="font-medium text-foreground">{slot.occupiedGuests}</span>
                                  {' / '}
                                  {formatCapacity(slot.capacityLimit)} pessoas
                                </span>
                                <span className="font-semibold tabular-nums text-foreground">{slot.fillPercent}%</span>
                              </div>
                              <div className={cn('h-1.5 overflow-hidden rounded-full', getSlotTrackClassName(slot))}>
                                <div
                                  className={cn('h-full rounded-full transition-[width]', getSlotFillClassName(slot))}
                                  style={{ width: `${progressValue}%` }}
                                />
                              </div>
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="rounded border border-black/[0.05] bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  {modeLabel}
                                </span>
                                <span className="rounded border border-black/[0.05] bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                                  Reservas {slot.arrivalReservationCount}
                                </span>
                                <span className="rounded border border-black/[0.05] bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                                  Vagas {formatCapacity(slot.remainingCapacity)}
                                </span>
                                {slot.availabilityMode === 'tables' && (
                                  <span className="rounded border border-black/[0.05] bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                                    Mesas {slot.availableTableCount}/{slot.totalTableCount}
                                  </span>
                                )}
                                {slot.unassignedReservationCount > 0 && (
                                  <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                    {slot.unassignedReservationCount} sem mesa
                                  </span>
                                )}
                                {slot.reservationLimit && (
                                  <span className="rounded border border-black/[0.05] bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                                    Limite {slot.reservationLimit} reservas
                                  </span>
                                )}
                                {showSlotHealthBadge && (
                                  <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-semibold', getSlotHealthClassName(slot))}>
                                    {getSlotHealthLabel(slot)}
                                  </span>
                                )}
                              </div>
                            </div>
                            <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-180')} />
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="border-t border-border/70 bg-muted/10 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-3 py-2 text-xs">
                              <div>
                                <p className="text-xs text-muted-foreground">Reservas da faixa</p>
                                <p className="mt-0.5 font-semibold tabular-nums">{formatReservationCountLabel(slot.arrivalReservationCount)} / {formatGuestCountLabel(slot.arrivalGuests)}</p>
                              </div>
                              {hasDifferentOccupancy && (
                                <div className="rounded-md bg-muted/45 px-2.5 py-1.5">
                                  <p className="text-xs text-muted-foreground">Ocupação simultânea</p>
                                  <p className="mt-0.5 font-semibold tabular-nums">{formatReservationCountLabel(slot.occupyingReservationCount)} / {formatGuestCountLabel(slot.occupiedGuests)}</p>
                                </div>
                              )}
                            </div>

                            {slot.reservations.length === 0 ? (
                              <p className="py-4 text-center text-sm text-muted-foreground">Nenhuma reserva nesta faixa.</p>
                            ) : (
                              <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
                                {slot.reservations.map((slotReservation, index) => {
                                  const reservation = slotReservation.reservation;
                                  const detail = reservation.occasion || reservation.notes;
                                  const paidPayment = getPaidReservationPayment(reservation);

                                  return (
                                    <div
                                      key={reservation.id}
                                      className={cn(
                                        'px-3 py-2.5',
                                        index !== slot.reservations.length - 1 && 'border-b border-border/70',
                                      )}
                                    >
                                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                        <div className="min-w-0 flex-1">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold tabular-nums text-primary">
                                              {reservation.time.slice(0, 5)}
                                            </span>
                                            <span className="truncate text-sm font-semibold text-foreground">{reservation.guest_name}</span>
                                            <ReservationStatusBadge status={reservation.status} />
                                            {paidPayment && <ReservationPaymentPaidBadge payment={paidPayment} />}
                                          </div>
                                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                            <PhoneWhatsAppLink
                                              phone={reservation.guest_phone}
                                              companyId={reservation.company_id}
                                              slug={slug}
                                              reservation={reservation}
                                              phoneClassName="text-xs text-muted-foreground"
                                              linkMode="button"
                                            />
                                            <span>{formatGuestCountLabel(reservation.party_size)}</span>
                                            <span>{reservation.duration_minutes ?? DEFAULT_RESERVATION_DURATION_MINUTES} min</span>
                                            <span className="inline-flex items-center gap-1">
                                              <Table2 className="h-3.5 w-3.5" />
                                              {reservation.created_in_mode === 'capacity' ? 'Por capacidade' : getTableLabel(slotReservation.table)}
                                            </span>
                                            {detail && <span className="min-w-0 truncate">{detail}</span>}
                                          </div>
                                        </div>

                                        <div className="flex flex-wrap gap-1.5 lg:justify-end">
                                          <Button type="button" variant="outline" size="sm" onClick={() => openDetails(reservation)}>
                                            <Eye className="mr-1.5 h-3.5 w-3.5" />
                                            Detalhes
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ReservationDetailsDialog
        open={detailsDialogOpen}
        onOpenChange={setDetailsDialogOpen}
        reservation={detailsReservation}
        slug={slug}
        companyId={companyId}
        onEdit={(r) => openEditDialog(r as Reservation)}
        onStatusChange={(r) => openStatusDialog(r as Reservation)}
        onCancel={(r) => setCancelReservation(r as Reservation)}
      />

      <Dialog open={!!statusDialogReservation} onOpenChange={handleStatusDialogChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editStatus === 'checked_in' ? 'Realizar check-in' : 'Alterar status'}</DialogTitle>
          </DialogHeader>

          {statusDialogReservation && (
            <div className="space-y-4 pt-2">
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <p className="font-medium text-foreground">{statusDialogReservation.guest_name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {format(new Date(`${statusDialogReservation.date}T12:00:00`), 'dd/MM/yyyy')} as {statusDialogReservation.time.slice(0, 5)}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="calendar-reservation-status">Status</Label>
                <Select value={editStatus} onValueChange={(value) => setEditStatus(value as ReservationStatus)}>
                  <SelectTrigger id="calendar-reservation-status" aria-label="Selecionar status da reserva">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!isEditableStatus(statusDialogReservation.status) && (
                      <SelectItem value={statusDialogReservation.status} disabled>
                        {getReservationStatusLabel(statusDialogReservation.status)}
                      </SelectItem>
                    )}
                    <SelectItem value="confirmed">Confirmada</SelectItem>
                    <SelectItem value="checked_in">Check-in realizado</SelectItem>
                    <SelectItem value="cancelled">Cancelada</SelectItem>
                    <SelectItem value="no-show">No Show</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {editStatus === 'checked_in' && (
                <div className="space-y-2 rounded-2xl border border-border bg-muted/20 p-4">
                  <Label htmlFor="calendar-checked-in-party-size">Total presente</Label>
                  <Input
                    id="calendar-checked-in-party-size"
                    type="number"
                    min="1"
                    max="50"
                    value={checkedInPartySize}
                    onChange={(event) => setCheckedInPartySize(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use essa quantidade para registrar quantas pessoas realmente chegaram.
                  </p>
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={() => handleStatusDialogChange(false)}>
                  Fechar
                </Button>
                <Button type="button" onClick={handleSaveStatus} disabled={saveStatusMutation.isPending || !isEditableStatus(editStatus)}>
                  {saveStatusMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Salvando...
                    </>
                  ) : editStatus === 'checked_in' ? 'Confirmar check-in' : 'Salvar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editDialogReservation} onOpenChange={handleEditDialogChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Editar reserva</DialogTitle>
          </DialogHeader>

          {editDialogReservation && editForm && (
            <div className="space-y-4 pt-2">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-name">Nome</Label>
                  <Input
                    id="calendar-edit-name"
                    value={editForm.guest_name}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, guest_name: event.target.value } : current)
                    }
                    autoComplete="name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-phone">WhatsApp</Label>
                  <Input
                    id="calendar-edit-phone"
                    value={editForm.guest_phone}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, guest_phone: formatBrazilPhone(event.target.value) } : current)
                    }
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={15}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-email">E-mail</Label>
                  <Input
                    id="calendar-edit-email"
                    type="email"
                    value={editForm.guest_email}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, guest_email: event.target.value } : current)
                    }
                    autoComplete="email"
                    inputMode="email"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-party-size">Pessoas</Label>
                  <Input
                    id="calendar-edit-party-size"
                    type="number"
                    min="1"
                    max="50"
                    value={editForm.party_size}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, party_size: event.target.value } : current)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-date">Data</Label>
                  <Input
                    id="calendar-edit-date"
                    type="date"
                    value={editForm.date}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, date: event.target.value } : current)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-time">Horario</Label>
                  <Input
                    id="calendar-edit-time"
                    type="time"
                    value={editForm.time}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, time: event.target.value } : current)
                    }
                  />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="calendar-edit-occasion">Ocasião</Label>
                  <Input
                    id="calendar-edit-occasion"
                    value={editForm.occasion}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, occasion: event.target.value } : current)
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="calendar-edit-notes">Observações</Label>
                <Textarea
                  id="calendar-edit-notes"
                  value={editForm.notes}
                  onChange={(event) =>
                    setEditForm((current) => current ? { ...current, notes: event.target.value } : current)
                  }
                  rows={4}
                />
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={() => handleEditDialogChange(false)}>
                  Fechar
                </Button>
                <Button type="button" onClick={handleSaveReservation} disabled={updateReservationMutation.isPending}>
                  {updateReservationMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Salvando...
                    </>
                  ) : 'Salvar alterações'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!cancelReservation} onOpenChange={(open) => !open && setCancelReservation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar reserva?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelReservation
                ? `A reserva de ${cancelReservation.guest_name} sera marcada como cancelada.`
                : 'Confirme o cancelamento da reserva.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const reservation = cancelReservation;
                setCancelReservation(null);

                if (!reservation) {
                  return;
                }

                saveStatusMutation.mutate({
                  reservationId: reservation.id,
                  status: 'cancelled',
                });
              }}
            >
              Confirmar cancelamento
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
