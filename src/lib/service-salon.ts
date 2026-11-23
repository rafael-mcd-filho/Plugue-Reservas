import { supabase } from '@/integrations/supabase/client';
import type { ReservationDetails } from '@/components/ReservationDetailsDialog';
import { getServiceTodayClock, isServiceTimeInPeriod, type ServiceTodayContext } from '@/lib/service-today';
import { normalizeReservationStatus } from '@/lib/reservation-status';

export interface SalonTable { id: string; number: number; capacity: number; section: string | null; status: string | null }
export interface SalonReservation {
  id: string; guest_name: string; date: string; time: string; party_size: number; checked_in_party_size: number | null;
  status: 'confirmed' | 'checked_in' | 'pending_payment'; checked_in_at: string | null; duration_minutes: number;
  source: string | null; origin_waitlist_id: string | null; created_in_mode: string | null; table_ids: string[]; payment_hold_active: boolean;
}
export interface SalonSnapshot {
  company_id: string; date: string; time_zone: string; reference_time: string; reference_at: string; generated_at: string;
  availability_mode: string; map: { id: string; name: string } | null; tables: SalonTable[]; reservations: SalonReservation[];
}
export type SalonTableState = 'checked_in' | 'reserved' | 'free' | 'blocked';
export interface SalonTableView {
  table: SalonTable; state: SalonTableState; current: SalonReservation[]; next: SalonReservation | null; planned: SalonReservation[]; conflicts: boolean;
}
export interface SalonView {
  tables: SalonTableView[]; unassigned: SalonReservation[]; sections: string[];
  checkedInPeople: number; currentGroups: number; freeTables: number; reservedTables: number;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const nullableText = (v: unknown): v is string | null => v === null || text(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string => {
  if (!text(v) || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const parsed = new Date(`${v}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === v;
};
const time = (v: unknown): v is string => text(v) && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(v);
const timestamp = (v: unknown): v is string => text(v) && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const invalid = () => new Error('Não foi possível validar os dados do salão desta unidade.');

export function parseSalonSnapshot(value: unknown, companyId: string, selectedDate: string): SalonSnapshot {
  if (!record(value) || value.company_id !== companyId || value.date !== selectedDate || !date(value.date)
    || !text(value.time_zone) || !time(value.reference_time) || !timestamp(value.reference_at) || !timestamp(value.generated_at)
    || !text(value.availability_mode) || !Array.isArray(value.tables) || !Array.isArray(value.reservations)
    || (value.map !== null && (!record(value.map) || !text(value.map.id) || !text(value.map.name)))) throw invalid();
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: value.time_zone }).format(0); } catch { throw invalid(); }
  const tableIds = new Set<string>();
  const tables = value.tables.map((v) => {
    if (!record(v) || !text(v.id) || !v.id || tableIds.has(v.id) || !integer(v.number) || !integer(v.capacity) || v.capacity < 1
      || !nullableText(v.section) || !nullableText(v.status)) throw invalid();
    tableIds.add(v.id); return v as unknown as SalonTable;
  });
  const reservationIds = new Set<string>();
  const reservations = value.reservations.map((v) => {
    if (!record(v) || !text(v.id) || !v.id || reservationIds.has(v.id) || !text(v.guest_name) || !date(v.date) || !time(v.time)
      || !integer(v.party_size) || (v.checked_in_party_size !== null && !integer(v.checked_in_party_size))
      || !['confirmed','checked_in','pending_payment'].includes(String(v.status))
      || (v.checked_in_at !== null && !timestamp(v.checked_in_at)) || !integer(v.duration_minutes) || v.duration_minutes < 1
      || !nullableText(v.source) || !nullableText(v.origin_waitlist_id) || !nullableText(v.created_in_mode)
      || !Array.isArray(v.table_ids) || !v.table_ids.every((id) => text(id) && !!id)
      || new Set(v.table_ids).size !== v.table_ids.length || typeof v.payment_hold_active !== 'boolean') throw invalid();
    reservationIds.add(v.id); return v as unknown as SalonReservation;
  });
  return { ...value, tables, reservations } as unknown as SalonSnapshot;
}

export async function fetchSalonSnapshot(companyId: string, context: Pick<ServiceTodayContext,'date'|'referenceTime'>, signal?: AbortSignal) {
  if (!companyId || !date(context.date)) throw invalid();
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  const query = supabase.rpc('get_company_service_salon' as never, {
    _company_id: companyId, _date: context.date, _reference_time: context.referenceTime ?? null,
  } as never);
  const { data,error } = await (signal ? query.abortSignal(signal) : query);
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  if (error) throw Object.assign(new Error('Não foi possível carregar o salão. Tente novamente.'), { code: error.code });
  return parseSalonSnapshot(data,companyId,context.date);
}

export function parseSalonReservationDetail(value: unknown,companyId: string,reservationId: string): ReservationDetails {
  if (!record(value) || value.company_id!==companyId || value.reservation_id!==reservationId || !record(value.row)) throw invalid();
  const row=value.row;
  if(row.id!==reservationId || row.company_id!==companyId || !text(row.guest_name) || !nullableText(row.guest_phone)
    || !nullableText(row.guest_phone_e164) || !nullableText(row.guest_email) || !nullableText(row.source)
    || !nullableText(row.table_id) || !nullableText(row.created_in_mode) || !date(row.date) || !time(row.time)
    || !integer(row.party_size) || !text(row.status) || !nullableText(row.occasion) || !nullableText(row.notes)
    || !nullableText(row.public_tracking_code) || (row.checked_in_at!==null&&!timestamp(row.checked_in_at))
    || (row.checked_in_party_size!==null&&!integer(row.checked_in_party_size))
    || !timestamp(row.created_at) || !timestamp(row.updated_at))throw invalid();
  return {...row,guest_phone:row.guest_phone??'',public_tracking_code:row.public_tracking_code??'',status:normalizeReservationStatus(row.status)} as unknown as ReservationDetails;
}
export async function fetchSalonReservationDetail(companyId: string,reservationId: string,signal?: AbortSignal) {
  if(!companyId||!reservationId)throw invalid();
  if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');
  const query=supabase.rpc('get_company_service_salon_reservation' as never,{_company_id:companyId,_reservation_id:reservationId} as never);
  const {data,error}=await(signal?query.abortSignal(signal):query);
  if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');
  if(error)throw Object.assign(new Error('Não foi possível abrir a reserva deste salão.'),{code:error.code});
  return parseSalonReservationDetail(data,companyId,reservationId);
}

export function salonMinute(value: string) {
  const [hour,minute,second = '0'] = value.split(':'); return Number(hour)*60+Number(minute)+Number(second)/60;
}
const dayDifference = (a: string,b: string) => (Date.parse(`${a}T00:00:00Z`)-Date.parse(`${b}T00:00:00Z`))/86400000;
function relativeTimestamp(value: string, snapshot: SalonSnapshot) {
  const clock = getServiceTodayClock(snapshot.time_zone,new Date(value));
  return dayDifference(clock.date,snapshot.date)*1440+salonMinute(clock.time);
}
export function salonReservationWindow(reservation: SalonReservation, snapshot: SalonSnapshot) {
  const planned = dayDifference(reservation.date,snapshot.date)*1440+salonMinute(reservation.time);
  const arrival = reservation.status==='checked_in' && reservation.checked_in_at ? relativeTimestamp(reservation.checked_in_at,snapshot) : planned;
  // This display window includes an early arrival and preserves a late check-in.
  // It does not alter reservation availability or assert a physical checkout.
  return { start: Math.min(planned,arrival), end: Math.max(planned+reservation.duration_minutes,arrival+reservation.duration_minutes), planned };
}
export function salonElapsedMinutes(reservation: SalonReservation, snapshot: SalonSnapshot) {
  if (!reservation.checked_in_at) return null;
  return Math.max(0,Math.floor((Date.parse(snapshot.reference_at)-Date.parse(reservation.checked_in_at))/60000));
}
const active = (r: SalonReservation) => r.status!=='pending_payment' || r.payment_hold_active;
const clean = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
function inPeriod(r: SalonReservation, period: ServiceTodayContext['period']) { return isServiceTimeInPeriod(r.time,period); }

export function buildSalonView(snapshot: SalonSnapshot, filters: Pick<ServiceTodayContext,'search'|'section'|'period'>): SalonView {
  const at = salonMinute(snapshot.reference_time);
  const reservations = snapshot.reservations.filter(active);
  const views: SalonTableView[] = snapshot.tables.map(table=>{
    const linked = reservations.filter(r=>r.table_ids.includes(table.id));
    const current = linked.filter(r=>{const w=salonReservationWindow(r,snapshot);return w.start<=at&&at<w.end;}).sort((a,b)=>Number(b.status==='checked_in')-Number(a.status==='checked_in')||a.time.localeCompare(b.time)||a.id.localeCompare(b.id));
    const next = linked.filter(r=>salonReservationWindow(r,snapshot).start>at).sort((a,b)=>salonReservationWindow(a,snapshot).start-salonReservationWindow(b,snapshot).start||a.id.localeCompare(b.id))[0]??null;
    const planned = linked.filter(r=>r.status!=='checked_in'&&(r.date===snapshot.date||current.some(item=>item.id===r.id))).sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)||a.id.localeCompare(b.id));
    const near = next && salonReservationWindow(next,snapshot).start<=at+30;
    const state: SalonTableState = table.status && table.status!=='available' ? 'blocked' : current.some(r=>r.status==='checked_in') ? 'checked_in' : current.length || near ? 'reserved' : 'free';
    const conflicts = current.length>1 || !!next && current.some(r=>salonReservationWindow(r,snapshot).end>salonReservationWindow(next,snapshot).start);
    return { table,state,current,next,planned,conflicts };
  });
  const selected = views.filter(v=>{
    if (filters.section!=='all' && (v.table.section??'Sem seção')!==filters.section) return false;
    const related = [...v.current,...v.planned,...(v.next?[v.next]:[])];
    // A period can hide tables belonging to another cohort; it never turns an
    // occupied table into a falsely free table by discarding its reservations.
    if (filters.period!=='all' && related.length && !related.some(r=>inPeriod(r,filters.period))) return false;
    return !filters.search || clean([`Mesa ${v.table.number}`,v.table.section??'',...related.map(r=>r.guest_name)].join(' ')).includes(clean(filters.search));
  });
  const mapIds = new Set(snapshot.tables.map(t=>t.id));
  const unassigned = reservations.filter(r=>!r.table_ids.some(id=>mapIds.has(id)) && inPeriod(r,filters.period)
    && salonReservationWindow(r,snapshot).end>at
    && (filters.section==='all' || filters.section==='Sem seção')
    && (!filters.search || clean(r.guest_name).includes(clean(filters.search))));
  const currentGroups = new Map<string,SalonReservation>();
  for (const v of selected) for(const r of v.current) currentGroups.set(r.id,r);
  for (const r of unassigned) {const w=salonReservationWindow(r,snapshot);if(w.start<=at&&at<w.end)currentGroups.set(r.id,r);}
  return {
    tables:selected, unassigned, sections:[...new Set(snapshot.tables.map(t=>t.section??'Sem seção'))].sort((a,b)=>a.localeCompare(b,'pt-BR')),
    checkedInPeople:[...currentGroups.values()].filter(r=>r.status==='checked_in').reduce((s,r)=>s+(r.checked_in_party_size??r.party_size),0),
    currentGroups:currentGroups.size,freeTables:selected.filter(v=>v.state==='free').length,reservedTables:selected.filter(v=>v.planned.length>0).length,
  };
}
