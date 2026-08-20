# Funil de Reservas: diagnóstico e solução implementada localmente

**Status:** implementação validada; implantação em produção autorizada em 2026-08-20
**Registrado em:** 2026-08-19
**Atualizado em:** 2026-08-20
**Regra de implantação:** nenhuma migration, frontend ou alteração de captura deve ir para produção sem autorização explícita.

## Resumo do problema

O Funil de Reservas podia aparecer inteiramente zerado enquanto a consulta ainda carregava ou depois de uma falha. A interface não diferenciava:

1. carregamento inicial;
2. atualização após troca de período;
3. erro ou timeout;
4. resposta válida sem jornadas no período.

Além do falso zero, a RPC antiga tinha um plano de execução instável. Ela aceitava empresa e datas opcionais por meio de condições como `(_company_id IS NULL OR ...)`, consultava o log bruto e era chamada com alta frequência. Em alguns recortes, essa combinação chegava ao timeout de 8 segundos da API.

Não há limitação de 1.000 registros nesse fluxo: a agregação ocorre no PostgreSQL e a resposta possui somente cinco linhas.

## Evidências de produção usadas no diagnóstico

A investigação foi somente leitura. No momento da análise:

- a RPC antiga acumulava aproximadamente 6 mil chamadas;
- o tempo médio era cerca de 1,36 segundo;
- o maior tempo observado era 7,999 segundos, praticamente o timeout de 8 segundos;
- `tracking_events` possuía aproximadamente 201 mil linhas e centenas de megabytes entre tabela e índices;
- uma chamada representativa de 30 dias levou cerca de 30,5 segundos com a função antiga;
- a consulta equivalente com empresa e intervalo explícitos levou cerca de 1,25 segundo;
- os índices anteriores existiam e eram utilizados, portanto o problema não era simplesmente falta de índice;
- o plano genérico dos parâmetros opcionais e o custo de agrupar eventos brutos eram os principais gargalos.

## Semântica adotada

O novo relatório é um **funil de coorte**:

> Sessões que acessaram a página pública dentro do período e as etapas que essas mesmas sessões alcançaram até o fim do período.

Regras:

- datas informadas pela interface são inclusivas;
- o PostgreSQL converte as datas para o intervalo semiaberto `[início, fim + 1 dia)` em `America/Fortaleza`;
- o cursor autoritativo continua sendo `tracking_events.created_at`, gerado no servidor;
- para eventos reenviados pela fila, o relatório usa `occurred_at` somente quando ele estiver dentro da janela confiável entre 24 horas antes e 5 minutos depois de `created_at`; fora dela usa `created_at`;
- o modo padrão identifica uma jornada por empresa + sessão;
- “visitantes únicos” identifica por empresa + `anonymous_id`;
- cada identidade recebe a maior etapa alcançada;
- as contagens são cumulativas e monotônicas: uma etapa posterior nunca pode superar a anterior;
- uma conversão registrada depois do fim selecionado aparece apenas em uma consulta cujo período também alcance essa conversão;
- reservas criadas no painel e reservas convertidas da fila não entram no funil público.

As cinco etapas continuam sendo:

1. `page_view` — Página Pública;
2. `date_select` — Seleção de Data;
3. `time_select` — Seleção de Horário;
4. `form_fill`/`lead_captured` — Dados Pessoais;
5. `reservation_created` — Reserva Finalizada.

## Solução implementada localmente

### 1. Estados corretos na interface

Arquivos principais:

- `src/hooks/useFunnelData.ts`;
- `src/components/ReservationFunnelChart.tsx`;
- `src/pages/Dashboard.tsx`.

O frontend agora:

