import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endOfDay, format, parseISO, startOfDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CalendarDays,
  CalendarIcon,
  Download,
  Eye,
  Mail,
  MapPin,
  Phone,
  Search,
  X,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { downloadCsv, formatDateRangeLabel, matchesLocalDateRange, matchesTimestampRange } from '@/lib/export-utils';
import { cn } from '@/lib/utils';
import { formatBrazilPhone } from '@/lib/validation';
import { toast } from 'sonner';
import type { DateRange } from 'react-day-picker';

type LeadVisitSource =
  | 'reservation_holder'
  | 'companion'
  | 'waitlist_holder'
  | 'waitlist_companion';
type LeadVisitOrigin = 'reservation' | 'waitlist';

interface LeadVisitRecord {
  id: string;
  visit_id: string;
  created_at: string;
  date: string;
  guest_birthdate: string | null;
  guest_email: string | null;
  guest_name: string;
  guest_phone: string;
  occasion: string | null;
  party_size: number;
  status: string;
  time: string;
  lead_source: LeadVisitSource;
  visit_origin: LeadVisitOrigin;
  reservation_holder_name: string | null;
}

interface ReservationCompanionRecord {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  birthdate: string | null;
  created_at: string;
  reservation_id: string;
  reservation: {
    id: string;
    guest_name: string;
    date: string;
    time: string;
    party_size: number;
    status: string;
    occasion: string | null;
    created_at: string;
    source: string | null;
  } | null;
}

interface WaitlistRecord {
  id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  guest_birthdate: string | null;
  party_size: number;
  seated_party_size: number | null;
  status: string;
  created_at: string;
  seated_at: string | null;
}

interface WaitlistCompanionRecord {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  birthdate: string | null;
  created_at: string;
  waitlist_id: string;
  waitlist: {
    id: string;
    guest_name: string;
    party_size: number;
    seated_party_size: number | null;
    status: string;
    created_at: string;
    seated_at: string | null;
  } | null;
}

type LeadSource = LeadVisitSource | 'mixed';
type LeadSourceFilter = 'all' | 'holder' | 'companion';

interface Lead {
  key: string;
  guest_phone: string;
  phone_digits: string;
  guest_name: string;
  guest_email: string | null;
  guest_birthdate: string | null;
  total_reservations: number;
  lead_created_at: string;
  last_reservation_date: string;
  last_reservation_time: string;
  stateCode: string | null;
  stateName: string | null;
  source: LeadSource;
  reservations: LeadVisitRecord[];
}

const LEADS_PAGE_SIZE_OPTIONS = ['25', '50', '100'] as const;
const LEAD_EXPORT_STATUS_OPTIONS = [
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'checked_in', label: 'Check-in realizado' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'no-show', label: 'Não compareceu' },
  { value: 'seated', label: 'Sentado' },
] as const;

