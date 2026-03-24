-- Substitui a policy permissiva WITH CHECK (true) por uma que valida
-- que a empresa existe na tabela companies antes de permitir o INSERT.
-- O INSERT em si ainda passa pelo SECURITY DEFINER da função RPC,
-- mas essa policy serve como segunda camada de proteção.

DROP POLICY IF EXISTS "Public funnel tracking via RPC" ON public.reservation_funnel_logs;

CREATE POLICY "Public funnel tracking via RPC"
ON public.reservation_funnel_logs
FOR INSERT
TO anon, authenticated
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE id = company_id)
);
