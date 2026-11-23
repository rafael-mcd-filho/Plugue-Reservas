import { useState } from 'react';
import { act,cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import ServiceSalon from './ServiceSalon';
import type { SalonSnapshot } from '@/lib/service-salon';
const mock=vi.hoisted(()=>({snapshot:vi.fn(),detail:vi.fn(),sections:vi.fn()}));
vi.mock('@/lib/service-salon',async original=>({...await original<typeof import('@/lib/service-salon')>(),fetchSalonSnapshot:mock.snapshot,fetchSalonReservationDetail:mock.detail}));
vi.mock('@/contexts/CompanySlugContext',()=>({useCompanySlug:()=>({slug:'demo'})}));
vi.mock('@/components/ReservationDetailsDialog',()=>({default:({open,reservation,loading,onBackToList,readOnly}:{open:boolean;reservation:{guest_name:string}|null;loading:boolean;onBackToList:()=>void;readOnly:boolean})=>open?<div role="dialog" aria-label="Reserva completa"><p>{loading?'Carregando detalhes':reservation?.guest_name}</p><p>{readOnly?'Somente consulta':'Edição'}</p><button onClick={onBackToList}>Voltar à mesa</button></div>:null}));
const base:SalonSnapshot={company_id:'unit-a',date:'2026-11-22',time_zone:'America/Sao_Paulo',reference_time:'19:10:00',reference_at:'2026-11-22T22:10:00Z',generated_at:'2026-11-22T22:10:00Z',availability_mode:'tables',map:{id:'m1',name:'Mapa principal'},tables:[{id:'t1',number:1,capacity:4,section:'Salão',status:'available'},{id:'t2',number:2,capacity:4,section:'Varanda',status:'available'}],reservations:[{id:'r1',guest_name:'Ana Ribeiro',date:'2026-11-22',time:'19:30:00',party_size:4,checked_in_party_size:3,status:'checked_in',checked_in_at:'2026-11-22T22:00:00Z',duration_minutes:60,source:'reservation',origin_waitlist_id:null,created_in_mode:'tables',table_ids:['t1'],payment_hold_active:true},{id:'r2',guest_name:'Bruno Costa',date:'2026-11-22',time:'20:00:00',party_size:2,checked_in_party_size:null,status:'confirmed',checked_in_at:null,duration_minutes:60,source:'reservation',origin_waitlist_id:null,created_in_mode:'tables',table_ids:['t1'],payment_hold_active:true}]};
const clients:QueryClient[]=[];
function mount(overrides:Partial<Parameters<typeof ServiceSalon>[0]>={}){
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);
  function Fixture(){const[selected,setSelected]=useState<string|null>(null);return <ServiceSalon companyId="unit-a" context={{date:'2026-11-22',search:'',section:'all',period:'all'}} selectedTableId={selected} onSelectedTableChange={setSelected} onSectionsChange={mock.sections} {...overrides}/>;}
  return{...render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>),client};
}
beforeEach(()=>{vi.clearAllMocks();mock.snapshot.mockResolvedValue(structuredClone(base));mock.detail.mockResolvedValue({id:'r1',guest_name:'Ana Ribeiro'});});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());});
describe('ServiceSalon',()=>{
  it('shows a real day snapshot with explicit reference and an estimated-window explanation',async()=>{
    mount();expect(await screen.findByText('Mesas neste horário')).toBeVisible();
    expect(screen.getByText(/Mapa principal · Referência: 22\/11\/2026 às 19:10/)).toBeVisible();
    expect(screen.getByText(/não acompanha a saída física/)).toBeVisible();
    expect(screen.getByRole('button',{name:'Mesa 1, Com check-in'})).toBeVisible();
    expect(screen.getByText('Check-in há 10 min')).toBeVisible();
    expect(mock.sections).toHaveBeenCalledWith(['Salão','Varanda']);
  });
  it('keeps the upcoming conflicting reservation visible in the table detail',async()=>{
    mount();fireEvent.click(await screen.findByRole('button',{name:'Mesa 1, Com check-in'}));
    const sheet=screen.getByRole('dialog',{name:'Mesa 1'});
    expect(within(sheet).getByText('Ana Ribeiro')).toBeVisible();expect(within(sheet).getByText('Bruno Costa')).toBeVisible();
    expect(within(sheet).getByText(/horários sobrepostos/)).toBeVisible();expect(within(sheet).getByText('Prevista · ainda sem chegada registrada')).toBeVisible();
  });
  it('shows day bookings under Reservadas even while their table is free at the current time',async()=>{
    const reservations=base.reservations.map((r,i)=>({...r,status:'confirmed',checked_in_at:null,checked_in_party_size:null,time:i===0?'19:00:00':'21:00:00'}));
    mock.snapshot.mockResolvedValue({...base,reference_time:'11:00:00',reference_at:'2026-11-22T14:00:00Z',reservations});
    mount();await screen.findByRole('button',{name:'Mesa 2, Livre no horário'});
    fireEvent.click(screen.getByRole('button',{name:'Reservadas'}));
    const table=screen.getByRole('button',{name:'Mesa 1, Livre no horário'});
    expect(within(table).getByText('Ana Ribeiro')).toBeVisible();expect(within(table).getByText('Reserva às 19:00')).toBeVisible();
    expect(within(table).getByText('+1 outra reserva hoje')).toBeVisible();
    expect(screen.queryByRole('button',{name:'Mesa 2, Livre no horário'})).toBeNull();
    expect(screen.queryByText('Nenhuma mesa neste recorte.')).toBeNull();
    fireEvent.click(table);
    const sheet=screen.getByRole('dialog',{name:'Mesa 1'});
    expect(within(sheet).getAllByText('Ana Ribeiro')).toHaveLength(1);expect(within(sheet).getAllByText('Bruno Costa')).toHaveLength(1);
    expect(within(sheet).getByText('22/11/2026 às 19:00')).toBeVisible();expect(within(sheet).getByText('22/11/2026 às 21:00')).toBeVisible();
    expect(within(sheet).getAllByRole('button',{name:'Ver reserva'})).toHaveLength(2);
    expect(mock.snapshot).toHaveBeenCalledTimes(1);
  });
  it('lists a current pending arrival and every later booking once in the same table drawer',async()=>{
    const current={...base.reservations[1],id:'current',guest_name:'Carla Lima',time:'19:00:00'};
    const later={...base.reservations[1],id:'later',guest_name:'Diana Rocha',time:'22:00:00'};
    mock.snapshot.mockResolvedValue({...base,reservations:[current,base.reservations[1],later]});
    mount();fireEvent.click(await screen.findByRole('button',{name:'Mesa 1, Reserva prevista'}));
    const sheet=screen.getByRole('dialog',{name:'Mesa 1'});
    for(const name of ['Carla Lima','Bruno Costa','Diana Rocha'])expect(within(sheet).getAllByText(name)).toHaveLength(1);
    expect(within(sheet).getAllByRole('button',{name:'Ver reserva'})).toHaveLength(3);
  });
  it('keeps unassigned bookings accessible under Reservadas without displaying a false empty result',async()=>{
    const unassigned={...base.reservations[1],table_ids:[],guest_name:'Elisa Duarte',time:'21:00:00'};
    mock.snapshot.mockResolvedValue({...base,reservations:[unassigned]});mount();
    await screen.findByText('Elisa Duarte');fireEvent.click(screen.getByRole('button',{name:'Reservadas'}));
    expect(screen.getByRole('heading',{name:'Reservas sem mesa neste mapa'})).toBeVisible();
    expect(screen.getByText('Elisa Duarte')).toBeVisible();expect(screen.getByRole('button',{name:'Ver reserva'})).toBeVisible();
    expect(screen.queryByRole('button',{name:/Mesa \d,/})).toBeNull();expect(screen.queryByText('Nenhuma mesa neste recorte.')).toBeNull();
  });
  it('omits the removed summary cards while retaining table status and details',async()=>{
    mount();expect(await screen.findByRole('button',{name:'Mesa 1, Com check-in'})).toBeVisible();
    for(const label of ['Grupos no horário','Pessoas com check-in','Mesas livres no horário','Mesas com reserva prevista'])expect(screen.queryByText(label,{exact:true})).toBeNull();
  });
  it('opens authorized full reservation detail in read-only mode and returns to the same table',async()=>{
    mount();fireEvent.click(await screen.findByRole('button',{name:'Mesa 1, Com check-in'}));
    const sheet=screen.getByRole('dialog',{name:'Mesa 1'});fireEvent.click(within(sheet).getAllByRole('button',{name:'Ver reserva'})[0]);
    const detail=await screen.findByRole('dialog',{name:'Reserva completa'});
    await waitFor(()=>expect(mock.detail).toHaveBeenCalledWith('unit-a','r1',expect.any(AbortSignal)));
    expect(within(detail).getByText('Somente consulta')).toBeVisible();
    fireEvent.click(within(detail).getByRole('button',{name:'Voltar à mesa'}));
    expect(screen.queryByRole('dialog',{name:'Reserva completa'})).toBeNull();expect(screen.getByRole('dialog',{name:'Mesa 1'})).toBeVisible();
  });
  it('hides cached snapshot and the drawer when a later detail request loses permission',async()=>{
    mock.detail.mockRejectedValue(Object.assign(new Error('Denied'),{code:'42501'}));
    mount();fireEvent.click(await screen.findByRole('button',{name:'Mesa 1, Com check-in'}));
    mock.snapshot.mockRejectedValue(Object.assign(new Error('Denied'),{code:'42501'}));
    fireEvent.click(within(screen.getByRole('dialog',{name:'Mesa 1'})).getAllByRole('button',{name:'Ver reserva'})[0]);
    await waitFor(()=>expect(screen.queryByText('Ana Ribeiro')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('button',{name:'Tentar novamente'})).toBeVisible();
  });
  it('keeps a missing response distinct from empty data and retries the actual query',async()=>{
    mock.snapshot.mockRejectedValueOnce(new Error('Offline'));mount();
    expect(await screen.findByText('Não foi possível carregar os dados do salão.')).toBeVisible();expect(screen.queryByText('Nenhuma mesa neste recorte.')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Tentar novamente'}));expect(await screen.findByRole('button',{name:'Mesa 1, Com check-in'})).toBeVisible();
  });
  it('shows a successful empty map explicitly and never invents a free table',async()=>{
    mock.snapshot.mockResolvedValue({...base,map:null,tables:[],reservations:[]});mount();
    expect(await screen.findByText('Nenhuma mesa neste recorte.')).toBeVisible();
    expect(screen.queryByRole('button',{name:/Mesa \d,/})).toBeNull();
  });
  it('uses shared search and section filters without fetching all history again',async()=>{
    mount({context:{date:'2026-11-22',search:'Mesa 2',section:'Varanda',period:'all'}});
    expect(await screen.findByRole('button',{name:'Mesa 2, Livre no horário'})).toBeVisible();
    expect(screen.queryByRole('button',{name:'Mesa 1, Com check-in'})).toBeNull();expect(mock.snapshot).toHaveBeenCalledTimes(1);
  });
  it('does not reuse another unit response after its request was cancelled',async()=>{
    let resolveOld:(value:SalonSnapshot)=>void=()=>{};mock.snapshot.mockImplementationOnce(()=>new Promise<SalonSnapshot>(resolve=>{resolveOld=resolve;}));
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);
    const props={context:{date:'2026-11-22',search:'',section:'all',period:'all' as const},selectedTableId:null,onSelectedTableChange:vi.fn()};
    const view=render(<QueryClientProvider client={client}><ServiceSalon companyId="unit-a" {...props}/></QueryClientProvider>);
    await waitFor(()=>expect(mock.snapshot).toHaveBeenCalledTimes(1));const oldSignal=mock.snapshot.mock.calls[0][2] as AbortSignal;
    mock.snapshot.mockResolvedValue({...base,company_id:'unit-b',tables:[],reservations:[]});
    view.rerender(<QueryClientProvider client={client}><ServiceSalon companyId="unit-b" {...props}/></QueryClientProvider>);
    await screen.findByText('Nenhuma mesa neste recorte.');expect(oldSignal.aborted).toBe(true);
    await act(async()=>resolveOld(base));expect(screen.queryByText('Ana Ribeiro')).toBeNull();
  });
});
