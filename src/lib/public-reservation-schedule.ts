import { supabase } from '@/integrations/supabase/client';
import { sortReservationScheduleSlots } from '@/lib/reservation-schedule';

export interface PublicReservationSchedule {
  source: 'blocked' | 'date_specific' | 'date_range' | 'weekly' | 'default';
  rule_id: string | null;
  rule_name: string | null;
  block_id: string | null;
  block_name: string | null;
  slots: string[];
  max_party_size_per_reservation: number | null;
  availability_mode: 'tables' | 'capacity';
  default_duration_minutes: number | null;
}

export function normalizePublicReservationSchedule(row: any): PublicReservationSchedule {
  return {
    source: row?.source ?? 'default',
    rule_id: row?.rule_id ?? null,
    rule_name: row?.rule_name ?? null,
    block_id: row?.block_id ?? null,
    block_name: row?.block_name ?? null,
    slots: sortReservationScheduleSlots(Array.isArray(row?.slots) ? row.slots : []),
    max_party_size_per_reservation: row?.max_party_size_per_reservation == null
      ? null
      : Number(row.max_party_size_per_reservation),
    availability_mode: row?.availability_mode === 'capacity' ? 'capacity' : 'tables',
    default_duration_minutes: row?.default_duration_minutes == null
      ? null
      : Number(row.default_duration_minutes),
  };
}

export function isMissingPublicReservationRpc(error: any, functionName: string) {
  const message = String(error?.message ?? '').toLowerCase();
  return error?.code === 'PGRST202'
    || error?.code === '42883'
    || (message.includes(functionName.toLowerCase()) && (
      message.includes('could not find')
      || message.includes('does not exist')
      || message.includes('schema cache')
    ));
}

export async function getPublicReservationSchedule(companyId: string, date: string): Promise<PublicReservationSchedule> {
  const { data, error } = await (supabase.rpc as any)('get_public_reservation_schedule', {
    _company_id: companyId,
    _date: date,
  });

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return normalizePublicReservationSchedule(row);
}

export async function getPublicReservationSchedules(companyId: string, dates: string[]) {
  if (dates.length === 0) return [];

  const functionName = 'get_public_reservation_schedule_range';
  const { data, error } = await (supabase.rpc as any)(functionName, {
    _company_id: companyId,
    _start_date: dates[0],
    _end_date: dates[dates.length - 1],
  });

  if (!error) {
    const schedulesByDate = new Map(
      ((data as any[]) ?? []).map((row) => [
        String(row.reservation_date),
        normalizePublicReservationSchedule(row),
      ]),
    );
    return dates.map((date) => ({
      date,
      schedule: schedulesByDate.get(date) ?? normalizePublicReservationSchedule(null),
    }));
  }

  if (!isMissingPublicReservationRpc(error, functionName)) throw error;

  return Promise.all(dates.map(async (date) => ({
    date,
    schedule: await getPublicReservationSchedule(companyId, date),
  })));
}
