# Problema conhecido: exclusão permanente de empresas

**Status:** resolvido (Fase A + desprovisionamento de WhatsApp/Storage) — implementado e verificado em produção em 2026-08-26  
**Registrado em:** 2026-08-19  
**Atualizado em:** 2026-08-26  
**Impacto original:** superadministradores podiam receber `canceling statement due to statement timeout` ao excluir uma empresa.

## Atualização 2026-08-26 — pipeline assíncrono implementado

O plano descrito abaixo (seção "Solução recomendada para o futuro") foi implementado como está documentado, com um recorte de escopo: as integrações externas cobrem **WhatsApp (evolution-api) e Storage**, mas **não Asaas** — nenhuma cobrança, assinatura ou token do Asaas é cancelado ou tocado automaticamente (decisão explícita do usuário).

O que existe agora, em produção:

- Tabela `company_deletion_requests` (auditoria própria, sem FK para `companies`, sobrevive à exclusão) + `company_deletion_phase_order` (58 tabelas com FK direta `company_id` para `companies`, auditadas ao vivo via `pg_constraint`).
- RPCs `request_company_deletion` / `cancel_company_deletion` (só durante carência) / `force_skip_company_deletion_teardown` / `list_company_deletion_requests`, superadmin-gated.
- Motor assíncrono `_process_company_deletion_batch` / `_run_company_deletion_pipeline` (service_role only), mesmo padrão de lock advisório + backoff exponencial do projetor de funil de tracking, agendado a cada minuto via pg_cron, gated por `system_settings.company_deletion_pipeline_enabled`.
- RLS de `companies` reescrita: nenhuma escrita (admin do tenant ou superadmin) é aceita enquanto `deletion_requested_at` estiver setado; `DELETE` foi revogado do papel `authenticated` por completo — só a função do motor (dona da função, bypassa RLS) apaga a linha.
- Nova Edge Function `teardown-company-external-resources`: apaga a instância WhatsApp via `DELETE /instance/delete/{instance}` na evolution-api e os arquivos da empresa nos 4 prefixos do bucket `system-assets`.
- Índice que faltava (`whatsapp_message_queue.company_id`, sem versão parcial) aplicado via `CONCURRENTLY`.
- Jobs de cron de maior risco (`process-meta-event-queue`, `process-message-queue`) agora pulam empresas com `deletion_requested_at` setado.
- Frontend (`Companies.tsx`, `CompanyProfile.tsx`) trocado do delete síncrono para o fluxo de solicitação com confirmação digitada + motivo, painel de exclusões pendentes com cancelar/pular etapa externa.

Verificado por um canário real em produção (empresa sintética, não um cliente real): solicitação → carência forçada para o passado → múltiplos ticks de lote (inclusive um bug real de off-by-one no `phase_index` default pego e corrigido nesse processo, ver `20260826164000_fix_company_deletion_phase_index_default.sql`) → chamada real ao `teardown-company-external-resources` via `pg_net` respondendo em ~1.5s → exclusão final da empresa → linha em `company_deletion_requests` e `audit_logs` sobrevivendo → varredura das 60 tabelas com FK para `companies` sem nenhuma linha órfã.

Um segundo bug foi encontrado depois, ao explicar o funcionamento da flag `company_deletion_pipeline_enabled`: ela só era checada pelo worker (`_run_company_deletion_pipeline`), não pela RPC `request_company_deletion`. Com a flag desligada, clicar em "Excluir" ainda colocava a empresa em quarentena (bloqueava edição) mas o pedido nunca seria processado — ficava travado para sempre. Corrigido em `20260826165000_gate_company_deletion_request_on_pipeline_flag.sql`: agora a solicitação falha na hora, sem quarentena, se a flag estiver desligada. Verificado em produção.

**Não verificado / pendente:**

