import { describe,expect,it,vi,beforeEach } from 'vitest';
import { buildSalonView,fetchSalonReservationDetail,fetchSalonSnapshot,parseSalonReservationDetail,parseSalonSnapshot,salonElapsedMinutes,salonReservationWindow,type SalonReservation,type SalonSnapshot } from './service-salon';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mock.rpc}}));
const filters={search:'',section:'all',period:'all' as const};
const reservation=(overrides:Partial<SalonReservation>={}):SalonReservation=>({id:'r1',guest_name:'Ana Ribeiro',date:'2026-11-22',time:'19:30:00',party_size:4,checked_in_party_size:null,status:'confirmed',checked_in_at:null,duration_minutes:60,source:'reservation',origin_waitlist_id:null,created_in_mode:'tables',table_ids:['t1'],payment_hold_active:true,...overrides});
const snapshot=(reservations:SalonReservation[]=[]):SalonSnapshot=>({company_id:'company-a',date:'2026-11-22',time_zone:'America/Sao_Paulo',reference_time:'19:10:00',reference_at:'2026-11-22T22:10:00Z',generated_at:'2026-11-22T22:10:00Z',availability_mode:'tables',map:{id:'map1',name:'Padrão'},tables:[{id:'t1',number:1,capacity:4,section:'Principal',status:'available'},{id:'t2',number:2,capacity:4,section:'Varanda',status:'available'}],reservations});
beforeEach(()=>vi.clearAllMocks());
describe('Salon contract',()=>{
  it('accepts the exact scoped complete snapshot',()=>expect(parseSalonSnapshot(snapshot(),'company-a','2026-11-22')).toEqual(snapshot()));
  it.each([
    {company_id:'other'}, {date:'2026-11-23'}, {time_zone:'Invalid/Zone'}, {reference_time:'25:00'},
    {reference_at:'not-a-timestamp'}, {date:'2026-99-99'}, {tables:[{...snapshot().tables[0],capacity:-1}]},
    {tables:[snapshot().tables[0],snapshot().tables[0]]}, {reservations:[reservation(),reservation()]},
    {reservations:[reservation({duration_minutes:0})]}, {reservations:[reservation({table_ids:['t1','t1']})]},
    {reservations:[reservation({checked_in_at:'invalid'})]},
  ])('rejects invalid or foreign snapshot %j',patch=>expect(()=>parseSalonSnapshot({...snapshot(),...patch},'company-a','2026-11-22')).toThrow());
  it('requests one day snapshot with cancellation and optional reference time',async()=>{
    const query={abortSignal:vi.fn().mockResolvedValue({data:snapshot(),error:null})};mock.rpc.mockReturnValue(query);
    const controller=new AbortController();
    await fetchSalonSnapshot('company-a',{date:'2026-11-22',referenceTime:'19:10'},controller.signal);
    expect(mock.rpc).toHaveBeenCalledWith('get_company_service_salon',{_company_id:'company-a',_date:'2026-11-22',_reference_time:'19:10'});
    expect(query.abortSignal).toHaveBeenCalledWith(controller.signal);
  });
  it('preserves authorization code so the UI can hide cached private data',async()=>{
    mock.rpc.mockResolvedValue({data:null,error:{code:'42501',message:'Forbidden'}});
    await expect(fetchSalonSnapshot('company-a',{date:'2026-11-22'})).rejects.toMatchObject({code:'42501'});
  });
  it('does not issue a request when already aborted',async()=>{
    const controller=new AbortController();controller.abort();
    await expect(fetchSalonSnapshot('company-a',{date:'2026-11-22'},controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('opens full detail through the separately authorized RPC rather than table SELECT',async()=>{
    const row={...reservation(),company_id:'company-a',table_id:'t1',guest_phone:'+5500000000000',guest_phone_e164:null,guest_email:null,public_tracking_code:'fixture',occasion:null,notes:null,created_at:'2026-11-22T12:00:00Z',updated_at:'2026-11-22T12:00:00Z'};
    mock.rpc.mockResolvedValue({data:{company_id:'company-a',reservation_id:'r1',row},error:null});
    await expect(fetchSalonReservationDetail('company-a','r1')).resolves.toMatchObject({id:'r1',guest_name:'Ana Ribeiro'});
    expect(mock.rpc).toHaveBeenCalledWith('get_company_service_salon_reservation',{_company_id:'company-a',_reservation_id:'r1'});
    expect(()=>parseSalonReservationDetail({company_id:'other',reservation_id:'r1',row},'company-a','r1')).toThrow();
    expect(()=>parseSalonReservationDetail({company_id:'company-a',reservation_id:'r1',row:{...row,company_id:'other'}},'company-a','r1')).toThrow();
  });
  it('preserves authorization failures from a detail request after a snapshot was allowed',async()=>{
    mock.rpc.mockResolvedValue({data:null,error:{code:'42501'}});
    await expect(fetchSalonReservationDetail('company-a','r1')).rejects.toMatchObject({code:'42501'});
  });
});
describe('Salon operational model',()=>{
  it('keeps upcoming booking separate from attendance and marks the next 30 minutes as planned',()=>{
    const view=buildSalonView(snapshot([reservation()]),filters);
    expect(view.tables[0]).toMatchObject({state:'reserved',current:[],next:{id:'r1'}});
    expect(view.currentGroups).toBe(0);expect(view.checkedInPeople).toBe(0);
  });
  it('keeps every booking for the selected day discoverable before service without claiming current occupancy',()=>{
    const later=reservation({id:'r2',guest_name:'Beatriz Santos',time:'21:00:00'});
    const data={...snapshot([later,reservation({time:'19:00:00'})]),reference_time:'11:00:00',reference_at:'2026-11-22T14:00:00Z'};
    const view=buildSalonView(data,filters);
    expect(view.tables[0]).toMatchObject({state:'free',current:[],next:{id:'r1'}});
    expect(view.tables[0].planned.map(r=>r.id)).toEqual(['r1','r2']);
    expect(view.tables[1].planned).toEqual([]);
    expect(view.reservedTables).toBe(1);expect(view.freeTables).toBe(2);
    expect(view.currentGroups).toBe(0);expect(view.checkedInPeople).toBe(0);
    expect(buildSalonView(data,{...filters,search:'beatriz'}).tables.map(t=>t.table.id)).toEqual(['t1']);
  });
  it('counts a multi-table group and checked-in people once',()=>{
    const r=reservation({status:'checked_in',time:'19:00',checked_in_at:'2026-11-22T22:00:00Z',checked_in_party_size:3,table_ids:['t1','t2']});
    const view=buildSalonView(snapshot([r]),filters);
    expect(view.tables.map(t=>t.state)).toEqual(['checked_in','checked_in']);
    expect(view.currentGroups).toBe(1);expect(view.checkedInPeople).toBe(3);
  });
  it('an early check-in appears immediately and keeps the planned duration end',()=>{
    const r=reservation({status:'checked_in',checked_in_at:'2026-11-22T22:00:00Z'});
    expect(salonReservationWindow(r,snapshot())).toMatchObject({start:1140,end:1230});
    expect(buildSalonView(snapshot([r]),filters).tables[0].state).toBe('checked_in');
    expect(salonElapsedMinutes(r,snapshot())).toBe(10);
  });
  it('does not defer a fresh check-in until the following minute',()=>{
    const r=reservation({status:'checked_in',checked_in_at:'2026-11-22T22:10:30Z'});
    const data={...snapshot([r]),reference_time:'19:10:45.500',reference_at:'2026-11-22T22:10:45.500Z'};
    expect(buildSalonView(data,filters).tables[0].state).toBe('checked_in');
    expect(salonElapsedMinutes(r,data)).toBe(0);
  });
  it('a late arrival has an estimated window without hiding the next conflicting reservation',()=>{
    const r=reservation({time:'18:00',status:'checked_in',checked_in_at:'2026-11-22T22:00:00Z'});
    const next=reservation({id:'r2',time:'19:30'});
    const view=buildSalonView(snapshot([r,next]),filters);
    expect(salonReservationWindow(r,snapshot())).toMatchObject({start:1080,end:1200});
    expect(view.tables[0]).toMatchObject({state:'checked_in',conflicts:true,next:{id:'r2'}});
  });
  it('uses a half-open duration boundary instead of claiming a physical checkout',()=>{
    const r=reservation({time:'18:10',status:'checked_in',checked_in_at:'2026-11-22T21:10:00Z'});
    expect(buildSalonView(snapshot([r]),filters).tables[0].state).toBe('free');
  });
  it('calculates overnight attendance in the company time zone',()=>{
    const r=reservation({date:'2026-11-21',time:'23:30',status:'checked_in',checked_in_at:'2026-11-22T02:50:00Z',duration_minutes:120});
    const data={...snapshot([r]),reference_time:'00:30:00',reference_at:'2026-11-22T03:30:00Z'};
    expect(salonReservationWindow(r,data)).toMatchObject({start:-30,end:110});
    expect(buildSalonView(data,filters).tables[0].state).toBe('checked_in');
    expect(salonElapsedMinutes(r,data)).toBe(40);
  });
  it('ignores expired pending-payment holds while preserving active holds',()=>{
    const expired=reservation({time:'19:00',status:'pending_payment',payment_hold_active:false});
    const expiredView=buildSalonView(snapshot([expired]),filters);
    expect(expiredView.tables[0].state).toBe('free');expect(expiredView.tables[0].planned).toEqual([]);expect(expiredView.reservedTables).toBe(0);
    const activeView=buildSalonView(snapshot([{...expired,payment_hold_active:true}]),filters);
    expect(activeView.tables[0].state).toBe('reserved');expect(activeView.tables[0].planned.map(r=>r.id)).toEqual(['r1']);expect(activeView.reservedTables).toBe(1);
  });
  it('does not turn another-period occupancy into a free table',()=>{
    const r=reservation({time:'17:30',status:'checked_in',checked_in_at:'2026-11-22T20:30:00Z',duration_minutes:180});
    const view=buildSalonView(snapshot([r]),{...filters,period:'dinner'});
    expect(view.tables.some(t=>t.table.id==='t1')).toBe(false);
    expect(view.freeTables).toBe(1);
  });
  it('filters sections and searches names and table numbers without losing shared definitions',()=>{
    const data=snapshot([reservation()]);
    expect(buildSalonView(data,{...filters,section:'Varanda'}).tables.map(t=>t.table.id)).toEqual(['t2']);
    expect(buildSalonView(data,{...filters,search:'ana'}).tables.map(t=>t.table.id)).toEqual(['t1']);
    expect(buildSalonView(data,{...filters,search:'Mesa 2'}).tables.map(t=>t.table.id)).toEqual(['t2']);
  });
  it('shows unassigned capacity and other-map groups without counting seating twice',()=>{
    const r=reservation({status:'checked_in',time:'19:00',checked_in_at:'2026-11-22T22:00:00Z',created_in_mode:'capacity',table_ids:[],source:'waitlist',origin_waitlist_id:'q1'});
    const view=buildSalonView(snapshot([r]),filters);
    expect(view.unassigned.map(g=>g.id)).toEqual(['r1']);expect(view.currentGroups).toBe(1);expect(view.checkedInPeople).toBe(4);
    expect(buildSalonView(snapshot([{...r,table_ids:['other-map-table']}]),filters).unassigned).toHaveLength(1);
  });
  it('keeps maintenance tables unavailable even when no booking occupies them',()=>{
    const data=snapshot();data.tables[0].status='maintenance';
    expect(buildSalonView(data,filters).tables[0].state).toBe('blocked');
    expect(buildSalonView(data,filters).freeTables).toBe(1);
  });
});
