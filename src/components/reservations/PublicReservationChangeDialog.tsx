import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ArrowLeft, ArrowRight, CalendarIcon, Clock, Loader2, Minus, Plus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getVisitorId } from '@/hooks/useFunnelTracking';
import { toStoredWhatsAppNumber } from '@/lib/phone';
import { buildWhatsAppMessageUrl } from '@/lib/whatsapp-links';
import { cn } from '@/lib/utils';
import {
  changePublicReservation,
  getPublicReservationChangeOptions,
  publicReservationChangeDateBounds,
  publicReservationChangeMessage,
  type PublicReservationChangeSnapshot,
} from '@/lib/public-reservation-changes';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<unknown> | void;
  companyName: string;
  companyWhatsapp: string | null;
  guestName: string;
  trackingCode: string;
  reservation: PublicReservationChangeSnapshot;
  hasPayment: boolean;
}

function dateLabel(date: string) {
  return format(new Date(`${date}T12:00:00`), 'dd/MM/yyyy');
}

// Calendar dates are local-noon objects built from the company's date keys.
// "Today" comes from the server/company zone, never the browser's clock.
function calendarDate(value: string) {
  return new Date(`${value}T12:00:00`);
}
function shiftDate(value: string, amount: number) {
  return format(addDays(calendarDate(value), amount), 'yyyy-MM-dd');
}
function dateWindowFor(value: string, minimum: string, maximum: string) {
  const days = Math.floor((Date.parse(`${value}T00:00:00Z`) - Date.parse(`${minimum}T00:00:00Z`)) / 86400000);
  const aligned = shiftDate(minimum, Math.max(0, Math.floor(days / 6) * 6));
  const lastStart = shiftDate(maximum, -5);
  return aligned < minimum ? minimum : aligned > lastStart ? lastStart : aligned;
}
function fullDateLabel(value: string) {
  return format(calendarDate(value), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR });
}

