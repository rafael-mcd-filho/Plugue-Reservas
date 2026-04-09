import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, eachDayOfInterval, format, isToday, parseISO, startOfDay, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CalendarIcon,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ReservationSourceBadge, ReservationStatusBadge } from '@/components/StatusBadge';
import ReservationDetailsDialog from '@/components/ReservationDetailsDialog';
import { downloadCsv, formatDateRangeLabel, matchesLocalDateRange, matchesTimestampRange } from '@/lib/export-utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import {
  formatBrazilPhone,
  getEmailValidationMessage,
  getPhoneValidationMessage,
  normalizeBrazilPhoneDigits,
  normalizeEmail,
} from '@/lib/validation';
import { getReservationStatusLabel, normalizeReservationStatus } from '@/lib/reservation-status';
import type { ReservationStatus } from '@/types/restaurant';
import type { DateRange } from 'react-day-picker';

type CalendarRangeMode = 'future' | 'past';

interface Reservation {
  id: string;
  company_id: string;
  table_id: string | null;
  table_map_id: string | null;
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
}

interface ReservationCompanionForm {
  key: string;
  name: string;
  phone: string;
  email: string;
  birthdate: string;
}

function createCompanionForm(values?: Partial<ReservationCompanionForm>): ReservationCompanionForm {
  return {
    key: values?.key ?? crypto.randomUUID(),
    name: values?.name ?? '',
    phone: values?.phone ?? '',
    email: values?.email ?? '',
    birthdate: values?.birthdate ?? '',
  };
}

interface ManualReservationForm {
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  guest_birthdate: string;
  date: string;
  time: string;
  party_size: string;
  occasion: string;
  notes: string;
}

const RESERVATION_STATUS_OPTIONS: Array<{ value: ReservationStatus; label: string }> = [
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'checked_in', label: 'Check-in realizado' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'no-show', label: 'Nao compareceu' },
];

function normalizePhone(phone: string | null | undefined) {
  return (phone ?? '').replace(/\D/g, '');
}

function formatReservationStatusLabel(status: ReservationStatus) {
  return getReservationStatusLabel(status);
}

function getNextHalfHourDate() {
  const next = new Date();
  next.setSeconds(0, 0);

  const minutes = next.getMinutes();
  const roundedMinutes = minutes === 0 || minutes === 30 ? minutes : minutes < 30 ? 30 : 60;
  next.setMinutes(roundedMinutes);

  return next;
}

function createManualReservationForm(): ManualReservationForm {
  const nextReservationAt = getNextHalfHourDate();

  return {
    guest_name: '',
    guest_phone: '',
    guest_email: '',
    guest_birthdate: '',
    date: format(nextReservationAt, 'yyyy-MM-dd'),
    time: format(nextReservationAt, 'HH:mm'),
    party_size: '2',
    occasion: '',
    notes: '',
  };
}

