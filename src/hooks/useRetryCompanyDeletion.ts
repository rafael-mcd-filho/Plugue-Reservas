import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export function useRetryCompanyDeletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (companyId: string) => {
      const { data, error } = await supabase.rpc('retry_company_deletion' as never, {
        _company_id: companyId,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['company-deletion-requests'] });
      toast.success('Exclusão retomada. O processamento continuará automaticamente.');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message
        ? `Erro ao retomar exclusão: ${error.message}`
        : 'Não foi possível retomar a exclusão.');
    },
  });
}
