import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Armchair, ArrowRight, Ban, CalendarCheck, CheckCircle2, Clock3, Info, Loader2, Search, Users, type LucideIcon } from 'lucide-react';
import ServiceQueryFeedback from '@/components/service-today/ServiceQueryFeedback';
import ReservationDetailsDialog from '@/components/ReservationDetailsDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { isAuthorizationFailure } from '@/lib/authorizationFailure';
import { buildSalonView, fetchSalonReservationDetail, fetchSalonSnapshot, salonElapsedMinutes, type SalonReservation, type SalonSnapshot, type SalonTableState, type SalonTableView } from '@/lib/service-salon';
import type { ServiceTodayContext } from '@/lib/service-today';
import { cn } from '@/lib/utils';

interface Props {
  companyId: string;
  context: ServiceTodayContext;
  selectedTableId: string | null;
  onSelectedTableChange: (tableId: string | null) => void;
  onSectionsChange?: (sections: string[]) => void;
}
const labels: Record<SalonTableState,string> = { checked_in:'Com check-in', reserved:'Reserva prevista', free:'Livre no horário', blocked:'Indisponível' };
const presentation: Record<SalonTableState,{icon:LucideIcon;card:string;badge:string;symbol:string}> = {
  checked_in:{icon:CheckCircle2,card:'border-info/20 border-l-info bg-info-soft/45 hover:border-info/40 hover:border-l-info',badge:'border-info/15 bg-info-soft text-info',symbol:'bg-info text-info-foreground'},
  reserved:{icon:CalendarCheck,card:'border-amber-200/80 border-l-amber-500 bg-amber-50/60 hover:border-amber-300 hover:border-l-amber-500',badge:'border-amber-200 bg-amber-100/80 text-amber-900',symbol:'bg-amber-100 text-amber-900'},
  free:{icon:Armchair,card:'border-success/20 border-l-success bg-success-soft/40 hover:border-success/40 hover:border-l-success',badge:'border-success/15 bg-success-soft text-success',symbol:'bg-success-soft text-success'},
  blocked:{icon:Ban,card:'border-border border-l-muted-foreground/50 bg-muted/30 hover:border-muted-foreground/40',badge:'border-border bg-muted text-muted-foreground',symbol:'bg-muted text-muted-foreground'},
};
function StateBadge({ state, compact = false }: {state:SalonTableState;compact?:boolean}) {
  const {icon:Icon,badge}=presentation[state];
  const shortLabels:Record<SalonTableState,string>={checked_in:'Check-in',reserved:'Prevista',free:'Livre',blocked:'Bloqueada'};
  return <Badge variant="secondary" aria-label={labels[state]} title={labels[state]} className={cn('w-fit max-w-full self-start gap-1 px-1.5 py-0.5 text-[10px] font-medium leading-snug',badge)}><Icon aria-hidden="true" className="h-3 w-3 shrink-0"/>{compact?<><span className="min-[440px]:hidden">{shortLabels[state]}</span><span className="hidden min-[440px]:inline">{labels[state]}</span></>:labels[state]}</Badge>;
}
function GroupSummary({ reservation, snapshot, compact = false }: {reservation:SalonReservation;snapshot:SalonSnapshot;compact?:boolean}) {
  const elapsed = salonElapsedMinutes(reservation,snapshot);
  const people=reservation.checked_in_party_size??reservation.party_size;
  const fromQueue=!!reservation.origin_waitlist_id||reservation.source==='waitlist';
  return <div className="min-w-0 space-y-1">
    <p className={cn('break-words font-medium',compact?'text-xs':'text-sm')}>{reservation.guest_name}</p>
    <p className={cn('flex items-start gap-1 text-muted-foreground',compact?'text-[11px]':'text-xs')}><Users aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0"/><span>{people} pessoas{(!compact||fromQueue)&&` · ${fromQueue?'Lista de espera':'Reserva'}`}</span></p>
    {reservation.status==='checked_in' ? <p className={cn('flex items-start gap-1 text-info',compact?'text-[11px]':'text-xs')}><Clock3 aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" /><span>{elapsed===null?'Check-in registrado':elapsed===0?'Check-in agora':`Check-in há ${elapsed} min`}</span></p>
      : <p className={cn('flex items-start gap-1',compact?'text-[11px] text-amber-900':'text-xs text-muted-foreground')}><CalendarCheck aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0"/><span>{compact?'Reserva':reservation.date.split('-').reverse().join('/')} às {reservation.time.slice(0,5)}{reservation.status==='pending_payment'?' · Aguardando pagamento':''}</span></p>}
  </div>;
}

function SalonTableCard({view,snapshot,preferPlanned,onSelect}:{view:SalonTableView;snapshot:SalonSnapshot;preferPlanned:boolean;onSelect:(id:string)=>void}) {
  const {table,state,current,planned,next,conflicts}=view;
  const group=preferPlanned?planned[0]:current[0]??planned[0]??next;
  // Show the day's planned booking even before its occupancy window starts.
  // The status badge still describes whether the table is free right now.
  const {card,symbol}=presentation[state==='free'&&planned.length>0?'reserved':state];
  return <button type="button" className={cn('group flex min-w-0 flex-col rounded-lg border border-l-[3px] p-2.5 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none',card)} onClick={()=>onSelect(table.id)} aria-label={`Mesa ${table.number}, ${labels[state]}`}>
    <div className="mb-1.5 flex items-center justify-between gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold sm:text-sm"><span className={cn('hidden h-6 w-6 shrink-0 items-center justify-center rounded-md min-[375px]:flex',symbol)}><Armchair aria-hidden="true" className="h-3.5 w-3.5"/></span><span className="whitespace-nowrap">Mesa {table.number}</span></span>
      <span className="flex shrink-0 items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground" title={`Capacidade da mesa: ${table.capacity} pessoas`}><Users aria-hidden="true" className="h-3 w-3"/>{table.capacity}</span>
    </div>
    <StateBadge state={state} compact/>
    {group&&<div className="my-1.5"><GroupSummary compact reservation={group} snapshot={snapshot}/>{planned.length>1&&<p className="mt-1 text-[10px] text-muted-foreground">+{planned.length-1} {planned.length===2?'outra reserva':'outras reservas'} hoje</p>}</div>}
    {!group&&state==='blocked'&&<p className="my-1.5 text-xs text-muted-foreground">Fora de atendimento</p>}
    {conflicts&&<p className="mb-2 flex items-start gap-1 rounded-md bg-amber-100/70 px-1.5 py-1 text-[11px] text-amber-900"><AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0"/>Conferir horários sobrepostos</p>}
    <div className={cn('mt-auto flex items-start gap-1 border-t pt-1.5 text-[10px] sm:text-[11px]',next?'border-amber-900/10 text-amber-900':'border-foreground/10 text-muted-foreground')} title={next?`Próxima reserva às ${next.time.slice(0,5)}`:'Sem próxima reserva nesta data'}>
      <CalendarCheck aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0"/><span>{next?`Próxima às ${next.time.slice(0,5)}`:'Sem próxima reserva'}</span><ArrowRight aria-hidden="true" className="ml-auto mt-0.5 h-3 w-3 shrink-0"/>
    </div>
  </button>;
}

export default function ServiceSalon({ companyId,context,selectedTableId,onSelectedTableChange,onSectionsChange }: Props) {
  const { slug } = useCompanySlug();
  const [stateFilter,setStateFilter] = useState<SalonTableState|'all'>('all');
  const [reservationId,setReservationId] = useState<string|null>(null);
  const [accessRevoked,setAccessRevoked] = useState(false);
  const query = useQuery({
    queryKey:['service-today-salon',companyId,context.date,context.referenceTime??null],
    queryFn:({signal})=>fetchSalonSnapshot(companyId,context,signal),
    enabled:!!companyId,refetchInterval:30000,staleTime:0,gcTime:0,retry:false,
  });
  const denied = query.isError && isAuthorizationFailure(query.error);
  const snapshot = denied||accessRevoked ? undefined : query.data;
  const view = useMemo(()=>snapshot?buildSalonView(snapshot,context):null,[snapshot,context]);
  const allTables = useMemo(()=>snapshot?buildSalonView(snapshot,{ search:'',section:'all',period:'all' }).tables:[],[snapshot]);
  const selected = allTables.find(v=>v.table.id===selectedTableId);
  const shown = view?.tables.filter(v=>stateFilter==='all'||(stateFilter==='reserved'?v.planned.length>0:v.state===stateFilter))??[];
  const unassigned = view?.unassigned.filter(r=>stateFilter==='all'||(stateFilter==='reserved'?r.status!=='checked_in':stateFilter==='checked_in'?r.status==='checked_in':false))??[];
  const sectionValues = useMemo(()=>snapshot?[...new Set(snapshot.tables.map(t=>t.section??'Sem seção'))].sort((a,b)=>a.localeCompare(b,'pt-BR')):undefined,[snapshot]);
  useEffect(()=>{ if(sectionValues)onSectionsChange?.(sectionValues); },[sectionValues,onSectionsChange]);
  useEffect(()=>{setReservationId(null);},[companyId,context.date]);
  useEffect(()=>{if(denied){setReservationId(null);onSelectedTableChange(null);}},[denied,onSelectedTableChange]);
  useEffect(()=>{if(snapshot && selectedTableId && !selected)onSelectedTableChange(null);},[snapshot,selectedTableId,selected,onSelectedTableChange]);
  const detail = useQuery({
    queryKey:['service-today-salon-detail',companyId,context.date,reservationId],
    queryFn:({signal})=>fetchSalonReservationDetail(companyId,reservationId!,signal),
    enabled:!!snapshot&&!!reservationId,gcTime:0,retry:false,
  });
  const {refetch:refetchSnapshot}=query;
  useEffect(()=>{if(query.data&&!query.isError)setAccessRevoked(false);},[query.dataUpdatedAt,query.isError,query.data]);
  useEffect(()=>{
    if(detail.isError&&isAuthorizationFailure(detail.error)){
      setAccessRevoked(true);setReservationId(null);onSelectedTableChange(null);void refetchSnapshot();
    }
  },[detail.isError,detail.error,refetchSnapshot,onSelectedTableChange]);
  const openReservation = (id:string)=>setReservationId(id);

  return <div className="space-y-4">
    <ServiceQueryFeedback queries={[{label:'os dados do salão',...query}]} onFreshnessChange={context.onFreshnessChange} />
    {snapshot&&view&&<>
      <Card className="overflow-hidden shadow-none"><CardContent className="space-y-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">Mesas neste horário</h2><p className="mt-1 text-xs text-muted-foreground">{snapshot.map?.name??'Nenhum mapa ativo'} · Referência: {snapshot.date.split('-').reverse().join('/')} às {snapshot.reference_time.slice(0,5)}</p></div><div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1" aria-label="Filtrar situação das mesas">{(['all','checked_in','free','reserved','blocked'] as const).map(state=>{
          const Icon=state==='all'?null:presentation[state].icon;
          return <Button key={state} type="button" size="sm" variant={stateFilter===state?'secondary':'ghost'} className="h-8 shrink-0 gap-1.5 text-xs" aria-pressed={stateFilter===state} onClick={()=>setStateFilter(state)}>{Icon&&<Icon aria-hidden="true" className={cn('h-3.5 w-3.5',state==='checked_in'?'text-info':state==='free'?'text-success':state==='reserved'?'text-amber-800':'text-muted-foreground')}/>}<span>{state==='all'?'Todas':state==='checked_in'?'Com check-in':state==='free'?'Livres':state==='reserved'?'Reservadas':'Indisponíveis'}</span></Button>;
        })}</div></div>
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground"><Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0"/><p>Janela estimada pela reserva, duração e chegada registrada. O tempo conta desde o check-in. Esta visão não acompanha a saída física nem altera a disponibilidade da agenda.{snapshot.availability_mode==='capacity'?' O dia atende por capacidade; grupos sem atribuição de mesa aparecem abaixo.':''}</p></div>
        {context.period!=='all'&&<p className="text-xs text-muted-foreground">O período seleciona os horários dos grupos; uma mesa ocupada não é marcada como livre por causa do filtro.</p>}
        {stateFilter==='reserved'&&<p className="text-xs text-muted-foreground">Inclui as reservas previstas para hoje, mesmo quando a mesa está livre no horário atual.</p>}
        {view.sections.map(section=>{const group=shown.filter(v=>(v.table.section??'Sem seção')===section);return group.length>0&&<section key={section} className="space-y-2"><h3 className="text-sm font-medium">{section}<span className="ml-2 text-xs font-normal text-muted-foreground">{group.length} {group.length===1?'mesa':'mesas'}</span></h3><div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 2xl:grid-cols-4">{group.map(v=><SalonTableCard key={v.table.id} view={v} snapshot={snapshot} preferPlanned={stateFilter==='reserved'} onSelect={onSelectedTableChange}/>)}</div></section>;})}
        {shown.length===0&&unassigned.length===0&&<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-muted-foreground"><Search aria-hidden="true" className="h-5 w-5"/><p className="text-sm">Nenhuma mesa neste recorte.</p><p className="text-xs">Confira o mapa ativo ou a busca.</p></div>}
      </CardContent></Card>
      {unassigned.length>0&&<Card className="shadow-none"><CardContent className="space-y-3 p-4 sm:p-5"><h2 className="text-base font-semibold">{stateFilter==='reserved'?'Reservas sem mesa neste mapa':'Grupos sem mesa neste mapa'}</h2><p className="text-xs text-muted-foreground">Inclui atendimento por capacidade, mesa ainda não atribuída ou mesa de outro mapa. Esses grupos não são contados duas vezes.</p><div className="space-y-2">{unassigned.map(r=><div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><GroupSummary reservation={r} snapshot={snapshot}/><Button variant="outline" size="sm" onClick={()=>openReservation(r.id)}>Ver reserva<ArrowRight className="ml-1 h-3 w-3" aria-hidden="true"/></Button></div>)}</div></CardContent></Card>}
    </>}
    {!snapshot&&query.isPending&&<div role="status" className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none"/>Carregando o salão…</div>}
    <Sheet open={!!selected&&!!snapshot} onOpenChange={open=>{if(!open)onSelectedTableChange(null);}}><SheetContent className="w-full overflow-y-auto sm:max-w-md"><SheetHeader><SheetTitle>Mesa {selected?.table.number}</SheetTitle><SheetDescription>{selected?.table.section??'Sem seção'} · Até {selected?.table.capacity} pessoas</SheetDescription></SheetHeader>{selected&&snapshot&&<div className="mt-6 space-y-5"><StateBadge state={selected.state}/>{selected.conflicts&&<p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0"/>Há grupos com horários sobrepostos nesta mesa. Confira as reservas antes de alocar outro grupo.</p>}{selected.current.map(r=><div key={r.id} className="space-y-3 rounded-lg border border-border p-4"><p className="text-xs text-muted-foreground">{r.status==='checked_in'?'Grupo com check-in':'Reserva aguardando chegada'}</p><GroupSummary reservation={r} snapshot={snapshot}/><Button variant="outline" size="sm" className="w-full" onClick={()=>openReservation(r.id)}>Ver reserva<ArrowRight className="ml-1 h-3 w-3" aria-hidden="true"/></Button></div>)}{selected.current.length===0&&<p className="text-sm text-muted-foreground">{selected.state==='blocked'?'Mesa indisponível no cadastro.':'Nenhum grupo ocupa a janela da agenda neste horário.'}</p>}{selected.planned.filter(r=>!selected.current.some(current=>current.id===r.id)).map(r=><div key={r.id} className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"><h3 className="text-sm font-medium">Reserva prevista</h3><GroupSummary reservation={r} snapshot={snapshot}/><p className="text-xs text-muted-foreground">Prevista · ainda sem chegada registrada</p><Button variant="outline" size="sm" className="w-full" onClick={()=>openReservation(r.id)}>Ver reserva<ArrowRight className="ml-1 h-3 w-3" aria-hidden="true"/></Button></div>)}<p className="text-xs leading-relaxed text-muted-foreground">Referência de {snapshot.date.split('-').reverse().join('/')} às {snapshot.reference_time.slice(0,5)}. A janela é estimada pela agenda e pelo check-in; o fim da duração não confirma saída física.</p></div>}</SheetContent></Sheet>
    {reservationId&&detail.isError&&<div role="alert" className="rounded-lg border border-destructive/20 p-3 text-sm text-destructive">Não foi possível abrir a reserva.<Button size="sm" variant="outline" className="ml-3" onClick={()=>void detail.refetch()}>Tentar novamente</Button><Button size="sm" variant="ghost" onClick={()=>setReservationId(null)}>Fechar</Button></div>}
    <ReservationDetailsDialog open={!!reservationId&&!!snapshot&&!detail.isError} onOpenChange={open=>{if(!open)setReservationId(null);}} reservation={detail.data??null} loading={detail.isPending} slug={slug} companyId={companyId} readOnly showEventHistory={false} showLeadHistory={false} onBackToList={()=>setReservationId(null)} backLabel={selected?'Voltar à mesa':'Voltar ao salão'}/>
  </div>;
}