const DDD_TO_STATE: Record<string, { code: string; name: string }> = {
  '11': { code: 'SP', name: 'São Paulo' },
  '12': { code: 'SP', name: 'São Paulo' },
  '13': { code: 'SP', name: 'São Paulo' },
  '14': { code: 'SP', name: 'São Paulo' },
  '15': { code: 'SP', name: 'São Paulo' },
  '16': { code: 'SP', name: 'São Paulo' },
  '17': { code: 'SP', name: 'São Paulo' },
  '18': { code: 'SP', name: 'São Paulo' },
  '19': { code: 'SP', name: 'São Paulo' },
  '21': { code: 'RJ', name: 'Rio de Janeiro' },
  '22': { code: 'RJ', name: 'Rio de Janeiro' },
  '24': { code: 'RJ', name: 'Rio de Janeiro' },
  '27': { code: 'ES', name: 'Espírito Santo' },
  '28': { code: 'ES', name: 'Espírito Santo' },
  '31': { code: 'MG', name: 'Minas Gerais' },
  '32': { code: 'MG', name: 'Minas Gerais' },
  '33': { code: 'MG', name: 'Minas Gerais' },
  '34': { code: 'MG', name: 'Minas Gerais' },
  '35': { code: 'MG', name: 'Minas Gerais' },
  '37': { code: 'MG', name: 'Minas Gerais' },
  '38': { code: 'MG', name: 'Minas Gerais' },
  '41': { code: 'PR', name: 'Paraná' },
  '42': { code: 'PR', name: 'Paraná' },
  '43': { code: 'PR', name: 'Paraná' },
  '44': { code: 'PR', name: 'Paraná' },
  '45': { code: 'PR', name: 'Paraná' },
  '46': { code: 'PR', name: 'Paraná' },
  '47': { code: 'SC', name: 'Santa Catarina' },
  '48': { code: 'SC', name: 'Santa Catarina' },
  '49': { code: 'SC', name: 'Santa Catarina' },
  '51': { code: 'RS', name: 'Rio Grande do Sul' },
  '53': { code: 'RS', name: 'Rio Grande do Sul' },
  '54': { code: 'RS', name: 'Rio Grande do Sul' },
  '55': { code: 'RS', name: 'Rio Grande do Sul' },
  '61': { code: 'DF', name: 'Distrito Federal' },
  '62': { code: 'GO', name: 'Goiás' },
  '63': { code: 'TO', name: 'Tocantins' },
  '64': { code: 'GO', name: 'Goiás' },
  '65': { code: 'MT', name: 'Mato Grosso' },
  '66': { code: 'MT', name: 'Mato Grosso' },
  '67': { code: 'MS', name: 'Mato Grosso do Sul' },
  '68': { code: 'AC', name: 'Acre' },
  '69': { code: 'RO', name: 'Rondônia' },
  '71': { code: 'BA', name: 'Bahia' },
  '73': { code: 'BA', name: 'Bahia' },
  '74': { code: 'BA', name: 'Bahia' },
  '75': { code: 'BA', name: 'Bahia' },
  '77': { code: 'BA', name: 'Bahia' },
  '79': { code: 'SE', name: 'Sergipe' },
  '81': { code: 'PE', name: 'Pernambuco' },
  '82': { code: 'AL', name: 'Alagoas' },
  '83': { code: 'PB', name: 'Paraíba' },
  '84': { code: 'RN', name: 'Rio Grande do Norte' },
  '85': { code: 'CE', name: 'Ceará' },
  '86': { code: 'PI', name: 'Piauí' },
  '87': { code: 'PE', name: 'Pernambuco' },
  '88': { code: 'CE', name: 'Ceará' },
  '89': { code: 'PI', name: 'Piauí' },
  '91': { code: 'PA', name: 'Pará' },
  '92': { code: 'AM', name: 'Amazonas' },
  '93': { code: 'PA', name: 'Pará' },
  '94': { code: 'PA', name: 'Pará' },
  '95': { code: 'RR', name: 'Roraima' },
  '96': { code: 'AP', name: 'Amapá' },
  '97': { code: 'AM', name: 'Amazonas' },
  '98': { code: 'MA', name: 'Maranhão' },
  '99': { code: 'MA', name: 'Maranhão' },
};

function normalizePhone(phone: string | null | undefined) {
  return (phone ?? '').replace(/\D/g, '');
}

function getDddFromPhone(phone: string | null | undefined) {
  const digits = normalizePhone(phone);

  if (digits.length >= 12 && digits.startsWith('55')) {
    return digits.slice(2, 4);
  }

  if (digits.length >= 10) {
    return digits.slice(0, 2);
  }

  return null;
}

function getStateFromPhone(phone: string | null | undefined) {
  const ddd = getDddFromPhone(phone);
  return ddd ? DDD_TO_STATE[ddd] ?? null : null;
}

function compareReservationDateTime(
  dateA: string,
  timeA: string,
  dateB: string,
  timeB: string,
) {
  const dateComparison = dateA.localeCompare(dateB);

  if (dateComparison !== 0) {
    return dateComparison;
  }

  return timeA.localeCompare(timeB);
}

function normalizeVisitStatus(status: string) {
  if (status === 'completed') {
    return 'checked_in';
  }

  if (status === 'no_show') {
    return 'no-show';
  }

  return status;
}

function formatLeadState(lead: Pick<Lead, 'stateCode' | 'stateName'>) {
  return lead.stateCode && lead.stateName ? `${lead.stateName} (${lead.stateCode})` : 'DDD não identificado';
}

function isCompanionVisitSource(source: LeadVisitSource) {
  return source === 'companion' || source === 'waitlist_companion';
}

function isHolderVisitSource(source: LeadVisitSource) {
  return source === 'reservation_holder' || source === 'waitlist_holder';
}

function formatLeadSource(source: LeadSource) {
  if (source === 'mixed') {
    return 'Multiplos papeis';
  }

  return isCompanionVisitSource(source) ? 'Acompanhante' : 'Titular';
}

function getLeadSourceFromVisits(visits: LeadVisitRecord[]): LeadSource {
  const hasHolder = visits.some((visit) => isHolderVisitSource(visit.lead_source));
  const hasCompanion = visits.some((visit) => isCompanionVisitSource(visit.lead_source));

  if (hasHolder && hasCompanion) {
    return 'mixed';
  }

  return hasCompanion ? 'companion' : 'reservation_holder';
}

function formatReservationStatus(status: string) {
  switch (normalizeVisitStatus(status)) {
    case 'confirmed':
      return 'Confirmada';
    case 'checked_in':
      return 'Check-in realizado';
    case 'cancelled':
      return 'Cancelada';
    case 'completed':
      return 'Check-in realizado';
    case 'no-show':
    case 'no_show':
      return 'Não compareceu';
    case 'seated':
      return 'Sentado';
    default:
      return status;
  }
}

