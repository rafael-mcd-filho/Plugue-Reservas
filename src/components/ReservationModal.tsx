import { useState, useMemo } from 'react';
import { format, addDays, parse } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarIcon, ArrowLeft, ArrowRight, Clock, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from 'sonner';

interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

interface ReservationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  openingHours: OpeningHour[];
}

const OCCASIONS = [
  'Aniversário',
  'Jantar Romântico',
  'Reunião de Negócios',
  'Confraternização',
  'Comemoração',
  'Outro',
];

const DAY_MAP: Record<string, number> = {
  'Domingo': 0,
  'Segunda': 1,
  'Terça': 2,
  'Quarta': 3,
  'Quinta': 4,
  'Sexta': 5,
  'Sábado': 6,
};

function generateTimeSlots(open: string, close: string): string[] {
  const slots: string[] = [];
  const [openH, openM] = open.split(':').map(Number);
  const [closeH, closeM] = close.split(':').map(Number);
  let current = openH * 60 + openM;
  const end = closeH * 60 + closeM;
  while (current < end) {
    const h = Math.floor(current / 60);
    const m = current % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    current += 30;
  }
  return slots;
}

export default function ReservationModal({ open, onOpenChange, companyName, openingHours }: ReservationModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>();
  const [selectedTime, setSelectedTime] = useState('');
  const [showCalendar, setShowCalendar] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    birthdate: '',
    whatsapp: '',
    occasion: '',
    observation: '',
  });

  const next7Days = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) days.push(addDays(new Date(), i));
    return days;
  }, []);

  const selectedDayHours = useMemo(() => {
    if (!selectedDate) return null;
    const dayIndex = selectedDate.getDay();
    const dayName = Object.entries(DAY_MAP).find(([, v]) => v === dayIndex)?.[0];
    return openingHours.find(h => h.day === dayName) || null;
  }, [selectedDate, openingHours]);

  const timeSlots = useMemo(() => {
    if (!selectedDayHours || selectedDayHours.closed) return [];
    return generateTimeSlots(selectedDayHours.open, selectedDayHours.close);
  }, [selectedDayHours]);

  const handleReset = () => {
    setStep(1);
    setSelectedDate(undefined);
    setSelectedTime('');
    setShowCalendar(false);
    setForm({ name: '', email: '', birthdate: '', whatsapp: '', occasion: '', observation: '' });
  };

  const handleClose = (v: boolean) => {
    if (!v) handleReset();
    onOpenChange(v);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.whatsapp) {
      toast.error('Preencha nome e WhatsApp');
      return;
    }
    toast.success('Reserva solicitada com sucesso! Entraremos em contato para confirmar.');
    handleClose(false);
  };

  const isDayClosed = (date: Date) => {
    const dayIndex = date.getDay();
    const dayName = Object.entries(DAY_MAP).find(([, v]) => v === dayIndex)?.[0];
    const hours = openingHours.find(h => h.day === dayName);
    return hours?.closed ?? true;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-center text-lg font-bold text-foreground">
            Reservar Mesa — {companyName}
          </DialogTitle>
          {/* Step indicator */}
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
        </DialogHeader>

        {/* Step 1: Date */}
        {step === 1 && (
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground text-center">Escolha a data da reserva</p>

            {!showCalendar ? (
              <>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {next7Days.map(date => {
                    const closed = isDayClosed(date);
                    const isSelected = selectedDate?.toDateString() === date.toDateString();
                    return (
                      <button
                        key={date.toISOString()}
                        disabled={closed}
                        onClick={() => setSelectedDate(date)}
                        className={cn(
                          'flex flex-col items-center p-3 rounded-xl border text-sm transition-all',
                          closed && 'opacity-40 cursor-not-allowed',
                          isSelected
                            ? 'border-primary bg-primary/10 text-primary font-semibold'
                            : 'border-border hover:border-primary/50 text-foreground'
                        )}
                      >
                        <span className="text-xs uppercase text-muted-foreground">
                          {format(date, 'EEE', { locale: ptBR })}
                        </span>
                        <span className="text-lg font-bold">{format(date, 'dd')}</span>
                        <span className="text-xs text-muted-foreground">{format(date, 'MMM', { locale: ptBR })}</span>
                      </button>
                    );
                  })}
                </div>
                <Button
                  variant="ghost"
                  className="w-full text-primary"
                  onClick={() => setShowCalendar(true)}
                >
                  <CalendarIcon className="h-4 w-4 mr-2" />
                  Escolher outra data
                </Button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(d) => {
                    setSelectedDate(d);
                    setShowCalendar(false);
                  }}
                  disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0)) || isDayClosed(date)}
                  locale={ptBR}
                  className="p-3 pointer-events-auto"
                />
                <Button variant="ghost" size="sm" onClick={() => setShowCalendar(false)}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
                </Button>
              </div>
            )}

            <Button
              className="w-full"
              disabled={!selectedDate}
              onClick={() => setStep(2)}
            >
              Continuar <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        )}

        {/* Step 2: Time */}
        {step === 2 && (
          <div className="space-y-4 pt-2">
            <Button variant="ghost" size="sm" onClick={() => { setStep(1); setSelectedTime(''); }}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
            <p className="text-sm text-muted-foreground text-center">
              Horários disponíveis para{' '}
              <span className="font-semibold text-foreground">
                {selectedDate && format(selectedDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}
              </span>
            </p>

            {timeSlots.length === 0 ? (
              <p className="text-center text-sm text-destructive">Nenhum horário disponível para esta data.</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-60 overflow-y-auto">
                {timeSlots.map(time => (
                  <button
                    key={time}
                    onClick={() => setSelectedTime(time)}
                    className={cn(
                      'flex items-center justify-center gap-1.5 py-3 rounded-xl border text-sm transition-all',
                      selectedTime === time
                        ? 'border-primary bg-primary/10 text-primary font-semibold'
                        : 'border-border hover:border-primary/50 text-foreground'
                    )}
                  >
                    <Clock className="h-3.5 w-3.5" />
                    {time}
                  </button>
                ))}
              </div>
            )}

            <Button
              className="w-full"
              disabled={!selectedTime}
              onClick={() => setStep(3)}
            >
              Continuar <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        )}

        {/* Step 3: Personal Info */}
        {step === 3 && (
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setStep(2)}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
            <p className="text-sm text-muted-foreground text-center">
              {selectedDate && format(selectedDate, "dd/MM/yyyy", { locale: ptBR })} às {selectedTime}
            </p>

            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">Nome Completo *</Label>
                <Input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Seu nome"
                  required
                  maxLength={100}
                />
              </div>
              <div>
                <Label className="text-sm font-medium">E-mail</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="seu@email.com"
                  maxLength={255}
                />
              </div>
              <div>
                <Label className="text-sm font-medium">Data de Nascimento</Label>
                <Input
                  type="date"
                  value={form.birthdate}
                  onChange={e => setForm(f => ({ ...f, birthdate: e.target.value }))}
                />
              </div>
              <div>
                <Label className="text-sm font-medium">WhatsApp *</Label>
                <Input
                  value={form.whatsapp}
                  onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))}
                  placeholder="(11) 99999-9999"
                  required
                  maxLength={20}
                />
              </div>
              <div>
                <Label className="text-sm font-medium">Ocasião</Label>
                <Select value={form.occasion} onValueChange={v => setForm(f => ({ ...f, occasion: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione..." />
                  </SelectTrigger>
                  <SelectContent>
                    {OCCASIONS.map(o => (
                      <SelectItem key={o} value={o}>{o}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm font-medium">Observação</Label>
                <Textarea
                  value={form.observation}
                  onChange={e => setForm(f => ({ ...f, observation: e.target.value }))}
                  placeholder="Alguma observação especial?"
                  maxLength={500}
                  rows={3}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Ao continuar você concorda com nossa{' '}
              <span className="underline text-primary cursor-pointer">Termos e Condições</span>
            </p>

            <Button type="submit" className="w-full py-5 text-base rounded-xl">
              Confirmar Reserva
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
