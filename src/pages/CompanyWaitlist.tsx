import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CalendarDays,
  Clock3,
  Copy,
  Link2,
  Mail,
  PencilLine,
  Phone,
  Plus,
  Save,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
} from 'lucide-react';
import { endOfDay, format, formatDistanceToNow, startOfDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { cn } from '@/lib/utils';
import {
  isValidBrazilWhatsApp,
  MAX_WAITLIST_NAME_LENGTH,
  MAX_WAITLIST_NOTES_LENGTH,
  normalizePhoneDigits,
} from '@/lib/validation';
import {
  formatWaitlistCountdown,
  getWaitlistCallRemainingMs,
  hasWaitlistCallExpired,
  WAITLIST_CALL_TIMEOUT_MINUTES,
} from '@/lib/waitlist';
import { toast } from 'sonner';

interface WaitlistEntry {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  guest_birthdate: string | null;
  party_size: number;
  seated_party_size: number | null;
  tracking_code: string;
  status: string;
  position: number;
  notes: string | null;
  called_at: string | null;
  seated_at: string | null;
  expired_at: string | null;
  created_at: string;
}

interface WaitlistCompanionForm {
  key: string;
  name: string;
  phone: string;
  email: string;
  birthdate: string;
}

interface WaitlistDetailsForm {
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  guest_birthdate: string;
  party_size: string;
  notes: string;
}

function validateWaitlistGuestInput(input: {
  guest_name: string;
  guest_phone: string;
  notes: string;
}) {
  const guestName = input.guest_name.trim();
  const guestPhone = normalizePhoneDigits(input.guest_phone);
  const notes = input.notes.trim();

  if (!guestName) {
    throw new Error('Informe o nome do cliente.');
  }

  if (guestName.length > MAX_WAITLIST_NAME_LENGTH) {
    throw new Error(`O nome deve ter no máximo ${MAX_WAITLIST_NAME_LENGTH} caracteres.`);
  }

  if (!isValidBrazilWhatsApp(guestPhone)) {
    throw new Error('Informe um WhatsApp válido com DDD.');
  }

  if (notes.length > MAX_WAITLIST_NOTES_LENGTH) {
    throw new Error(`As observações devem ter no máximo ${MAX_WAITLIST_NOTES_LENGTH} caracteres.`);
  }

  return {
    guestName,
    guestPhone,
    notes,
  };
}

function createCompanionForm(values?: Partial<WaitlistCompanionForm>): WaitlistCompanionForm {
  return {
    key: values?.key ?? crypto.randomUUID(),
    name: values?.name ?? '',
    phone: values?.phone ?? '',
    email: values?.email ?? '',
    birthdate: values?.birthdate ?? '',
  };
}

function createWaitlistDetailsForm(entry: WaitlistEntry | null): WaitlistDetailsForm {
  return {
    guest_name: entry?.guest_name ?? '',
    guest_phone: entry?.guest_phone ?? '',
    guest_email: entry?.guest_email ?? '',
    guest_birthdate: entry?.guest_birthdate ?? '',
    party_size: entry ? String(entry.party_size) : '2',
    notes: entry?.notes ?? '',
  };
}

const statusConfig: Record<string, { label: string; className: string }> = {
  waiting: { label: 'Aguardando', className: 'border-primary/20 bg-primary-soft text-primary' },
  called: { label: 'Chamado', className: 'border-info/20 bg-info-soft text-info' },
  seated: { label: 'Sentado', className: 'border-success/20 bg-success-soft text-success' },
  expired: { label: 'Expirado', className: 'border-border bg-muted text-muted-foreground' },
  removed: { label: 'Removido', className: 'border-destructive/20 bg-destructive-soft text-destructive' },
};

const statCards = [
  {
    key: 'waiting',
    label: 'Aguardando',
    icon: Users,
    iconClassName: 'bg-primary-soft text-primary',
  },
  {
    key: 'called',
    label: 'Chamados',
    icon: Bell,
    iconClassName: 'bg-info-soft text-info',
  },
  {
    key: 'seated',
    label: 'Sentados hoje',
    icon: UserCheck,
    iconClassName: 'bg-success-soft text-success',
  },
  {
    key: 'avgWait',
    label: 'Espera média',
    icon: Clock3,
    iconClassName: 'bg-muted text-muted-foreground',
  },
] as const;

export default function CompanyWaitlist() {
  const { companyId, companyName, slug } = useCompanySlug();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    guest_name: '',
    guest_phone: '',
    guest_email: '',
    guest_birthdate: '',
    party_size: 2,
    notes: '',
  });
  const [selectedEntry, setSelectedEntry] = useState<WaitlistEntry | null>(null);
  const [detailsForm, setDetailsForm] = useState<WaitlistDetailsForm>(createWaitlistDetailsForm(null));
  const [seatEntry, setSeatEntry] = useState<WaitlistEntry | null>(null);
  const [showSeatedToday, setShowSeatedToday] = useState(false);
  const [seatedPartySize, setSeatedPartySize] = useState('2');
  const [seatGuestEmail, setSeatGuestEmail] = useState('');
  const [seatGuestBirthdate, setSeatGuestBirthdate] = useState('');
  const [seatCompanionForms, setSeatCompanionForms] = useState<WaitlistCompanionForm[]>([]);
  const [removeEntry, setRemoveEntry] = useState<WaitlistEntry | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['waitlist', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('waitlist' as any)
        .select('*')
        .eq('company_id', companyId)
        .in('status', ['waiting', 'called'])
        .order('position', { ascending: true });

      if (error) throw error;
      return data as unknown as WaitlistEntry[];
    },
    refetchInterval: 10000,
  });

  const todayKey = format(new Date(), 'yyyy-MM-dd');

  const { data: seatedTodayEntries = [] } = useQuery({
    queryKey: ['waitlist-seated-today', companyId, todayKey],
    queryFn: async () => {
      const now = new Date();
      const start = startOfDay(now).toISOString();
      const end = endOfDay(now).toISOString();
      const { data, error } = await supabase
        .from('waitlist' as any)
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'seated')
        .gte('seated_at', start)
        .lte('seated_at', end)
        .order('seated_at', { ascending: false });

      if (error) throw error;
      return (data as unknown as WaitlistEntry[]) ?? [];
    },
    enabled: !!companyId,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (!seatEntry) return;

    const parsedPartySize = Number.parseInt(seatedPartySize, 10);
    const targetCompanionCount = Math.max((Number.isNaN(parsedPartySize) ? 1 : parsedPartySize) - 1, 0);

    setSeatCompanionForms((current) => {
      if (current.length >= targetCompanionCount) {
        return current;
      }

      return [
        ...current,
        ...Array.from({ length: targetCompanionCount - current.length }, () => createCompanionForm()),
      ];
    });
  }, [seatEntry, seatedPartySize]);

  const addMutation = useMutation({
    mutationFn: async () => {
      const { guestName, guestPhone, notes } = validateWaitlistGuestInput(addForm);
      const nextPosition = entries.length > 0 ? Math.max(...entries.map((entry) => entry.position)) + 1 : 1;
      const { data, error } = await supabase
        .from('waitlist' as any)
        .insert({
          company_id: companyId,
          guest_name: guestName,
          guest_phone: guestPhone,
          guest_email: addForm.guest_email || null,
          guest_birthdate: addForm.guest_birthdate || null,
          party_size: addForm.party_size,
          notes: notes || null,
          position: nextPosition,
          status: 'waiting',
        } as any)
        .select('*')
        .single();

      if (error) throw error;
      return data as any;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['waitlist', companyId] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist'] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist-seated'] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist-dropped'] });

      toast.success('Cliente adicionado à fila.');

      supabase.functions.invoke('reservation-events', {
        body: {
          event: 'waitlist_added',
          waitlist: { id: data.id },
        },
      }).catch((error) => console.warn('Waitlist notification error:', error));

      setShowAdd(false);
      setAddForm({
        guest_name: '',
        guest_phone: '',
        guest_email: '',
        guest_birthdate: '',
        party_size: 2,
        notes: '',
      });
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const updateEntryDetails = useMutation({
    mutationFn: async ({
      id,
      payload,
    }: {
      id: string;
      payload: WaitlistDetailsForm;
    }) => {
      const { guestName, guestPhone, notes } = validateWaitlistGuestInput(payload);
      const parsedPartySize = Number.parseInt(payload.party_size, 10);

      if (Number.isNaN(parsedPartySize) || parsedPartySize < 1 || parsedPartySize > 50) {
        throw new Error('Informe uma quantidade valida de pessoas.');
      }

      const { data, error } = await supabase
        .from('waitlist' as any)
        .update({
          guest_name: guestName,
          guest_phone: guestPhone,
          guest_email: payload.guest_email.trim() || null,
          guest_birthdate: payload.guest_birthdate || null,
          party_size: parsedPartySize,
          notes: notes || null,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', id)
        .select('*')
        .single();

      if (error) throw error;
      return data as unknown as WaitlistEntry;
    },
    onSuccess: (updatedEntry) => {
      qc.invalidateQueries({ queryKey: ['waitlist', companyId] });
      qc.invalidateQueries({ queryKey: ['waitlist-seated-today', companyId] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist'] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist-seated'] });
      setSelectedEntry(updatedEntry);
      setDetailsForm(createWaitlistDetailsForm(updatedEntry));
      toast.success('Dados da fila atualizados.');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const updates: any = { status, updated_at: new Date().toISOString() };
      if (status === 'called') updates.called_at = new Date().toISOString();
      if (status === 'seated') updates.seated_at = new Date().toISOString();
      if (status === 'expired') updates.expired_at = new Date().toISOString();
      if (status === 'removed') updates.removed_at = new Date().toISOString();

      const { error } = await supabase
        .from('waitlist' as any)
        .update(updates)
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ['waitlist', companyId] });
      qc.invalidateQueries({ queryKey: ['waitlist-seated-today', companyId] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist'] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist-seated'] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist-dropped'] });

      const labels: Record<string, string> = {
        called: 'Cliente chamado.',
        seated: 'Cliente marcado como sentado.',
        removed: 'Cliente removido.',
        expired: 'Entrada expirada.',
      };

      toast.success(labels[variables.status] || 'Atualizado.');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const seatEntryMutation = useMutation({
    mutationFn: async ({
      id,
      actualPartySize,
      guestEmail,
      guestBirthdate,
      companions,
    }: {
      id: string;
      actualPartySize: number;
      guestEmail: string;
      guestBirthdate: string;
      companions: Array<Omit<WaitlistCompanionForm, 'key'>>;
    }) => {
      const seatedAt = new Date();
      const { data, error } = await (supabase as any).rpc('seat_waitlist_entry', {
        _waitlist_id: id,
        _seated_party_size: actualPartySize,
        _guest_email: guestEmail,
        _guest_birthdate: guestBirthdate,
        _companions: companions,
        _reservation_date: format(seatedAt, 'yyyy-MM-dd'),
        _reservation_time: format(seatedAt, 'HH:mm:ss'),
      });

      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as WaitlistEntry;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['waitlist', companyId] });
      qc.invalidateQueries({ queryKey: ['waitlist-seated-today', companyId] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist'] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist-seated'] });
      qc.invalidateQueries({ queryKey: ['dashboard-waitlist-dropped'] });
      qc.invalidateQueries({ queryKey: ['reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['dashboard-reservations'] });
      qc.invalidateQueries({ queryKey: ['dashboard-reservations-created'] });
      qc.invalidateQueries({ queryKey: ['leads-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['leads-companions', companyId] });
      qc.invalidateQueries({ queryKey: ['leads-waitlist', companyId] });
      qc.invalidateQueries({ queryKey: ['leads-waitlist-companions', companyId] });
      toast.success('Entrada da fila registrada.');
      closeSeatDialog();
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const waitingCount = entries.filter((entry) => entry.status === 'waiting').length;
  const calledCount = entries.filter((entry) => entry.status === 'called').length;
  const seatedTodayStats = useMemo(() => {
    if (seatedTodayEntries.length === 0) {
      return { seated: 0, avgWaitMin: 0 };
    }

    const totalWaitMs = seatedTodayEntries.reduce((sum, entry) => {
      const seatedAt = entry.seated_at ? new Date(entry.seated_at).getTime() : new Date(entry.created_at).getTime();
      return sum + Math.max(seatedAt - new Date(entry.created_at).getTime(), 0);
    }, 0);

    return {
      seated: seatedTodayEntries.length,
      avgWaitMin: Math.round(totalWaitMs / seatedTodayEntries.length / 60000),
    };
  }, [seatedTodayEntries]);

  const stats = useMemo(
    () => ({
      waiting: waitingCount,
      called: calledCount,
      seated: seatedTodayStats.seated,
      avgWait: `${seatedTodayStats.avgWaitMin}min`,
    }),
    [calledCount, seatedTodayStats.avgWaitMin, seatedTodayStats.seated, waitingCount],
  );

  const callNext = () => {
    const nextEntry = entries.find((entry) => entry.status === 'waiting');
    if (!nextEntry) {
      toast.info('Fila vazia.');
      return;
    }

    updateStatus.mutate({ id: nextEntry.id, status: 'called' });

    supabase.functions.invoke('reservation-events', {
      body: { event: 'waitlist_called', waitlist: { id: nextEntry.id } },
    }).catch((error) => console.warn('Waitlist call notification error:', error));
  };

  const copyTrackingLink = async (code: string) => {
    const url = `${window.location.origin}/${slug}/fila/${code}`;
    await navigator.clipboard.writeText(url);
    toast.success('Link copiado.');
  };

  const openDetailsDialog = (entry: WaitlistEntry) => {
    setSelectedEntry(entry);
    setDetailsForm(createWaitlistDetailsForm(entry));
  };

  const closeDetailsDialog = () => {
    setSelectedEntry(null);
    setDetailsForm(createWaitlistDetailsForm(null));
  };

  const handleSaveDetails = () => {
    if (!selectedEntry) return;

    updateEntryDetails.mutate({
      id: selectedEntry.id,
      payload: detailsForm,
    });
  };

  const stopRowAction = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleWaitlistRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, entry: WaitlistEntry) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetailsDialog(entry);
    }
  };

  const handleSeatedCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setShowSeatedToday(true);
    }
  };

  const openSeatDialog = (entry: WaitlistEntry) => {
    setSeatEntry(entry);
    setSeatedPartySize(String(entry.seated_party_size ?? entry.party_size));
    setSeatGuestEmail(entry.guest_email ?? '');
    setSeatGuestBirthdate(entry.guest_birthdate ?? '');
    setSeatCompanionForms([]);
  };

  const closeSeatDialog = () => {
    setSeatEntry(null);
    setSeatGuestEmail('');
    setSeatGuestBirthdate('');
    setSeatedPartySize('2');
    setSeatCompanionForms([]);
  };

  const updateSeatCompanionForm = (
    key: string,
    field: keyof Omit<WaitlistCompanionForm, 'key'>,
    value: string,
  ) => {
    setSeatCompanionForms((current) =>
      current.map((companion) =>
        companion.key === key
          ? { ...companion, [field]: value }
          : companion,
      ),
    );
  };

  const removeSeatCompanionForm = (key: string) => {
    setSeatCompanionForms((current) => current.filter((companion) => companion.key !== key));
  };

  const handleSeatEntry = () => {
    if (!seatEntry) return;

    const parsedPartySize = Number.parseInt(seatedPartySize, 10);
    if (Number.isNaN(parsedPartySize) || parsedPartySize < 1 || parsedPartySize > 50) {
      toast.error('Informe uma quantidade presente válida.');
      return;
    }

    const companions = seatCompanionForms
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

    if (companions.length > Math.max(parsedPartySize - 1, 0)) {
      toast.error('A quantidade de acompanhantes excede o total presente informado.');
      return;
    }

    seatEntryMutation.mutate({
      id: seatEntry.id,
      actualPartySize: parsedPartySize,
      guestEmail: seatGuestEmail.trim(),
      guestBirthdate: seatGuestBirthdate.trim(),
      companions,
    });
  };

  const selectedEntryStatus = selectedEntry ? (statusConfig[selectedEntry.status] || statusConfig.waiting) : null;
  const selectedEntryCalledRemainingMs = selectedEntry?.status === 'called'
    ? getWaitlistCallRemainingMs(selectedEntry.called_at, nowMs)
    : null;
  const selectedEntryCalledExpired = selectedEntry?.status === 'called'
    ? hasWaitlistCallExpired(selectedEntry.called_at, nowMs)
    : false;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Lista de Espera</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie a fila de {companyName}
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="outline"
            className="gap-2 rounded-lg px-4"
            onClick={callNext}
            disabled={waitingCount === 0}
          >
            <Bell className="h-4 w-4" />
            Chamar próximo
          </Button>
          <Button className="gap-2 rounded-lg px-4" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" />
            Adicionar
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          const value = stats[card.key];
          const isSeatedCard = card.key === 'seated';

          return (
            <Card
              key={card.key}
              role={isSeatedCard ? 'button' : undefined}
              tabIndex={isSeatedCard ? 0 : undefined}
              aria-label={isSeatedCard ? 'Abrir lista de clientes sentados hoje' : undefined}
              className={cn(
                'rounded-2xl border border-border bg-card shadow-sm',
                isSeatedCard && 'cursor-pointer transition-colors hover:bg-muted/20 focus:outline-none focus-visible:bg-muted/20',
              )}
              onClick={isSeatedCard ? () => setShowSeatedToday(true) : undefined}
              onKeyDown={isSeatedCard ? handleSeatedCardKeyDown : undefined}
            >
              <CardContent className="flex items-center gap-4 p-5">
                <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', card.iconClassName)}>
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xl font-semibold leading-none text-foreground">{value}</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">{card.label}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">Fila atual</h3>
          </div>
          <span className="text-sm text-muted-foreground">Atualizado agora</span>
        </div>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-5">
              {[1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-20 w-full rounded-2xl" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center px-6 py-14 text-center">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Users className="h-7 w-7 opacity-60" />
              </div>
              <p className="text-xl font-medium text-foreground">Nenhum cliente na fila</p>
              <p className="mt-3 max-w-md text-sm text-muted-foreground">
                Clique em &quot;Adicionar&quot; para incluir alguém na fila de espera.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {entries.map((entry, index) => {
                const status = statusConfig[entry.status] || statusConfig.waiting;
                const queueNumber = entry.status === 'waiting' ? index + 1 : null;
                const calledRemainingMs = entry.status === 'called'
                  ? getWaitlistCallRemainingMs(entry.called_at, nowMs)
                  : null;
                const calledExpired = entry.status === 'called'
                  ? hasWaitlistCallExpired(entry.called_at, nowMs)
                  : false;

                return (
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Abrir resumo da fila de ${entry.guest_name}`}
                    className="flex cursor-pointer flex-col gap-4 px-5 py-4 transition-colors hover:bg-muted/20 focus:outline-none focus-visible:bg-muted/20 xl:flex-row xl:items-center"
                    onClick={() => openDetailsDialog(entry)}
                    onKeyDown={(event) => handleWaitlistRowKeyDown(event, entry)}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-foreground">
                        {queueNumber ?? '-'}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-base font-semibold text-foreground">
                            {entry.guest_name}
                          </p>
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium',
                              status.className,
                            )}
                          >
                            {status.label}
                          </span>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            <Phone className="h-3.5 w-3.5" />
                            {entry.guest_phone}
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <Users className="h-3.5 w-3.5" />
                            {entry.party_size} pessoas
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <Clock3 className="h-3.5 w-3.5" />
                            Na fila há {formatDistanceToNow(new Date(entry.created_at), { locale: ptBR })}
                          </span>
                        </div>

                        {entry.status === 'called' && (
                          <div
                            className={cn(
                              'mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium tabular-nums',
                              calledExpired
                                ? 'border-destructive/30 bg-destructive-soft text-destructive'
                                : 'border-info/30 bg-info-soft text-info',
                            )}
                          >
                            <Clock3 className="h-3.5 w-3.5" />
                            {calledExpired
                              ? `Tempo esgotado · ${formatWaitlistCountdown(calledRemainingMs)}`
                              : `Tempo restante ${formatWaitlistCountdown(calledRemainingMs)} de ${WAITLIST_CALL_TIMEOUT_MINUTES}:00`}
                          </div>
                        )}

                        {entry.notes && (
                          <p className="mt-2 text-sm text-muted-foreground">{entry.notes}</p>
                        )}

                        <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground/80">
                          <PencilLine className="h-3.5 w-3.5" />
                          Clique para conferir e editar os dados
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2 rounded-lg"
                        onClick={(event) => {
                          stopRowAction(event);
                          copyTrackingLink(entry.tracking_code);
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Copiar link
                      </Button>

                      {entry.status === 'waiting' && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-2 rounded-lg"
                            onClick={(event) => {
                              stopRowAction(event);
                              updateStatus.mutate({ id: entry.id, status: 'called' });
                            }}
                          >
                            <Bell className="h-3.5 w-3.5" />
                            Chamar
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-2 rounded-lg text-destructive hover:text-destructive"
                            onClick={(event) => {
                              stopRowAction(event);
                              setRemoveEntry(entry);
                            }}
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                            Remover
                          </Button>
                        </>
                      )}

                      {entry.status === 'called' && (
                        <>
                          <Button
                            size="sm"
                            className="gap-2 rounded-lg"
                            onClick={(event) => {
                              stopRowAction(event);
                              openSeatDialog(entry);
                            }}
                          >
                            <UserCheck className="h-3.5 w-3.5" />
                            Sentar
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className={cn(
                              'gap-2 rounded-lg',
                              calledExpired && 'border-destructive/30 text-destructive hover:text-destructive',
                            )}
                            onClick={(event) => {
                              stopRowAction(event);
                              updateStatus.mutate({ id: entry.id, status: 'expired' });
                            }}
                          >
                            <Clock3 className="h-3.5 w-3.5" />
                            {calledExpired ? 'Expirar agora' : 'Expirar'}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showSeatedToday} onOpenChange={setShowSeatedToday}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sentados hoje</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Clientes sentados</p>
                <p className="mt-2 text-xl font-semibold text-foreground">{seatedTodayStats.seated}</p>
              </div>
              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Espera media</p>
                <p className="mt-2 text-xl font-semibold text-foreground">{seatedTodayStats.avgWaitMin}min</p>
              </div>
            </div>

            {seatedTodayEntries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-muted/10 px-5 py-10 text-center">
                <p className="text-sm font-medium text-foreground">Ninguem foi sentado hoje ainda.</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Assim que uma entrada da fila for concluida, ela aparece aqui.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {seatedTodayEntries.map((entry) => {
                  const seatedAt = entry.seated_at ? new Date(entry.seated_at) : new Date(entry.created_at);
                  const waitMinutes = Math.max(
                    Math.round((seatedAt.getTime() - new Date(entry.created_at).getTime()) / 60000),
                    0,
                  );

                  return (
                    <div key={entry.id} className="rounded-2xl border border-border bg-card p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-base font-semibold text-foreground">{entry.guest_name}</p>
                            <span className="inline-flex items-center rounded-full border border-success/20 bg-success-soft px-3 py-1 text-xs font-medium text-success">
                              Sentado
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                            <span className="inline-flex items-center gap-1.5">
                              <Phone className="h-3.5 w-3.5" />
                              {entry.guest_phone}
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <Users className="h-3.5 w-3.5" />
                              {entry.seated_party_size ?? entry.party_size} pessoas
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <Clock3 className="h-3.5 w-3.5" />
                              Esperou {waitMinutes}min
                            </span>
                          </div>
                          {entry.notes && (
                            <p className="text-sm text-muted-foreground">{entry.notes}</p>
                          )}
                        </div>

                        <div className="space-y-2 text-sm text-muted-foreground sm:text-right">
                          <p className="font-medium text-foreground">{format(seatedAt, 'HH:mm')}</p>
                          <p>{format(seatedAt, 'dd/MM/yyyy')}</p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-2 rounded-lg"
                            onClick={() => copyTrackingLink(entry.tracking_code)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Copiar link
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar a fila</DialogTitle>
          </DialogHeader>
          <form onSubmit={(event) => {
            event.preventDefault();
            addMutation.mutate();
          }} className="mt-4 space-y-4">
            <div>
              <Label htmlFor="waitlist-add-name">Nome *</Label>
              <Input
                id="waitlist-add-name"
                name="guest_name"
                value={addForm.guest_name}
                onChange={(event) => setAddForm({ ...addForm, guest_name: event.target.value })}
                placeholder="Nome do cliente"
                autoComplete="name"
                maxLength={MAX_WAITLIST_NAME_LENGTH}
                required
              />
            </div>
            <div>
              <Label htmlFor="waitlist-add-phone">WhatsApp *</Label>
              <Input
                id="waitlist-add-phone"
                name="guest_phone"
                type="tel"
                value={addForm.guest_phone}
                onChange={(event) => setAddForm({ ...addForm, guest_phone: event.target.value })}
                placeholder="(11) 99999-9999"
                autoComplete="tel"
                inputMode="tel"
                maxLength={20}
                required
              />
            </div>
            <div>
              <Label htmlFor="waitlist-add-email">Email</Label>
              <Input
                id="waitlist-add-email"
                name="guest_email"
                type="email"
                value={addForm.guest_email}
                onChange={(event) => setAddForm({ ...addForm, guest_email: event.target.value })}
                placeholder="cliente@email.com"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
              />
            </div>
            <div>
              <Label htmlFor="waitlist-add-birthdate">Data de nascimento</Label>
              <Input
                id="waitlist-add-birthdate"
                name="guest_birthdate"
                type="date"
                value={addForm.guest_birthdate}
                onChange={(event) => setAddForm({ ...addForm, guest_birthdate: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="waitlist-add-party-size">Pessoas</Label>
              <div className="mt-1 flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  aria-label="Diminuir quantidade de pessoas"
                  onClick={() => setAddForm((current) => ({ ...current, party_size: Math.max(1, current.party_size - 1) }))}
                >
                  -
                </Button>
                <span id="waitlist-add-party-size" aria-live="polite" className="w-8 text-center font-semibold">{addForm.party_size}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  aria-label="Aumentar quantidade de pessoas"
                  onClick={() => setAddForm((current) => ({ ...current, party_size: Math.min(20, current.party_size + 1) }))}
                >
                  +
                </Button>
              </div>
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea id="waitlist-add-notes" name="notes"
                value={addForm.notes}
                onChange={(event) => setAddForm({ ...addForm, notes: event.target.value })}
                placeholder="Ex: cadeira de bebê, aniversário..."
                rows={3}
                maxLength={MAX_WAITLIST_NOTES_LENGTH}
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? 'Adicionando...' : 'Adicionar'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedEntry} onOpenChange={(open) => !open && closeDetailsDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Resumo da fila</DialogTitle>
          </DialogHeader>

          {selectedEntry && selectedEntryStatus && (
            <div className="space-y-5 pt-2">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border bg-muted/20 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Status</p>
                  <div className="mt-2">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium',
                        selectedEntryStatus.className,
                      )}
                    >
                      {selectedEntryStatus.label}
                    </span>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-muted/20 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Pessoas</p>
                  <p className="mt-2 text-lg font-semibold text-foreground">{selectedEntry.party_size}</p>
                </div>

                <div className="rounded-xl border border-border bg-muted/20 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Entrada</p>
                  <p className="mt-2 text-sm font-medium text-foreground">
                    {format(new Date(selectedEntry.created_at), 'dd/MM/yyyy HH:mm')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Há {formatDistanceToNow(new Date(selectedEntry.created_at), { locale: ptBR })}
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-muted/20 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Acompanhamento</p>
                  <button
                    type="button"
                    className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
                    onClick={() => copyTrackingLink(selectedEntry.tracking_code)}
                  >
                    <Link2 className="h-4 w-4" />
                    Copiar link
                  </button>
                </div>
              </div>

              {selectedEntry.status === 'called' && (
                <div
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium tabular-nums',
                    selectedEntryCalledExpired
                      ? 'border-destructive/30 bg-destructive-soft text-destructive'
                      : 'border-info/30 bg-info-soft text-info',
                  )}
                >
                  <Clock3 className="h-3.5 w-3.5" />
                  {selectedEntryCalledExpired
                    ? `Tempo esgotado · ${formatWaitlistCountdown(selectedEntryCalledRemainingMs)}`
                    : `Tempo restante ${formatWaitlistCountdown(selectedEntryCalledRemainingMs)} de ${WAITLIST_CALL_TIMEOUT_MINUTES}:00`}
                </div>
              )}

              <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Conferir ou editar dados</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Atualize os dados antes de chamar, sentar ou remover o cliente.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2 self-start rounded-lg"
                    onClick={() => copyTrackingLink(selectedEntry.tracking_code)}
                  >
                    <Copy className="h-4 w-4" />
                    Copiar link
                  </Button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="waitlist-details-name">Nome</Label>
                    <Input
                      id="waitlist-details-name"
                      name="guest_name"
                      value={detailsForm.guest_name}
                      onChange={(event) => setDetailsForm((current) => ({ ...current, guest_name: event.target.value }))}
                      placeholder="Nome do cliente"
                      autoComplete="name"
                      maxLength={MAX_WAITLIST_NAME_LENGTH}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="waitlist-details-phone">WhatsApp</Label>
                    <Input
                      id="waitlist-details-phone"
                      name="guest_phone"
                      type="tel"
                      value={detailsForm.guest_phone}
                      onChange={(event) => setDetailsForm((current) => ({ ...current, guest_phone: event.target.value }))}
                      placeholder="(11) 99999-9999"
                      autoComplete="tel"
                      inputMode="tel"
                      maxLength={20}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="waitlist-details-party-size">Pessoas</Label>
                    <Input
                      id="waitlist-details-party-size"
                      name="party_size"
                      type="number"
                      min="1"
                      max="50"
                      value={detailsForm.party_size}
                      onChange={(event) => setDetailsForm((current) => ({ ...current, party_size: event.target.value }))}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="waitlist-details-email">Email</Label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="waitlist-details-email"
                        name="guest_email"
                        type="email"
                        value={detailsForm.guest_email}
                        onChange={(event) => setDetailsForm((current) => ({ ...current, guest_email: event.target.value }))}
                        placeholder="cliente@email.com"
                        className="pl-9"
                        autoComplete="email"
                        inputMode="email"
                        spellCheck={false}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="waitlist-details-birthdate">Nascimento</Label>
                    <div className="relative">
                      <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="waitlist-details-birthdate"
                        name="guest_birthdate"
                        type="date"
                        value={detailsForm.guest_birthdate}
                        onChange={(event) => setDetailsForm((current) => ({ ...current, guest_birthdate: event.target.value }))}
                        className="pl-9"
                        autoComplete="bday"
                      />
                    </div>
                  </div>

                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="waitlist-details-notes">Observações</Label>
                    <Textarea
                      id="waitlist-details-notes"
                      name="notes"
                      value={detailsForm.notes}
                      onChange={(event) => setDetailsForm((current) => ({ ...current, notes: event.target.value }))}
                      placeholder="Informações importantes, preferências ou contexto do atendimento"
                      rows={4}
                      maxLength={MAX_WAITLIST_NOTES_LENGTH}
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-dashed border-border bg-muted/15 p-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Código de acompanhamento</p>
                  <p className="mt-1 break-all font-mono text-xs">{selectedEntry.tracking_code}</p>
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={closeDetailsDialog}>
                  Fechar
                </Button>
                <Button type="button" className="gap-2" onClick={handleSaveDetails} disabled={updateEntryDetails.isPending}>
                  <Save className="h-4 w-4" />
                  {updateEntryDetails.isPending ? 'Salvando...' : 'Salvar alterações'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!seatEntry} onOpenChange={(open) => !open && closeSeatDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sentar cliente da fila</DialogTitle>
          </DialogHeader>

          {seatEntry && (
            <div className="space-y-4 pt-2">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{seatEntry.guest_name}</p>
                <p className="text-sm text-muted-foreground">{seatEntry.guest_phone}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="waitlist-seat-email">Email do titular</Label>
                  <Input
                    id="waitlist-seat-email"
                    name="guest_email"
                    type="email"
                    value={seatGuestEmail}
                    onChange={(event) => setSeatGuestEmail(event.target.value)}
                    placeholder="cliente@email.com"
                    autoComplete="email"
                    inputMode="email"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="waitlist-seat-birthdate">Nascimento do titular</Label>
                  <Input
                    id="waitlist-seat-birthdate"
                    name="guest_birthdate"
                    type="date"
                    value={seatGuestBirthdate}
                    onChange={(event) => setSeatGuestBirthdate(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-4 rounded-2xl border border-border bg-muted/20 p-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Entrada</p>
                  <p className="text-xs text-muted-foreground">
                    O titular conta como 1 pessoa. Cadastre aqui quem realmente entrou para gerar os leads da fila.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-[180px_1fr] sm:items-end">
                  <div className="space-y-2">
                    <Label
                      htmlFor="waitlist-seat-party-size"
                      className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
                    >
                      Total presente
                    </Label>
                    <Input
                      id="waitlist-seat-party-size"
                      name="seated_party_size"
                      type="number"
                      min="1"
                      max="50"
                      value={seatedPartySize}
                      onChange={(event) => setSeatedPartySize(event.target.value)}
                    />
                  </div>

                  <div className="rounded-xl border border-dashed border-border bg-background/70 p-3 text-xs text-muted-foreground">
                    Entrada original na fila para <span className="font-medium text-foreground">{seatEntry.party_size}</span> pessoas.
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Acompanhantes</p>
                    <p className="text-xs text-muted-foreground">
                      Nome e WhatsApp são os dados mais importantes. Email e aniversário podem ser opcionais.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => setSeatCompanionForms((current) => [...current, createCompanionForm()])}
                  >
                    <Plus className="h-4 w-4" />
                    Adicionar
                  </Button>
                </div>

                {seatCompanionForms.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-background/70 p-4 text-sm text-muted-foreground">
                    Nenhum acompanhante cadastrado ainda.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {seatCompanionForms.map((companion, index) => (
                      <div key={companion.key} className="space-y-3 rounded-2xl border border-border bg-background p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-foreground">Acompanhante {index + 1}</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-lg text-muted-foreground"
                            aria-label={`Remover acompanhante ${index + 1}`}
                            onClick={() => removeSeatCompanionForm(companion.key)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <Input
                            id={`waitlist-seat-companion-name-${companion.key}`}
                            name={`companions[${index}].name`}
                            value={companion.name}
                            onChange={(event) => updateSeatCompanionForm(companion.key, 'name', event.target.value)}
                            placeholder="Nome do acompanhante"
                            autoComplete="name"
                          />
                          <Input
                            id={`waitlist-seat-companion-phone-${companion.key}`}
                            name={`companions[${index}].phone`}
                            type="tel"
                            value={companion.phone}
                            onChange={(event) => updateSeatCompanionForm(companion.key, 'phone', event.target.value)}
                            placeholder="WhatsApp"
                            autoComplete="tel"
                            inputMode="tel"
                          />
                          <Input
                            id={`waitlist-seat-companion-email-${companion.key}`}
                            name={`companions[${index}].email`}
                            type="email"
                            value={companion.email}
                            onChange={(event) => updateSeatCompanionForm(companion.key, 'email', event.target.value)}
                            placeholder="Email"
                            autoComplete="email"
                            inputMode="email"
                            spellCheck={false}
                          />
                          <Input
                            id={`waitlist-seat-companion-birthdate-${companion.key}`}
                            name={`companions[${index}].birthdate`}
                            type="date"
                            value={companion.birthdate}
                            onChange={(event) => updateSeatCompanionForm(companion.key, 'birthdate', event.target.value)}
                            autoComplete="bday"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={closeSeatDialog}>
                  Cancelar
                </Button>
                <Button onClick={handleSeatEntry} disabled={seatEntryMutation.isPending}>
                  {seatEntryMutation.isPending ? 'Salvando...' : 'Confirmar entrada'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!removeEntry} onOpenChange={(open) => !open && setRemoveEntry(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover da fila?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeEntry?.guest_name} será removido(a) da lista de espera.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (removeEntry) {
                  updateStatus.mutate({ id: removeEntry.id, status: 'removed' });
                }
                setRemoveEntry(null);
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