- mostra skeleton no carregamento inicial;
- mantém e identifica os dados anteriores ao trocar o período;
- mostra atualização sem substituir o gráfico por zeros;
- mostra erro com “Tentar novamente”;
- mostra vazio somente depois de uma resposta válida com cinco etapas zeradas;
- marca a Dashboard como “Erro parcial” se apenas o funil falhar;
- valida quantidade de linhas, etapas únicas, contagens inteiras, fonte do dado e período máximo de 366 dias;
- usa escopo explícito de empresa ou global, impedindo que empresa ausente vire consulta global;
- conecta o `AbortSignal` do React Query à requisição;
- não repete automaticamente timeout, autenticação, permissão ou payload inválido;
- faz no máximo uma repetição para falha transitória de rede;
- atualiza a cada cinco minutos somente quando o período inclui o dia atual;
- usa uma chave de cache baseada em datas canônicas, sem horário variável;
- não possui filtro de Ads.

### 2. RPC rápida com contrato estável

Migration:

- `supabase/migrations/20260820120000_add_fast_tracking_funnel_report.sql`.

Contratos públicos:

- `get_tracking_funnel_report(company_id, start_date, end_date, unique_only)`;
- `get_global_tracking_funnel_report(start_date, end_date, unique_only)`.

Características:

- empresa e datas são obrigatórias;
- empresa e global usam funções separadas, evitando o predicado opcional que prejudicava o plano;
- o recorte aceita no máximo 366 dias;
- o relatório de empresa exige permissão de Dashboard e Relatórios Avançados;
- superadmin mantém o acesso de inspeção por empresa;
- o relatório global é exclusivo de superadmin;
- a resposta tem exatamente cinco linhas e informa `data_source`;
- a RPC antiga permanece intacta para rollback e não é usada pelo frontend novo.

### 3. Índices próprios e não bloqueantes

Migrations:

- `20260820122000_index_tracking_funnel_company_cursor.sql`;
- `20260820122100_index_tracking_funnel_company_session.sql`;
- `20260820122200_index_tracking_funnel_global_cursor.sql`.

Os índices são parciais para os eventos do funil e usam `CREATE INDEX CONCURRENTLY`. Cada migration contém um único índice para que a criação seja executada fora de uma transação explícita e não bloqueie as inserções do tracking público.

### 4. Modelo de leitura assíncrono

Migration:

- `supabase/migrations/20260820121000_add_tracking_funnel_read_model.sql`.
- `supabase/migrations/20260820121500_harden_tracking_funnel_projection.sql`.

O modelo `tracking_funnel_sessions` mantém uma linha por empresa + sessão, com os primeiros horários de cada etapa. Ele é privado, possui RLS sem políticas de cliente e só é lido pelas RPCs autorizadas.

Decisões importantes:

- não existe trigger novo em `tracking_events`;
- o evento público é gravado antes e independentemente da projeção;
- a projeção é idempotente, paginada e protegida por advisory lock por empresa;
- um cursor por `created_at + id` permite retomar o processamento;
- uma janela de sobreposição limitada ao lote processado cobre commits tardios sem reler todo o histórico a cada minuto;
- uma reconciliação periódica paginada cobre exclusões e correções do dado bruto;
- falhas são isoladas por empresa, usam backoff e não impedem que as demais avancem;
- o modelo só é considerado pronto quando o backfill terminou, não existe erro pendente e a cobertura alcança o período solicitado;
- a fonte bruta continua sendo a verdade;
- o rollout começa em `fast`, não no modelo consolidado;
- se o modelo consolidado não estiver pronto ou falhar, a RPC usa automaticamente `fast_fallback`;
- a troca entre `fast` e `read_model` é feita no banco e não exige novo build do frontend.

### 5. Projeção agendada

Migration:

- `supabase/migrations/20260820123000_schedule_tracking_funnel_projection.sql`.

Jobs planejados:

- projeção incremental a cada minuto;
- reconciliação diária com janela mais ampla.

Os jobs leem `tracking_events` e atualizam somente o modelo do funil. Eles não chamam nem alteram o worker da Meta.

### 6. Captura mais confiável no navegador

Arquivos principais:

- `src/hooks/useFunnelTracking.ts`;
- `src/lib/funnelTrackingPersistence.ts`;
- `src/pages/CompanyPublicPage.tsx`.

