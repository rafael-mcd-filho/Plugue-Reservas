import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface ReservationScheduleOverride {
  id: string;
  company_id: string;
  date: string;
  start_time: string;
  end_time: string;
  slot_interval_minutes: number;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export type ReservationScheduleOverrideInsert = {
  company_id: string;
  date: string;
  start_time: string;
  end_time: string;
  slot_interval_minutes: number;
  label?: string | null;
};

export type ReservationScheduleOverrideUpdate = Partial<
  Omit<ReservationScheduleOverrideInsert, 'company_id'>
>;

export function useReservationScheduleOverrides(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ['reservation-schedule-overrides', companyId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('reservation_schedule_overrides')
        .select('*')
        .eq('company_id', companyId)
        .gte('date', new Date().toISOString().slice(0, 10))
        .order('date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReservationScheduleOverride[];
    },
    enabled: !!companyId,
  });
}

export function useCreateReservationScheduleOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (override: ReservationScheduleOverrideInsert) => {
      const { data, error } = await (supabase as any)
        .from('reservation_schedule_overrides')
        .insert(override)
        .select()
        .single();
      if (error) throw error;
      return data as ReservationScheduleOverride;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['reservation-schedule-overrides', data.company_id] });
      toast.success('Regra criada com sucesso');
    },
    onError: (err: any) => {
      const msg = String(err?.message ?? '');
      if (msg.includes('rso_end_after_start') || msg.includes('end_time')) {
        toast.error('O horário de término deve ser depois do início');
      } else if (msg.includes('unique') || msg.includes('23505')) {
        toast.error('Já existe uma regra para essa data');
      } else {
        toast.error('Erro ao salvar regra');
      }
    },
  });
}

export function useUpdateReservationScheduleOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, companyId, update }: { id: string; companyId: string; update: ReservationScheduleOverrideUpdate }) => {
      const { data, error } = await (supabase as any)
        .from('reservation_schedule_overrides')
        .update(update)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return { data: data as ReservationScheduleOverride, companyId };
    },
    onSuccess: ({ companyId }) => {
      queryClient.invalidateQueries({ queryKey: ['reservation-schedule-overrides', companyId] });
      toast.success('Regra atualizada');
    },
    onError: (err: any) => {
      const msg = String(err?.message ?? '');
      if (msg.includes('rso_end_after_start') || msg.includes('end_time')) {
        toast.error('O horário de término deve ser depois do início');
      } else if (msg.includes('unique') || msg.includes('23505')) {
        toast.error('Já existe uma regra para essa data');
      } else {
        toast.error('Erro ao atualizar regra');
      }
    },
  });
}

export function useDeleteReservationScheduleOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, companyId }: { id: string; companyId: string }) => {
      const { error } = await (supabase as any)
        .from('reservation_schedule_overrides')
        .delete()
        .eq('id', id);
      if (error) throw error;
      return companyId;
    },
    onSuccess: (companyId) => {
      queryClient.invalidateQueries({ queryKey: ['reservation-schedule-overrides', companyId] });
      toast.success('Regra removida');
    },
    onError: () => {
      toast.error('Erro ao remover regra');
    },
  });
}