function formatLeadVisitContext(visit: LeadVisitRecord) {
  if (isCompanionVisitSource(visit.lead_source)) {
    return visit.reservation_holder_name
      ? ` · Acompanhou ${visit.reservation_holder_name}`
      : visit.visit_origin === 'waitlist'
        ? ' · Acompanhante da fila'
        : ' · Acompanhante da reserva';
  }

  return visit.visit_origin === 'waitlist'
    ? ' · Titular da fila'
    : ' · Titular da reserva';
}

function formatLeadCreatedAt(date: string) {
  return format(parseISO(date), 'dd/MM/yyyy', { locale: ptBR });
}

function formatLeadDateRangeLabel(range: DateRange | undefined) {
  return formatDateRangeLabel(range, 'Criado em');
}

function getVisiblePages(currentPage: number, totalPages: number) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', totalPages] as const;
  }

  if (currentPage >= totalPages - 3) {
    return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages] as const;
  }

  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages] as const;
}

export default function Leads() {
  const { companyId } = useCompanySlug();
  const [search, setSearch] = useState('');
  const [createdRange, setCreatedRange] = useState<DateRange | undefined>();
  const [createdFrom, setCreatedFrom] = useState<Date | undefined>();
  const [createdTo, setCreatedTo] = useState<Date | undefined>();
  const [stateFilter, setStateFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState<LeadSourceFilter>('all');
  const [minReservations, setMinReservations] = useState('');
  const [maxReservations, setMaxReservations] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof LEADS_PAGE_SIZE_OPTIONS)[number]>('25');
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportLeadCreatedRange, setExportLeadCreatedRange] = useState<DateRange | undefined>();
  const [exportVisitRange, setExportVisitRange] = useState<DateRange | undefined>();
  const [exportStateFilter, setExportStateFilter] = useState('all');
  const [exportSourceFilter, setExportSourceFilter] = useState<LeadSourceFilter>('all');
  const [exportStatuses, setExportStatuses] = useState<string[]>([]);
  const [exportSearchTriggered, setExportSearchTriggered] = useState(false);

  useEffect(() => {
    setCreatedFrom(createdRange?.from);
    setCreatedTo(createdRange?.to);
  }, [createdRange]);

  const { data: reservations = [], isLoading: reservationsLoading } = useQuery({
    queryKey: ['leads-reservations', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as never)
        .select(
          'id, guest_name, guest_phone, guest_email, guest_birthdate, date, time, party_size, status, occasion, created_at, source',
        )
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return ((data ?? []) as any[])
        .filter((reservation) => reservation.source !== 'waitlist')
        .map((reservation) => ({
          ...reservation,
          visit_id: reservation.id,
          lead_source: 'reservation_holder' as const,
          visit_origin: 'reservation' as const,
          reservation_holder_name: reservation.guest_name,
        })) as LeadVisitRecord[];
    },
    enabled: !!companyId,
  });

  const { data: companionVisits = [], isLoading: companionsLoading } = useQuery({
    queryKey: ['leads-companions', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservation_companions' as never)
        .select(
          'id, name, phone, email, birthdate, created_at, reservation_id, reservation:reservations!inner(id, guest_name, date, time, party_size, status, occasion, created_at, source)',
        )
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return ((data ?? []) as any[]).flatMap((companion) => {
        const reservation = (
          Array.isArray(companion.reservation)
            ? companion.reservation[0]
            : companion.reservation
        ) as ReservationCompanionRecord['reservation'];

        if (!reservation || reservation.source === 'waitlist') {
          return [];
        }

        return [{
          id: `companion-${companion.id}`,
          visit_id: companion.reservation_id,
          created_at: companion.created_at ?? reservation.created_at,
          date: reservation.date,
          guest_birthdate: companion.birthdate ?? null,
          guest_email: companion.email ?? null,
          guest_name: companion.name,
          guest_phone: companion.phone ?? '',
          occasion: reservation.occasion ?? null,
          party_size: reservation.party_size,
          status: reservation.status,
          time: reservation.time,
          lead_source: 'companion' as const,
          visit_origin: 'reservation' as const,
          reservation_holder_name: reservation.guest_name ?? null,
        }] satisfies LeadVisitRecord[];
      });
    },
    enabled: !!companyId,
  });

  const { data: waitlistVisits = [], isLoading: waitlistLoading } = useQuery({
    queryKey: ['leads-waitlist', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('waitlist' as never)
        .select(
          'id, guest_name, guest_phone, guest_email, guest_birthdate, party_size, seated_party_size, status, created_at, seated_at',
        )
        .eq('company_id', companyId!)
        .eq('status', 'seated')
        .order('seated_at', { ascending: false });

      if (error) {
        throw error;
      }

      return ((data ?? []) as WaitlistRecord[]).map((entry) => {
        const seatedAt = entry.seated_at ?? entry.created_at;
        return {
          id: `waitlist-${entry.id}`,
          visit_id: entry.id,
          created_at: entry.created_at,
          date: seatedAt.slice(0, 10),
          guest_birthdate: entry.guest_birthdate ?? null,
          guest_email: entry.guest_email ?? null,
          guest_name: entry.guest_name,
          guest_phone: entry.guest_phone,
          occasion: null,
          party_size: entry.seated_party_size ?? entry.party_size,
          status: entry.status,
          time: seatedAt.slice(11, 19),
          lead_source: 'waitlist_holder' as const,
          visit_origin: 'waitlist' as const,
          reservation_holder_name: entry.guest_name,
        };
      }) as LeadVisitRecord[];
    },
    enabled: !!companyId,
  });

  const { data: waitlistCompanionVisits = [], isLoading: waitlistCompanionsLoading } = useQuery({
    queryKey: ['leads-waitlist-companions', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('waitlist_companions' as never)
        .select(
          'id, name, phone, email, birthdate, created_at, waitlist_id, waitlist:waitlist!inner(id, guest_name, party_size, seated_party_size, status, created_at, seated_at)',
        )
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return ((data ?? []) as any[]).flatMap((companion) => {
        const waitlist = (
          Array.isArray(companion.waitlist)
            ? companion.waitlist[0]
            : companion.waitlist
        ) as WaitlistCompanionRecord['waitlist'];

        if (!waitlist) {
          return [];
        }

        const seatedAt = waitlist.seated_at ?? waitlist.created_at;

        return [{
          id: `waitlist-companion-${companion.id}`,
          visit_id: companion.waitlist_id,
          created_at: companion.created_at ?? waitlist.created_at,
          date: seatedAt.slice(0, 10),
          guest_birthdate: companion.birthdate ?? null,
          guest_email: companion.email ?? null,
          guest_name: companion.name,
          guest_phone: companion.phone ?? '',
          occasion: null,
          party_size: waitlist.seated_party_size ?? waitlist.party_size,
          status: waitlist.status,
          time: seatedAt.slice(11, 19),
          lead_source: 'waitlist_companion' as const,
          visit_origin: 'waitlist' as const,
          reservation_holder_name: waitlist.guest_name ?? null,
        }] satisfies LeadVisitRecord[];
      });
    },
    enabled: !!companyId,
  });

  const isLoading = reservationsLoading || companionsLoading || waitlistLoading || waitlistCompanionsLoading;

  const leads = useMemo(() => {
    const map = new Map<string, Lead>();
    const allVisits = [...reservations, ...companionVisits, ...waitlistVisits, ...waitlistCompanionVisits];

    for (const visit of allVisits) {
      const phoneDigits = normalizePhone(visit.guest_phone);
      const key = phoneDigits || visit.guest_phone || visit.id;

      if (!map.has(key)) {
        const state = getStateFromPhone(visit.guest_phone);

        map.set(key, {
          key,
          guest_phone: visit.guest_phone,
          phone_digits: phoneDigits,
          guest_name: visit.guest_name,
          guest_email: visit.guest_email,
          guest_birthdate: visit.guest_birthdate,
          total_reservations: 0,
          lead_created_at: visit.created_at,
          last_reservation_date: visit.date,
          last_reservation_time: visit.time,
          stateCode: state?.code ?? null,
          stateName: state?.name ?? null,
          source: visit.lead_source,
          reservations: [],
        });
      }

      const lead = map.get(key)!;
      const state = getStateFromPhone(visit.guest_phone);

      lead.total_reservations += 1;
      lead.reservations.push(visit);

      if (visit.guest_name) {
        lead.guest_name = visit.guest_name;
      }

      if (visit.guest_email) {
        lead.guest_email = visit.guest_email;
      }

      if (visit.guest_birthdate) {
        lead.guest_birthdate = visit.guest_birthdate;
      }

      if (visit.guest_phone) {
        lead.guest_phone = visit.guest_phone;
        lead.phone_digits = phoneDigits;
        lead.stateCode = state?.code ?? null;
        lead.stateName = state?.name ?? null;
      }

      if (visit.created_at.localeCompare(lead.lead_created_at) < 0) {
        lead.lead_created_at = visit.created_at;
      }

      if (
        compareReservationDateTime(
          visit.date,
          visit.time,
          lead.last_reservation_date,
          lead.last_reservation_time,
        ) > 0
      ) {
        lead.last_reservation_date = visit.date;
        lead.last_reservation_time = visit.time;
      }

      if (lead.source !== visit.lead_source) {
        lead.source = 'mixed';
      }
    }

    return Array.from(map.values())
      .map((lead) => ({
        ...lead,
        reservations: [...lead.reservations].sort((a, b) =>
          compareReservationDateTime(b.date, b.time, a.date, a.time),
        ),
      }))
      .sort((a, b) => {
        const reservationDiff = b.total_reservations - a.total_reservations;

        if (reservationDiff !== 0) {
          return reservationDiff;
        }

        return b.lead_created_at.localeCompare(a.lead_created_at);
      });
  }, [companionVisits, reservations, waitlistCompanionVisits, waitlistVisits]);

  const stateOptions = useMemo(() => {
    const uniqueStates = new Map<string, string>();

    for (const lead of leads) {
      if (lead.stateCode && lead.stateName) {
        uniqueStates.set(lead.stateCode, lead.stateName);
      }
    }

    return Array.from(uniqueStates.entries())
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [leads]);

  const filteredLeads = useMemo(() => {
    const searchTerm = search.trim().toLowerCase();
    const searchDigits = normalizePhone(search);
    const parsedMinReservations = minReservations ? Number(minReservations) : null;
    const parsedMaxReservations = maxReservations ? Number(maxReservations) : null;

    return leads.filter((lead) => {
      if (searchTerm) {
        const matchesText =
          lead.guest_name.toLowerCase().includes(searchTerm) ||
          lead.guest_email?.toLowerCase().includes(searchTerm) ||
          lead.guest_phone.toLowerCase().includes(searchTerm);

        const matchesPhoneDigits = searchDigits.length > 0 && lead.phone_digits.includes(searchDigits);

        if (!matchesText && !matchesPhoneDigits) {
          return false;
        }
      }

      const leadCreatedAt = parseISO(lead.lead_created_at);

      if (createdFrom && leadCreatedAt < startOfDay(createdFrom)) {
        return false;
      }

      if (createdTo && leadCreatedAt > endOfDay(createdTo)) {
        return false;
      }

      if (stateFilter === 'unknown' && lead.stateCode) {
        return false;
      }

      if (stateFilter !== 'all' && stateFilter !== 'unknown' && lead.stateCode !== stateFilter) {
        return false;
      }

      if (
        sourceFilter === 'holder' &&
        !lead.reservations.some((reservation) => isHolderVisitSource(reservation.lead_source))
      ) {
        return false;
      }

      if (
        sourceFilter === 'companion' &&
        !lead.reservations.some((reservation) => isCompanionVisitSource(reservation.lead_source))
      ) {
        return false;
      }

      if (parsedMinReservations !== null && !Number.isNaN(parsedMinReservations) && lead.total_reservations < parsedMinReservations) {
        return false;
      }

      if (parsedMaxReservations !== null && !Number.isNaN(parsedMaxReservations) && lead.total_reservations > parsedMaxReservations) {
        return false;
      }

      return true;
    });
  }, [createdFrom, createdTo, leads, maxReservations, minReservations, search, sourceFilter, stateFilter]);

  const filteredReservationsCount = useMemo(
    () => filteredLeads.reduce((total, lead) => total + lead.total_reservations, 0),
    [filteredLeads],
  );
  const totalLeadRecords =
    reservations.length +
    companionVisits.length +
    waitlistVisits.length +
    waitlistCompanionVisits.length;

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / Number(pageSize)));

  const paginatedLeads = useMemo(() => {
    const size = Number(pageSize);
    const startIndex = (currentPage - 1) * size;
    return filteredLeads.slice(startIndex, startIndex + size);
  }, [currentPage, filteredLeads, pageSize]);

  const pageSummary = useMemo(() => {
    if (filteredLeads.length === 0) {
      return 'Exibindo 0 de 0 leads';
    }

    const size = Number(pageSize);
    const start = (currentPage - 1) * size + 1;
    const end = Math.min(currentPage * size, filteredLeads.length);

    return `Exibindo ${start}-${end} de ${filteredLeads.length} leads`;
  }, [currentPage, filteredLeads.length, pageSize]);

  const visiblePages = useMemo(() => getVisiblePages(currentPage, totalPages), [currentPage, totalPages]);

  const hasActiveFilters =
    search.trim().length > 0 ||
    !!createdFrom ||
    !!createdTo ||
    stateFilter !== 'all' ||
    sourceFilter !== 'all' ||
    minReservations.trim().length > 0 ||
    maxReservations.trim().length > 0;

  useEffect(() => {
    setCurrentPage(1);
  }, [search, createdFrom, createdTo, stateFilter, sourceFilter, minReservations, maxReservations, pageSize]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const exportedLeads = useMemo(() => {
    return leads
      .map((lead) => {
        if (!matchesTimestampRange(lead.lead_created_at, exportLeadCreatedRange)) {
          return null;
        }

        if (exportStateFilter === 'unknown' && lead.stateCode) {
          return null;
        }

        if (exportStateFilter !== 'all' && exportStateFilter !== 'unknown' && lead.stateCode !== exportStateFilter) {
          return null;
        }

        const matchedVisits = lead.reservations.filter((visit) => {
          if (exportSourceFilter === 'holder' && !isHolderVisitSource(visit.lead_source)) {
            return false;
          }

          if (exportSourceFilter === 'companion' && !isCompanionVisitSource(visit.lead_source)) {
            return false;
          }

          if (!matchesLocalDateRange(visit.date, exportVisitRange)) {
            return false;
          }

          if (exportStatuses.length > 0 && !exportStatuses.includes(normalizeVisitStatus(visit.status))) {
            return false;
          }

          return true;
        });

        if (matchedVisits.length === 0) {
          return null;
        }

        return {
          lead,
          matchedVisits,
          matchedSource: getLeadSourceFromVisits(matchedVisits),
        };
      })
      .filter((item): item is { lead: Lead; matchedVisits: LeadVisitRecord[]; matchedSource: LeadSource } => item !== null);
  }, [exportLeadCreatedRange, exportSourceFilter, exportStateFilter, exportStatuses, exportVisitRange, leads]);

  const exportedLeadsSummary = useMemo(() => {
    const totalVisits = exportedLeads.reduce((sum, item) => sum + item.matchedVisits.length, 0);

    return {
      totalLeads: exportedLeads.length,
      totalVisits,
      byStatus: LEAD_EXPORT_STATUS_OPTIONS.map((status) => ({
        ...status,
        count: exportedLeads.reduce(
          (sum, item) =>
            sum + item.matchedVisits.filter((visit) => normalizeVisitStatus(visit.status) === status.value).length,
          0,
        ),
      })),
    };
  }, [exportedLeads]);

  const clearFilters = () => {
    setSearch('');
    setCreatedRange(undefined);
    setCreatedFrom(undefined);
    setCreatedTo(undefined);
    setStateFilter('all');
    setSourceFilter('all');
    setMinReservations('');
    setMaxReservations('');
    setCurrentPage(1);
  };

  const clearExportFilters = () => {
    setExportLeadCreatedRange(undefined);
    setExportVisitRange(undefined);
    setExportStateFilter('all');
    setExportSourceFilter('all');
    setExportStatuses([]);
    setExportSearchTriggered(false);
  };

  const toggleExportStatus = (status: string, checked: boolean) => {
    setExportStatuses((current) =>
      checked ? [...current, status] : current.filter((value) => value !== status),
    );
  };

  const exportLeadsCsv = () => {
    const rows = exportedLeads.map(({ lead, matchedVisits, matchedSource }) => [
      lead.guest_name,
      formatBrazilPhone(lead.guest_phone),
      lead.guest_email || '',
      lead.stateCode ? `${lead.stateName} (${lead.stateCode})` : '',
      lead.guest_birthdate || '',
      format(parseISO(lead.lead_created_at), 'dd/MM/yyyy HH:mm'),
      formatLeadSource(matchedSource),
      matchedVisits.length,
      lead.total_reservations,
      matchedVisits[0]
        ? `${format(new Date(`${matchedVisits[0].date}T12:00:00`), 'dd/MM/yyyy')} ${matchedVisits[0].time.slice(0, 5)}`
        : '',
      matchedVisits
        .map((visit) => {
          const visitStatus = formatReservationStatus(visit.status);
          const visitMoment = `${format(new Date(`${visit.date}T12:00:00`), 'dd/MM/yyyy')} ${visit.time.slice(0, 5)}`;
          return `${visitMoment} - ${visitStatus}${formatLeadVisitContext(visit)}${visit.occasion ? ` - ${visit.occasion}` : ''}`;
        })
        .join(' | '),
    ]);

    downloadCsv(
      `leads_${format(new Date(), 'yyyy-MM-dd')}.csv`,
      [
        'Nome',
        'WhatsApp',
        'Email',
        'Estado',
        'Nascimento',
        'Lead criado em',
        'Papel filtrado',
        'Visitas filtradas',
        'Visitas totais',
        'Ultima visita filtrada',
        'Histórico filtrado',
      ],
      rows,
    );

    toast.success(`${exportedLeads.length} leads exportados.`);
  };

  const getStatusColor = (status: string) => {
    switch (normalizeVisitStatus(status)) {
      case 'confirmed':
        return 'bg-primary text-primary-foreground';
      case 'checked_in':
        return 'bg-info text-info-foreground';
      case 'cancelled':
        return 'bg-destructive text-destructive-foreground';
      case 'no-show':
        return 'bg-secondary text-secondary-foreground';
      case 'seated':
        return 'bg-success text-success-foreground';
      default:
        return 'bg-secondary text-secondary-foreground';
    }
  };

  const summaryText = hasActiveFilters
    ? `${filteredLeads.length} de ${leads.length} clientes · ${filteredReservationsCount} de ${totalLeadRecords} registros`
    : `${leads.length} clientes · ${totalLeadRecords} registros`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Leads</h1>
          <p className="text-sm text-muted-foreground">{summaryText}</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={pageSize} onValueChange={(value) => setPageSize(value as (typeof LEADS_PAGE_SIZE_OPTIONS)[number])}>
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEADS_PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option} por página
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setExportDialogOpen(true)} variant="outline" className="gap-2" disabled={leads.length === 0}>
            <Download className="h-4 w-4" />
            Exportar leads
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_220px_220px_220px_130px_130px_auto]">
        <div className="relative md:col-span-2 xl:col-span-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, telefone ou email..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-10"
          />
        </div>

        <Select value={stateFilter} onValueChange={setStateFilter}>
          <SelectTrigger>
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os estados</SelectItem>
            <SelectItem value="unknown">DDD não identificado</SelectItem>
            {stateOptions.map((state) => (
              <SelectItem key={state.code} value={state.code}>
                {state.name} ({state.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as LeadSourceFilter)}>
          <SelectTrigger>
            <SelectValue placeholder="Papel" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os papeis</SelectItem>
            <SelectItem value="holder">Titular</SelectItem>
            <SelectItem value="companion">Acompanhante</SelectItem>
          </SelectContent>
        </Select>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn('justify-start text-left text-sm', !createdRange?.from && 'text-muted-foreground')}
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {formatLeadDateRangeLabel(createdRange)}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={createdRange}
              onSelect={setCreatedRange}
              numberOfMonths={2}
              initialFocus
              className="pointer-events-auto p-3"
            />
          </PopoverContent>
        </Popover>

        <Input
          type="number"
          min="1"
          inputMode="numeric"
          placeholder="Visitas min."
          value={minReservations}
          onChange={(event) => setMinReservations(event.target.value)}
        />

        <Input
          type="number"
          min="1"
          inputMode="numeric"
          placeholder="Visitas max."
          value={maxReservations}
          onChange={(event) => setMaxReservations(event.target.value)}
        />

        <Button variant="ghost" className="gap-2" disabled={!hasActiveFilters} onClick={clearFilters}>
          <X className="h-4 w-4" />
          Limpar
        </Button>
      </div>

      {isLoading ? (
        <p className="py-12 text-center text-muted-foreground">Carregando...</p>
      ) : filteredLeads.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">
          {hasActiveFilters ? 'Nenhum lead encontrado com os filtros atuais' : 'Nenhum lead encontrado'}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{pageSummary}</span>
            <span>Página {currentPage} de {totalPages}</span>
          </div>

          <div className="grid gap-3">
            {paginatedLeads.map((lead) => (
              <Card
                key={lead.key}
                className="cursor-pointer border shadow-sm transition-shadow hover:shadow-md"
                onClick={() => setSelectedLead(lead)}
              >
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {(lead.guest_name.charAt(0) || '?').toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{lead.guest_name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {formatBrazilPhone(lead.guest_phone)}
                        </span>
                        {lead.guest_email && (
                          <span className="flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            {lead.guest_email}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" />
                          Lead desde {formatLeadCreatedAt(lead.lead_created_at)}
                        </span>
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {formatLeadState(lead)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-right">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{lead.total_reservations}</p>
                      <p className="text-xs text-muted-foreground">visitas</p>
                    </div>
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {totalPages > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      if (currentPage > 1) {
                        setCurrentPage(currentPage - 1);
                      }
                    }}
                    className={cn(currentPage === 1 && 'pointer-events-none opacity-50')}
                  />
                </PaginationItem>

                {visiblePages.map((page, index) => (
                  <PaginationItem key={`${page}-${index}`}>
                    {page === 'ellipsis' ? (
                      <PaginationEllipsis />
                    ) : (
                      <PaginationLink
                        href="#"
                        isActive={page === currentPage}
                        onClick={(event) => {
                          event.preventDefault();
                          setCurrentPage(page);
                        }}
                      >
                        {page}
                      </PaginationLink>
                    )}
                  </PaginationItem>
                ))}

                <PaginationItem>
                  <PaginationNext
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      if (currentPage < totalPages) {
                        setCurrentPage(currentPage + 1);
                      }
                    }}
                    className={cn(currentPage === totalPages && 'pointer-events-none opacity-50')}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>
      )}

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
            <DialogTitle>Exportar leads</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 pt-2">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>Criacao do lead</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'h-11 w-full justify-between rounded-xl bg-card px-4 text-left font-normal',
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
              </div>

              <div className="space-y-2">
                <Label>Periodo das visitas</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'h-11 w-full justify-between rounded-xl bg-card px-4 text-left font-normal',
                        !exportVisitRange?.from && 'text-muted-foreground',
                      )}
                    >
                      {formatDateRangeLabel(exportVisitRange, 'Selecionar período')}
                      <CalendarIcon className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="range"
                      selected={exportVisitRange}
                      onSelect={setExportVisitRange}
                      numberOfMonths={2}
                      initialFocus
                      className="pointer-events-auto p-3"
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Estado</Label>
                <Select value={exportStateFilter} onValueChange={setExportStateFilter}>
                  <SelectTrigger className="h-11 rounded-xl bg-card">
                    <SelectValue placeholder="Todos os estados" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os estados</SelectItem>
                    <SelectItem value="unknown">DDD não identificado</SelectItem>
                    {stateOptions.map((state) => (
                      <SelectItem key={state.code} value={state.code}>
                        {state.name} ({state.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Papel</Label>
                <Select value={exportSourceFilter} onValueChange={(value) => setExportSourceFilter(value as LeadSourceFilter)}>
                  <SelectTrigger className="h-11 rounded-xl bg-card">
                    <SelectValue placeholder="Todos os papeis" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os papeis</SelectItem>
                    <SelectItem value="holder">Titular</SelectItem>
                    <SelectItem value="companion">Acompanhante</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Status da visita</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                {LEAD_EXPORT_STATUS_OPTIONS.map((status) => (
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
                Os filtros sao combinados. O resumo usa apenas as visitas que baterem com o recorte escolhido.
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" onClick={clearExportFilters}>
                  Limpar filtros
                </Button>
                <Button onClick={() => setExportSearchTriggered(true)}>
                  Buscar
                </Button>
              </div>
            </div>

            {exportSearchTriggered && (
              <div className="space-y-4 rounded-3xl border border-border bg-muted/20 p-5">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Leads encontrados</p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">{exportedLeadsSummary.totalLeads}</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Visitas filtradas</p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">{exportedLeadsSummary.totalVisits}</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Papel filtrado</p>
                    <p className="mt-2 text-sm font-medium text-foreground">
                      {exportSourceFilter === 'all'
                        ? 'Todos'
                        : exportSourceFilter === 'holder'
                          ? 'Titular'
                          : 'Acompanhante'}
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  {LEAD_EXPORT_STATUS_OPTIONS.map((status) => {
                    const summaryItem = exportedLeadsSummary.byStatus.find((item) => item.value === status.value);

                    return (
                      <div key={status.value} className="rounded-2xl border border-border bg-card p-4">
                        <p className="text-xs text-muted-foreground">{status.label}</p>
                        <p className="mt-1 text-lg font-semibold text-foreground">{summaryItem?.count ?? 0}</p>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    {exportedLeads.length === 0
                      ? 'Nenhum lead encontrado com os filtros informados.'
                      : 'A planilha vai sair com os dados do lead e um histórico resumido somente das visitas filtradas.'}
                  </p>
                  <Button className="gap-2" onClick={exportLeadsCsv} disabled={exportedLeads.length === 0}>
                    <Download className="h-4 w-4" />
                    Exportar planilha
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedLead} onOpenChange={() => setSelectedLead(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          {selectedLead && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 font-bold text-primary">
                    {(selectedLead.guest_name.charAt(0) || '?').toUpperCase()}
                  </div>
                  <div>
                    <p>{selectedLead.guest_name}</p>
                    <p className="text-sm font-normal text-muted-foreground">{formatBrazilPhone(selectedLead.guest_phone)}</p>
                  </div>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-3 pt-2">
                {selectedLead.guest_email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="text-foreground">{selectedLead.guest_email}</span>
                  </div>
                )}

                {selectedLead.guest_birthdate && (
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    <span className="text-foreground">
                      {format(new Date(`${selectedLead.guest_birthdate}T12:00:00`), "dd 'de' MMMM", {
                        locale: ptBR,
                      })}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm">
                  <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-foreground">
                    Lead desde{' '}
                    {format(parseISO(selectedLead.lead_created_at), "dd 'de' MMMM 'de' yyyy", {
                      locale: ptBR,
                    })}
                  </span>
                </div>

                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <span className="text-foreground">{formatLeadState(selectedLead)}</span>
                </div>

              </div>

              <div className="pt-4">
                <h4 className="mb-3 text-sm font-semibold text-foreground">
                  Histórico de Presenças ({selectedLead.total_reservations})
                </h4>
                <div className="max-h-60 space-y-2 overflow-y-auto">
                  {selectedLead.reservations.map((reservation) => (
                    <div
                      key={reservation.id}
                      className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
                    >
                      <div>
                        <p className="font-medium text-foreground">
                          {format(new Date(`${reservation.date}T12:00:00`), 'dd/MM/yyyy', { locale: ptBR })} às{' '}
                          {reservation.time?.substring(0, 5)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {reservation.party_size} pessoas
                          {formatLeadVisitContext(reservation)}
                          {reservation.occasion ? ` · ${reservation.occasion}` : ''}
                        </p>
                      </div>
                      <Badge className={getStatusColor(reservation.status)}>
                        {formatReservationStatus(reservation.status)}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