Melhorias:

- `session_ping` e `page_view` entram na fila durável antes da primeira continuação de rede;
- criação concorrente de sessão e jornada compartilha a mesma Promise;
- a fila é separada por empresa;
- cada evento possui sua própria chave no armazenamento, evitando que duas abas sobrescrevam a fila inteira;
- o processamento relê a fila até drená-la, inclusive para itens adicionados durante uma requisição;
- retries preservam o mesmo `event_id`;
- cada tentativa de rede possui timeout de 12 segundos; uma requisição pendurada volta ao backoff sem bloquear o restante da fila;
- falhas transitórias permanecem na fila por até 24 horas com backoff e jitter; falhas permanentes e itens expirados vão para diagnóstico;
- indisponibilidade ou bloqueio de `localStorage` usa memória como fallback;
- o diagnóstico não guarda payload, e-mail, telefone ou outros dados do lead;
- dados pessoais do lead ficam somente na memória durante a tentativa atual e nunca são gravados no armazenamento durável;
- URLs duráveis preservam apenas caminho e parâmetros técnicos permitidos, removendo fragmentos, tokens e queries arbitrárias;
- diagnósticos expiram e possuem limite de capacidade;
- estado legado sem empresa explícita nunca é atribuído por suposição à empresa atual;
- um evento atrasado que já pertence a uma sessão preserva essa sessão, mesmo que outra aba já tenha criado uma sessão mais nova;
- jornadas provisórias permanecem internas à fila e só entram no snapshot usado pela reserva depois de confirmadas pelo servidor;
- a página pública envia `company_id` junto com o slug assim que a empresa é conhecida.

### 7. Replay idempotente no `public-tracking`

Arquivos principais:

- `supabase/functions/public-tracking/index.ts`;
- `supabase/functions/public-tracking/idempotent-replay.ts`.

O handler passou a resolver repetições antes de alterar sessão, jornada ou reserva. O mesmo `event_id` recupera o contexto originalmente persistido, enquanto colisões entre empresas, visitantes ou eventos são rejeitadas. Sessões e jornadas rotacionadas usam identificadores determinísticos, de modo que requisições concorrentes convergem para o mesmo contexto.

O `session_ping` continua sem gerar linha em `tracking_events` e sem acionar a fila Meta. Eventos atrasados podem reutilizar a sessão e a jornada originais dentro da janela validada; uma resposta antiga não substitui uma sessão ou jornada mais recente no navegador. A atualização da sessão usa comparação monotônica no banco, impedindo que uma requisição antiga sobrescreva o horário, a página ou a atribuição gravados por uma requisição mais nova.

## Garantia sobre Meta/CAPI

Esta solução altera o transporte e a idempotência de `supabase/functions/public-tracking`, mas não altera:

- o trigger que captura eventos para a fila Meta;
- `meta_event_queue` e `meta_event_attempts`;
- o worker `process-meta-event-queue`;
- Pixel, CAPI, credenciais, nomes dos eventos ou mapeamento para a Meta;
- os triggers de reserva que produzem os eventos finais.

O caminho continua sendo:

```text
navegador -> public-tracking -> tracking_events
                              -> trigger Meta -> meta_event_queue -> worker CAPI
                              -> projetor assíncrono do funil
```

O projetor é um consumidor paralelo e assíncrono. Uma falha nele não desfaz a gravação em `tracking_events` e não impede o enfileiramento para a Meta.

Os retries do navegador reutilizam o mesmo `event_id`, e o backend agora devolve o contexto original antes de executar efeitos laterais. A restrição `UNIQUE` de `tracking_events.event_id` e a fila Meta continuam impedindo duplicidade do evento. O envio normal preserva o mesmo payload; após recarregar ou fechar a aba, um retry durável ainda envia o evento e os dados de atribuição, mas sem os dados pessoais do lead, que não são persistidos no navegador por segurança.

