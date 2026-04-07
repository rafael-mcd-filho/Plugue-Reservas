import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, addDays, isToday, isTomorrow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarIcon, ArrowLeft, ArrowRight, Clock, Users, Loader2, Check, Copy, CalendarPlus, ExternalLink, Flame, BadgeCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { getVisitorId, type TrackingSnapshot, type TrackingUserData } from '@/hooks/useFunnelTracking';

interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

interface ReservationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  companyId: string;
  companyName: string;
  openingHours: OpeningHour[];
  reservationDuration?: number;
  maxGuestsPerSlot?: number;
  initialDate?: string | null;
  initialPartySize?: number;
  onStepChange?: (step: 'date_select' | 'time_select' | 'form_fill' | 'completed') => void;
  getTrackingSnapshot?: () => Promise<TrackingSnapshot>;
  clearTrackingJourney?: () => void;
}

const OCCASIONS = ['Aniversário', 'Jantar Romântico', 'Reunião de Negócios', 'Confraternização', 'Comemoração', 'Outro'];

const MIN_PREFILL_PHONE_DIGITS = 10;

const DAY_MAP: Record<string, number> = {
  'Dom': 0, 'Seg': 1, 'Ter': 2, 'Qua': 3, 'Qui': 4, 'Sex': 5, 'Sáb': 6,
};

function generateTimeSlots(open: string, close: string, interval: number = 30): string[] {
  const slots: string[] = [];
  const [openH, openM] = open.split(':').map(Number);
  const [closeH, closeM] = close.split(':').map(Number);
  let current = openH * 60 + openM;
  const end = closeH * 60 + closeM;
  while (current < end) {
    const h = Math.floor(current / 60);
    const m = current % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    current += interval;
  }
  return slots;
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function splitGuestName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    return { first_name: null, last_name: null };
  }

  const [firstName, ...rest] = trimmed.split(/\s+/);
  return {
    first_name: firstName || null,
    last_name: rest.length > 0 ? rest.join(' ') : null,
  };
}


interface AvailableTable {
  id: string;
  number: number;
  capacity: number;
  section: string;
  table_map_id: string;
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
}

interface UrgencySlot extends SlotAvailability {
  time: string;
  fillRate: number;
}

interface ConfirmedReservation {
  id: string;
  trackingCode: string;
  trackingUrl: string;
  date: string;
  time: string;
  partySize: number;
  tableName: string;
  guestName: string;
  companyName: string;
}

