import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, addDays, isToday, isTomorrow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarIcon, ArrowLeft, ArrowRight, Clock, Users, Loader2, Check, Copy, CalendarPlus } from 'lucide-react';
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

interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

interface ReservationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyName: string;
  openingHours: OpeningHour[];
  reservationDuration?: number;
  maxGuestsPerSlot?: number;
  onStepChange?: (step: 'date_select' | 'time_select' | 'form_fill' | 'completed') => void;
}

const OCCASIONS = ['Aniversário', 'Jantar Romântico', 'Reunião de Negócios', 'Confraternização', 'Comemoração', 'Outro'];

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

function getVisitorId(): string {
  const key = 'rv_visitor_id';
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

interface AvailableTable {
  id: string;
  number: number;
  capacity: number;
  section: string;
}

interface SlotAvailability {
  total: number;
  occupied: number;
  available: number;
}

interface ConfirmedReservation {
  id: string;
  date: string;
  time: string;
  partySize: number;
  tableName: string;
  guestName: string;
  companyName: string;
}

export default function ReservationModal({
  open, onOpenChange, companyId, companyName, openingHours, reservationDuration = 30, maxGuestsPerSlot = 0, onStepChange
}: ReservationModalProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>();
  const [selectedTime, setSelectedTime] = useState('');
  const [selectedPartySize, setSelectedPartySize] = useState(2);
  const [selectedTableId, setSelectedTableId] = useState('');
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

  // Fetch blocked dates for this company
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

  // Fetch slot availability when date changes (for step 2 vacancy indicators)
  useEffect(() => {
    if (!selectedDate || !companyId) return;
    
    const fetchSlotAvailability = async () => {
      setLoadingSlots(true);
      try {
        const dateStr = format(selectedDate, 'yyyy-MM-dd');
        
      const [{ data: allTables }, { data: slotOccupancy }] = await Promise.all([
          supabase.from('restaurant_tables' as any).select('id, capacity').eq('company_id', companyId).eq('status', 'available'),
          supabase.rpc('get_slot_occupancy', { _company_id: companyId, _date: dateStr }),
        ]);

        const totalTables = (allTables as any[] || []).filter((t: any) => t.capacity >= selectedPartySize).length;
        
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
  }, [selectedDate, companyId, selectedPartySize, timeSlots, blockedDates, maxGuestsPerSlot]);

  // Auto-assign best-fit table when time is selected
  useEffect(() => {
    if (!selectedDate || !selectedTime || step !== 2) return;
    
    const fetchAndAssignTable = async () => {
      setLoadingTables(true);
      try {
        const dateStr = format(selectedDate, 'yyyy-MM-dd');
        
        const { data: allTables, error: tablesErr } = await supabase
          .from('restaurant_tables' as any)
          .select('id, number, capacity, section')
          .eq('company_id', companyId)
          .eq('status', 'available')
          .order('capacity', { ascending: true });
        if (tablesErr) throw tablesErr;

        const { data: occupiedTableIds, error: resErr } = await supabase
          .rpc('get_occupied_table_ids', {
            _company_id: companyId,
            _date: dateStr,
            _time: selectedTime + ':00',
          });
        if (resErr) throw resErr;

        const occupiedIds = new Set((occupiedTableIds as string[]) || []);
        const available = (allTables as any[])
          .filter((t: any) => !occupiedIds.has(t.id) && t.capacity >= selectedPartySize) as AvailableTable[];
        
        setAvailableTables(available);
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
      } finally {
        setLoadingTables(false);
      }
    };

    fetchAndAssignTable();
  }, [selectedDate, selectedTime, companyId, selectedPartySize, step]);

  const handleReset = () => {
    setStep(1);
    setSelectedDate(undefined);
    setSelectedTime('');
    setSelectedPartySize(2);
    setSelectedTableId('');
    setShowCalendar(false);
    setConfirmedReservation(null);
    setForm({ name: '', email: '', birthdate: '', whatsapp: '', occasion: '', observation: '' });
  };

  const handleClose = (v: boolean) => {
    if (!v) handleReset();
    onOpenChange(v);
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
      const reservationData = {
        company_id: companyId,
        table_id: selectedTableId || null,
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
        visitor_id: getVisitorId(),
        status: 'confirmed',
      };

      const { data: inserted, error } = await supabase
        .from('reservations' as any)
        .insert(reservationData as any)
        .select('*')
        .single();
      
      if (error) throw error;

      // Fire reservation events
      supabase.functions.invoke('reservation-events', {
        body: { event: 'reservation_created', reservation: inserted },
      }).catch(err => console.warn('Reservation events error:', err));

      const tableName = availableTables.find(t => t.id === selectedTableId)?.number?.toString() || '';

      setConfirmedReservation({
        id: (inserted as any).id,
        date: dateStr,
        time: selectedTime,
        partySize: selectedPartySize,
        tableName: tableName ? `Mesa ${tableName}` : '',
        guestName: form.name,
        companyName,
      });

      onStepChange?.('completed');
      setStep(4);
    } catch (err: any) {
      toast.error(`Erro ao criar reserva: ${err.message}`);
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

  const addToCalendarUrl = () => {
    if (!confirmedReservation || !selectedDate) return '#';
    const [h, m] = confirmedReservation.time.split(':').map(Number);
    const startDate = new Date(selectedDate);
    startDate.setHours(h, m, 0);
    const endDate = new Date(startDate.getTime() + reservationDuration * 60000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`Reserva - ${companyName}`)}&dates=${fmt(startDate)}/${fmt(endDate)}&details=${encodeURIComponent(`Reserva para ${confirmedReservation.partySize} pessoas${confirmedReservation.tableName ? ` · ${confirmedReservation.tableName}` : ''}`)}`;
  };

  const getSlotStatus = (slot: string): 'available' | 'low' | 'full' => {
    const avail = slotAvailability[slot];
    if (!avail || avail.total === 0) return 'available';
    if (avail.available === 0) return 'full';
    if (avail.available <= 2) return 'low';
    return 'available';
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-center text-lg font-bold text-foreground">
            {step === 4 ? 'Reserva Confirmada!' : `Reservar Mesa — ${companyName}`}
          </DialogTitle>
          {step !== 4 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              {[1, 2, 3].map(s => (
                <div
                  key={s}
                  className={cn(
                    'h-2 rounded-full transition-all',
                    s === step ? 'w-8 bg-primary' : s < step ? 'w-6 bg-primary/50' : 'w-6 bg-muted'
                  )}
                />
              ))}
            </div>
          )}
        </DialogHeader>

        {/* Step 1: Date + Party Size */}
        {step === 1 && (
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground text-center">Escolha a data e número de pessoas</p>

            <div className="flex items-center justify-center gap-3">
              <Label className="text-sm">Pessoas:</Label>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" className="h-8 w-8" type="button"
                  onClick={() => setSelectedPartySize(Math.max(1, selectedPartySize - 1))}>-</Button>
                <span className="w-8 text-center font-semibold">{selectedPartySize}</span>
                <Button variant="outline" size="icon" className="h-8 w-8" type="button"
                  onClick={() => setSelectedPartySize(Math.min(20, selectedPartySize + 1))}>+</Button>
              </div>
            </div>

            {!showCalendar ? (
              <>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {next7Days.map(date => {
                    const closed = isDayClosed(date);
                    const isSelected = selectedDate?.toDateString() === date.toDateString();
                    return (
                      <button key={date.toISOString()} disabled={closed} onClick={() => setSelectedDate(date)}
                        className={cn(
                          'flex flex-col items-center p-3 rounded-xl border text-sm transition-all',
                          closed && 'opacity-40 cursor-not-allowed',
                          isSelected ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border hover:border-primary/50 text-foreground'
                        )}>
                        <span className="text-xs uppercase text-muted-foreground">{format(date, 'EEE', { locale: ptBR })}</span>
                        <span className="text-lg font-bold">{format(date, 'dd')}</span>
                        <span className="text-xs text-muted-foreground">{format(date, 'MMM', { locale: ptBR })}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Show selected calendar date if outside next 7 days */}
                {selectedDate && !isDateInQuickSelect && (
                  <div className="flex items-center justify-center gap-2 p-3 rounded-xl border border-primary bg-primary/10">
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
          <div className="space-y-4 pt-2">
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
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {timeSlots.map(time => {
                  const status = getSlotStatus(time);
                  const avail = slotAvailability[time];
                  const isFull = status === 'full';
                  return (
                    <button key={time} onClick={() => { if (!isFull) { setSelectedTime(time); setSelectedTableId(''); } }}
                      disabled={isFull}
                      className={cn(
                        'flex flex-col items-center justify-center gap-0.5 py-2.5 rounded-xl border text-sm transition-all',
                        isFull && 'opacity-40 cursor-not-allowed bg-muted',
                        selectedTime === time ? 'border-primary bg-primary/10 text-primary font-semibold' : !isFull ? 'border-border hover:border-primary/50 text-foreground' : 'border-border'
                      )}>
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" />{time}
                      </span>
                      {avail && (
                        <span className={cn(
                          'text-[10px] font-medium',
                          isFull ? 'text-destructive' : status === 'low' ? 'text-amber-600' : 'text-muted-foreground'
                        )}>
                          {isFull ? 'Lotado' : `${avail.available} ${avail.available === 1 ? 'vaga' : 'vagas'}`}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* No table availability message */}
            {selectedTime && !loadingTables && availableTables.length === 0 && (
              <p className="text-center text-sm text-destructive py-2">Nenhuma mesa disponível para este horário e número de pessoas.</p>
            )}
            {selectedTime && loadingTables && (
              <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
            )}

            <div className="space-y-1">
              <Button className="w-full" disabled={!selectedTime || !selectedTableId || loadingTables}
                onClick={() => { setStep(3); onStepChange?.('time_select'); onStepChange?.('form_fill'); }}>
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
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setStep(2)}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
            <p className="text-sm text-muted-foreground text-center">
              {selectedDate && format(selectedDate, "dd/MM/yyyy", { locale: ptBR })} às {selectedTime} · Mesa {availableTables.find(t => t.id === selectedTableId)?.number} · {selectedPartySize} pessoas
            </p>

            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">WhatsApp *</Label>
                <div className="flex gap-2">
                  <Input value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))}
                    placeholder="(11) 99999-9999" required maxLength={20}
                    onBlur={async () => {
                      if (form.whatsapp.replace(/\D/g, '').length >= 10) {
                        try {
                          const { data } = await supabase
                            .from('reservations' as any)
                            .select('guest_name, guest_email, guest_birthdate')
                            .eq('company_id', companyId)
                            .eq('guest_phone', form.whatsapp)
                            .order('created_at', { ascending: false })
                            .limit(1)
                            .maybeSingle();
                          if (data) {
                            const d = data as any;
                            setForm(f => ({
                              ...f,
                              name: f.name || d.guest_name || '',
                              email: f.email || d.guest_email || '',
                              birthdate: f.birthdate || d.guest_birthdate || '',
                            }));
                            toast.success('Dados preenchidos automaticamente! 🎉');
                          }
                        } catch { /* silent */ }
                      }
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">Digite seu WhatsApp para preencher automaticamente</p>
              </div>
              <div>
                <Label className="text-sm font-medium">Nome Completo *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Seu nome" required maxLength={100} />
              </div>
              <div>
                <Label className="text-sm font-medium">E-mail</Label>
                <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="seu@email.com" maxLength={255} />
              </div>
              <div>
                <Label className="text-sm font-medium">Data de Nascimento</Label>
                <div className="grid grid-cols-3 gap-2">
                  <Select
                    value={form.birthdate ? form.birthdate.split('-')[2] : ''}
                    onValueChange={d => {
                      const [y, m] = (form.birthdate || '--').split('-');
                      setForm(f => ({ ...f, birthdate: `${y || '2000'}-${m || '01'}-${d}` }));
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="Dia" /></SelectTrigger>
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
                    <SelectTrigger><SelectValue placeholder="Ano" /></SelectTrigger>
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
                  <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                  <SelectContent>
                    {OCCASIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm font-medium">Observação</Label>
                <Textarea value={form.observation} onChange={e => setForm(f => ({ ...f, observation: e.target.value }))}
                  placeholder="Alguma observação especial?" maxLength={500} rows={3} />
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Ao continuar você concorda com nossa{' '}
              <span className="underline text-primary cursor-pointer">Termos e Condições</span>
            </p>

            <Button type="submit" className="w-full py-5 text-base rounded-xl" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirmar Reserva
            </Button>
          </form>
        )}

        {/* Step 4: Success */}
        {step === 4 && confirmedReservation && (
          <div className="space-y-6 pt-4 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Check className="h-8 w-8 text-primary" />
            </div>

            <div className="space-y-1">
              <p className="text-foreground font-medium">
                Olá {confirmedReservation.guestName}, sua reserva foi confirmada!
              </p>
              <p className="text-sm text-muted-foreground">
                Estamos ansiosos para recebê-lo(a).
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
                {confirmedReservation.tableName && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Mesa</span>
                    <span className="font-medium text-foreground">{confirmedReservation.tableName}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="space-y-2">
              <a href={addToCalendarUrl()} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="w-full gap-2">
                  <CalendarPlus className="h-4 w-4" />
                  Adicionar ao Google Calendar
                </Button>
              </a>
              <Button className="w-full" onClick={() => handleClose(false)}>
                Fechar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
