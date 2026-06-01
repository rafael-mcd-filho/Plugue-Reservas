import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { sortReservationScheduleSlotSettings } from '@/lib/reservation-schedule';
import { toast } from 'sonner';

export type ReservationScheduleRuleScope = 'weekly' | 'date_specific' | 'date_range';

export interface ReservationScheduleRuleSlot {
  id: string;
  rule_id: string;
  time: string;
  sort_order: number;
  max_party_size_per_reservation: number | null;
  max_reservations_per_slot: number | null;
  created_at: string;
}

export interface ReservationScheduleRule {
  id: string;
  company_id: string;
  name: string;
  scope: ReservationScheduleRuleScope;
  weekdays: number[] | null;
  start_date: string | null;
  end_date: string | null;
  enabled: boolean;
  priority: number;
  max_party_size_per_reservation: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  reservation_schedule_rule_slots: ReservationScheduleRuleSlot[];
}

export interface ReservationScheduleRuleDraft {
  id?: string;
  company_id: string;
  name: string;
  scope: ReservationScheduleRuleScope;
  weekdays: number[] | null;
  start_date: string | null;
  end_date: string | null;
  enabled: boolean;
  priority: number;
  max_party_size_per_reservation: number | null;
  slots: Array<{
    time: string;
    max_party_size_per_reservation: number | null;
    max_reservations_per_slot: number | null;
  }>;
}

function getErrorMessage(error: unknown) {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : '';
}

export function useReservationScheduleRules(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ['reservation-schedule-rules', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservation_schedule_rules' as any)
        .select('*, reservation_schedule_rule_slots(*)')
        .eq('company_id', companyId)
        .is('archived_at', null)
        .order('priority', { ascending: true })
        .order('created_at', { ascending: false });

      if (error) throw error;

      return ((data ?? []) as unknown as ReservationScheduleRule[]).map((rule) => ({
        ...rule,
        reservation_schedule_rule_slots: [...(rule.reservation_schedule_rule_slots ?? [])]
          .sort((left, right) => left.time.localeCompare(right.time)),
      }));
    },
    enabled: !!companyId,
  });
}

export function useSaveReservationScheduleRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (draft: ReservationScheduleRuleDraft) => {
      const { data, error } = await (supabase.rpc as any)('upsert_reservation_schedule_rule', {
        _company_id: draft.company_id,
        _rule_id: draft.id ?? null,
        _name: draft.name.trim(),
        _scope: draft.scope,
        _weekdays: draft.scope === 'weekly' ? draft.weekdays : null,
        _start_date: draft.scope === 'weekly' ? null : draft.start_date,
        _end_date: draft.scope === 'date_range' ? draft.end_date : draft.start_date,
        _enabled: draft.enabled,
        _priority: draft.priority,
        _max_party_size_per_reservation: draft.max_party_size_per_reservation,
        _slots: sortReservationScheduleSlotSettings(draft.slots).map((slot) => slot.time),
        _slot_settings: sortReservationScheduleSlotSettings(draft.slots),
      });

      if (error) throw error;
      return { id: data as string, companyId: draft.company_id, editing: !!draft.id };
    },
    onSuccess: ({ companyId, editing }) => {
      queryClient.invalidateQueries({ queryKey: ['reservation-schedule-rules', companyId] });
      queryClient.invalidateQueries({ queryKey: ['public-reservation-schedule', companyId] });
      queryClient.invalidateQueries({ queryKey: ['public-reservation-schedules-preview', companyId] });
      toast.success(editing ? 'Regra atualizada.' : 'Regra criada.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error) || 'Não foi possível salvar a regra.');
    },
  });
}

export function useArchiveReservationScheduleRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, companyId }: { id: string; companyId: string }) => {
      const { error } = await (supabase.rpc as any)('archive_reservation_schedule_rule', {
        _rule_id: id,
      });

      if (error) throw error;
      return companyId;
    },
    onSuccess: (companyId) => {
      queryClient.invalidateQueries({ queryKey: ['reservation-schedule-rules', companyId] });
      queryClient.invalidateQueries({ queryKey: ['public-reservation-schedule', companyId] });
      queryClient.invalidateQueries({ queryKey: ['public-reservation-schedules-preview', companyId] });
      toast.success('Regra arquivada.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error) || 'Não foi possível arquivar a regra.');
    },
  });
}