export default function ReservationModal({
  open,
  onOpenChange,
  slug,
  companyId,
  companyName,
  openingHours,
  reservationDuration = 30,
  maxGuestsPerSlot = 0,
  initialDate,
  initialPartySize = 2,
  onStepChange,
  getTrackingSnapshot,
  clearTrackingJourney,
}: ReservationModalProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>();
  const [selectedTime, setSelectedTime] = useState('');
  const [selectedPartySize, setSelectedPartySize] = useState(2);
  const [selectedTableId, setSelectedTableId] = useState('');
  const [selectedTableMapId, setSelectedTableMapId] = useState('');
  const [showCalendar, setShowCalendar] = useState(false);
  const [availableTables, setAvailableTables] = useState<AvailableTable[]>([]);
  const [slotAvailability, setSlotAvailability] = useState<Record<string, SlotAvailability>>({});
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmedReservation, setConfirmedReservation] = useState<ConfirmedReservation | null>(null);
  const [form, setForm] = useState({
    name: '', email: '', birthdate: '', whatsapp: '', occasion: '', observation: '',
  });
  const [prefilledPhoneDigits, setPrefilledPhoneDigits] = useState('');
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const whatsappDigits = normalizePhone(form.whatsapp);
  const customerFoundForCurrentPhone = !!prefilledPhoneDigits && prefilledPhoneDigits === whatsappDigits;

  useEffect(() => {
    if (!open) return;

    setStep(1);
    setSelectedDate(initialDate ? new Date(`${initialDate}T12:00:00`) : undefined);
    setSelectedTime('');
    setSelectedPartySize(initialPartySize);
    setSelectedTableId('');
    setSelectedTableMapId('');
    setShowCalendar(false);
    setAvailableTables([]);
    setSlotAvailability({});
    setConfirmedReservation(null);
    setForm({ name: '', email: '', birthdate: '', whatsapp: '', occasion: '', observation: '' });
    setPrefilledPhoneDigits('');
  }, [initialDate, initialPartySize, open]);

  useEffect(() => {
    if (!open || step !== 2 || !selectedTime) return;
    onStepChange?.('time_select');
  }, [onStepChange, open, selectedTime, step]);

  useEffect(() => {
    if (!open || step !== 3) return;
    onStepChange?.('form_fill');
  }, [onStepChange, open, step]);

  const { data: companyTableMaps = [], isLoading: tableMapsLoading } = useQuery({
    queryKey: ['public-table-maps', companyId],
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
    staleTime: 0,
    gcTime: 15 * 60 * 1000,
    refetchOnMount: 'always',
  });

  const { data: allTables = [], isLoading: tablesLoading } = useQuery({
    queryKey: ['public-available-tables', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('id, number, capacity, section, table_map_id')
        .eq('company_id', companyId)
        .eq('status', 'available')
        .order('capacity', { ascending: true });
      if (error) throw error;
      return (data as any[]) as AvailableTable[];
    },
    enabled: !!companyId,
    staleTime: 0,
    gcTime: 15 * 60 * 1000,
    refetchOnMount: 'always',
  });

  const { data: blockedDates = [] } = useQuery({
    queryKey: ['blocked-dates-public', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('blocked_dates' as any)
        .select('date, all_day, start_time, end_time')
        .eq('company_id', companyId)
        .gte('date', new Date().toISOString().split('T')[0]);
      if (error) throw error;
      return data as any[];
    },
    enabled: !!companyId,
  });

  const next7Days = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) days.push(addDays(new Date(), i));
    return days;
  }, []);

  // Check if the selected date is within the next7Days range or from calendar
  const isDateInQuickSelect = useMemo(() => {
    if (!selectedDate) return false;
    return next7Days.some(d => d.toDateString() === selectedDate.toDateString());
  }, [selectedDate, next7Days]);

  const selectedDayHours = useMemo(() => {
    if (!selectedDate) return null;
    const dayIndex = selectedDate.getDay();
    const dayName = Object.entries(DAY_MAP).find(([, v]) => v === dayIndex)?.[0];
    return openingHours.find(h => h.day === dayName) || null;
  }, [selectedDate, openingHours]);

  const timeSlots = useMemo(() => {
    if (!selectedDayHours || selectedDayHours.closed) return [];
    return generateTimeSlots(selectedDayHours.open, selectedDayHours.close, reservationDuration);
  }, [selectedDayHours, reservationDuration]);

  const resolveActiveTableMap = useCallback((date: Date, time: string) => {
    const [hours, minutes] = time.split(':').map(Number);
    const reservationAt = new Date(date);
    reservationAt.setHours(hours, minutes, 0, 0);

    const specialMap = companyTableMaps
      .filter((tableMap) =>
        !tableMap.is_default &&
        tableMap.is_enabled &&
        tableMap.active_from &&
        new Date(tableMap.active_from).getTime() <= reservationAt.getTime() &&
        (!tableMap.active_to || new Date(tableMap.active_to).getTime() > reservationAt.getTime()))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (b.active_from ? new Date(b.active_from).getTime() : 0) - (a.active_from ? new Date(a.active_from).getTime() : 0);
      })[0];

    if (specialMap) return specialMap;
    return companyTableMaps.find((tableMap) => tableMap.is_default) ?? null;
  }, [companyTableMaps]);

  const getEligibleTables = useCallback((date: Date, time: string, partySize: number) => {
    const activeTableMap = resolveActiveTableMap(date, time);
    const scopedTables = activeTableMap
      ? allTables.filter((table) => table.table_map_id === activeTableMap.id)
      : companyTableMaps.length === 0
        ? allTables
        : [];

    return {
      activeTableMap,
      tables: scopedTables.filter((table) => table.capacity >= partySize),
    };
  }, [allTables, companyTableMaps.length, resolveActiveTableMap]);

  // Fetch slot availability when date changes (for step 2 vacancy indicators)
  useEffect(() => {
    if (!selectedDate || !companyId || timeSlots.length === 0) {
      setSlotAvailability({});
      return;
    }
    if (tablesLoading || tableMapsLoading) return;
    
    const fetchSlotAvailability = async () => {
      setLoadingSlots(true);
      try {
        const dateStr = format(selectedDate, 'yyyy-MM-dd');
        const { data: slotOccupancy, error: slotOccupancyError } = await supabase.rpc('get_slot_occupancy', {
          _company_id: companyId,
          _date: dateStr,
        });
        if (slotOccupancyError) throw slotOccupancyError;

        // Count occupied tables and total guests per time slot from RPC
        const occupiedBySlot: Record<string, number> = {};
        const guestsBySlot: Record<string, number> = {};
        ((slotOccupancy as any[]) || []).forEach((r: any) => {
          const timeKey = r.time_slot?.substring(0, 5) || '';
          occupiedBySlot[timeKey] = Number(r.occupied_tables) || 0;
          guestsBySlot[timeKey] = Number(r.total_guests) || 0;
        });

        // Check blocked time ranges for this date
        const dateBlocks = blockedDates.filter((bd: any) => bd.date === dateStr && !bd.all_day);

        const availability: Record<string, SlotAvailability> = {};
        timeSlots.forEach(slot => {
          const { tables: eligibleTables } = getEligibleTables(selectedDate, slot, selectedPartySize);
          const totalTables = eligibleTables.length;
          const occupied = occupiedBySlot[slot] || 0;
          let available = Math.max(0, totalTables - occupied);

          // Check if slot is within a blocked time range
          const isTimeBlocked = dateBlocks.some((bd: any) => {
            const start = bd.start_time?.substring(0, 5) || '00:00';
            const end = bd.end_time?.substring(0, 5) || '23:59';
            return slot >= start && slot < end;
          });
          if (isTimeBlocked) available = 0;

          // Check max guests per slot
          if (maxGuestsPerSlot > 0) {
            const currentGuests = guestsBySlot[slot] || 0;
            if (currentGuests + selectedPartySize > maxGuestsPerSlot) {
              available = 0;
            }
          }

          availability[slot] = { total: totalTables, occupied, available };
        });
        setSlotAvailability(availability);
      } catch (err) {
        console.error('Error fetching slot availability:', err);
      } finally {
        setLoadingSlots(false);
      }
    };

    fetchSlotAvailability();
  }, [selectedDate, companyId, selectedPartySize, timeSlots, blockedDates, maxGuestsPerSlot, tablesLoading, tableMapsLoading, getEligibleTables]);

  // Auto-assign best-fit table when time is selected
  useEffect(() => {
    if (!selectedDate || !selectedTime || step !== 2) return;
    if (tablesLoading || tableMapsLoading) return;

    if (allTables.length === 0) {
      setAvailableTables([]);
      setSelectedTableId('');
      setSelectedTableMapId('');
      return;
    }
    
    const fetchAndAssignTable = async () => {
      setLoadingTables(true);
      try {
        const dateStr = format(selectedDate, 'yyyy-MM-dd');

        const { data: occupiedTableIds, error: resErr } = await supabase
          .rpc('get_occupied_table_ids', {
            _company_id: companyId,
            _date: dateStr,
            _time: selectedTime + ':00',
          });
        if (resErr) throw resErr;

        const occupiedIds = new Set((occupiedTableIds as string[]) || []);
        const { activeTableMap, tables: eligibleTables } = getEligibleTables(selectedDate, selectedTime, selectedPartySize);
        const activeTableMapId = activeTableMap?.id ?? '';
        const available = eligibleTables.filter((table) => !occupiedIds.has(table.id));
        
        setAvailableTables(available);
        setSelectedTableMapId(activeTableMapId || available[0]?.table_map_id || '');
        // Auto-select the smallest table that fits the party (best-fit)
        if (available.length > 0) {
          setSelectedTableId(available[0].id);
        } else {
          setSelectedTableId('');
        }
      } catch (err) {
        console.error('Error fetching availability:', err);
        setAvailableTables([]);
        setSelectedTableId('');
        setSelectedTableMapId('');
      } finally {
        setLoadingTables(false);
      }
    };

    fetchAndAssignTable();
  }, [selectedDate, selectedTime, companyId, selectedPartySize, step, allTables.length, tablesLoading, tableMapsLoading, getEligibleTables]);

  const handleReset = () => {
    setStep(1);
    setSelectedDate(undefined);
    setSelectedTime('');
    setSelectedPartySize(2);
    setSelectedTableId('');
    setSelectedTableMapId('');
    setShowCalendar(false);
    setAvailableTables([]);
    setSlotAvailability({});
    setConfirmedReservation(null);
    setForm({ name: '', email: '', birthdate: '', whatsapp: '', occasion: '', observation: '' });
    setPrefilledPhoneDigits('');
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      handleReset();
      clearTrackingJourney?.();
    }
    onOpenChange(v);
  };

  const focusConfirmButton = () => {
    window.setTimeout(() => {
      const button = confirmButtonRef.current;
      if (!button) return;

      button.focus({ preventScroll: true });
      button.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 0);
  };

  const handleWhatsappBlur = async (event: React.FocusEvent<HTMLInputElement>) => {
    const normalizedPhone = normalizePhone(event.currentTarget.value);

    if (normalizedPhone.length < MIN_PREFILL_PHONE_DIGITS) {
      setPrefilledPhoneDigits('');
      return;
    }

    try {
      const { data, error } = await (supabase.rpc as any)('get_public_reservation_prefill', {
        _company_id: companyId,
        _visitor_id: getVisitorId(),
        _guest_phone: normalizedPhone,
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        setPrefilledPhoneDigits('');
        return;
      }

      const d = row as any;
      setForm(f => ({
        ...f,
        name: f.name || d.guest_name || '',
        email: f.email || d.guest_email || '',
        birthdate: f.birthdate || d.guest_birthdate || '',
      }));
      setPrefilledPhoneDigits(normalizedPhone);
      focusConfirmButton();
    } catch { /* silent */ }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.whatsapp) {
      toast.error('Preencha nome e WhatsApp');
      return;
    }
    if (!selectedDate || !selectedTime) return;

    setSubmitting(true);
    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const reservationId = crypto.randomUUID();
      const trackingCode = crypto.randomUUID().replace(/-/g, '');
      const trackingSnapshot: TrackingSnapshot = getTrackingSnapshot
        ? await getTrackingSnapshot()
        : {
            anonymous_id: getVisitorId(),
            session_id: null,
            journey_id: null,
            company_id: companyId,
            company_slug: slug,
            fbp: null,
            fbc: null,
            fbclid: null,
            utm_source: null,
            utm_medium: null,
            utm_campaign: null,
            utm_content: null,
            utm_term: null,
            page_url: typeof window !== 'undefined' ? window.location.href : null,
            path: typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : null,
            referrer: typeof document !== 'undefined' ? document.referrer || null : null,
            event_source_url: typeof window !== 'undefined' ? window.location.href : null,
            attribution_snapshot: {
              tracking_source: 'public_web',
            },
          };
      const guestNameParts = splitGuestName(form.name);
      const reservationUserData: TrackingUserData = {
        first_name: guestNameParts.first_name,
        last_name: guestNameParts.last_name,
        email: form.email || null,
        phone: form.whatsapp || null,
        zip: null,
        city: null,
        state: null,
        country: null,
        external_id: trackingSnapshot.anonymous_id,
      };

      const attributionSnapshot = {
        ...trackingSnapshot.attribution_snapshot,
        tracking_source: 'public_web',
        anonymous_id: trackingSnapshot.anonymous_id,
        session_id: trackingSnapshot.session_id,
        journey_id: trackingSnapshot.journey_id,
        page_url: trackingSnapshot.page_url,
        path: trackingSnapshot.path,
        referrer: trackingSnapshot.referrer,
        event_source_url: trackingSnapshot.event_source_url,
        fbp: trackingSnapshot.fbp,
        fbc: trackingSnapshot.fbc,
        fbclid: trackingSnapshot.fbclid,
        utm_source: trackingSnapshot.utm_source,
        utm_medium: trackingSnapshot.utm_medium,
        utm_campaign: trackingSnapshot.utm_campaign,
        utm_content: trackingSnapshot.utm_content,
        utm_term: trackingSnapshot.utm_term,
        user_data: reservationUserData,
      };
      const reservationData = {
        id: reservationId,
        public_tracking_code: trackingCode,
        company_id: companyId,
        table_id: selectedTableId || null,
        table_map_id: selectedTableMapId || null,
        guest_name: form.name,
        guest_phone: form.whatsapp,
        guest_email: form.email || null,
        guest_birthdate: form.birthdate || null,
        date: dateStr,
        time: selectedTime + ':00',
        party_size: selectedPartySize,
        duration_minutes: reservationDuration,
        occasion: form.occasion || null,
        notes: form.observation || null,
        visitor_id: trackingSnapshot.anonymous_id,
        origin_tracking_session_id: trackingSnapshot.session_id,
        origin_tracking_journey_id: trackingSnapshot.journey_id,
        origin_anonymous_id: trackingSnapshot.anonymous_id,
        origin_fbp: trackingSnapshot.fbp,
        origin_fbc: trackingSnapshot.fbc,
        attribution_snapshot: attributionSnapshot,
        status: 'confirmed',
      };

      const { error } = await supabase
        .from('reservations' as any)
        .insert(reservationData as any)
      
      if (error) throw error;

      // Fire reservation events
      supabase.functions.invoke('reservation-events', {
        body: {
          event: 'reservation_created',
          reservation: {
            id: reservationId,
            visitor_id: reservationData.visitor_id,
          },
        },
      }).catch(err => console.warn('Reservation events error:', err));

      const tableName = availableTables.find(t => t.id === selectedTableId)?.number?.toString() || '';

      setConfirmedReservation({
        id: reservationId,
        trackingCode,
        trackingUrl: `${window.location.origin}/${slug}/reserva/${trackingCode}`,
        date: dateStr,
        time: selectedTime,
        partySize: selectedPartySize,
        tableName: tableName ? `Mesa ${tableName}` : '',
        guestName: form.name,
        companyName,
      });

      clearTrackingJourney?.();
      setStep(4);
    } catch (err: any) {
      const message: string = err?.message ?? '';
      if (message.includes('Muitas tentativas')) {
        toast.error(message);
      } else {
        toast.error('Não foi possível criar a reserva. Tente novamente em instantes.');
        console.error('[ReservationModal] Submit error:', err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const isDayClosed = (date: Date) => {
    const dayIndex = date.getDay();
    const dayName = Object.entries(DAY_MAP).find(([, v]) => v === dayIndex)?.[0];
    const hours = openingHours.find(h => h.day === dayName);
    if (!hours) return true;
    if (hours.closed === true) return true;
    // Check blocked dates (all_day only for calendar disable)
    const dateStr = format(date, 'yyyy-MM-dd');
    const blocked = blockedDates.find((bd: any) => bd.date === dateStr && bd.all_day);
    return !!blocked;
  };

  const handleCalendarSelect = (d: Date | undefined) => {
    setSelectedDate(d);
    setShowCalendar(false);
  };

  const copyReservationCode = () => {
    if (confirmedReservation) {
      navigator.clipboard.writeText(confirmedReservation.id.substring(0, 8).toUpperCase());
      toast.success('Código copiado!');
    }
  };

  const copyTrackingLink = () => {
    if (confirmedReservation) {
      navigator.clipboard.writeText(confirmedReservation.trackingUrl);
      toast.success('Link de acompanhamento copiado!');
    }
  };

  const addToCalendarUrl = () => {
    if (!confirmedReservation || !selectedDate) return '#';
    const [h, m] = confirmedReservation.time.split(':').map(Number);
    const startDate = new Date(selectedDate);
    startDate.setHours(h, m, 0);
    const endDate = new Date(startDate.getTime() + reservationDuration * 60000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`Reserva - ${companyName}`)}&dates=${fmt(startDate)}/${fmt(endDate)}&details=${encodeURIComponent(`Reserva para ${confirmedReservation.partySize} pessoas${confirmedReservation.tableName ? ` · ${confirmedReservation.tableName}` : ''}`)}`;
  };

  const urgencySlots = useMemo<UrgencySlot[]>(() => {
    return timeSlots
      .map((time) => {
        const slot = slotAvailability[time];
        if (!slot || slot.total <= 0 || slot.available <= 0) return null;

        return {
          time,
          ...slot,
          fillRate: slot.occupied / slot.total,
        };
      })
      .filter((slot): slot is UrgencySlot => !!slot && (slot.available <= 2 || slot.occupied > 0))
      .sort((a, b) => {
        if (a.available !== b.available) return a.available - b.available;
        if (a.fillRate !== b.fillRate) return b.fillRate - a.fillRate;
        return a.time.localeCompare(b.time);
      })
      .slice(0, 3);
  }, [slotAvailability, timeSlots]);

  const selectedSlotAvailability = selectedTime ? slotAvailability[selectedTime] : null;
  const selectedSlotIsLow = !!selectedSlotAvailability
    && selectedSlotAvailability.available > 0
    && selectedSlotAvailability.available <= 2;
  const selectedSlotHasDemand = !!selectedSlotAvailability
    && selectedSlotAvailability.occupied > 0
    && selectedSlotAvailability.available > 0;
  const hasCriticalUrgency = urgencySlots.some((slot) => slot.available <= 2);

  const getSlotStatus = (slot: string): 'available' | 'low' | 'full' => {
    const avail = slotAvailability[slot];
    if (!avail || avail.total === 0) return 'available';
    if (avail.available === 0) return 'full';
    if (avail.available <= 2) return 'low';
    return 'available';
  };

  const getSlotSignalLabel = (slot: SlotAvailability | undefined) => {
    if (!slot || slot.available <= 0) return null;
    if (slot.available <= 2) return 'Últimas vagas';
    if (slot.occupied > 0) return 'Alta procura';
    return null;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="left-[50%] right-auto top-[50%] bottom-auto w-[calc(100vw-1.5rem)] max-w-md translate-x-[-50%] translate-y-[-50%] max-h-[88vh] overflow-y-auto data-[state=open]:slide-in-from-bottom-0 data-[state=closed]:slide-out-to-bottom-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 sm:max-w-md sm:max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="text-center text-lg font-bold text-foreground">
            {step === 4 ? 'Reserva Confirmada!' : `Reservar Mesa — ${companyName}`}
          </DialogTitle>
          {step !== 4 && (
            <div className="flex items-center justify-center gap-2 pt-2" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={3} aria-label={`Passo ${step} de 3`}>
              {[1, 2, 3].map(s => (
                <div
                  key={s}
                  className={cn(
                    'h-2 rounded-full transition-[width,background-color] duration-200',
                    s === step ? 'w-8 bg-primary' : s < step ? 'w-6 bg-primary/50' : 'w-6 bg-muted'
                  )}
                />
              ))}
            </div>
          )}
        </DialogHeader>

        {/* Step 1: Date + Party Size */}
        {step === 1 && (
          <div className="animate-fade-in space-y-4 pt-2">
            <p className="text-sm text-muted-foreground text-center">Escolha a data e número de pessoas</p>

            <div className="flex items-center justify-center gap-3">
              <span className="text-sm font-medium text-foreground">Pessoas</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" className="h-8 w-8" type="button"
                  aria-label="Diminuir número de pessoas"
                  onClick={() => setSelectedPartySize(Math.max(1, selectedPartySize - 1))}>-</Button>
                <span id="reservation-party-size-value" className="w-8 text-center font-semibold" aria-live="polite">{selectedPartySize}</span>
                <Button variant="outline" size="icon" className="h-8 w-8" type="button"
                  aria-label="Aumentar número de pessoas"
                  onClick={() => setSelectedPartySize(Math.min(20, selectedPartySize + 1))}>+</Button>
              </div>
            </div>

            {!showCalendar ? (
              <>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {next7Days.map(date => {
                    const closed = isDayClosed(date);
                    const isSelected = selectedDate?.toDateString() === date.toDateString();
                    const todayLabel = isToday(date) ? 'Hoje' : isTomorrow(date) ? 'Amanhã' : null;
                    return (
                      <button key={date.toISOString()} disabled={closed} onClick={() => setSelectedDate(date)}
                        className={cn(
                          'relative flex flex-col items-center p-3 rounded-md border text-sm transition-[border-color,background-color,color] duration-150',
                          closed && 'opacity-40 cursor-not-allowed',
                          isSelected ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border hover:border-primary/50 text-foreground'
                        )}>
                        {todayLabel ? (
                          <span className={cn('text-[10px] font-semibold uppercase tracking-wide', isSelected ? 'text-primary' : 'text-primary/70')}>{todayLabel}</span>
                        ) : (
                          <span className="text-xs uppercase text-muted-foreground">{format(date, 'EEE', { locale: ptBR })}</span>
                        )}
                        <span className="text-lg font-bold">{format(date, 'dd')}</span>
                        <span className="text-xs text-muted-foreground">{format(date, 'MMM', { locale: ptBR })}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Show selected calendar date if outside next 7 days */}
                {selectedDate && !isDateInQuickSelect && (
                  <div className="flex items-center justify-center gap-2 p-3 rounded-md border border-primary bg-primary/10">
                    <CalendarIcon className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold text-primary">
                      {format(selectedDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}
                    </span>
                  </div>
                )}

                <Button variant="ghost" className="w-full text-primary" onClick={() => setShowCalendar(true)}>
                  <CalendarIcon className="h-4 w-4 mr-2" /> Escolher outra data
                </Button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Calendar mode="single" selected={selectedDate}
                  onSelect={handleCalendarSelect}
                  disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0)) || isDayClosed(date)}
                  locale={ptBR} className="p-3 pointer-events-auto" />
                <Button variant="ghost" size="sm" onClick={() => setShowCalendar(false)}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
                </Button>
              </div>
            )}

            <div className="space-y-1">
              <Button className="w-full" disabled={!selectedDate}
                onClick={() => { setStep(2); onStepChange?.('date_select'); }}>
                Continuar <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
              {!selectedDate && (
                <p className="text-xs text-muted-foreground text-center">Selecione uma data para continuar</p>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Time + Table */}
        {step === 2 && (
          <div className="animate-fade-in space-y-4 pt-2">
            <Button variant="ghost" size="sm" onClick={() => { setStep(1); setSelectedTime(''); setSelectedTableId(''); }}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
            <p className="text-sm text-muted-foreground text-center">
              Horários para{' '}
              <span className="font-semibold text-foreground">
                {selectedDate && format(selectedDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}
              </span>
              {' '}· {selectedPartySize} {selectedPartySize === 1 ? 'pessoa' : 'pessoas'}
            </p>

            {timeSlots.length === 0 ? (
              <p className="text-center text-sm text-destructive">Nenhum horário disponível para esta data.</p>
            ) : loadingSlots ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
            ) : (
              <>
                <div
                  className={cn(
                    'animate-fade-in rounded-lg border p-3 shadow-sm',
                    urgencySlots.length > 0
                      ? 'border-amber-200 bg-amber-50 text-amber-950'
                      : 'border-primary/20 bg-primary/5 text-foreground',
                  )}
                  role="status"
                >
                  <div className="flex items-start gap-3">
                    <span className={cn(
                      'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                      urgencySlots.length > 0 ? 'bg-amber-100 text-amber-700' : 'bg-primary/10 text-primary',
                    )}>
                      <Flame className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 space-y-2">
                      <div>
                        <p className="text-sm font-semibold">
                          {urgencySlots.length > 0
                            ? hasCriticalUrgency ? 'Horários quase esgotando' : 'Horários com maior procura'
                            : 'Os horários podem esgotar rápido'}
                        </p>
                        <p className={cn(
                          'text-xs leading-relaxed',
                          urgencySlots.length > 0 ? 'text-amber-800' : 'text-muted-foreground',
                        )}>
                          {urgencySlots.length > 0
                            ? hasCriticalUrgency
                              ? 'Alguns horários estão com poucas vagas para o tamanho do seu grupo.'
                              : 'Já existem reservas nesses horários. Se um deles encaixa para você, vale garantir agora.'
                            : 'Escolha uma opção para garantir sua mesa. A disponibilidade muda conforme novas reservas entram.'}
                        </p>
                      </div>
                      {urgencySlots.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {urgencySlots.map((slot) => (
                            <span key={slot.time} className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 shadow-sm">
                              {slot.time} - {slot.available} {slot.available === 1 ? 'vaga' : 'vagas'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {timeSlots.map(time => {
                    const status = getSlotStatus(time);
                    const avail = slotAvailability[time];
                    const isFull = status === 'full';
                    const signalLabel = getSlotSignalLabel(avail);
                    return (
                      <button key={time} onClick={() => { if (!isFull) { setSelectedTime(time); setSelectedTableId(''); } }}
                        disabled={isFull}
                        className={cn(
                          'flex flex-col items-center justify-center gap-0.5 py-2.5 rounded-md border text-sm transition-[border-color,background-color,color] duration-150',
                          isFull && 'opacity-40 cursor-not-allowed bg-muted',
                          selectedTime === time ? 'border-primary bg-primary/10 text-primary font-semibold' : !isFull ? 'border-border hover:border-primary/50 text-foreground' : 'border-border',
                          status === 'low' && selectedTime !== time && !isFull && 'border-amber-300 bg-amber-50 text-amber-950 hover:border-amber-400'
                        )}>
                        <span className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />{time}
                        </span>
                        {avail && (
                          <span className={cn(
                            'text-[10px] font-medium',
                            isFull ? 'text-destructive' : status === 'low' ? 'text-amber-700' : 'text-muted-foreground'
                          )}>
                            {isFull ? 'Lotado' : `${avail.available} ${avail.available === 1 ? 'vaga' : 'vagas'}`}
                          </span>
                        )}
                        {signalLabel && (
                          <span className={cn(
                            'rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
                            status === 'low' ? 'bg-amber-100 text-amber-800' : 'bg-primary/10 text-primary',
                          )}>
                            {signalLabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {(selectedSlotIsLow || selectedSlotHasDemand) && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-900">
                {selectedSlotIsLow
                  ? `Esse horário tem só ${selectedSlotAvailability?.available} ${selectedSlotAvailability?.available === 1 ? 'vaga' : 'vagas'} para ${selectedPartySize} ${selectedPartySize === 1 ? 'pessoa' : 'pessoas'}. Continue para garantir a reserva.`
                  : 'Esse horário já recebeu reservas. Continue para garantir sua mesa enquanto ainda há disponibilidade.'}
              </p>
            )}

            {/* No table availability message */}
            {selectedTime && !loadingTables && availableTables.length === 0 && (
              <p className="text-center text-sm text-destructive py-2">Nenhuma mesa disponível para este horário e número de pessoas.</p>
            )}
            {selectedTime && (loadingTables || tablesLoading) && (
              <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
            )}

            <div className="space-y-1">
              <Button className="w-full" disabled={!selectedTime || !selectedTableId || loadingTables || tablesLoading}
                onClick={() => { setStep(3); }}>
                Continuar <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
              {!selectedTime && (
                <p className="text-xs text-muted-foreground text-center">Selecione um horário para continuar</p>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Personal Info */}
        {step === 3 && (
          <form onSubmit={handleSubmit} className="animate-fade-in space-y-4 pt-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setStep(2)}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
            <p className="text-sm text-muted-foreground text-center">
              {selectedDate && format(selectedDate, "dd/MM/yyyy", { locale: ptBR })} às {selectedTime} · Mesa {availableTables.find(t => t.id === selectedTableId)?.number} · {selectedPartySize} pessoas
            </p>

            <p className="text-xs text-muted-foreground">* Campos obrigatórios</p>

            <div className="space-y-3">
              <div>
                <Label htmlFor="public-reservation-whatsapp" className="text-sm font-medium">WhatsApp *</Label>
                <div className="flex gap-2">
                  <Input
                    id="public-reservation-whatsapp"
                    name="guest_phone"
                    value={form.whatsapp}
                    onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))}
                    placeholder="(11) 99999-9999" required maxLength={20} autoComplete="tel" inputMode="tel"
                    onBlur={handleWhatsappBlur}
                  />
                </div>
                {customerFoundForCurrentPhone && (
                  <div className="mt-2 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900" role="status" aria-live="polite">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Cadastro encontrado. Conferimos seus dados e você já pode confirmar a reserva.</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {whatsappDigits.length > 0 && whatsappDigits.length < MIN_PREFILL_PHONE_DIGITS
                    ? 'Digite o WhatsApp completo com DDD para buscar os dados.'
                    : 'Digite o WhatsApp completo. A busca acontece ao sair do campo.'}
                </p>
              </div>
              <div>
                <Label htmlFor="public-reservation-name" className="text-sm font-medium">Nome Completo *</Label>
                <Input
                  id="public-reservation-name"
                  name="guest_name"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Seu nome"
                  required
                  maxLength={100}
                  autoComplete="name"
                />
              </div>
              <div>
                <Label htmlFor="public-reservation-email" className="text-sm font-medium">E-mail</Label>
                <Input
                  id="public-reservation-email"
                  name="guest_email"
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="seu@email.com"
                  maxLength={255}
                  autoComplete="email"
                  inputMode="email"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2" role="group" aria-labelledby="public-reservation-birthdate-label">
                <p id="public-reservation-birthdate-label" className="text-sm font-medium text-foreground">Data de Nascimento</p>
                <div className="grid grid-cols-3 gap-1.5 xs:gap-2">
                  <Select
                    value={form.birthdate ? form.birthdate.split('-')[2] : ''}
                    onValueChange={d => {
                      const [y, m] = (form.birthdate || '--').split('-');
                      setForm(f => ({ ...f, birthdate: `${y || '2000'}-${m || '01'}-${d}` }));
                    }}
                  >
                    <SelectTrigger aria-label="Selecionar dia do nascimento"><SelectValue placeholder="Dia" /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map(d => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={form.birthdate ? form.birthdate.split('-')[1] : ''}
                    onValueChange={m => {
                      const [y, , d] = (form.birthdate || '--').split('-');
                      setForm(f => ({ ...f, birthdate: `${y || '2000'}-${m}-${d || '01'}` }));
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="Mês" /></SelectTrigger>
                    <SelectContent>
                      {['01','02','03','04','05','06','07','08','09','10','11','12'].map((m, i) => (
                        <SelectItem key={m} value={m}>{['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][i]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={form.birthdate ? form.birthdate.split('-')[0] : ''}
                    onValueChange={y => {
                      const [, m, d] = (form.birthdate || '--').split('-');
                      setForm(f => ({ ...f, birthdate: `${y}-${m || '01'}-${d || '01'}` }));
                    }}
                  >
                    <SelectTrigger aria-label="Selecionar ano do nascimento"><SelectValue placeholder="Ano" /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 80 }, (_, i) => String(new Date().getFullYear() - i)).map(y => (
                        <SelectItem key={y} value={y}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-sm font-medium">Ocasião</Label>
                <Select value={form.occasion} onValueChange={v => setForm(f => ({ ...f, occasion: v }))}>
                  <SelectTrigger id="public-reservation-occasion-trigger" aria-label="Selecionar ocasião da reserva">
                    <SelectValue placeholder="Selecione..." />
                  </SelectTrigger>
                  <SelectContent>
                    {OCCASIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm font-medium">Observação</Label>
                <Textarea id="public-reservation-observation" name="notes" value={form.observation} onChange={e => setForm(f => ({ ...f, observation: e.target.value }))}
                  placeholder="Alguma observação especial?" maxLength={500} rows={3} />
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Ao continuar você concorda com nossos{' '}
              <button type="button" className="underline text-primary hover:text-primary/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
                Termos e Condições
              </button>
            </p>

            <div className="sticky bottom-0 -mx-5 bg-card/95 px-5 pb-1 pt-3 shadow-[0_-12px_24px_rgba(255,255,255,0.92)] backdrop-blur">
              <Button ref={confirmButtonRef} type="submit" className="w-full text-base rounded-md shadow-sm" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Confirmar Reserva
              </Button>
            </div>
          </form>
        )}

        {/* Step 4: Success */}
        {step === 4 && confirmedReservation && (
          <div className="animate-fade-in space-y-6 pt-4 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-100 shadow-[0_18px_40px_rgba(16,185,129,0.18)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-[0_10px_24px_rgba(5,150,105,0.35)]">
                <BadgeCheck className="h-8 w-8" strokeWidth={2.25} />
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-lg font-semibold leading-snug text-foreground">
                {confirmedReservation.guestName}, está tudo pronto para você.
              </p>
              <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
                Agora é só relaxar — sua experiência com a gente já começou.
              </p>
            </div>

            <Card className="border-none shadow-sm text-left">
              <CardContent className="pt-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Código</span>
                  <button onClick={copyReservationCode} className="flex items-center gap-1.5 font-mono font-bold text-primary hover:text-primary/80">
                    {confirmedReservation.id.substring(0, 8).toUpperCase()}
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">Acompanhamento</span>
                  <button
                    type="button"
                    onClick={copyTrackingLink}
                    className="flex items-center gap-1.5 font-medium text-primary hover:text-primary/80"
                  >
                    Copiar link
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Data</span>
                  <span className="font-medium text-foreground">
                    {format(new Date(confirmedReservation.date + 'T12:00:00'), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Horário</span>
                  <span className="font-medium text-foreground">{confirmedReservation.time}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Pessoas</span>
                  <span className="font-medium text-foreground">{confirmedReservation.partySize}</span>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-col gap-3">
              <a href={confirmedReservation.trackingUrl} target="_blank" rel="noopener noreferrer" className="block">
                <Button className="w-full gap-2">
                  <ExternalLink className="h-4 w-4" />
                  Acompanhar reserva
                </Button>
              </a>
              <a href={addToCalendarUrl()} target="_blank" rel="noopener noreferrer" className="block">
                <Button variant="outline" className="w-full gap-2">
                  <CalendarPlus className="h-4 w-4" />
                  Adicionar ao Google Calendar
                </Button>
              </a>
              <Button variant="ghost" className="w-full text-muted-foreground hover:text-foreground" onClick={() => handleClose(false)}>
                Fechar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
