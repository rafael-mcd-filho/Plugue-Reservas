-- Reservas: a regra de acesso de superadmin passa a ser conferida uma vez por
-- consulta, e não uma vez por reserva.
--
-- A regra "Superadmins can manage all reservations" chamava has_role(...) em cada
-- linha. Como has_role não depende da linha, o resultado é o mesmo para a consulta
-- inteira, mas o Postgres pagava cerca de 0,13 ms por reserva lida. Cada página de
-- 1.000 reservas do dashboard do superadmin levava 0,45 s no banco; as listas das
-- unidades pagavam o mesmo custo, porque as regras que liberam a leitura são
-- combinadas com OU.
--
-- Com has_role dentro de (SELECT ...), o Postgres calcula o valor uma vez e o usa
-- em todas as linhas. Quem pode ler, criar, alterar ou apagar reservas continua o
-- mesmo. As demais regras da tabela não mudam.

DO $guard$
DECLARE
  _expected constant text := 'has_role(( SELECT effective_auth_uid() AS effective_auth_uid), ''superadmin''::app_role)';
  _policy record;
BEGIN
  SELECT policies.cmd, policies.permissive, policies.roles, policies.qual, policies.with_check
  INTO _policy
  FROM pg_catalog.pg_policies AS policies
  WHERE policies.schemaname = 'public'
    AND policies.tablename = 'reservations'
    AND policies.policyname = 'Superadmins can manage all reservations';

  IF NOT FOUND
    OR _policy.cmd <> 'ALL'
    OR _policy.permissive <> 'PERMISSIVE'
    OR _policy.roles <> ARRAY['authenticated']::name[]
    OR _policy.qual IS DISTINCT FROM _expected
    OR _policy.with_check IS DISTINCT FROM _expected THEN
    RAISE EXCEPTION 'Regra "Superadmins can manage all reservations" diferente da esperada: % / %',
      _policy.qual, _policy.with_check;
  END IF;
END
$guard$;

ALTER POLICY "Superadmins can manage all reservations" ON public.reservations
  USING ((SELECT public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role)))
  WITH CHECK ((SELECT public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role)));