- `supabase/tests/company_deletion_regression.sql` foi reescrito para o novo pipeline (incluindo o teste da flag) mas **não foi executado** (não há runner PGlite disponível neste ambiente) — precisa rodar antes de confiar nele como regressão automatizada.
- `send-reminders` e o sync de billing da plataforma não ganharam o filtro de "pular empresa em exclusão" (só os dois jobs de maior risco ganharam); risco residual baixo dado o volume atual, mas vale revisar.
- A flag `company_deletion_pipeline_enabled` está **desligada** em produção — agora, com a correção acima, isso significa que o botão "Excluir" falha de forma limpa (sem travar empresa nenhuma) até alguém ligar a flag deliberadamente.
- Teardown do Asaas continua deliberadamente fora do escopo automatizado — se isso vier a ser necessário, exige decisão de negócio explícita antes de qualquer código novo.

## Histórico original (2026-08-19) — mantido para contexto

## Resumo

A exclusão atual é feita diretamente na tabela `companies`. Como existem muitas relações com `ON DELETE CASCADE` ou `ON DELETE SET NULL`, o PostgreSQL precisa remover ou atualizar uma árvore grande de registros dentro da mesma requisição.

Em empresas com bastante histórico, essa operação ultrapassa o `statement_timeout` do papel usado pelo PostgREST. A transação é cancelada e revertida, e a interface mostra um erro técnico.

Este problema está documentado, mas sua solução foi deliberadamente adiada. A exclusão permanente não deve ser liberada novamente sem cumprir o plano de retomada deste documento.

## Estado confirmado em produção

Na auditoria somente leitura realizada em 2026-08-19:

- o papel `authenticated` usado pelo frontend possuía `statement_timeout` de 8 segundos;
- a maior empresa tinha aproximadamente 178 mil registros apenas na árvore de eventos e rastreamento, além dos demais dados operacionais;
- a contagem somente leitura dessa árvore levou aproximadamente 31 segundos;
- a migration experimental `20260819120000_optimize_company_deletion.sql` não estava registrada como aplicada;
- 6 dos 17 índices previstos por essa migration já existiam, estavam válidos e prontos;
- os outros 11 índices ainda não existiam;
- não existia a RPC `delete_company_permanently(uuid)` em produção;
- não havia índices inválidos no schema `public` no momento da auditoria.

Os 6 índices existentes podem permanecer. Eles são auxiliares de integridade/performance e não ativam o novo fluxo de exclusão.

## Causas técnicas

1. **Exclusão síncrona e monolítica**

   A empresa e todos os registros relacionados são processados em uma única transação iniciada pelo navegador.

2. **Limite de tempo curto**

   Configurar um timeout maior dentro de uma função não garante a extensão do comando que já chegou ao PostgreSQL com o limite do papel chamador.

3. **Árvore extensa de chaves estrangeiras**

   A exclusão alcança reservas, eventos de rastreamento, filas, pagamentos, mensagens, destinatários, configurações e outras tabelas.

4. **Índices de suporte incompletos**

   A auditoria encontrou relações ainda sem índice completo adequado, incluindo `whatsapp_message_queue(company_id)` e relações associadas a regras e mapas de mesas.

5. **Efeitos externos não tratados**

   Remover dados locais não cancela automaticamente cobranças no Asaas, instâncias ou recursos de WhatsApp, arquivos no Storage ou outros recursos mantidos por provedores externos.

6. **Operação irreversível sem recuperação por empresa**

   Depois que lotes forem removidos, a recuperação depende de backup/PITR. Não existe restauração isolada e testada de uma única empresa.

## Correção experimental local

Existem arquivos locais de uma tentativa de correção:

- `supabase/migrations/20260819120000_optimize_company_deletion.sql`;
- `supabase/tests/company_deletion_regression.sql`;
- alterações em `src/hooks/useCompanies.ts`;
- alterações em `src/pages/Companies.tsx`;
- alterações em `src/pages/CompanyProfile.tsx`;
- `src/hooks/useCompanies.test.tsx`.

Esses arquivos **não representam uma solução aprovada para produção** e devem permanecer fora de qualquer release enquanto este item estiver adiado.

A proposta experimental melhora índices, locks, mensagens e proteção contra clique duplo, mas ainda executa a exclusão como uma única requisição. Isso continua vulnerável ao timeout real de produção e não resolve limpeza externa, retomada, auditoria permanente nem recuperação.