export default function Reservations() {
  const { companyId, slug } = useCompanySlug();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [calendarRangeMode, setCalendarRangeMode] = useState<CalendarRangeMode>('future');
  const [editDialog, setEditDialog] = useState(false);
  const [editingReservation, setEditingReservation] = useState<Reservation | null>(null);
  const [detailsDialog, setDetailsDialog] = useState(false);
  const [detailsReservation, setDetailsReservation] = useState<Reservation | null>(null);
  const [detailsReturnDay, setDetailsReturnDay] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<ReservationStatus>('confirmed');
  const [checkedInPartySize, setCheckedInPartySize] = useState('1');
  const [companionForms, setCompanionForms] = useState<ReservationCompanionForm[]>([]);
  const [loadingCompanions, setLoadingCompanions] = useState(false);
  const [createDialog, setCreateDialog] = useState(false);
  const [manualReservationForm, setManualReservationForm] = useState<ManualReservationForm>(createManualReservationForm);
  const [dayModal, setDayModal] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportCreatedRange, setExportCreatedRange] = useState<DateRange | undefined>();
  const [exportReservationRange, setExportReservationRange] = useState<DateRange | undefined>();
  const [exportLeadCreatedRange, setExportLeadCreatedRange] = useState<DateRange | undefined>();
  const [exportStatuses, setExportStatuses] = useState<ReservationStatus[]>([]);
  const [exportSearchTriggered, setExportSearchTriggered] = useState(false);

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['reservations', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('date', { ascending: true })
        .order('time', { ascending: true });

      if (error) throw error;
      return ((data as Reservation[]) ?? []).map((reservation) => ({
        ...reservation,
        status: normalizeReservationStatus(reservation.status),
      }));
    },
    enabled: !!companyId,
    refetchInterval: 30000,
  });

  const { data: reservationSettings } = useQuery({
    queryKey: ['reservation-settings', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('reservation_duration')
        .eq('id', companyId)
        .maybeSingle();

      if (error) throw error;
      return data as { reservation_duration: number | null } | null;
    },
    enabled: !!companyId,
  });

  const { data: leadCreatedAtByPhone = {}, isFetching: leadCreatedAtByPhoneLoading } = useQuery({
    queryKey: ['reservation-export-lead-created-at', companyId],
    queryFn: async () => {
      const [reservationResult, companionResult, waitlistResult, waitlistCompanionResult] = await Promise.all([
        supabase
          .from('reservations' as never)
          .select('guest_phone, created_at')
          .eq('company_id', companyId!),
        supabase
          .from('reservation_companions' as never)
          .select('phone, created_at')
          .eq('company_id', companyId!),
        supabase
          .from('waitlist' as never)
          .select('guest_phone, created_at')
          .eq('company_id', companyId!),
        supabase
          .from('waitlist_companions' as never)
          .select('phone, created_at')
          .eq('company_id', companyId!),
      ]);

      if (reservationResult.error) throw reservationResult.error;
      if (companionResult.error) throw companionResult.error;
      if (waitlistResult.error) throw waitlistResult.error;
      if (waitlistCompanionResult.error) throw waitlistCompanionResult.error;

      const map: Record<string, string> = {};
      const mergeEntry = (phone: string | null | undefined, createdAt: string | null | undefined) => {
        const phoneDigits = normalizePhone(phone);

        if (!phoneDigits || !createdAt) {
          return;
        }

        if (!map[phoneDigits] || createdAt.localeCompare(map[phoneDigits]) < 0) {
          map[phoneDigits] = createdAt;
        }
      };

      ((reservationResult.data ?? []) as Array<{ guest_phone: string | null; created_at: string | null }>).forEach((entry) => {
        mergeEntry(entry.guest_phone, entry.created_at);
      });

      ((companionResult.data ?? []) as Array<{ phone: string | null; created_at: string | null }>).forEach((entry) => {
        mergeEntry(entry.phone, entry.created_at);
      });

      ((waitlistResult.data ?? []) as Array<{ guest_phone: string | null; created_at: string | null }>).forEach((entry) => {
        mergeEntry(entry.guest_phone, entry.created_at);
      });

      ((waitlistCompanionResult.data ?? []) as Array<{ phone: string | null; created_at: string | null }>).forEach((entry) => {
        mergeEntry(entry.phone, entry.created_at);
      });

      return map;
    },
    enabled: !!companyId && exportDialogOpen,
  });

  const reservationsByDate = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const reservation of reservations) {
      const current = map.get(reservation.date) ?? [];
      current.push(reservation);
      map.set(reservation.date, current);
    }
    return map;
  }, [reservations]);

  useEffect(() => {
    if (!editDialog || !editingReservation) return;

    let ignore = false;

    const loadCompanions = async () => {
      setLoadingCompanions(true);

      const { data, error } = await supabase
        .from('reservation_companions' as any)
        .select('id, name, phone, email, birthdate, position')
        .eq('reservation_id', editingReservation.id)
        .order('position', { ascending: true });

      if (ignore) return;

      if (error) {
        console.warn('Reservation companions load error:', error);
        setCompanionForms([]);
      } else {
        setCompanionForms(
          ((data as any[]) ?? []).map((companion) =>
            createCompanionForm({
              key: companion.id,
              name: companion.name,
              phone: companion.phone ?? '',
              email: companion.email ?? '',
              birthdate: companion.birthdate ?? '',
            }),
          ),
        );
      }

      setLoadingCompanions(false);
    };

    loadCompanions();

    return () => {
      ignore = true;
    };
  }, [editDialog, editingReservation]);

  useEffect(() => {
    if (!editDialog || editStatus !== 'checked_in') return;

    const parsedPartySize = Number.parseInt(checkedInPartySize, 10);
    const targetCompanionCount = Math.max((Number.isNaN(parsedPartySize) ? 1 : parsedPartySize) - 1, 0);

    setCompanionForms((current) => {
      if (current.length >= targetCompanionCount) return current;

      return [
        ...current,
        ...Array.from({ length: targetCompanionCount - current.length }, () => createCompanionForm()),
      ];
    });
  }, [checkedInPartySize, editDialog, editStatus]);

  const saveStatusMutation = useMutation({
    mutationFn: async ({
      id,
      status,
      companions,
      checkedInCount,
    }: {
      id: string;
      status: ReservationStatus;
      companions?: Array<Omit<ReservationCompanionForm, 'key'>>;
      checkedInCount?: number;
    }) => {
      if (status === 'checked_in') {
        const { data, error } = await (supabase as any).rpc('check_in_reservation', {
          _reservation_id: id,
          _checked_in_party_size: checkedInCount,
          _companions: companions ?? [],
        });

        if (error) throw error;
        return (Array.isArray(data) ? data[0] : data) as Reservation;
      }

      const { data, error } = await (supabase as any).rpc('update_reservation_status', {
        _reservation_id: id,
        _status: status,
      });

      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as Reservation;
    },
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['reservation-companions'] });
      toast.success(updated.status === 'checked_in' ? 'Check-in registrado.' : 'Status atualizado.');
      setEditDialog(false);
      setEditingReservation(null);
      setCompanionForms([]);

      const event = updated.status === 'cancelled' ? 'reservation_cancelled' : 'status_changed';
      supabase.functions.invoke('reservation-events', {
        body: { event, reservation: { id: updated.id } },
      }).catch((error) => console.warn('Reservation events error:', error));
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('reservations' as any)
        .delete()
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
      toast.success('Reserva removida.');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const createReservationMutation = useMutation({
    mutationFn: async () => {
      const parsedPartySize = Number.parseInt(manualReservationForm.party_size, 10);
      const guestPhoneError = getPhoneValidationMessage(manualReservationForm.guest_phone, 'o WhatsApp do cliente', true);
      const guestEmailError = getEmailValidationMessage(manualReservationForm.guest_email, 'o e-mail do cliente');

      if (!manualReservationForm.guest_name.trim() || !manualReservationForm.guest_phone.trim()) {
        throw new Error('Informe nome e WhatsApp do cliente.');
      }

      if (guestPhoneError) {
        throw new Error(guestPhoneError);
      }

      if (guestEmailError) {
        throw new Error(guestEmailError);
      }

      if (!manualReservationForm.date || !manualReservationForm.time) {
        throw new Error('Informe data e horário da reserva.');
      }

      if (Number.isNaN(parsedPartySize) || parsedPartySize < 1 || parsedPartySize > 50) {
        throw new Error('Informe uma quantidade válida de pessoas.');
      }

      const reservationId = crypto.randomUUID();
      const trackingCode = crypto.randomUUID().replace(/-/g, '');
      const payload = {
        id: reservationId,
        public_tracking_code: trackingCode,
        company_id: companyId,
        table_id: null,
        table_map_id: null,
        guest_name: manualReservationForm.guest_name.trim(),
        guest_phone: normalizeBrazilPhoneDigits(manualReservationForm.guest_phone),
        guest_email: normalizeEmail(manualReservationForm.guest_email) || null,
        guest_birthdate: manualReservationForm.guest_birthdate || null,
        date: manualReservationForm.date,
        time: `${manualReservationForm.time}:00`,
        party_size: parsedPartySize,
        duration_minutes: reservationSettings?.reservation_duration ?? 30,
        occasion: manualReservationForm.occasion.trim() || null,
        notes: manualReservationForm.notes.trim() || null,
        status: 'confirmed',
      };

      const { data, error } = await supabase
        .from('reservations' as any)
        .insert(payload as any)
        .select('*')
        .single();

      if (error) throw error;
      return data as Reservation;
    },
    onSuccess: (createdReservation) => {
      qc.invalidateQueries({ queryKey: ['reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['leads-reservations', companyId] });
      toast.success('Reserva criada manualmente.');
      setCreateDialog(false);
      setManualReservationForm(createManualReservationForm());

      supabase.functions.invoke('reservation-events', {
        body: {
          event: 'reservation_created',
          reservation: { id: createdReservation.id },
        },
      }).catch((error) => console.warn('Reservation events error:', error));
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const sortedReservations = useMemo(() => {
    const todayString = format(new Date(), 'yyyy-MM-dd');

    return [...reservations].sort((left, right) => {
      const leftFuture = left.date >= todayString;
      const rightFuture = right.date >= todayString;

      if (leftFuture && !rightFuture) return -1;
      if (!leftFuture && rightFuture) return 1;

      if (leftFuture) {
        const dateCompare = left.date.localeCompare(right.date);
        return dateCompare !== 0 ? dateCompare : left.time.localeCompare(right.time);
      }

      const dateCompare = right.date.localeCompare(left.date);
      return dateCompare !== 0 ? dateCompare : right.time.localeCompare(left.time);
    });
  }, [reservations]);

  const filteredReservations = useMemo(() => {
    return sortedReservations
      .filter((reservation) => statusFilter === 'all' || reservation.status === statusFilter)
      .filter((reservation) => {
        if (dateFrom && reservation.date < format(dateFrom, 'yyyy-MM-dd')) return false;
        if (dateTo && reservation.date > format(dateTo, 'yyyy-MM-dd')) return false;
        return true;
      })
      .filter((reservation) => {
        const query = search.toLowerCase();
        const queryDigits = normalizePhone(search);
        return (
          reservation.guest_name.toLowerCase().includes(query) ||
          reservation.guest_phone.includes(search) ||
          (!!queryDigits && normalizePhone(reservation.guest_phone).includes(queryDigits))
        );
      });
  }, [dateFrom, dateTo, search, sortedReservations, statusFilter]);

  const exportedReservations = useMemo(() => {
    return sortedReservations.filter((reservation) => {
      if (exportStatuses.length > 0 && !exportStatuses.includes(reservation.status)) {
        return false;
      }

      if (!matchesTimestampRange(reservation.created_at, exportCreatedRange)) {
        return false;
      }

      if (!matchesLocalDateRange(reservation.date, exportReservationRange)) {
        return false;
      }

      const leadCreatedAt = leadCreatedAtByPhone[normalizePhone(reservation.guest_phone)] ?? null;

      if (!matchesTimestampRange(leadCreatedAt, exportLeadCreatedRange)) {
        return false;
      }

      return true;
    });
  }, [
    exportCreatedRange,
    exportLeadCreatedRange,
    exportReservationRange,
    exportStatuses,
    leadCreatedAtByPhone,
    sortedReservations,
  ]);

  const exportedReservationsSummary = useMemo(() => {
    return {
      totalReservations: exportedReservations.length,
      totalGuests: exportedReservations.reduce((sum, reservation) => sum + reservation.party_size, 0),
      byStatus: RESERVATION_STATUS_OPTIONS.map((status) => ({
        ...status,
        count: exportedReservations.filter((reservation) => reservation.status === status.value).length,
      })),
    };
  }, [exportedReservations]);

  const calendarDays = useMemo(() => {
    const today = startOfDay(new Date());
    const range =
      calendarRangeMode === 'future'
        ? { start: today, end: addDays(today, 14) }
        : { start: subDays(today, 14), end: today };
    const days = eachDayOfInterval(range);

    return days.map((day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      const dayReservations = reservationsByDate.get(dateString) ?? [];

      return {
        date: day,
        dateString,
        reservationCount: dayReservations.length,
        totalGuests: dayReservations.reduce((sum, reservation) => sum + reservation.party_size, 0),
      };
    });
  }, [calendarRangeMode, reservationsByDate]);

  const dayModalReservations = useMemo(() => {
    if (!dayModal) return [];
    return (reservationsByDate.get(dayModal) ?? []).sort((left, right) => left.time.localeCompare(right.time));
  }, [dayModal, reservationsByDate]);

  const openEdit = (reservation: Reservation) => {
    setEditingReservation(reservation);
    setEditStatus(reservation.status);
    setCheckedInPartySize(String(reservation.checked_in_party_size ?? reservation.party_size));
    setCompanionForms([]);
    setEditDialog(true);
  };

  const openCheckIn = (reservation: Reservation) => {
    setEditingReservation(reservation);
    setEditStatus('checked_in');
    setCheckedInPartySize(String(reservation.checked_in_party_size ?? reservation.party_size));
    setCompanionForms([]);
    setEditDialog(true);
  };

  const openDetails = (reservation: Reservation, options?: { returnDay?: string | null }) => {
    setDetailsReservation(reservation);
    setDetailsReturnDay(options?.returnDay ?? null);
    setDetailsDialog(true);
  };

  const closeDetails = (options?: { returnToDay?: boolean }) => {
    const returnDay = options?.returnToDay ? detailsReturnDay : null;
    setDetailsDialog(false);
    setDetailsReservation(null);
    setDetailsReturnDay(null);

    if (returnDay) {
      setDayModal(returnDay);
    }
  };

  const clearDateFilters = () => {
    setDateFrom(undefined);
    setDateTo(undefined);
  };

  const clearExportFilters = () => {
    setExportCreatedRange(undefined);
    setExportReservationRange(undefined);
    setExportLeadCreatedRange(undefined);
    setExportStatuses([]);
    setExportSearchTriggered(false);
  };

  const toggleExportStatus = (status: ReservationStatus, checked: boolean) => {
    setExportStatuses((current) =>
      checked ? [...current, status] : current.filter((value) => value !== status),
    );
  };

  const exportReservationsCsv = () => {
    const rows = exportedReservations.map((reservation) => {
      const leadCreatedAt = leadCreatedAtByPhone[normalizePhone(reservation.guest_phone)] ?? null;

      return [
        reservation.guest_name,
        reservation.source === 'waitlist' ? 'Fila convertida' : 'Agendada',
        formatBrazilPhone(reservation.guest_phone),
        reservation.guest_email ?? '',
        format(new Date(`${reservation.date}T12:00:00`), 'dd/MM/yyyy'),
        reservation.time.slice(0, 5),
        reservation.party_size,
        reservation.occasion ?? '',
        formatReservationStatusLabel(reservation.status),
        format(new Date(reservation.created_at), 'dd/MM/yyyy HH:mm'),
        leadCreatedAt ? format(parseISO(leadCreatedAt), 'dd/MM/yyyy HH:mm') : '',
        reservation.checked_in_at ? format(new Date(reservation.checked_in_at), 'dd/MM/yyyy HH:mm') : '',
        reservation.notes ?? '',
        `${window.location.origin}/${slug}/reserva/${reservation.public_tracking_code}`,
      ];
    });

    downloadCsv(
      `reservas_${format(new Date(), 'yyyy-MM-dd')}.csv`,
      [
        'Cliente',
        'Origem',
        'WhatsApp',
        'Email',
        'Data da reserva',
        'Horario',
        'Pessoas',
        'Ocasiao',
        'Status',
        'Criada em',
        'Lead criado em',
        'Check-in em',
        'Observacoes',
        'Link de acompanhamento',
      ],
      rows,
    );

    toast.success(`${exportedReservations.length} reservas exportadas.`);
  };

  const openCreateDialog = () => {
    setManualReservationForm(createManualReservationForm());
    setCreateDialog(true);
  };

  const updateCompanionForm = (key: string, field: keyof Omit<ReservationCompanionForm, 'key'>, value: string) => {
    setCompanionForms((current) =>
      current.map((companion) =>
        companion.key === key
          ? { ...companion, [field]: field === 'phone' ? formatBrazilPhone(value) : value }
          : companion,
      ),
    );
  };

  const removeCompanionForm = (key: string) => {
    setCompanionForms((current) => current.filter((companion) => companion.key !== key));
  };

  const handleSaveStatus = () => {
    if (!editingReservation) return;

    if (editStatus === 'checked_in') {
      const parsedCheckedInCount = Number.parseInt(checkedInPartySize, 10);

      if (Number.isNaN(parsedCheckedInCount) || parsedCheckedInCount < 1 || parsedCheckedInCount > 50) {
        toast.error('Informe uma quantidade presente valida.');
        return;
      }

      const companions = companionForms
        .map((companion) => ({
          name: companion.name.trim(),
          phone: companion.phone.trim(),
          email: companion.email.trim(),
          birthdate: companion.birthdate.trim(),
        }))
        .filter((companion) => companion.name || companion.phone || companion.email || companion.birthdate);

      if (companions.some((companion) => !companion.name)) {
        toast.error('Cada acompanhante precisa de um nome.');
        return;
      }

      for (const [index, companion] of companions.entries()) {
        const phoneError = getPhoneValidationMessage(companion.phone, `o telefone do acompanhante ${index + 1}`);
        if (phoneError) {
          toast.error(phoneError);
          return;
        }

        const emailError = getEmailValidationMessage(companion.email, `o e-mail do acompanhante ${index + 1}`);
        if (emailError) {
          toast.error(emailError);
          return;
        }
      }

      if (companions.length > Math.max(parsedCheckedInCount - 1, 0)) {
        toast.error('A quantidade de acompanhantes excede o total presente informado.');
        return;
      }

      saveStatusMutation.mutate({
        id: editingReservation.id,
        status: editStatus,
        checkedInCount: parsedCheckedInCount,
        companions: companions.map((companion) => ({
          ...companion,
          phone: normalizeBrazilPhoneDigits(companion.phone),
          email: normalizeEmail(companion.email),
        })),
      });
      return;
    }

    saveStatusMutation.mutate({ id: editingReservation.id, status: editStatus });
  };

  const handleEditDialogChange = (open: boolean) => {
    setEditDialog(open);

    if (!open) {
      setEditingReservation(null);
      setEditStatus('confirmed');
      setCheckedInPartySize('1');
      setCompanionForms([]);
      setLoadingCompanions(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-9 w-40 animate-pulse rounded-lg bg-muted" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
          {Array.from({ length: 14 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Reservas</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie todas as reservas da unidade
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" className="gap-2 rounded-lg" onClick={() => setExportDialogOpen(true)}>
            <Download className="h-4 w-4" />
            Exportar reservas
          </Button>
          <Button className="gap-2 rounded-lg" onClick={openCreateDialog}>
            <Plus className="h-4 w-4" />
            Nova reserva
          </Button>
        </div>
      </div>

      <Tabs defaultValue="calendar" className="space-y-6">
        <TabsList className="h-auto rounded-xl border border-border bg-card p-1">
          <TabsTrigger
            value="calendar"
            className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            Calendario
          </TabsTrigger>
          <TabsTrigger
            value="list"
            className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            Lista
          </TabsTrigger>
        </TabsList>

        <TabsContent value="calendar" className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {calendarRangeMode === 'future' ? 'Proximos 15 dias' : 'Ultimos 15 dias'}
            </p>

            <div className="inline-flex w-full rounded-xl border border-border bg-card p-1 sm:w-auto">
              <Button
                type="button"
                variant={calendarRangeMode === 'future' ? 'default' : 'ghost'}
                className="flex-1 rounded-lg px-4 sm:flex-none"
                onClick={() => setCalendarRangeMode('future')}
              >
                Proximos 15 dias
              </Button>
              <Button
                type="button"
                variant={calendarRangeMode === 'past' ? 'default' : 'ghost'}
                className="flex-1 rounded-lg px-4 sm:flex-none"
                onClick={() => setCalendarRangeMode('past')}
              >
                Ultimos 15 dias
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
            {calendarDays.map((day) => (
              <button
                key={day.dateString}
                onClick={() => setDayModal(day.dateString)}
                className={cn(
                  'rounded-xl border p-4 text-left transition-all hover:border-primary/40 hover:shadow-sm',
                  isToday(day.date) ? 'border-primary bg-primary-soft/50' : 'border-border bg-card',
                  day.reservationCount === 0 && 'opacity-70',
                )}
              >
                <div className="text-xs uppercase text-muted-foreground">
                  {format(day.date, 'EEE', { locale: ptBR })}
                </div>
                <div className="mt-1 text-xl font-semibold text-foreground">
                  {format(day.date, 'dd')}
                </div>
                <div className="text-xs text-muted-foreground">
                  {format(day.date, 'MMM', { locale: ptBR })}
                </div>

                <div className="mt-4 space-y-1.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5 text-primary" />
                    <span className="font-medium text-foreground">{day.reservationCount}</span>
                    reservas
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5 text-info" />
                    <span className="font-medium text-foreground">{day.totalGuests}</span>
                    pessoas
                  </div>
                </div>
              </button>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="list" className="space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="reservations-search"
                name="search_reservations"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por nome ou telefone..."
                className="h-10 rounded-lg bg-card pl-10"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-10 w-full rounded-lg bg-card sm:w-[170px]" aria-label="Filtrar reservas por status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  <SelectItem value="confirmed">Confirmada</SelectItem>
                  <SelectItem value="checked_in">Check-in realizado</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                  <SelectItem value="no-show">Nao compareceu</SelectItem>
                </SelectContent>
              </Select>

              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'h-10 w-full justify-between rounded-lg bg-card px-4 text-left font-normal sm:w-[150px]',
                      !dateFrom && 'text-muted-foreground',
                    )}
                  >
                    {dateFrom ? format(dateFrom, 'dd/MM/yyyy') : 'dd/mm/aaaa'}
                    <CalendarIcon className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateFrom}
                    onSelect={setDateFrom}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'h-10 w-full justify-between rounded-lg bg-card px-4 text-left font-normal sm:w-[150px]',
                      !dateTo && 'text-muted-foreground',
                    )}
                  >
                    {dateTo ? format(dateTo, 'dd/MM/yyyy') : 'dd/mm/aaaa'}
                    <CalendarIcon className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateTo}
                    onSelect={setDateTo}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>

              {(dateFrom || dateTo) && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 rounded-lg bg-card"
                  onClick={clearDateFilters}
                  aria-label="Limpar filtro de datas"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/55">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="h-12 px-4 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Data/Hora
                  </TableHead>
                  <TableHead className="h-12 px-4 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Cliente
                  </TableHead>
                  <TableHead className="hidden h-12 px-4 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:table-cell">
                    Pessoas
                  </TableHead>
                  <TableHead className="hidden h-12 px-4 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground lg:table-cell">
                    Ocasião
                  </TableHead>
                  <TableHead className="h-12 px-4 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="h-12 px-4 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Ações
                  </TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {filteredReservations.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="py-16 text-center text-sm text-muted-foreground">
                      Nenhuma reserva encontrada.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredReservations.map((reservation) => {
                    const todayString = format(new Date(), 'yyyy-MM-dd');
                    const isPastReservation = reservation.date < todayString;

                    return (
                      <TableRow
                        key={reservation.id}
                        className={cn(
                          'border-border/80 bg-card hover:bg-muted/25',
                          isPastReservation && 'opacity-70',
                        )}
                      >
                        <TableCell className="px-4 py-4">
                          <div className={cn('font-semibold text-foreground', reservation.date === todayString && 'text-primary')}>
                            {format(new Date(`${reservation.date}T12:00:00`), 'dd/MM/yyyy')}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {reservation.time.slice(0, 5)}
                          </div>
                        </TableCell>

                        <TableCell className="px-4 py-4">
                          <div className="font-medium text-foreground">{reservation.guest_name}</div>
                          <div className="mt-1 text-sm text-muted-foreground">{formatBrazilPhone(reservation.guest_phone)}</div>
                          <div className="mt-2">
                            <ReservationSourceBadge source={reservation.source} />
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Criada em {format(new Date(reservation.created_at), 'dd/MM/yyyy HH:mm')}
                          </div>
                        </TableCell>

                        <TableCell className="hidden px-4 py-4 font-medium text-foreground sm:table-cell">
                          {reservation.party_size}
                        </TableCell>

                        <TableCell className="hidden px-4 py-4 text-sm text-muted-foreground lg:table-cell">
                          {reservation.occasion || '-'}
                        </TableCell>

                        <TableCell className="px-4 py-4">
                          <ReservationStatusBadge status={reservation.status} />
                        </TableCell>

                        <TableCell className="px-4 py-4">
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 rounded-lg bg-card"
                              aria-label="Ver detalhes"
                              onClick={() => openDetails(reservation)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            {reservation.status === 'confirmed' && (
                              <Button
                                variant="outline"
                                className="h-9 rounded-lg bg-card px-3 text-xs font-medium"
                                onClick={() => openCheckIn(reservation)}
                              >
                                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                                Realizar check-in
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 rounded-lg bg-card"
                              aria-label="Editar reserva"
                              onClick={() => openEdit(reservation)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 rounded-lg bg-card text-destructive hover:text-destructive"
                              aria-label="Excluir reserva"
                              onClick={() => setDeleteConfirmId(reservation.id)}
                            >
                              <Trash2 className="h-4 w-4" />
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
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          setExportDialogOpen(open);
          if (!open) {
            setExportSearchTriggered(false);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Exportar reservas</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 pt-2">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>Periodo de criacao da reserva</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'h-10 w-full justify-between rounded-lg bg-card px-4 text-left font-normal',
                        !exportCreatedRange?.from && 'text-muted-foreground',
                      )}
                    >
                      {formatDateRangeLabel(exportCreatedRange, 'Selecionar período')}
                      <CalendarIcon className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="range"
                      selected={exportCreatedRange}
                      onSelect={setExportCreatedRange}
                      numberOfMonths={2}
                      initialFocus
                      className="pointer-events-auto p-3"
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Periodo da reserva</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'h-10 w-full justify-between rounded-lg bg-card px-4 text-left font-normal',
                        !exportReservationRange?.from && 'text-muted-foreground',
                      )}
                    >
                      {formatDateRangeLabel(exportReservationRange, 'Selecionar período')}
                      <CalendarIcon className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="range"
                      selected={exportReservationRange}
                      onSelect={setExportReservationRange}
                      numberOfMonths={2}
                      initialFocus
                      className="pointer-events-auto p-3"
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2 lg:col-span-2">
                <Label>Periodo de criacao do lead</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'h-10 w-full justify-between rounded-lg bg-card px-4 text-left font-normal',
                        !exportLeadCreatedRange?.from && 'text-muted-foreground',
                      )}
                    >
                      {formatDateRangeLabel(exportLeadCreatedRange, 'Selecionar período')}
                      <CalendarIcon className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="range"
                      selected={exportLeadCreatedRange}
                      onSelect={setExportLeadCreatedRange}
                      numberOfMonths={2}
                      initialFocus
                      className="pointer-events-auto p-3"
                    />
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  Esse filtro usa a primeira vez em que o telefone apareceu como lead no sistema.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Status da reserva</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                {RESERVATION_STATUS_OPTIONS.map((status) => (
                  <label
                    key={status.value}
                    className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm"
                  >
                    <Checkbox
                      checked={exportStatuses.includes(status.value)}
                      onCheckedChange={(checked) => toggleExportStatus(status.value, checked === true)}
                    />
                    <span>{status.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-muted-foreground">
                {leadCreatedAtByPhoneLoading && exportLeadCreatedRange?.from
                  ? 'Carregando base de leads para aplicar o filtro de criacao.'
                  : 'Os filtros podem ser usados juntos. O resumo so aparece depois de Buscar.'}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" onClick={clearExportFilters}>
                  Limpar filtros
                </Button>
                <Button
                  onClick={() => setExportSearchTriggered(true)}
                  disabled={leadCreatedAtByPhoneLoading && !!exportLeadCreatedRange?.from}
                >
                  Buscar
                </Button>
              </div>
            </div>

            {exportSearchTriggered && (
              <div className="space-y-4 rounded-2xl border border-border bg-muted/20 p-5">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Reservas encontradas</p>
                    <p className="mt-2 text-xl font-semibold text-foreground">
                      {exportedReservationsSummary.totalReservations}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Pessoas somadas</p>
                    <p className="mt-2 text-xl font-semibold text-foreground">
                      {exportedReservationsSummary.totalGuests}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Status selecionados</p>
                    <p className="mt-2 text-sm font-medium text-foreground">
                      {exportStatuses.length > 0 ? exportStatuses.length : 'Todos'}
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {exportedReservationsSummary.byStatus.map((status) => (
                    <div key={status.value} className="rounded-2xl border border-border bg-card p-4">
                      <p className="text-xs text-muted-foreground">{status.label}</p>
                      <p className="mt-1 text-lg font-semibold text-foreground">{status.count}</p>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    {exportedReservations.length === 0
                      ? 'Nenhuma reserva encontrada com os filtros informados.'
                      : 'A exportacao vai gerar uma planilha com dados da reserva, criacao, lead, check-in e link de acompanhamento.'}
                  </p>
                  <Button
                    className="gap-2"
                    onClick={exportReservationsCsv}
                    disabled={exportedReservations.length === 0}
                  >
                    <Download className="h-4 w-4" />
                    Exportar planilha
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ReservationDetailsDialog
        open={detailsDialog}
        onOpenChange={(open) => {
          if (open) {
            setDetailsDialog(true);
            return;
          }

          closeDetails({ returnToDay: !!detailsReturnDay });
        }}
        onBackToList={detailsReturnDay ? () => closeDetails({ returnToDay: true }) : undefined}
        backLabel={detailsReturnDay ? 'Voltar para as reservas do dia' : undefined}
        reservation={detailsReservation}
        slug={slug}
      />

      <Dialog open={editDialog} onOpenChange={handleEditDialogChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editStatus === 'checked_in' ? 'Realizar check-in' : 'Alterar status'}</DialogTitle>
          </DialogHeader>

          {editingReservation && (
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground">
                {editingReservation.guest_name} - {format(new Date(`${editingReservation.date}T12:00:00`), 'dd/MM/yyyy')} as {editingReservation.time.slice(0, 5)}
              </p>

              <Select value={editStatus} onValueChange={(value) => setEditStatus(value as ReservationStatus)}>
                <SelectTrigger aria-label="Selecionar status da reserva">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="confirmed">Confirmada</SelectItem>
                  <SelectItem value="checked_in">Check-in realizado</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                  <SelectItem value="no-show">Nao compareceu</SelectItem>
                </SelectContent>
              </Select>

              {editStatus === 'checked_in' && (
                <div className="space-y-4 rounded-2xl border border-border bg-muted/20 p-4">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-foreground">Entrada</p>
                    <p className="text-xs text-muted-foreground">
                      O titular conta como 1 pessoa. Cadastre aqui os acompanhantes que vieram para gerar leads adicionais.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[180px_1fr] sm:items-end">
                    <div className="space-y-2">
                    <Label
                      htmlFor="reservation-checked-in-party-size"
                      className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
                    >
                      Total presente
                    </Label>
                    <Input
                      id="reservation-checked-in-party-size"
                      name="checked_in_party_size"
                      type="number"
                      min="1"
                      max="50"
                        value={checkedInPartySize}
                        onChange={(event) => setCheckedInPartySize(event.target.value)}
                      />
                    </div>

                    <div className="rounded-xl border border-dashed border-border bg-background/70 p-3 text-xs text-muted-foreground">
                      Reserva original para <span className="font-medium text-foreground">{editingReservation.party_size}</span> pessoas.
                      {editingReservation.checked_in_at && (
                        <>
                          {' '}Check-in anterior em{' '}
                          <span className="font-medium text-foreground">
                            {format(new Date(editingReservation.checked_in_at), 'dd/MM/yyyy HH:mm')}
                          </span>
                          .
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Acompanhantes</p>
                      <p className="text-xs text-muted-foreground">
                        Preencha nome e, quando possivel, WhatsApp, email e aniversario.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => setCompanionForms((current) => [...current, createCompanionForm()])}
                    >
                      <Plus className="h-4 w-4" />
                      Adicionar
                    </Button>
                  </div>

                  {loadingCompanions ? (
                    <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-4 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Carregando acompanhantes...
                    </div>
                  ) : companionForms.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border bg-background/70 p-4 text-sm text-muted-foreground">
                      Nenhum acompanhante cadastrado ainda.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {companionForms.map((companion, index) => (
                        <div key={companion.key} className="space-y-3 rounded-2xl border border-border bg-background p-4">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-medium text-foreground">Acompanhante {index + 1}</p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-lg text-muted-foreground"
                              aria-label={`Remover acompanhante ${index + 1}`}
                              onClick={() => removeCompanionForm(companion.key)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <Input
                              id={`reservation-companion-name-${companion.key}`}
                              name={`companions[${index}].name`}
                              value={companion.name}
                              onChange={(event) => updateCompanionForm(companion.key, 'name', event.target.value)}
                              placeholder="Nome do acompanhante"
                              autoComplete="name"
                            />
                            <Input
                              id={`reservation-companion-phone-${companion.key}`}
                              name={`companions[${index}].phone`}
                              type="tel"
                              value={companion.phone}
                              onChange={(event) => updateCompanionForm(companion.key, 'phone', event.target.value)}
                              placeholder="WhatsApp"
                              autoComplete="tel"
                              inputMode="tel"
                              maxLength={15}
                            />
                            <Input
                              id={`reservation-companion-email-${companion.key}`}
                              name={`companions[${index}].email`}
                              type="email"
                              value={companion.email}
                              onChange={(event) => updateCompanionForm(companion.key, 'email', event.target.value)}
                              placeholder="Email"
                              autoComplete="email"
                              inputMode="email"
                              spellCheck={false}
                            />
                            <Input
                              id={`reservation-companion-birthdate-${companion.key}`}
                              name={`companions[${index}].birthdate`}
                              type="date"
                              value={companion.birthdate}
                              onChange={(event) => updateCompanionForm(companion.key, 'birthdate', event.target.value)}
                              autoComplete="bday"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <Button
                className="w-full"
                onClick={handleSaveStatus}
                disabled={saveStatusMutation.isPending}
              >
                {saveStatusMutation.isPending ? 'Salvando...' : editStatus === 'checked_in' ? 'Confirmar check-in' : 'Salvar'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={createDialog}
        onOpenChange={(open) => {
          setCreateDialog(open);
          if (!open) {
            setManualReservationForm(createManualReservationForm());
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nova reserva manual</DialogTitle>
          </DialogHeader>

          <form
            className="space-y-4 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              createReservationMutation.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="manual-reservation-name">Nome *</Label>
                <Input
                  id="manual-reservation-name"
                  name="guest_name"
                  value={manualReservationForm.guest_name}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, guest_name: event.target.value }))
                  }
                  placeholder="Nome do cliente"
                  autoComplete="name"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-reservation-phone">WhatsApp *</Label>
                <Input
                  id="manual-reservation-phone"
                  name="guest_phone"
                  type="tel"
                  value={manualReservationForm.guest_phone}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, guest_phone: formatBrazilPhone(event.target.value) }))
                  }
                  placeholder="(11) 99999-9999"
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={15}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-reservation-email">Email</Label>
                <Input
                  id="manual-reservation-email"
                  name="guest_email"
                  type="email"
                  value={manualReservationForm.guest_email}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, guest_email: event.target.value }))
                  }
                  placeholder="cliente@email.com"
                  autoComplete="email"
                  inputMode="email"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-reservation-birthdate">Data de nascimento</Label>
                <Input
                  id="manual-reservation-birthdate"
                  name="guest_birthdate"
                  type="date"
                  value={manualReservationForm.guest_birthdate}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, guest_birthdate: event.target.value }))
                  }
                  autoComplete="bday"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-reservation-date">Data *</Label>
                <Input
                  id="manual-reservation-date"
                  name="date"
                  type="date"
                  value={manualReservationForm.date}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, date: event.target.value }))
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-reservation-time">Horario *</Label>
                <Input
                  id="manual-reservation-time"
                  name="time"
                  type="time"
                  value={manualReservationForm.time}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, time: event.target.value }))
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-reservation-party-size">Pessoas *</Label>
                <Input
                  id="manual-reservation-party-size"
                  name="party_size"
                  type="number"
                  min="1"
                  max="50"
                  value={manualReservationForm.party_size}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, party_size: event.target.value }))
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-reservation-occasion">Ocasiao</Label>
                <Input
                  id="manual-reservation-occasion"
                  name="occasion"
                  value={manualReservationForm.occasion}
                  onChange={(event) =>
                    setManualReservationForm((current) => ({ ...current, occasion: event.target.value }))
                  }
                  placeholder="Ex: aniversario"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-reservation-notes">Observacoes</Label>
              <Textarea
                id="manual-reservation-notes"
                name="notes"
                value={manualReservationForm.notes}
                onChange={(event) =>
                  setManualReservationForm((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder="Preferências do cliente, restrições, observações internas..."
                rows={4}
                autoComplete="off"
              />
            </div>

            <div className="rounded-2xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              A reserva será criada como <span className="font-medium text-foreground">Confirmada</span>. O check-in e os acompanhantes podem ser registrados depois, no dia do atendimento.
            </div>

            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setCreateDialog(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={createReservationMutation.isPending}>
                {createReservationMutation.isPending ? 'Criando...' : 'Criar reserva'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir reserva?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. A reserva será removida permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteConfirmId) deleteMutation.mutate(deleteConfirmId);
                setDeleteConfirmId(null);
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!dayModal} onOpenChange={(open) => !open && setDayModal(null)}>
        <DialogContent className="max-h-[80vh] w-[calc(100vw-2rem)] max-w-3xl overflow-x-hidden overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="pr-10 text-left leading-tight">
              Reservas - {dayModal && format(new Date(`${dayModal}T12:00:00`), "EEEE, dd 'de' MMMM", { locale: ptBR })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 pt-2">
            {dayModalReservations.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nenhuma reserva para este dia.
              </p>
            ) : (
              dayModalReservations.map((reservation) => (
                <div key={reservation.id} className="rounded-[24px] border border-border bg-card p-4 shadow-sm">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                    <div className="flex items-center gap-3 lg:w-28 lg:flex-col lg:items-start lg:gap-2">
                      <div className="inline-flex min-w-[78px] items-center justify-center rounded-2xl bg-primary/10 px-4 py-3 text-xl font-semibold text-primary">
                        {reservation.time.slice(0, 5)}
                      </div>
                      <ReservationStatusBadge status={reservation.status} />
                    </div>

                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="break-words text-base font-semibold text-foreground">{reservation.guest_name}</div>
                          <div className="mt-1 text-sm tabular-nums text-muted-foreground">
                            {formatBrazilPhone(reservation.guest_phone)}
                          </div>
                        </div>

                        {reservation.source && (
                          <div className="shrink-0">
                            <ReservationSourceBadge source={reservation.source} />
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                          <Users className="h-3 w-3" />
                          {reservation.party_size} {reservation.party_size === 1 ? 'pessoa' : 'pessoas'}
                        </span>
                        {reservation.occasion && (
                          <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                            {reservation.occasion}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-2 border-t border-border/70 pt-3 sm:flex-row sm:flex-wrap sm:justify-end">
                    {reservation.status === 'confirmed' && (
                      <Button
                        variant="outline"
                        className="h-9 rounded-xl px-4 text-sm"
                        onClick={() => openCheckIn(reservation)}
                      >
                        Realizar check-in
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      className="h-9 gap-2 rounded-xl px-4 text-sm"
                      onClick={() => {
                        setDayModal(null);
                        openDetails(reservation, { returnDay: dayModal });
                      }}
                    >
                      <Eye className="h-4 w-4" />
                      Ver reserva
                    </Button>

                    <Button
                      variant="outline"
                      className="h-9 gap-2 rounded-xl px-4 text-sm"
                      onClick={() => openEdit(reservation)}
                    >
                      <Pencil className="h-4 w-4" />
                      Editar
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
