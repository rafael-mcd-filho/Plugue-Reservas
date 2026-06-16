import { type KeyboardEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInMinutes, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Ban, CheckCircle2, ChevronDown, Clock3, Loader2, Search, Users } from 'lucide-react';
import { toast } from 'sonner';
import PhoneWhatsAppLink from '@/components/PhoneWhatsAppLink';
import ReservationDetailsDialog, { type ReservationDetails } from '@/components/ReservationDetailsDialog';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { cn } from '@/lib/utils';
import type { ReservationStatus } from '@/types/restaurant';
import { normalizePhoneDigits } from '@/lib/validation';

const DEFAULT_RESERVATION_DURATION_MINUTES = 30;
const RECENT_PENDING_PAYMENT_GRACE_MS = 2 * 60 * 1000;
const OPERATOR_RESERVATION_SELECT =
  'id, company_id, table_id, source, guest_name, guest_phone, guest_email, date, time, party_size, public_tracking_code, status, occasion, notes, checked_in_at, checked_in_party_size, created_at, updated_at, duration_minutes, created_in_mode, reservation_payments(id,status,expires_at)';
const OPERATOR_RESERVATION_LEGACY_SELECT =
  'id, company_id, table_id, source, guest_name, guest_phone, guest_email, date, time, party_size, public_tracking_code, status, occasion, notes, checked_in_at, checked_in_party_size, created_at, updated_at, reservation_payments(id,status)';

type ReservationAvailabilityMode = 'tables' | 'capacity';
type PublicReservationScheduleSource = 'blocked' | 'date_specific' | 'date_range' | 'weekly' | 'default';
type SlotHealth = 'available' | 'near_full' | 'full' | 'over_capacity' | 'blocked' | 'configuration';

interface ReservationPaymentInfo {
  id: string;
  status: string;
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
  created_in_mode?: ReservationAvailabilityMode | string | null;
  reservation_payments?: ReservationPaymentInfo[] | null;
}

