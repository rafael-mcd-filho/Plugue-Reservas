-- Regras de acesso: a conferência de superadmin passa a ser feita uma vez por
-- consulta em todas as tabelas, e não uma vez por linha.
--
-- 87 regras, em 58 tabelas, chamavam
-- has_role(( SELECT effective_auth_uid() ...), 'superadmin') em cada linha. A
-- resposta depende só de quem está logado, mas o Postgres pagava cerca de 0,13 ms
-- por linha lida, para qualquer usuário, porque as regras que liberam a leitura
-- são combinadas com OU. A 20261123170000 já tinha feito a troca na regra
-- principal de reservas.
--
-- Este bloco põe só esse trecho dentro de (SELECT ...), e o Postgres passa a
-- calcular o valor uma vez por consulta. O restante de cada regra, as conferências
-- que dependem da linha (unidade, papel na unidade) e as demais regras ficam como
-- estão. Quem pode ler, criar, alterar ou apagar continua o mesmo. Rodar de novo
-- não muda nada.
--
-- Em produção (23/11/2026) a mesma troca foi aplicada tabela por tabela, para
-- travar uma tabela por vez. O resultado é o deste bloco.

DO $migration$
DECLARE
  _wrapped constant text := '( SELECT has_role(( SELECT effective_auth_uid() AS effective_auth_uid), ''superadmin''::app_role) AS has_role)';
  _unwrapped constant text := 'has_role(( SELECT effective_auth_uid() AS effective_auth_uid), ''superadmin''::app_role)';
  _placeholder constant text := '@@superadmin_check_once@@';
  _policy record;
  _qual text;
  _check text;
  _statement text;
BEGIN
  -- O texto das regras sai sem o esquema public em qualquer sessão.
  PERFORM pg_catalog.set_config('search_path', 'public', true);

  FOR _policy IN
    SELECT policies.tablename, policies.policyname, policies.qual, policies.with_check
    FROM pg_catalog.pg_policies AS policies
    WHERE policies.schemaname = 'public'
      AND (
        position(_unwrapped IN replace(COALESCE(policies.qual, ''), _wrapped, '')) > 0
        OR position(_unwrapped IN replace(COALESCE(policies.with_check, ''), _wrapped, '')) > 0
      )
    ORDER BY policies.tablename, policies.policyname
  LOOP
    _qual := replace(replace(replace(_policy.qual, _wrapped, _placeholder), _unwrapped, _wrapped), _placeholder, _wrapped);
    _check := replace(replace(replace(_policy.with_check, _wrapped, _placeholder), _unwrapped, _wrapped), _placeholder, _wrapped);
    _statement := format('ALTER POLICY %I ON public.%I', _policy.policyname, _policy.tablename);
    IF _qual IS NOT NULL THEN
      _statement := _statement || ' USING (' || _qual || ')';
    END IF;
    IF _check IS NOT NULL THEN
      _statement := _statement || ' WITH CHECK (' || _check || ')';
    END IF;
    EXECUTE _statement;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies AS policies
    WHERE policies.schemaname = 'public'
      AND (
        position(_unwrapped IN replace(COALESCE(policies.qual, ''), _wrapped, '')) > 0
        OR position(_unwrapped IN replace(COALESCE(policies.with_check, ''), _wrapped, '')) > 0
      )
  ) THEN
    RAISE EXCEPTION 'Ainda há regra com a conferência de superadmin por linha.';
  END IF;
END
$migration$;