export function PublicReservationChangeDialog(props: Props) {
  const { open, onOpenChange, reservation, hasPayment } = props;
  const [date, setDate] = useState(reservation.date);
  const [time, setTime] = useState(reservation.time.slice(0, 5));
  const [partySize, setPartySize] = useState(reservation.party_size);
  const [baseline, setBaseline] = useState(reservation);
  const [message, setMessage] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => calendarDate(reservation.date));
  const [dateWindowStart, setDateWindowStart] = useState(reservation.date);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const previousRevision = useRef<string | null>(null);
  const dateWindowInitialized = useRef(false);
  const visitorId = getVisitorId();
  const hasValidDate = /^\d{4}-\d{2}-\d{2}$/.test(date);

  useEffect(() => {
    if (!open) return;
    setDate(reservation.date);
    setTime(reservation.time.slice(0, 5));
    setPartySize(reservation.party_size);
    setBaseline(reservation);
    setMessage('');
    setStep(1);
    setShowCalendar(false);
    setCalendarMonth(calendarDate(reservation.date));
    setDateWindowStart(reservation.date);
    dateWindowInitialized.current = false;
    request.current = null;
    previousRevision.current = null;
    // Reopening starts a new edit; polling the tracking page must not overwrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reservation.id]);

  const optionsQuery = useQuery({
    queryKey: ['public-reservation-change-options', props.trackingCode, visitorId, reservation.id, date, partySize],
    queryFn: () => getPublicReservationChangeOptions({
      trackingCode: props.trackingCode, visitorId, reservationId: reservation.id, date, partySize,
    }),
    enabled: open && !hasPayment && hasValidDate,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    placeholderData: previous => previous,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });
  const options = optionsQuery.data;

  useEffect(() => {
    if (!options) return;
    if (previousRevision.current && previousRevision.current !== options.revision) {
      setMessage(publicReservationChangeMessage('stale'));
      request.current = null;
    }
    previousRevision.current = options.revision;
    setBaseline(options.reservation);
  }, [options]);

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof changePublicReservation>[0]) => changePublicReservation(input),
    retry: false,
    onSuccess: async result => {
      if (result.changed || result.reason === 'no_changes') {
        await props.onChanged();
        onOpenChange(false);
        if (result.changed) toast.success('Reserva alterada com sucesso.');
        else toast.info(publicReservationChangeMessage('no_changes'));
        return;
      }
      setMessage(publicReservationChangeMessage(result.reason));
      request.current = null;
      if (result.reason === 'stale') {
        setBaseline(result.reservation);
        setDate(result.reservation.date);
        setTime(result.reservation.time);
        setPartySize(result.reservation.party_size);
        setStep(1);
        setShowCalendar(false);
        setCalendarMonth(calendarDate(result.reservation.date));
        dateWindowInitialized.current = false;
        await props.onChanged();
      }
      await optionsQuery.refetch();
    },
    onError: () => {
      // A lost response may have committed. Keep the same request id for a safe retry.
      setMessage('Não foi possível confirmar a alteração. Tente novamente para consultar a mesma solicitação.');
    },
  });

  const manual = hasPayment || (!optionsQuery.isPending && (optionsQuery.isError || !options?.allowed));
  const normalizedWhatsapp = toStoredWhatsAppNumber(props.companyWhatsapp);
  const whatsappUrl = normalizedWhatsapp ? buildWhatsAppMessageUrl(normalizedWhatsapp,
    `Olá! Gostaria de alterar uma reserva em ${props.companyName}.\n` +
    `Nome: ${props.guestName}\nData: ${dateLabel(baseline.date)}\nHorário: ${baseline.time.slice(0, 5)}\nPessoas: ${baseline.party_size}`,
  ) : null;
  const bounds = options ? publicReservationChangeDateBounds(options.server_now, options.time_zone) : undefined;
  const minimumDate = bounds?.min;
  const maximumDate = bounds?.max;
  useEffect(() => {
    if (!minimumDate || !maximumDate || dateWindowInitialized.current) return;
    setDateWindowStart(dateWindowFor(date, minimumDate, maximumDate));
    dateWindowInitialized.current = true;
  }, [minimumDate, maximumDate, date]);
  const dateWindowDays = Array.from({ length: 6 }, (_, index) => shiftDate(dateWindowStart, index));
  const firstDateLabel = format(calendarDate(dateWindowDays[0]), 'dd MMM', { locale: ptBR }).replace('.', '');
  const lastDateLabel = format(calendarDate(dateWindowDays[5]), 'dd MMM', { locale: ptBR }).replace('.', '');
  const dateWindowLabel = `${firstDateLabel} - ${lastDateLabel}`;
  const selectedSlot = options?.slots.find(slot => slot.time === time);
  const changed = date !== baseline.date || time !== baseline.time.slice(0, 5) || partySize !== baseline.party_size;
  const ready = !!options?.allowed && options.date === date && options.party_size === partySize
    && !!selectedSlot?.available && changed && !optionsQuery.isFetching && !mutation.isPending;
  const paymentAtDestination = options?.slots.some(slot => slot.reason === 'payment') ?? false;
  const noAvailableSlots = !!options?.slots.length && !options.slots.some(slot => slot.available);
  const unavailableMessage = options?.slots.every(slot => slot.reason === 'cutoff')
    ? 'Nenhum horário atende à antecedência mínima nesta data. Escolha outra data.'
    : options?.slots.every(slot => slot.reason === 'party_size')
      ? 'Nenhum horário comporta essa quantidade de pessoas. Ajuste o grupo ou escolha outra data.'
      : 'Não há horários disponíveis para estas opções. Escolha outra data ou ajuste as pessoas.';

  function selectDate(value: string) {
    if (!bounds || value < bounds.min || value > bounds.max || mutation.isPending) return;
    if (value !== date) setTime('');
    setDate(value);
    setCalendarMonth(calendarDate(value));
    setDateWindowStart(dateWindowFor(value, bounds.min, bounds.max));
    setShowCalendar(false);
    setMessage('');
  }

  function moveDateWindow(direction: -1 | 1) {
    if (!bounds) return;
    const next = shiftDate(dateWindowStart, direction * 6);
    setDateWindowStart(next < bounds.min ? bounds.min : next > shiftDate(bounds.max, -5) ? shiftDate(bounds.max, -5) : next);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (step === 1) {
      if (!mutation.isPending && hasValidDate && partySize <= (options?.max_party_size ?? 20)) setStep(2);
      return;
    }
    if (!ready || !options) return;
    const signature = JSON.stringify([date, time, partySize, options.revision]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    setMessage('');
    mutation.mutate({ trackingCode: props.trackingCode, visitorId, reservationId: reservation.id,
      date, time, partySize, revision: options.revision, requestId: request.current.id });
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!mutation.isPending) onOpenChange(next); }}>
      <DialogContent className="left-[50%] right-auto top-[50%] bottom-auto grid-cols-[minmax(0,1fr)] w-[calc(100%-1.5rem)] max-w-md translate-x-[-50%] translate-y-[-50%] max-h-[88vh] overflow-y-auto data-[state=open]:slide-in-from-bottom-0 data-[state=closed]:slide-out-to-bottom-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 sm:max-w-md sm:max-h-[90vh]" onEscapeKeyDown={event => { if (mutation.isPending) event.preventDefault(); }} onPointerDownOutside={event => { if (mutation.isPending) event.preventDefault(); }}>
        <DialogHeader className={manual ? 'pr-7' : 'px-12'}>
          <DialogTitle className={manual ? undefined : 'mx-auto max-w-full text-center text-lg font-bold leading-snug'}>Alterar reserva</DialogTitle>
          <DialogDescription className={manual ? undefined : 'sr-only'}>
            {manual
              ? publicReservationChangeMessage(hasPayment ? 'payment' : options?.reason ?? 'disabled')
              : 'Ajuste as pessoas, a data ou o horário da sua reserva.'}
          </DialogDescription>
          {!manual && <>
            <p className="text-center text-xs text-muted-foreground">{props.companyName}</p>
            <div className="grid grid-cols-2 gap-2 pt-1.5" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={2} aria-label={`Passo ${step} de 2`}>
              {['Data', 'Horário'].map((label, index) => <div key={label} className="space-y-1">
                <div aria-hidden="true" className={cn('h-1 rounded-full transition-colors duration-200', index + 1 < step ? 'bg-primary/50' : index + 1 === step ? 'bg-primary' : 'bg-muted')} />
                <p className={cn('text-center text-[10px] font-medium leading-none', index + 1 === step ? 'text-foreground' : 'text-muted-foreground')}>{label}</p>
              </div>)}
            </div>
          </>}
        </DialogHeader>

        {manual ? (
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Voltar</Button>
            {whatsappUrl ? <Button asChild className="bg-emerald-600 text-white hover:bg-emerald-700">
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">Falar pelo WhatsApp</a>
            </Button> : <Button disabled>WhatsApp indisponível</Button>}
          </DialogFooter>
        ) : optionsQuery.isPending && !options && hasValidDate ? (
          <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> Consultando opções…
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3 pt-2">
            {step === 1 ? <>
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div className="min-w-0">
                  <p id="public-change-party-size-label" className="flex items-center gap-1.5 text-[15px] font-semibold leading-tight text-foreground"><Users className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />Quantas pessoas?</p>
                  <p id="public-change-party-size-help" className="mt-0.5 pl-[22px] text-xs text-muted-foreground">Inclua você, os demais adultos e as crianças.</p>
                </div>
                <div role="group" aria-labelledby="public-change-party-size-label" aria-describedby="public-change-party-size-help" className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/30 p-1">
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full bg-background shadow-sm active:scale-100" aria-label="Diminuir pessoas" disabled={partySize <= 1 || mutation.isPending} onClick={() => { setPartySize(value => value - 1); setMessage(''); }}><Minus aria-hidden="true" /></Button>
                  <span className="w-9 text-center text-lg font-semibold tabular-nums" aria-live="polite" aria-atomic="true">{partySize}</span>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full bg-background shadow-sm active:scale-100" aria-label="Aumentar pessoas" disabled={partySize >= (options?.max_party_size ?? 20) || mutation.isPending} onClick={() => { setPartySize(value => value + 1); setMessage(''); }}><Plus aria-hidden="true" /></Button>
                </div>
              </div>
              {partySize > (options?.max_party_size ?? 20) && <p className="text-xs text-muted-foreground">Pelo site, o limite é de {options?.max_party_size ?? 20} pessoas. Para manter um grupo maior, fale com a equipe pelo WhatsApp.</p>}
              {!showCalendar ? <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2" role="group" aria-label="Escolher data">
                  {dateWindowDays.map(value => {
                    const day = calendarDate(value);
                    const isSelected = date === value;
                    const todayLabel = value === bounds?.min ? 'Hoje' : bounds && value === shiftDate(bounds.min, 1) ? 'Amanhã' : null;
                    return <button key={value} type="button" aria-label={fullDateLabel(value)} aria-pressed={isSelected} disabled={mutation.isPending || !bounds || value < bounds.min || value > bounds.max} onClick={() => selectDate(value)} className={cn(
                      'relative flex h-[4.75rem] min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border p-2 text-sm transition-[border-color,background-color,color,box-shadow] duration-150',
                      isSelected ? 'border-primary bg-primary text-primary-foreground shadow-[0_6px_16px_rgba(201,129,58,0.28)]' : 'border-border bg-card text-foreground hover:border-primary/50 hover:shadow-sm',
                    )}>
                      {todayLabel ? <span className={cn('rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide', isSelected ? 'bg-white/25 text-primary-foreground' : 'bg-primary/12 text-primary')}>{todayLabel}</span>
                        : <span className={cn('block w-full truncate text-center text-[10px] font-semibold uppercase leading-none tracking-wide', isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{format(day, 'EEE', { locale: ptBR })}</span>}
                      <span className="block text-center text-[1.375rem] font-bold leading-none tabular-nums">{format(day, 'dd')}</span>
                      <span className={cn('block text-[10px] font-medium uppercase leading-none tracking-wide', isSelected ? 'text-primary-foreground/75' : 'text-muted-foreground/70')}>{todayLabel ? format(day, 'EEE', { locale: ptBR }) : format(day, 'MMM', { locale: ptBR }).replace('.', '')}</span>
                    </button>;
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <div className="grid min-w-0 flex-1 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-1 rounded-lg border border-border bg-muted/20 px-2 py-2 min-[460px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                    <Button type="button" variant="ghost" size="sm" className="h-8 min-w-0 justify-center px-1 text-xs active:scale-100 [&_svg]:size-5 min-[460px]:[&_svg]:size-4" aria-label="Mostrar 6 dias anteriores" disabled={!bounds || dateWindowStart <= bounds.min} onClick={() => moveDateWindow(-1)}><ArrowLeft className="shrink-0 min-[460px]:mr-1" aria-hidden="true" /><span className="hidden min-[460px]:inline">Anteriores</span></Button>
                    <span className="flex h-8 min-w-0 items-center justify-center truncate px-1 text-center text-xs font-medium tabular-nums text-muted-foreground">{dateWindowLabel}</span>
                    <Button type="button" variant="ghost" size="sm" className="h-8 min-w-0 justify-center px-1 text-xs active:scale-100 [&_svg]:size-5 min-[460px]:[&_svg]:size-4" aria-label="Mostrar próximos 6 dias" disabled={!bounds || dateWindowDays[5] >= bounds.max} onClick={() => moveDateWindow(1)}><span className="hidden min-[460px]:inline">Próximos</span><ArrowRight className="shrink-0 min-[460px]:ml-1" aria-hidden="true" /></Button>
                  </div>
                  <Button type="button" variant="outline" size="icon" className="h-[2.75rem] w-11 shrink-0 text-primary active:scale-100" aria-label="Escolher outra data no calendário" onClick={() => { setCalendarMonth(calendarDate(date)); setShowCalendar(true); }}><CalendarIcon className="h-4 w-4" aria-hidden="true" /></Button>
                </div>
                {!dateWindowDays.includes(date) && <div className="flex items-center justify-center gap-2 rounded-md border border-primary bg-primary/10 p-3">
                  <CalendarIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="text-center text-sm font-semibold text-primary">{format(calendarDate(date), "EEEE, dd 'de' MMMM", { locale: ptBR })}</span>
                </div>}
              </div> : <div className="flex flex-col items-center gap-3">
                <Calendar mode="single" selected={calendarDate(date)} month={calendarMonth} onMonthChange={setCalendarMonth} onSelect={day => { if (day) selectDate(format(day, 'yyyy-MM-dd')); }} fromDate={bounds ? calendarDate(bounds.min) : undefined} toDate={bounds ? calendarDate(bounds.max) : undefined} disabled={day => !bounds || format(day, 'yyyy-MM-dd') < bounds.min || format(day, 'yyyy-MM-dd') > bounds.max} locale={ptBR} className="p-0 pointer-events-auto" labels={{ labelNext: () => 'Próximo mês', labelPrevious: () => 'Mês anterior', labelDay: day => fullDateLabel(format(day, 'yyyy-MM-dd')) }} classNames={{
                  head_cell: 'w-8 rounded-md text-[0.8rem] font-normal text-muted-foreground min-[360px]:w-9',
                  cell: 'relative h-8 w-8 p-0 text-center text-sm [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20 min-[360px]:h-9 min-[360px]:w-9',
                  day: 'inline-flex h-8 w-8 items-center justify-center rounded-md p-0 text-sm font-normal transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-selected:opacity-100 min-[360px]:h-9 min-[360px]:w-9',
                }} />
                <Button type="button" variant="ghost" size="sm" aria-label="Voltar para as datas" onClick={() => setShowCalendar(false)}><ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />Voltar</Button>
              </div>}
              {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
              {!showCalendar && <Button type="button" className="h-10 w-full" disabled={mutation.isPending || !hasValidDate || partySize > (options?.max_party_size ?? 20)} onClick={() => setStep(2)}>Continuar</Button>}
            </> : <div className="space-y-4">
              <Button type="button" variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => setStep(1)}><ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />Voltar</Button>
              <div className="space-y-1 text-center">
                <p className="text-sm text-muted-foreground">Horários para <span className="font-semibold text-foreground">{format(calendarDate(date), "EEEE, dd 'de' MMMM", { locale: ptBR })}</span> · {partySize} {partySize === 1 ? 'pessoa' : 'pessoas'}</p>
                <Button type="button" variant="ghost" size="sm" className="min-h-11 text-primary" disabled={mutation.isPending} onClick={() => setStep(1)}><Users className="mr-1.5 h-4 w-4" aria-hidden="true" />Alterar pessoas</Button>
              </div>
              <fieldset aria-label="Horário" disabled={mutation.isPending}>
                {optionsQuery.isFetching ? <p role="status" className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Atualizando horários…</p> : options?.slots.length ? <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2">
                  {options.slots.map(slot => <button key={slot.time} type="button" aria-label={slot.time} aria-pressed={time === slot.time} disabled={!slot.available} title={slot.available ? undefined : slot.reason === 'payment' ? 'Este horário exige pagamento; fale pelo WhatsApp.' : publicReservationChangeMessage(slot.reason)} className={cn(
                    'relative h-10 w-[calc(33.333%-4px)] rounded-md border px-2 py-0.5 text-xs transition-[border-color,background-color,color] duration-150 sm:h-11 sm:w-[calc(25%-6px)] sm:text-[13px]',
                    !slot.available && 'cursor-not-allowed bg-muted opacity-40',
                    time === slot.time && slot.available ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border text-foreground',
                    slot.available && time !== slot.time && 'hover:border-primary/50',
                  )} onClick={() => { setTime(slot.time); setMessage(''); }}><span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap leading-none"><Clock className="h-3.5 w-3.5" aria-hidden="true" />{slot.time}</span>{slot.reason === 'full' && <span aria-hidden="true" className="pointer-events-none absolute inset-x-1 bottom-px text-center text-[9px] font-medium text-destructive">Lotado</span>}</button>)}
                </div> : <p className="py-2 text-center text-sm text-muted-foreground">Não há horários disponíveis para esta data e quantidade de pessoas.</p>}
              </fieldset>
              {paymentAtDestination && <p className="text-center text-xs text-muted-foreground">Horários com pagamento precisam ser alterados pelo WhatsApp.</p>}
              {!optionsQuery.isFetching && noAvailableSlots && !paymentAtDestination && <p className="text-center text-xs text-muted-foreground">{unavailableMessage}</p>}
              {time && changed && <div className="space-y-0.5 border-t border-border pt-3 text-center text-xs leading-relaxed text-muted-foreground" aria-label="Resumo da alteração">
                <p>Atual: {dateLabel(baseline.date)} às {baseline.time.slice(0, 5)} · {baseline.party_size} {baseline.party_size === 1 ? 'pessoa' : 'pessoas'}</p>
                <p className="font-medium text-foreground">Nova: {dateLabel(date)} às {time} · {partySize} {partySize === 1 ? 'pessoa' : 'pessoas'}</p>
              </div>}
              {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
              <Button type="submit" className="h-10 w-full" disabled={!ready}>{mutation.isPending && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}{mutation.isPending ? 'Salvando…' : 'Confirmar alteração'}</Button>
            </div>}
            {whatsappUrl && <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="block text-center text-xs text-muted-foreground underline underline-offset-4">Prefere falar pelo WhatsApp?</a>}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