interface ReservationSettings {
  reservation_duration: number | null;
  max_guests_per_slot: number | null;
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

interface SlotAvailability {
  total: number;
  occupied: number;
  available: number;
  isAvailable: boolean;
  unavailableReason: string | null;
  reservationCount: number;
  maxPartySizePerReservation: number | null;
  maxReservationsPerSlot: number | null;
  availabilityMode: ReservationAvailabilityMode;
  durationMinutes: number | null;
  maxGuestsPerSlot: number | null;
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

interface OperatorCapacitySlot {
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

interface ReservationSlotGroup {
  key: string;
  startMinutes: number;
  endMinutes: number;
  label: string;
  reservations: Reservation[];
  totalGuests: number;
  capacitySlot?: OperatorCapacitySlot;
  isOutsideConfiguredSchedule?: boolean;
}

function toPositiveNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
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

function normalizeReservationRecord(reservation: Reservation) {
  return {
    ...reservation,
    status: normalizeReservationStatus(reservation.status),
    duration_minutes: reservation.duration_minutes ?? DEFAULT_RESERVATION_DURATION_MINUTES,
  };
}

async function fetchOperatorReservations(companyId: string, date: string, selectColumns: string) {
  const { data, error } = await supabase
    .from('reservations' as any)
    .select(selectColumns)
    .eq('company_id', companyId)
    .eq('date', date)
    .order('time', { ascending: true });

  if (error) throw error;
  return ((data ?? []) as Reservation[]).map(normalizeReservationRecord).sort(sortReservations);
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

async function getSlotAvailability(companyId: string, date: string): Promise<Record<string, SlotAvailability>> {
  const { data, error } = await (supabase.rpc as any)('get_public_reservation_availability', {
    _company_id: companyId,
    _date: date,
    _party_size: 1,
  });

  if (error) throw error;

  return ((data as any[]) ?? []).reduce<Record<string, SlotAvailability>>((acc, row) => {
    const timeKey = toTimeKey(row?.time_slot);
    if (!timeKey) return acc;

    acc[timeKey] = {
      total: Number(row.total_tables) || 0,
      occupied: Number(row.occupied_tables) || 0,
      available: Number(row.available_tables) || 0,
      isAvailable: Boolean(row.available),
      unavailableReason: row.unavailable_reason ?? null,
      reservationCount: Number(row.reservation_count) || 0,
      maxPartySizePerReservation: row.max_party_size_per_reservation == null
        ? null
        : Number(row.max_party_size_per_reservation),
      maxReservationsPerSlot: row.max_reservations_per_slot == null
        ? null
        : Number(row.max_reservations_per_slot),
      availabilityMode: row.availability_mode === 'capacity' ? 'capacity' : 'tables',
      durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
      maxGuestsPerSlot: row.max_guests_per_slot == null ? null : Number(row.max_guests_per_slot),
    };

    return acc;
  }, {});
}

function sortReservations(left: Reservation, right: Reservation) {
  if (left.status === 'confirmed' && right.status !== 'confirmed') return -1;
  if (left.status !== 'confirmed' && right.status === 'confirmed') return 1;
  return left.time.localeCompare(right.time);
}

function getReservationDateTime(reservation: Reservation) {
  return new Date(`${reservation.date}T${reservation.time}`);
}

function getLateMinutes(reservation: Reservation, now: Date) {
  if (reservation.status !== 'confirmed') return null;

  const delayInMinutes = differenceInMinutes(now, getReservationDateTime(reservation));
  return delayInMinutes > 0 ? delayInMinutes : null;
}

function formatLateLabel(minutes: number) {
  if (minutes < 60) {
    return `Atrasada há ${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `Atrasada há ${hours}h`;
  }

  return `Atrasada há ${hours}h${String(remainingMinutes).padStart(2, '0')}`;
}

function getLateBadgeClassName(minutes: number) {
  if (minutes >= 30) {
    return 'border-destructive/25 bg-destructive-soft text-destructive';
  }

  if (minutes >= 10) {
    return 'border-orange-200 bg-orange-50 text-orange-800';
  }

  return 'border-amber-200 bg-amber-50 text-amber-800';
}

function getPresentGuestCount(reservation: Reservation) {
  if (reservation.status !== 'checked_in') return 0;
  return reservation.checked_in_party_size ?? reservation.party_size;
}

function getVisibleOccasionLabel(occasion: string | null | undefined) {
  const normalizedOccasion = occasion?.trim();
  if (!normalizedOccasion) return null;
  return normalizedOccasion.toLowerCase() === 'outro' ? null : normalizedOccasion;
}

function formatReservationCountLabel(count: number) {
  return `${count} ${count === 1 ? 'reserva' : 'reservas'}`;
}

function formatGuestCountLabel(count: number) {
  return `${count} ${count === 1 ? 'pessoa' : 'pessoas'}`;
}

function timeToMinutes(value: string) {
  const [hours, minutes] = toTimeKey(value).split(':').map((part) => Number(part));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes: number) {
  const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatMinutesLabel(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function buildSlotLabel(startMinutes: number, durationInMinutes: number) {
  return `${formatMinutesLabel(startMinutes)} - ${formatMinutesLabel(startMinutes + durationInMinutes)}`;
}

function groupReservationsBySlot(reservations: Reservation[], durationInMinutes: number) {
  const groups = new Map<string, ReservationSlotGroup>();

  reservations.forEach((reservation) => {
    const startMinutes = timeToMinutes(reservation.time);
    const key = String(startMinutes);

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        startMinutes,
        endMinutes: startMinutes + durationInMinutes,
        label: buildSlotLabel(startMinutes, durationInMinutes),
        reservations: [],
        totalGuests: 0,
      });
    }

    const group = groups.get(key)!;
    group.reservations.push(reservation);
    group.totalGuests += reservation.party_size;
  });

  return Array.from(groups.values()).sort((left, right) => left.startMinutes - right.startMinutes);
}

function isReservationOccupyingCapacity(reservation: Reservation, nowMs = Date.now()) {
  if (
    reservation.status === 'cancelled'
    || reservation.status === 'no-show'
    || reservation.status === 'payment_expired'
    || reservation.status === 'payment_cancelled'
  ) {
    return false;
  }

  if (reservation.status !== 'pending_payment') {
    return true;
  }

  const payments = reservation.reservation_payments ?? [];
  const hasActivePayment = payments.some((payment) => {
    if (payment.status !== 'awaiting_method' && payment.status !== 'pending') return false;
    if (!payment.expires_at) return true;
    return new Date(payment.expires_at).getTime() > nowMs;
  });

  if (hasActivePayment) return true;

  const createdAtMs = new Date(reservation.created_at).getTime();
  return payments.length === 0 && Number.isFinite(createdAtMs) && nowMs - createdAtMs <= RECENT_PENDING_PAYMENT_GRACE_MS;
}

function getReservationOccupancyGuests(reservation: Reservation) {
  if (reservation.status === 'checked_in' && reservation.checked_in_party_size != null) {
    return Math.max(Number(reservation.checked_in_party_size) || 0, 0);
  }

  return Math.max(Number(reservation.party_size) || 0, 0);
}

function reservationOverlapsSlot(
  reservation: Reservation,
  slotTime: string,
  slotDurationMinutes: number,
  fallbackReservationDurationMinutes: number,
) {
  const reservationStart = timeToMinutes(reservation.time);
  const reservationDuration = toPositiveNumber(reservation.duration_minutes) ?? fallbackReservationDurationMinutes;
  const reservationEnd = reservationStart + reservationDuration;
  const slotStart = timeToMinutes(slotTime);
  const slotEnd = slotStart + slotDurationMinutes;

  return reservationStart < slotEnd && reservationEnd > slotStart;
}

function getSlotBandDurationMinutes(slotTimes: string[], index: number, fallbackDurationMinutes: number) {
  const nextTime = slotTimes[index + 1];
  if (!nextTime) return fallbackDurationMinutes;

  const slotStart = timeToMinutes(slotTimes[index]);
  const nextSlotStart = timeToMinutes(nextTime);
  const bandDuration = nextSlotStart - slotStart;

  return bandDuration > 0 ? bandDuration : fallbackDurationMinutes;
}

function reservationStartsInSlotBand(reservation: Reservation, slotTime: string, slotDurationMinutes: number) {
  const reservationStart = timeToMinutes(reservation.time);
  const slotStart = timeToMinutes(slotTime);
  const slotEnd = slotStart + slotDurationMinutes;

  return reservationStart >= slotStart && reservationStart < slotEnd;
}

function resolveActiveTableMap(tableMaps: TableMapRow[], date: Date, time: string) {
  const [hours, minutes] = toTimeKey(time).split(':').map(Number);
  const reservationAt = new Date(date);
  reservationAt.setHours(hours || 0, minutes || 0, 0, 0);

  const specialMap = tableMaps
    .filter((tableMap) =>
      !tableMap.is_default
      && tableMap.is_enabled
      && tableMap.active_from
      && new Date(tableMap.active_from).getTime() <= reservationAt.getTime()
      && (!tableMap.active_to || new Date(tableMap.active_to).getTime() > reservationAt.getTime()))
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return (right.active_from ? new Date(right.active_from).getTime() : 0)
        - (left.active_from ? new Date(left.active_from).getTime() : 0);
    })[0];

  if (specialMap) return specialMap;
  return tableMaps.find((tableMap) => tableMap.is_default && tableMap.is_enabled) ?? null;
}

function getScopedTables(tables: RestaurantTableRow[], tableMaps: TableMapRow[], activeTableMap: TableMapRow | null) {
  const availableTables = tables.filter((table) => table.status === 'available' || !table.status);

  if (activeTableMap) {
    return availableTables.filter((table) => table.table_map_id === activeTableMap.id);
  }

  return tableMaps.length === 0 ? availableTables : [];
}

function buildOperatorCapacitySlots({
  selectedDate,
  dayReservations,
  schedule,
  availabilityByTime,
  settings,
  tables,
  tableMaps,
}: {
  selectedDate: Date;
  dayReservations: Reservation[];
  schedule: PublicReservationSchedule | undefined;
  availabilityByTime: Record<string, SlotAvailability>;
  settings: ReservationSettings | null | undefined;
  tables: RestaurantTableRow[];
  tableMaps: TableMapRow[];
}): OperatorCapacitySlot[] {
  const fallbackDuration = toPositiveNumber(settings?.reservation_duration)
    ?? toPositiveNumber(schedule?.default_duration_minutes)
    ?? DEFAULT_RESERVATION_DURATION_MINUTES;
  const reservationTimeSlots = dayReservations.map((reservation) => toTimeKey(reservation.time)).filter(Boolean);
  const scheduleSlots = sortReservationScheduleSlots(schedule?.slots ?? []);
  const slotTimes = scheduleSlots.length > 0 ? scheduleSlots : sortReservationScheduleSlots(reservationTimeSlots);
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const nowMs = Date.now();

  return slotTimes.map((time, index) => {
    const availability = availabilityByTime[time];
    const availabilityMode = availability?.availabilityMode ?? schedule?.availability_mode ?? 'tables';
    const configuredDurationMinutes = toPositiveNumber(availability?.durationMinutes)
      ?? toPositiveNumber(schedule?.default_duration_minutes)
      ?? fallbackDuration;
    const durationMinutes = scheduleSlots.length > 0
      ? getSlotBandDurationMinutes(slotTimes, index, configuredDurationMinutes)
      : configuredDurationMinutes;
    const activeTableMap = availabilityMode === 'tables' ? resolveActiveTableMap(tableMaps, selectedDate, time) : null;
    const scopedTables = availabilityMode === 'tables' ? getScopedTables(tables, tableMaps, activeTableMap) : [];
    const tableCapacity = scopedTables.reduce((sum, table) => sum + (Number(table.capacity) || 0), 0);
    const slotGuestLimit = toPositiveNumber(availability?.maxGuestsPerSlot);
    const companyGuestLimit = toPositiveNumber(settings?.max_guests_per_slot);
    const configuredGuestLimit = slotGuestLimit ?? companyGuestLimit;
    const capacityLimit = availabilityMode === 'capacity'
      ? configuredGuestLimit ?? 0
      : configuredGuestLimit
        ? Math.min(configuredGuestLimit, tableCapacity)
        : tableCapacity;

    const reservations = dayReservations
      .map<SlotReservation | null>((reservation) => {
        const isArrival = scheduleSlots.length > 0
          ? reservationStartsInSlotBand(reservation, time, durationMinutes)
          : toTimeKey(reservation.time) === time;
        const isOccupying = reservationOverlapsSlot(reservation, time, durationMinutes, fallbackDuration);

        if (!isArrival && !isOccupying) return null;

        const countsCapacity = isOccupying && isReservationOccupyingCapacity(reservation, nowMs);
        return {
          reservation,
          table: reservation.table_id ? tableById.get(reservation.table_id) ?? null : null,
          isArrival,
          isOccupying,
          countsCapacity,
          occupancyGuests: countsCapacity ? getReservationOccupancyGuests(reservation) : 0,
        };
      })
      .filter((reservation): reservation is SlotReservation => Boolean(reservation))
      .sort((left, right) => {
        if (left.isArrival !== right.isArrival) return left.isArrival ? -1 : 1;
        return left.reservation.time.localeCompare(right.reservation.time)
          || left.reservation.guest_name.localeCompare(right.reservation.guest_name);
      });

    const capacityReservations = reservations.filter((reservation) => reservation.countsCapacity);
    const occupiedGuests = capacityReservations.reduce((sum, reservation) => sum + reservation.occupancyGuests, 0);
    const arrivalReservations = reservations.filter((reservation) => reservation.isArrival);
    const arrivalGuests = arrivalReservations.reduce((sum, reservation) => sum + reservation.reservation.party_size, 0);
    const remainingCapacity = capacityLimit > 0 ? Math.max(capacityLimit - occupiedGuests, 0) : null;
    const arrivalRemainingCapacity = capacityLimit > 0 ? Math.max(capacityLimit - arrivalGuests, 0) : null;
    const fillPercent = capacityLimit > 0 ? Math.min(Math.round((occupiedGuests / capacityLimit) * 100), 999) : 0;
    const arrivalFillPercent = capacityLimit > 0 ? Math.min(Math.round((arrivalGuests / capacityLimit) * 100), 999) : 0;
    const occupiedTableIds = new Set(
      capacityReservations
        .map((reservation) => reservation.reservation.table_id)
        .filter((tableId): tableId is string => Boolean(tableId)),
    );
    const unassignedReservationCount = availabilityMode === 'tables'
      ? capacityReservations.filter((reservation) => !reservation.reservation.table_id).length
      : 0;
    const unavailableReason = availability?.unavailableReason ?? null;
    const isBlocked = schedule?.source === 'blocked' || unavailableReason === 'blocked';

    let health: SlotHealth = 'available';
    if (isBlocked) {
      health = 'blocked';
    } else if (!capacityLimit || capacityLimit <= 0) {
      health = 'configuration';
    } else if (occupiedGuests > capacityLimit) {
      health = 'over_capacity';
    } else if (remainingCapacity === 0 || unavailableReason === 'guest_limit' || unavailableReason === 'reservation_limit' || unavailableReason === 'no_table') {
      health = 'full';
    } else if (fillPercent >= 75) {
      health = 'near_full';
    }

    return {
      time,
      endTime: minutesToTime(timeToMinutes(time) + durationMinutes),
      durationMinutes,
      availabilityMode,
      capacityLimit: capacityLimit > 0 ? capacityLimit : null,
      occupiedGuests,
      arrivalGuests,
      remainingCapacity,
      arrivalRemainingCapacity,
      fillPercent,
      arrivalFillPercent,
      arrivalReservationCount: arrivalReservations.length,
      occupyingReservationCount: capacityReservations.length,
      totalTableCount: scopedTables.length,
      occupiedTableCount: occupiedTableIds.size,
      availableTableCount: Math.max(scopedTables.length - occupiedTableIds.size, 0),
      unassignedReservationCount,
      reservationLimit: availability?.maxReservationsPerSlot ?? null,
      unavailableReason,
      activeTableMap,
      health,
      reservations,
    };
  });
}

function groupReservationsByCapacitySlots(
  reservations: Reservation[],
  capacitySlots: OperatorCapacitySlot[],
  fallbackDurationInMinutes: number,
  includeEmptyCapacitySlots = false,
) {
  if (capacitySlots.length === 0) return groupReservationsBySlot(reservations, fallbackDurationInMinutes);

  const reservationIds = new Set(reservations.map((reservation) => reservation.id));
  const groupedIds = new Set<string>();
  const groups = capacitySlots
    .map<ReservationSlotGroup | null>((slot) => {
      const slotReservations = slot.reservations
        .filter((slotReservation) => slotReservation.isArrival && reservationIds.has(slotReservation.reservation.id))
        .map((slotReservation) => slotReservation.reservation)
        .sort(sortReservations);

      if (slotReservations.length === 0 && !includeEmptyCapacitySlots) return null;
      slotReservations.forEach((reservation) => groupedIds.add(reservation.id));

      return {
        key: `capacity-${slot.time}`,
        startMinutes: timeToMinutes(slot.time),
        endMinutes: timeToMinutes(slot.time) + slot.durationMinutes,
        label: `${slot.time} - ${slot.endTime}`,
        reservations: slotReservations,
        totalGuests: slotReservations.reduce((sum, reservation) => sum + reservation.party_size, 0),
        capacitySlot: slot,
      };
    })
    .filter((group): group is ReservationSlotGroup => Boolean(group));

  const orphanReservations = reservations.filter((reservation) => !groupedIds.has(reservation.id));
  const orphanGroups = groupReservationsBySlot(orphanReservations, fallbackDurationInMinutes)
    .map((group) => ({
      ...group,
      isOutsideConfiguredSchedule: true,
    }));

  return [
    ...groups,
    ...orphanGroups,
  ].sort((left, right) => left.startMinutes - right.startMinutes);
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

function getSlotHealthLabel(slot: OperatorCapacitySlot) {
  if (slot.health === 'blocked') return 'Bloqueado';
  if (slot.health === 'configuration') return 'Sem capacidade';
  if (slot.health === 'over_capacity') return 'Acima do limite';
  if (slot.health === 'full') return getUnavailableReasonLabel(slot.unavailableReason) ?? 'Lotado';
  if (slot.health === 'near_full') return 'Alta ocupacao';
  return 'Com vagas';
}

function getSlotHealthClassName(slot: OperatorCapacitySlot) {
  if (slot.health === 'blocked') return 'border-slate-200 bg-slate-50 text-slate-700';
  if (slot.health === 'configuration') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (slot.health === 'over_capacity') return 'border-destructive/20 bg-destructive-soft text-destructive';
  if (slot.health === 'full') return 'border-rose-200 bg-rose-50 text-rose-700';
  if (slot.health === 'near_full') return 'border-orange-200 bg-orange-50 text-orange-700';
  return 'border-emerald-200 bg-emerald-50 text-emerald-700';
}

function getSlotFillClassName(slot: OperatorCapacitySlot) {
  if (slot.health === 'blocked') return 'bg-slate-400';
  if (slot.health === 'configuration') return 'bg-amber-500';
  if (slot.health === 'over_capacity' || slot.health === 'full') return 'bg-rose-500';
  if (slot.health === 'near_full') return 'bg-amber-500';
  return 'bg-emerald-500';
}

function getSlotTrackClassName(slot: OperatorCapacitySlot) {
  if (slot.health === 'blocked') return 'bg-slate-100';
  if (slot.health === 'configuration') return 'bg-amber-100';
  if (slot.health === 'over_capacity' || slot.health === 'full') return 'bg-rose-100';
  if (slot.health === 'near_full') return 'bg-amber-100';
  return 'bg-emerald-100';
}

function formatCapacity(value: number | null) {
  return value == null ? '--' : String(value);
}

function isNowWithinSlot(group: ReservationSlotGroup, now: Date) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= group.startMinutes && currentMinutes < group.endMinutes;
}

export default function OperatorTodayReservations() {
  const { companyId, slug } = useCompanySlug();
  const qc = useQueryClient();
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const todayDate = useMemo(() => new Date(`${todayKey}T12:00:00`), [todayKey]);
  const [search, setSearch] = useState('');
  const [detailsReservation, setDetailsReservation] = useState<ReservationDetails | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyDetailsReservation, setHistoryDetailsReservation] = useState<ReservationDetails | null>(null);
  const [historyDetailsOpen, setHistoryDetailsOpen] = useState(false);
  const [checkInReservation, setCheckInReservation] = useState<Reservation | null>(null);
  const [noShowReservation, setNoShowReservation] = useState<Reservation | null>(null);
  const [checkedInPartySize, setCheckedInPartySize] = useState('1');
  const [expandedReservationGroupKey, setExpandedReservationGroupKey] = useState<string | null>(null);
  const [hideEmptyReservationSlots, setHideEmptyReservationSlots] = useState(true);

  const invalidateReservationQueries = () => {
    qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['operator-public-availability', companyId] });
    qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservation-companions'] });
    qc.invalidateQueries({ queryKey: ['reservation-event-history'] });
    qc.invalidateQueries({ queryKey: ['reservation-lead-history'] });
  };

  const syncReservationInDialogs = (updated: Reservation) => {
    setDetailsReservation((current) => (current?.id === updated.id ? updated : current));
    setHistoryDetailsReservation((current) => (current?.id === updated.id ? updated : current));
    setCheckInReservation((current) => (current?.id === updated.id ? updated : current));
  };

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['today-reservations', companyId, todayKey],
    queryFn: async () => {
      try {
        return await fetchOperatorReservations(companyId!, todayKey, OPERATOR_RESERVATION_SELECT);
      } catch (error) {
        console.warn('Operator reservations full select failed, retrying legacy select.', error);
        return fetchOperatorReservations(companyId!, todayKey, OPERATOR_RESERVATION_LEGACY_SELECT);
      }
    },
    enabled: !!companyId,
    refetchInterval: 30000,
  });

  const { data: reservationSettings = null } = useQuery({
    queryKey: ['operator-reservation-settings', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('reservation_duration, max_guests_per_slot')
        .eq('id', companyId!)
        .maybeSingle();

      if (error) throw error;
      return (data as ReservationSettings | null) ?? null;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: publicSchedule } = useQuery({
    queryKey: ['operator-public-schedule', companyId, todayKey],
    queryFn: async () => {
      if (!companyId) throw new Error('Empresa nao selecionada.');
      return getPublicReservationSchedule(companyId, todayKey);
    },
    enabled: !!companyId,
    staleTime: 30 * 1000,
  });

  const { data: slotAvailability = {} } = useQuery({
    queryKey: ['operator-public-availability', companyId, todayKey],
    queryFn: async () => {
      if (!companyId) throw new Error('Empresa nao selecionada.');
      return getSlotAvailability(companyId, todayKey);
    },
    enabled: !!companyId && !!publicSchedule && publicSchedule.source !== 'blocked' && publicSchedule.slots.length > 0,
    staleTime: 15 * 1000,
  });

  const { data: tableMaps = [] } = useQuery({
    queryKey: ['operator-table-maps', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('table_maps' as any)
        .select('id, name, is_default, is_enabled, active_from, active_to, priority')
        .eq('company_id', companyId)
        .order('is_default', { ascending: false })
        .order('priority', { ascending: true });

      if (error) throw error;
      return (data as any[]) as TableMapRow[];
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: tables = [] } = useQuery({
    queryKey: ['operator-restaurant-tables', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('id, number, capacity, section, status, table_map_id')
        .eq('company_id', companyId)
        .order('capacity', { ascending: true })
        .order('number', { ascending: true });

      if (error) throw error;
      return (data as any[]) as RestaurantTableRow[];
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });

  const statusMutation = useMutation({
    mutationFn: async ({
      reservationId,
      status,
      totalPresent,
    }: {
      reservationId: string;
      status: ReservationStatus;
      totalPresent?: number;
    }) => {
      if (status === 'checked_in') {
        const { data, error } = await (supabase as any).rpc('check_in_reservation', {
          _reservation_id: reservationId,
          _checked_in_party_size: totalPresent,
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
      toast.success(updated.status === 'checked_in' ? 'Check-in registrado.' : 'Reserva marcada como No-Show.');
      if (updated.status === 'checked_in') {
        setCheckInReservation(null);
        setCheckedInPartySize('1');
      }
      if (updated.status === 'no-show') {
        setNoShowReservation(null);
      }
      supabase.functions.invoke('reservation-events', {
        body: { event: updated.status === 'cancelled' ? 'reservation_cancelled' : 'status_changed', reservation: { id: updated.id } },
      }).catch((error) => console.warn('Reservation events error:', error));
    },
    onError: (_error, variables) => {
      const errorMessage = variables.status === 'no-show'
        ? 'Nao foi possivel marcar a reserva como No-Show.'
        : 'Nao foi possivel registrar o check-in.';

      toast.error(errorMessage);
      return;
      toast.error('Não foi possível registrar o check-in.');
    },
  });

  const pendingReservations = useMemo(
    () => reservations.filter((reservation) => reservation.status === 'confirmed'),
    [reservations],
  );
  const processedReservations = useMemo(
    () => reservations.filter((reservation) => reservation.status !== 'confirmed'),
    [reservations],
  );
  const summary = useMemo(
    () => ({
      total: reservations.length,
      guests: reservations.reduce((totalGuests, reservation) => totalGuests + reservation.party_size, 0),
      pending: pendingReservations.length,
      pendingGuests: pendingReservations.reduce((totalGuests, reservation) => totalGuests + reservation.party_size, 0),
      checkedIn: reservations.filter((reservation) => reservation.status === 'checked_in').length,
      checkedInGuests: reservations.reduce((totalGuests, reservation) => totalGuests + getPresentGuestCount(reservation), 0),
      issues: reservations.filter((reservation) => reservation.status === 'cancelled' || reservation.status === 'no-show').length,
    }),
    [pendingReservations, reservations],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const normalizedSearchDigits = normalizePhoneDigits(search);
  const hasActiveSearch = Boolean(normalizedSearch || normalizedSearchDigits);
  const matchesSearch = (reservation: Reservation) => {
    if (!normalizedSearch && !normalizedSearchDigits) return true;

    const matchesName = reservation.guest_name.toLowerCase().includes(normalizedSearch);
    const matchesPhone = normalizedSearchDigits.length > 0
      && normalizePhoneDigits(reservation.guest_phone).includes(normalizedSearchDigits);

    return matchesName || matchesPhone;
  };
  const filteredPendingReservations = useMemo(
    () => pendingReservations.filter(matchesSearch),
    [pendingReservations, normalizedSearch, normalizedSearchDigits],
  );
  const filteredProcessedReservations = useMemo(
    () => processedReservations.filter(matchesSearch),
    [processedReservations, normalizedSearch, normalizedSearchDigits],
  );
  const now = new Date();
  const slotDuration = Math.max(reservationSettings?.reservation_duration ?? 30, 5);
  const capacitySlots = useMemo(
    () => buildOperatorCapacitySlots({
      selectedDate: todayDate,
      dayReservations: reservations,
      schedule: publicSchedule,
      availabilityByTime: slotAvailability,
      settings: reservationSettings,
      tables,
      tableMaps,
    }),
    [publicSchedule, reservationSettings, reservations, slotAvailability, tableMaps, tables, todayDate],
  );
  const pendingReservationGroups = useMemo(
    () => groupReservationsByCapacitySlots(
      filteredPendingReservations,
      capacitySlots,
      slotDuration,
      !hasActiveSearch && !hideEmptyReservationSlots,
    ),
    [capacitySlots, filteredPendingReservations, hasActiveSearch, hideEmptyReservationSlots, slotDuration],
  );
  const processedReservationGroups = useMemo(
    () => groupReservationsByCapacitySlots(filteredProcessedReservations, capacitySlots, slotDuration, false),
    [capacitySlots, filteredProcessedReservations, slotDuration],
  );
  const summaryItems = [
    {
      label: 'Reservas',
      value: summary.total,
      hint: 'dia',
      className: 'bg-background text-foreground',
    },
    {
      label: 'Pendentes',
      value: summary.pending,
      hint: 'faltam chegar',
      className: 'bg-primary-soft text-primary',
    },
    {
      label: 'Pessoas',
      value: summary.guests,
      hint: 'previstas',
      className: 'bg-emerald-50 text-emerald-700',
    },
    {
      label: 'Check-ins',
      value: summary.checkedIn,
      hint: 'realizados',
      className: 'bg-info-soft text-info',
    },
    {
      label: 'Ocorrências',
      value: summary.issues,
      hint: 'No Show/canc.',
      className: 'bg-destructive-soft text-destructive',
    },
  ];

  const openDetails = (reservation: ReservationDetails) => {
    setDetailsReservation(reservation);
    setDetailsOpen(true);
  };

  const openHistoryDetails = (reservation: ReservationDetails) => {
    setHistoryDetailsReservation(reservation);
    setHistoryDetailsOpen(true);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, reservation: Reservation) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetails(reservation);
    }
  };

  const openCheckIn = (reservation: Reservation) => {
    setDetailsOpen(false);
    setHistoryDetailsOpen(false);
    setCheckInReservation(reservation);
    setCheckedInPartySize(String(reservation.checked_in_party_size ?? reservation.party_size));
  };

  const handleCheckInDialogChange = (open: boolean) => {
    if (open) return;
    setCheckInReservation(null);
    setCheckedInPartySize('1');
  };

  const handleConfirmCheckIn = () => {
    if (!checkInReservation) return;

    const parsedCheckedInCount = Number.parseInt(checkedInPartySize, 10);
    if (Number.isNaN(parsedCheckedInCount) || parsedCheckedInCount < 1 || parsedCheckedInCount > 50) {
      toast.error('Informe uma quantidade presente valida.');
      return;
    }

    statusMutation.mutate({
      reservationId: checkInReservation.id,
      status: 'checked_in',
      totalPresent: parsedCheckedInCount,
    });
  };

  const handleMarkNoShow = (reservation: Reservation) => {
    setNoShowReservation(null);
    statusMutation.mutate({
      reservationId: reservation.id,
      status: 'no-show',
    });
  };

  const renderPendingReservationItem = (reservation: Reservation) => {
    const lateMinutes = getLateMinutes(reservation, now);
    const visibleOccasion = getVisibleOccasionLabel(reservation.occasion);
    const hasSecondaryMeta = Boolean(visibleOccasion || reservation.notes);
    const reservationActionPending = statusMutation.isPending
      && statusMutation.variables?.reservationId === reservation.id;
    const pendingStatus = reservationActionPending ? statusMutation.variables?.status : null;

    return (
      <div
        key={reservation.id}
        role="button"
        tabIndex={0}
        onClick={() => openDetails(reservation)}
        onKeyDown={(event) => handleCardKeyDown(event, reservation)}
        className={cn(
          'group grid grid-cols-[3rem_minmax(0,1fr)] items-start px-2.5 py-2.5 text-left transition hover:bg-accent/10 sm:grid-cols-[3.75rem_minmax(0,1fr)_auto] sm:items-center sm:px-3',
          hasSecondaryMeta ? 'gap-3' : 'gap-2',
        )}
      >
        <div className="flex h-9 w-12 items-center justify-center rounded-md bg-primary/10 text-sm font-semibold tracking-tight text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          {reservation.time.slice(0, 5)}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground sm:text-[15px]">{reservation.guest_name}</p>
            {lateMinutes && (
              <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold', getLateBadgeClassName(lateMinutes))}>
                {formatLateLabel(lateMinutes)}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            <PhoneWhatsAppLink
              phone={reservation.guest_phone}
              companyId={reservation.company_id}
              slug={slug}
              reservation={reservation}
              phoneClassName="text-xs text-muted-foreground sm:text-sm"
            />
            <span
              className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground sm:text-xs"
              aria-label={`${reservation.party_size} pessoas`}
              title={`${reservation.party_size} pessoas`}
            >
              <span className="tabular-nums">{reservation.party_size}</span>
              <Users className="h-3.5 w-3.5" />
            </span>
            {visibleOccasion && (
              <span
                className="max-w-[11rem] truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:max-w-[14rem] sm:text-xs"
                title={visibleOccasion}
              >
                {visibleOccasion}
              </span>
            )}
            {reservation.notes && (
              <span
                className="rounded-md border border-dashed border-black/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:text-xs"
                title="Observacao registrada"
              >
                Obs.
              </span>
            )}
          </div>
        </div>

        <div
          className={cn(
            'col-span-2 flex gap-2 sm:col-span-1 sm:min-w-[98px] sm:justify-end sm:pt-0',
            hasSecondaryMeta ? 'pt-1' : 'pt-0',
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <Button
            type="button"
            size="icon"
            aria-label={pendingStatus === 'checked_in' ? 'Registrando check-in' : 'Realizar check-in'}
            title={pendingStatus === 'checked_in' ? 'Registrando check-in' : 'Realizar check-in'}
            className="h-9 flex-1 rounded-md sm:h-9 sm:w-9 sm:flex-none"
            onClick={() => openCheckIn(reservation)}
            disabled={reservationActionPending}
          >
            {pendingStatus === 'checked_in' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={pendingStatus === 'no-show' ? 'Marcando como no-show' : 'Marcar como no-show'}
            title={pendingStatus === 'no-show' ? 'Marcando como no-show' : 'Marcar como no-show'}
            className="h-9 flex-1 rounded-md border-destructive/25 text-destructive hover:border-destructive/35 hover:bg-destructive/5 hover:text-destructive sm:h-9 sm:w-9 sm:flex-none"
            onClick={() => setNoShowReservation(reservation)}
            disabled={reservationActionPending}
          >
            {pendingStatus === 'no-show' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Ban className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    );
  };

  const renderProcessedReservationItem = (reservation: Reservation) => {
    const visibleOccasion = getVisibleOccasionLabel(reservation.occasion);
    const hasSecondaryMeta = Boolean(visibleOccasion || reservation.notes);

    return (
      <div
        key={reservation.id}
        role="button"
        tabIndex={0}
        onClick={() => openDetails(reservation)}
        onKeyDown={(event) => handleCardKeyDown(event, reservation)}
        className={cn(
          'grid grid-cols-[3rem_minmax(0,1fr)] items-start px-2.5 py-2.5 text-left transition hover:bg-accent/10 sm:grid-cols-[3.75rem_minmax(0,1fr)] sm:items-center sm:px-3',
          hasSecondaryMeta ? 'gap-3' : 'gap-2',
        )}
      >
        <div className="flex h-9 w-12 items-center justify-center rounded-md bg-muted text-sm font-semibold tracking-tight text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          {reservation.time.slice(0, 5)}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground sm:text-[15px]">{reservation.guest_name}</p>
            <ReservationStatusBadge status={reservation.status} />
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            <PhoneWhatsAppLink
              phone={reservation.guest_phone}
              companyId={reservation.company_id}
              slug={slug}
              reservation={reservation}
              phoneClassName="text-xs text-muted-foreground sm:text-sm"
            />

            <span
              className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground sm:text-xs"
              aria-label={`${reservation.party_size} pessoas`}
              title={`${reservation.party_size} pessoas`}
            >
              <span className="tabular-nums">{reservation.party_size}</span>
              <Users className="h-3.5 w-3.5" />
            </span>

            {visibleOccasion && (
              <span
                className="max-w-[11rem] truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:max-w-[14rem] sm:text-xs"
                title={visibleOccasion}
              >
                {visibleOccasion}
              </span>
            )}

            {reservation.notes && (
              <span
                className="rounded-md border border-dashed border-black/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:text-xs"
                title="Observacao registrada"
              >
                Obs.
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderCapacitySlotSummary = (slot: OperatorCapacitySlot) => {
    const modeLabel = slot.availabilityMode === 'capacity' ? 'Por capacidade' : 'Por mesas';
    const fillWidth = `${Math.min(slot.fillPercent, 100)}%`;

    return (
      <div className="w-full min-w-0 space-y-1.5 sm:min-w-[15rem]">
        <div className="flex items-center justify-between gap-3 text-[11px] leading-none text-muted-foreground">
          <span className="truncate">
            <span className="font-medium text-foreground">{slot.occupiedGuests}</span>
            {' / '}
            {formatCapacity(slot.capacityLimit)} pessoas
          </span>
          <span className="font-semibold text-foreground">{slot.fillPercent}%</span>
        </div>

        <div className={cn('h-1.5 overflow-hidden rounded-full', getSlotTrackClassName(slot))}>
          <div className={cn('h-full rounded-full', getSlotFillClassName(slot))} style={{ width: fillWidth }} />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="rounded border border-black/[0.05] bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {modeLabel}
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
          {slot.reservationLimit != null && (
            <span className="rounded border border-black/[0.05] bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
              Limite {slot.reservationLimit} reservas
            </span>
          )}
          {slot.health !== 'available' && (
            <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-semibold', getSlotHealthClassName(slot))}>
              {getSlotHealthLabel(slot)}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderReservationGroups = (
    groups: ReservationSlotGroup[],
    options: {
      listKey: string;
      emptyTitle: string;
      emptyDescription: string;
      renderItem: (reservation: Reservation) => JSX.Element;
      accent?: 'primary' | 'neutral';
    },
  ) => {
    if (groups.length === 0) {
      return (
        <div className="rounded-md border border-dashed border-black/[0.08] bg-muted/15 px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">{options.emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{options.emptyDescription}</p>
        </div>
      );
    }

    return (
      <div className="space-y-2.5">
        {groups.map((group) => {
          const slotIsCurrent = options.accent === 'primary' && isNowWithinSlot(group, now);
          const capacitySlot = group.capacitySlot;
          const groupExpansionKey = `${options.listKey}:${group.key}`;
          const groupIsExpanded = hasActiveSearch || expandedReservationGroupKey === groupExpansionKey;

          return (
            <section
              key={group.key}
              className={cn(
                'overflow-hidden rounded-md bg-background/92 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.06]',
                slotIsCurrent && 'ring-primary/20',
              )}
            >
              <button
                type="button"
                aria-expanded={groupIsExpanded}
                onClick={() => {
                  setExpandedReservationGroupKey((current) => (
                    current === groupExpansionKey ? null : groupExpansionKey
                  ));
                }}
                className={cn(
                  'grid w-full gap-2 px-3 py-2 text-left transition sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start',
                  slotIsCurrent ? 'bg-primary/[0.05]' : 'bg-muted/[0.08]',
                  groupIsExpanded && 'border-b border-black/[0.04]',
                  !groupIsExpanded && 'hover:bg-muted/15',
                )}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-stretch gap-2.5">
                    <div
                      className={cn(
                        'w-1 min-h-9 rounded-full',
                        group.isOutsideConfiguredSchedule
                          ? 'bg-amber-500'
                          : slotIsCurrent
                            ? 'bg-primary'
                            : 'bg-primary/70',
                      )}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold leading-tight tracking-tight text-foreground">
                          {group.label}
                        </p>
                        {slotIsCurrent && (
                          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
                            Agora
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatReservationCountLabel(group.reservations.length)} chegando · {formatGuestCountLabel(group.totalGuests)}
                      </p>
                      {group.isOutsideConfiguredSchedule && (
                        <span className="mt-1 inline-flex rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          Fora dos horários configurados
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {capacitySlot ? (
                  <div className="flex w-full min-w-0 items-start gap-2 sm:justify-end">
                    {renderCapacitySlotSummary(capacitySlot)}
                    <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', groupIsExpanded && 'rotate-180')} />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 sm:justify-self-end">
                    <div className="w-fit rounded border border-black/[0.06] bg-background/85 px-2 py-1 text-xs font-semibold text-foreground">
                      {group.reservations.length}
                    </div>
                    <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', groupIsExpanded && 'rotate-180')} />
                  </div>
                )}
              </button>

              {groupIsExpanded && (
                <div className="divide-y divide-black/[0.05]">
                  {group.reservations.length > 0 ? (
                    group.reservations.map((reservation) => options.renderItem(reservation))
                  ) : (
                    <div className="px-3 py-4 text-sm text-muted-foreground">
                      Nenhuma reserva nesta faixa.
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div>
          <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
          <div className="mt-2 h-5 w-80 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-20 animate-pulse rounded-lg bg-muted" />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)]">
          <div className="h-[420px] animate-pulse rounded-lg bg-muted" />
          <div className="h-[360px] animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Check-ins de hoje</h1>
            <p className="text-sm text-muted-foreground">
              {format(new Date(`${todayKey}T12:00:00`), "EEEE, dd 'de' MMMM", { locale: ptBR })}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">Atualiza automaticamente a cada 30s</p>
        </div>

        <div className="rounded-md bg-card/80 p-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.04]">
          <div className="flex gap-1 overflow-x-auto pb-0.5 md:grid md:grid-cols-5 md:overflow-visible md:pb-0">
            {summaryItems.map((item) => (
              <div key={item.label} className="flex min-h-10 min-w-[8rem] flex-1 items-center justify-between gap-2 rounded bg-muted/25 px-2 py-1.5 md:min-w-0">
                <div className="min-w-0">
                  <p className="truncate text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {item.label}
                  </p>
                  <p className="truncate text-[11px] leading-tight text-muted-foreground">{item.hint}</p>
                </div>
                <div className={cn('inline-flex min-w-8 items-center justify-center rounded px-1.5 py-1 text-sm font-semibold tabular-nums tracking-tight sm:text-base', item.className)}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md bg-card/80 p-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.04]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar reserva por nome ou telefone..."
              className="h-9 rounded !border-transparent bg-muted/20 pl-9 text-sm shadow-none focus-visible:!ring-1 focus-visible:!ring-primary/25 focus-visible:!ring-offset-0"
              autoComplete="off"
              inputMode="search"
            />
          </div>
          {search.trim() && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Filtrando reservas por nome ou telefone.
            </p>
          )}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)]">
          <Card className="rounded-md border-0 bg-card/95 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.04]">
            <CardHeader className="space-y-0 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">Aguardando chegada</CardTitle>
                    <div className="flex h-7 items-center gap-1.5 rounded bg-muted/20 px-2">
                      <Switch
                        id="hide-empty-reservation-slots"
                        checked={hideEmptyReservationSlots}
                        onCheckedChange={setHideEmptyReservationSlots}
                        className="scale-75"
                      />
                      <Label
                        htmlFor="hide-empty-reservation-slots"
                        className="cursor-pointer whitespace-nowrap text-[11px] font-medium text-muted-foreground"
                      >
                        Ocultar vazias
                      </Label>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">Clique em uma faixa para ver as reservas.</p>
                </div>
                <span className="inline-flex min-w-8 shrink-0 items-center justify-center rounded-md bg-primary-soft px-2 py-1 text-sm font-semibold text-primary">
                  {filteredPendingReservations.length}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-2.5 px-3 pb-3">
              {hasActiveSearch && filteredPendingReservations.length === 0 ? (
                <div className="rounded-md border border-dashed border-black/[0.08] bg-muted/15 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva encontrada para essa busca.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Tente buscar por outro nome ou telefone.</p>
                </div>
              ) : pendingReservationGroups.length === 0 ? (
                <div className="rounded-md border border-dashed border-black/[0.08] bg-muted/15 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva pendente de check-in.</p>
                  <p className="mt-1 text-sm text-muted-foreground">As proximas reservas confirmadas de hoje aparecerao aqui.</p>
                </div>
              ) : (
                renderReservationGroups(pendingReservationGroups, {
                  listKey: 'pending',
                  emptyTitle: 'Nenhuma reserva pendente de check-in.',
                  emptyDescription: 'As próximas reservas confirmadas de hoje aparecerão aqui.',
                  renderItem: renderPendingReservationItem,
                  accent: 'primary',
                })
              )}
            </CardContent>
          </Card>

          <Card className="rounded-md border-0 bg-card/90 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.04]">
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 px-3 py-2.5">
              <div className="space-y-1">
                <CardTitle className="text-base">Já atualizadas</CardTitle>
                <p className="text-xs text-muted-foreground">Check-ins, cancelamentos e No Show.</p>
              </div>
              <span className="inline-flex min-w-8 items-center justify-center rounded-md bg-background px-2 py-1 text-sm font-semibold text-foreground">
                {filteredProcessedReservations.length}
              </span>
            </CardHeader>
            <CardContent className="space-y-2.5 px-3 pb-3">
              {hasActiveSearch && filteredProcessedReservations.length === 0 ? (
                <div className="rounded-md border border-dashed border-black/[0.08] bg-background/70 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhum resultado encontrado.</p>
                  <p className="mt-1 text-sm text-muted-foreground">A busca atual não encontrou reservas nesta lista.</p>
                </div>
              ) : processedReservationGroups.length === 0 ? (
                <div className="rounded-md border border-dashed border-black/[0.08] bg-background/70 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva atualizada hoje.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Check-ins, cancelamentos e No Show do dia aparecem aqui.</p>
                </div>
              ) : (
                renderReservationGroups(processedReservationGroups, {
                  listKey: 'processed',
                  emptyTitle: 'Nenhuma reserva atualizada hoje.',
                  emptyDescription: 'Check-ins, cancelamentos e No Show do dia aparecem aqui.',
                  renderItem: renderProcessedReservationItem,
                  accent: 'neutral',
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>
 
      <ReservationDetailsDialog
        open={detailsOpen}
        onOpenChange={(open) => {
          setDetailsOpen(open);
          if (!open) {
            setDetailsReservation(null);
            setHistoryDetailsOpen(false);
            setHistoryDetailsReservation(null);
          }
        }}
        reservation={detailsReservation}
        slug={slug}
        companyId={companyId}
        showEventHistory={false}
        showLeadHistory
        onReservationSelect={openHistoryDetails}
      />

      <ReservationDetailsDialog
        open={historyDetailsOpen}
        onOpenChange={(open) => {
          setHistoryDetailsOpen(open);
          if (!open) {
            setHistoryDetailsReservation(null);
          }
        }}
        reservation={historyDetailsReservation}
        slug={slug}
        companyId={companyId}
        showEventHistory={false}
        onBackToList={() => setHistoryDetailsOpen(false)}
        backLabel="Voltar para a reserva atual"
      />

      <Dialog open={!!checkInReservation} onOpenChange={handleCheckInDialogChange}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-md overflow-x-hidden sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Realizar check-in</DialogTitle>
          </DialogHeader>

          {checkInReservation && (
            <div className="space-y-4 pt-2">
              <div className="rounded-md border border-black/[0.08] bg-muted/15 p-3">
                <p className="font-medium text-foreground">{checkInReservation.guest_name}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-4 w-4" />
                    {checkInReservation.time.slice(0, 5)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-4 w-4" />
                    Reserva para {checkInReservation.party_size} pessoas
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="operator-checked-in-party-size">Total presente</Label>
                <Input
                  id="operator-checked-in-party-size"
                  type="number"
                  min="1"
                  max="50"
                  value={checkedInPartySize}
                  onChange={(event) => setCheckedInPartySize(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Ajuste somente se a quantidade que chegou for diferente da reserva original.
                </p>
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => handleCheckInDialogChange(false)}>
                  Cancelar
                </Button>
                <Button className="w-full sm:w-auto" onClick={handleConfirmCheckIn} disabled={statusMutation.isPending}>
                  {statusMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Registrando...
                    </>
                  ) : (
                    'Confirmar check-in'
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!noShowReservation} onOpenChange={(open) => !open && setNoShowReservation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marcar reserva como No-Show?</AlertDialogTitle>
            <AlertDialogDescription>
              {noShowReservation
                ? `${noShowReservation.guest_name} sera marcado como No-Show para a reserva das ${noShowReservation.time.slice(0, 5)}.`
                : 'Confirme a marcacao de No-Show para esta reserva.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusMutation.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const reservation = noShowReservation;

                if (!reservation) {
                  return;
                }

                handleMarkNoShow(reservation);
              }}
            >
              {statusMutation.isPending && statusMutation.variables?.status === 'no-show'
                ? 'Marcando...'
                : 'Confirmar No-Show'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