### Limite arquitetural conhecido

Retries normais do mesmo evento usam o mesmo contexto e convergem corretamente. Ainda existe uma janela teórica entre a consulta inicial do `event_id` e o `INSERT`: duas requisições concorrentes que reutilizem maliciosamente ou por corrupção o mesmo `event_id` com contextos diferentes podem criar estado parcial antes que a restrição `UNIQUE` rejeite a perdedora. Esse cenário não duplica o evento nem o envio à Meta, é incompatível com a fila normal do navegador e foi classificado como risco arquitetural médio de baixa probabilidade operacional.

A eliminação completa dessa janela exige mover criação de sessão, jornada, vínculo e evento para uma única RPC transacional, serializada por `pg_advisory_xact_lock(event_id)`. Isso deve ser tratado como hardening separado, com canário e testes próprios, para não substituir o fluxo atual por uma mudança transacional ampla sem validação de produção.

## Implantação futura, quando autorizada

A implantação deve ser gradual e **DB-first**. Antes de qualquer `db push`, a migration pendente e adiada de exclusão de empresas (`20260819120000_optimize_company_deletion.sql`) precisa ser retirada temporariamente do diretório de migrations; ela não faz parte desta entrega.

Ordem da entrega:

1. validar em staging que o Supabase CLI executa cada `CREATE INDEX CONCURRENTLY` fora de transação;
2. aplicar as migrations do funil com rollout ainda em `fast`, sem publicar o frontend;
3. confirmar em `pg_index` que os três índices estão `indisvalid=true` e `indisready=true`;
4. executar `EXPLAIN (ANALYZE, BUFFERS)` somente leitura no maior tenant e nos períodos suportados;
5. acompanhar cursor, atraso e erros do projetor e concluir o backfill;
6. comparar `fast` e `read_model` por empresa, período e modo de visitantes únicos;
7. publicar a Edge `public-tracking` e o frontend na mesma janela controlada;
8. validar captura, `tracking_events` e fila Meta ponta a ponta;
9. habilitar `read_model` primeiro para uma empresa canário;
10. habilitar outras empresas gradualmente;
11. habilitar o global por último.

Monitorar durante o rollout:

- tempo p50/p95/p99 das duas RPCs;
- erros e timeouts;
- atraso de `covered_through_at`;
- divergência `fast` x `read_model`;
- tamanho e falhas da fila local de captura;
- volume, falhas e atraso de `meta_event_queue` antes e depois;
- locks e progresso dos índices concorrentes.

Rollback:

- mudar o rollout do banco para `fast`;
- se necessário, voltar temporariamente o frontend para a RPC antiga;
- não remover os índices durante um incidente;
- não apagar `tracking_events` nem filas da Meta.

## Critérios de aceite antes de produção

- loading e erro nunca aparecem como `0%`;
- vazio só aparece após resposta válida;
- payload incompleto, duplicado ou inválido falha visivelmente;
- as cinco etapas são monotônicas;
- os períodos respeitam Fortaleza e o limite de 366 dias;
- empresa ausente não dispara consulta global;
- timeout não provoca quatro consultas consecutivas;
- a RPC rápida fica confortavelmente abaixo do timeout no maior tenant e nos períodos suportados;
- `fast` e `read_model` têm equivalência nas mesmas fixtures;
- backfill, retomada, overlap, reconciliação e fallback estão testados;
- fila por empresa, concorrência, storage bloqueado, retry idempotente e redaction estão testados;
- perda de resposta, colisão de IDs, sessão expirada, duas abas e eventos atrasados estão testados;
- ACLs impedem acesso cross-company e acesso direto às tabelas privadas;
- todos os índices estão válidos;
- métricas da Meta permanecem estáveis;
- existe um canário e um rollback testado.

## Decisão atual

A implantação foi autorizada em 2026-08-20 e deve seguir rigorosamente a ordem DB-first e os gates descritos acima. A migration adiada de exclusão de empresas continua fora desta entrega.
