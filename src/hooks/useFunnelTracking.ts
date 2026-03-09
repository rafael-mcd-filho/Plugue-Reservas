import { useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Steps in order for the funnel
export const FUNNEL_STEPS = [
  'page_view',      // Visited public page
  'date_select',    // Opened reservation modal / selected date
  'time_select',    // Selected time slot
  'form_fill',      // Reached personal info form
  'completed',      // Submitted reservation
] as const;

export type FunnelStep = typeof FUNNEL_STEPS[number];

const STEP_LABELS: Record<FunnelStep, string> = {
  page_view: 'Página Pública',
  date_select: 'Seleção de Data',
  time_select: 'Seleção de Horário',
  form_fill: 'Dados Pessoais',
  completed: 'Reserva Finalizada',
};

export { STEP_LABELS };

function getVisitorId(): string {
  const key = 'rv_visitor_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export function useFunnelTracking(companyId: string | undefined) {
  const logged = useRef<Set<string>>(new Set());

  const trackStep = useCallback(async (step: FunnelStep) => {
    if (!companyId) return;
    const key = `${companyId}_${step}_${new Date().toISOString().split('T')[0]}`;
    if (logged.current.has(key)) return;
    logged.current.add(key);

    try {
      await supabase
        .from('reservation_funnel_logs' as any)
        .upsert({
          company_id: companyId,
          visitor_id: getVisitorId(),
          step,
          date: new Date().toISOString().split('T')[0],
        } as any, { onConflict: 'company_id,visitor_id,step,date' as any });
    } catch {
      // Silently fail — analytics shouldn't break the UX
    }
  }, [companyId]);

  return { trackStep };
}
