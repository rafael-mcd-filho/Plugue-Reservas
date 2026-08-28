# Runbook de publicacao dos relatorios avancados

Este runbook cobre os quatro RPCs temporais usados por Demanda, Ocupacao,
Comparecimento e Recorrencia. A entrega nao cria nem altera Edge Functions e
nao modifica tracking, fila Meta, CAPI ou envio de eventos.

## Escopo do banco

Aplicar, nesta ordem:

1. `20260827100000_expand_demand_temporal_analysis.sql`
2. `20260827110000_expand_occupancy_temporal_analysis.sql`
3. `20260827111000_index_waitlist_seated_events.sql`
4. `20260827111100_index_waitlist_expired_events.sql`
5. `20260827111200_index_waitlist_removed_events.sql`
6. `20260827120000_expand_attendance_outcome_series.sql`
7. `20260827130000_expand_customer_recurrence_temporal_analysis.sql`

Os tres indices usam `CREATE INDEX CONCURRENTLY` em migrations separadas para
evitar bloqueio prolongado das escritas da fila.

## 1. Validacao local obrigatoria

```sh
npm run test:reports:sql
npx vitest run src/test/advancedReportTemporalMigrations.test.ts
npm run lint
npm run build
```

Depois, executar sequencialmente (nao em paralelo):

```sh
npx supabase@2.116.0 migration list --linked
npx supabase@2.116.0 db push --linked --dry-run
```

O `dry-run` deve listar somente as sete migrations deste runbook.

## 2. Protecoes antes da janela

- Confirmar backup/PITR ativo e recente no Supabase.
- Confirmar que nenhuma migration posterior apareceu no projeto remoto.
- Guardar a definicao atual do modelo de contatos para restauracao emergencial:

```sql
SELECT pg_get_functiondef(
  'public._get_crm_contact_records(uuid)'::regprocedure
);
```

- Confirmar que os nomes dos indices novos ainda nao existem. Qualquer retorno
  exige investigacao antes do `db push`:

```sql
SELECT to_regclass(index_name) AS existing_index
FROM unnest(ARRAY[
  'public.idx_waitlist_company_seated_event',
  'public.idx_waitlist_company_expired_event',
  'public.idx_waitlist_company_removed_event'
]) AS indexes(index_name);
```

- Registrar uma empresa pequena e uma empresa de maior volume para os testes.
- Nao publicar Edge Functions nesta entrega.
- Nao publicar o frontend antes da validacao do banco.

## 3. Aplicacao do banco

```sh
npx supabase@2.116.0 db push --linked
```

Se uma migration de indice for interrompida, nao repetir cegamente e nao usar
`migration repair`. Inspecionar primeiro:

```sql
SELECT
  index_class.relname AS index_name,
  indexes.indisready,
  indexes.indisvalid
FROM pg_index AS indexes
JOIN pg_class AS index_class ON index_class.oid = indexes.indexrelid
WHERE index_class.relname IN (
  'idx_waitlist_company_seated_event',
  'idx_waitlist_company_expired_event',
  'idx_waitlist_company_removed_event'
);
```

Somente se o indice exato estiver invalido, removê-lo antes de repetir a
migration correspondente:

```sql
DROP INDEX CONCURRENTLY public.nome_exato_do_indice_invalido;
```

## 4. Verificacao imediata do banco

Executar novamente, em sequencia:

```sh
npx supabase@2.116.0 migration list --linked
npx supabase@2.116.0 db push --linked --dry-run
```

O segundo comando deve informar que o banco esta atualizado. Confirmar tambem:

```sql
SELECT to_regprocedure(signature) IS NOT NULL AS exists, signature
FROM unnest(ARRAY[
  'public.get_demand_temporal_analysis(uuid,date,date,text)',
  'public.get_occupancy_waitlist_series(uuid,date,date,text)',
  'public.get_attendance_outcome_series(uuid,date,date,text,text,text)',
  'public.get_customer_recurrence_visit_series(uuid,date,date,text,boolean)'
]) AS signatures(signature);
```

Todos os RPCs precisam existir e os tres indices precisam estar com
`indisready = true` e `indisvalid = true`.

## 5. Smoke e desempenho antes do frontend

Executar
`supabase/tests/advanced_report_temporal_production_preflight.sql` em uma
conexao segura contra o banco migrado. O arquivo verifica apenas catalogo,
ACLs e indices, abre uma transacao `READ ONLY` e termina com `ROLLBACK`.

Nunca executar em producao
`advanced_report_temporal_rpc_contract_regression.sql`: ele pertence ao runner
PGlite e usa UUIDs e totais fixos de fixtures locais.

Na empresa de maior volume, medir os quatro RPCs em periodos de 30 e 366 dias,
com granularidades diaria e mensal:

```sql
BEGIN READ ONLY;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT public.get_customer_recurrence_visit_series(
  'COMPANY_ID'::uuid,
  CURRENT_DATE - 365,
  CURRENT_DATE,
  'month',
  false
);

ROLLBACK;
```

Repetir o formato para os demais RPCs. Interromper a publicacao do frontend se
houver timeout, leitura excessiva, erro de permissao ou indice invalido.

## 6. Smoke funcional

Antes de publicar o frontend, validar com um admin autenticado:

- Demanda: evolucao de entrada e percentual do funil;
- Ocupacao: entradas, sentados, desistencias e espera por dia;
- Comparecimento: reservas/pessoas e evolucao dos resultados;
- Recorrencia: primeiras visitas e retornos;
- periodos diario, semanal e mensal;
- Dashboard da empresa;
- Dashboard do superadmin;
- impersonacao de uma empresa.

Depois desses testes, publicar apenas o frontend e repetir o smoke funcional.

## 7. Monitoramento e rollback

- Monitorar erros PostgREST, especialmente funcao ausente, timeout e permissao.
- Monitorar duracao dos quatro RPCs e carga do banco durante a primeira hora.
- Para erro apenas visual, voltar ao deploy anterior do frontend.
- As migrations sao majoritariamente aditivas; preferir uma nova migration de
  correcao em vez de apagar historico ou reverter migration aplicada.
- Se a alteracao do modelo de contatos causar regressao, restaurar a definicao
  capturada no passo 2 por uma nova migration.
- A flag `advanced_reports` pode desativar as telas por empresa enquanto uma
  correcao e preparada.