## Solução recomendada para o futuro

A abordagem segura é transformar a exclusão em um processo assíncrono, em duas fases e retomável.

### 1. Solicitação e quarentena

- exigir superadministrador;
- exigir a digitação exata do nome ou slug da empresa;
- exibir uma prévia com quantidade de registros e bloqueios;
- impedir a solicitação quando houver cobranças externas ou outras pendências não tratadas;
- marcar a empresa como `deleting` e desativar novas reservas, webhooks, sincronizações e gravações;
- registrar solicitante, motivo, data e identificador da operação em auditoria que não seja apagada com a empresa;
- aplicar um período de carência cancelável antes da limpeza.

### 2. Limpeza por job

- executar em worker/Edge Function usando `service_role`, nunca pelo navegador;
- adquirir lock por empresa;
- remover registros em lotes pequenos e transações curtas;
- persistir fase, cursor, quantidades removidas, erros e tentativas;
- permitir retomada idempotente após timeout ou reinicialização;
- tratar recursos externos antes da exclusão final;
- verificar que não restam dependências e somente então apagar `companies` em uma transação curta.

## Preparação obrigatória antes de retomar

1. Confirmar backup/PITR e testar restauração.
2. Auditar recursivamente todas as chaves estrangeiras alcançadas por `companies`.
3. Criar os índices faltantes de forma concorrente e separada do fluxo comportamental.
4. Verificar `indisvalid`, `indisready`, `indislive` e a definição de cada índice após sua criação.
5. Tratar explicitamente qualquer índice inválido; `IF NOT EXISTS` sozinho não é suficiente.
6. Bloquear `DELETE` direto em `companies`, deixando apenas o executor controlado finalizar o job.
7. Revisar ACLs das funções `SECURITY DEFINER` envolvidas.
8. Definir a política de cobranças Asaas, pagamentos de reservas, WhatsApp e Storage.
9. Criar feature flag server-side inicialmente desligada.
10. Validar o processo em clone/staging com volume semelhante ao da maior empresa.

## Plano de liberação futuro

1. Publicar somente os índices, um por vez, em período de baixo movimento.
2. Validar locks, progresso, WAL/replicação e integridade de cada índice.
3. Publicar tabela de jobs, auditoria, quarentena, RPC curta e worker com a feature flag desligada.
4. Executar um canário exclusivamente em empresa sintética com dados representativos.
5. Testar interrupção, retomada, concorrência e rollback operacional.
6. Liberar por allowlist para poucos superadministradores.
7. Monitorar duração dos lotes, locks, erros e diferenças de contagem.
8. Habilitar gradualmente somente após os resultados do canário.

## Rollback operacional

- desligar a feature flag;
- interromper o worker;
- revogar a execução das RPCs de solicitação/finalização;
- manter os índices válidos, pois eles não precisam ser revertidos;
- reativar empresas que ainda estejam apenas na fase de carência;
- restaurar dados já removidos somente por backup/PITR.

## Critérios para considerar o problema resolvido

- nenhuma exclusão longa é executada pelo navegador;
- o processo pode ser interrompido e retomado sem duplicar efeitos;
- o `DELETE` direto em `companies` está bloqueado;
- todas as dependências possuem índices adequados e validados;
- recursos externos possuem política explícita de encerramento;
- existe auditoria persistente da solicitação ao resultado final;
- confirmação digitada, prévia de impacto e bloqueios estão presentes na interface;
- canário, teste de volume, concorrência, falha e restauração foram aprovados;
- o frontend valida a resposta e reconcilia resultados ambíguos de rede;
- caches e dados sensíveis da empresa removida são eliminados do cliente.

## Decisão atual (histórica, substituída pela atualização de 2026-08-26 no topo do documento)

Não priorizar esta correção agora. Manter a exclusão permanente desabilitada/não publicada e retomar somente quando houver espaço para implementar o fluxo assíncrono completo e validar sua recuperação.
