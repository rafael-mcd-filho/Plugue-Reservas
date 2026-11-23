# Telefones internacionais: validação e migração

Publicação autorizada pelo responsável e executada em 19/10/2026. O procedimento abaixo registra o contrato, os controles usados e os cuidados para futuras manutenções.

## Contrato

- Novos formulários e integrações enviam `+E.164`; o Brasil é o país inicial da interface.
- Campos originais (`guest_phone`, `phone`, `responsible_phone`, `whatsapp`) permanecem. Seus pares `_e164` e `_country` são aditivos e preenchidos pelos novos gatilhos.
- Leituras e identidade usam `phone_identity_digits(e164, raw, country)`. `phone_normalized` e o sufixo de `phone:` em `customer_key` são **dígitos internacionais completos**, nunca apenas os últimos 11. Quando um desses valores passar pelo normalizador, prefixar `+`.
- Somente entradas nacionais legadas sem `+` usam o contexto BR. Não interpretar um número americano canônico de 11 dígitos como nacional BR: passar seu campo `_e164` ou `+` explícito.
- A validação de numeração usa os mesmos metadados fixados de libphonenumber-js 1.13.15 no cliente, nas funções Edge e no SQL. A migration de metadados é gerada localmente pelo script versionado e verifica DDIs reais, padrões e comprimentos. Atualizações da biblioteca exigem uma nova migration de metadados e a revisão/reconstrução dos índices que usam essas funções imutáveis.
- Novos cadastros continuam com validação estrita. Leitores e automações de registros existentes preservam o formato BR aceito anteriormente, incluindo celulares antigos com oito dígitos, sem inventar um nono dígito. `normalizeStoredPhoneE164`/`toStoredWhatsAppNumber` e `phone_stored_identity_digits` delimitam essa compatibilidade; o gatilho permite o fallback apenas em tabelas de entrega. Valores que falham nos metadados permanecem sem backfill e disponíveis para revisão.
- O CRM e os relatórios preservam também a identidade histórica de números malformados através de `phone_customer_identity_digits`. Esse fallback é exclusivo de leitura e não autoriza envio. O histórico continua sujeito à autorização da empresa.
- Não inferir EUA pelo DDI `1`: Canadá e outros países compartilham esse código. `_country` pode ficar nulo quando não há contexto suficiente; o telefone completo continua funcionando.

## Arquivos e ordem

1. `20261019115000_add_phone_number_metadata.sql`: funções de validação por país sem ler ou alterar dados de clientes.
2. `international_phone_preflight.sql`: simulação antes da migração, sem alterar dados persistentes. Mostra inválidos, DDD55, conflitos canônicos e todos os gatilhos instalados.
3. `20261019120000_add_international_phone_contract.sql`: helpers, colunas, gatilhos e índices canônicos. Não executa backfill. Se houver conflito nos novos índices, falha atomicamente para revisão, sem excluir destinatários.
4. `20261019121000_use_international_phone_identity.sql`: prefill, fila pública, CRM, UF, recorrência, NPS e reativação usam identidade completa. Preserva autorização e mascaramento dos RPCs existentes.
5. `20261019122000_add_phone_migration_tooling.sql`: relatório por lote e backfill manual, restritos a `service_role`.
6. `international_phone_backfill.sql`: exemplo conservador; o comando de escrita vem comentado e a transação termina em rollback.

## Validação em uma cópia isolada

Restaurar um backup em ambiente sem workers, cron de mensagens, filas externas, eventos Meta ou webhooks ativos. Não usar tokens de integrações reais nos testes. Executar o preflight e salvar o resultado em local com acesso restrito, pois contém telefones.

Revisar os conflitos antes de criar os novos índices. A migração não decide se registros semelhantes representam a mesma pessoa e não apaga mensagens. Os conflitos em destinatários, filas, reativação e CRM impedem os novos índices até serem resolvidos com uma decisão explícita que preserve o histórico. Nenhuma duplicata é fundida automaticamente.

Inventariar todos os gatilhos e webhooks presentes no ambiente. Atualizar apenas colunas aditivas não gera transição de status, e o audit de reservas versionado ignora essas colunas; entretanto, um webhook externo que escute qualquer UPDATE também receberá o backfill. A função **não desabilita gatilhos** e não contorna RLS por meio de configuração global de replicação. Identificar e tratar webhooks externos antes de qualquer lote. Os gatilhos novos usam uma flag local de manutenção e preservam `updated_at`, impedindo que o backfill altere a precedência dos perfis CRM.

Executar localmente:

```powershell
node supabase/tests/run_international_phone_regression.mjs
```

O teste usa PGlite em memória, reaproveita as regressões CRM/recorrência e verifica a aplicação repetida das migrações, BR, DDD55, EUA/Canadá, Portugal, deduplicação por país, prefill, fila pública, NPS, reativação e backfill idempotente com preservação dos dados anteriores. Não conecta ao Supabase remoto.

## Backfill revisado em lotes

Para cada par tabela/campo com chave UUID `id` do preflight, consultar `report_international_phone_migration(table, column, limit, after)`. O limite aceito é de 1 a 10.000; começar com 100 ou 500. Paginar por UUID usando `last_scanned_id`, e não por offset.

O relatório classifica registros como `ready`, `already_set`, `empty` ou `review_required`. Números inválidos ficam intactos para correção posterior. País estrangeiro com DDI explícito continua internacional; país compartilhado desconhecido permanece nulo. Conferir em especial os nacionais com DDD55, pois o normalizador anterior confundia DDD e DDI.

Depois da revisão, executar manualmente `backfill_international_phone_batch(table, column, limit, after)`. A rotina só preenche metadados nulos, confere se o número bruto ainda corresponde à simulação antes do UPDATE e restaura a flag de manutenção ao terminar ou falhar. Repetir o mesmo lote não reescreve registros já migrados. Preserva os campos brutos, `phone_normalized` histórico, IDs, `updated_at`, status, tentativas e chaves de envio.

A tabela `whatsapp_dispatch_guards` usa `delivery_key` como chave primária e permanece com os valores históricos. Seus índices e claims consultam a identidade canônica derivada, sem precisar de backfill. Não chamar a ferramenta de lotes UUID para essa tabela.

O cursor deve avançar mesmo quando houver linhas inválidas; elas continuam no relatório de revisão. Registrar a tabela, o cursor, as contagens de examinados/atualizados/inválidos e o resultado da transação. Conferir totais e amostras antes de seguir para o próximo lote.

## Identidade e histórico

A correção de um nacional DDD55 muda sua identidade derivada de `phone:559...` para `phone:55559...`. `canonical_crm_customer_key` aceita a chave anterior como alias determinístico, inclusive em perfis editados manualmente e chamadas de histórico. Não reescreve reservas, visitas ou `profile_customer_key` em massa.

Os índices de idempotência PlugueChat reconhecem as chaves canônicas de aniversário e campanha junto com as chaves anteriores DDD55. Claims e finalizações Evolution também reconhecem as chaves anteriores de aniversário. Nenhuma chave histórica precisa ser recriada.

Um índice canônico adicional nos dispatches de reativação considera telefone completo, data da última visita e quantidade de dias. Assim, a correção DDD55 não permite um segundo dispatch para o mesmo evento, mantendo as chaves e os status anteriores.

A origem dos eventos de recorrência permanece vinculada aos IDs e `profile_ref` existentes. UF por DDD é calculada somente para um canônico BR com DDI55 e comprimento BR; estrangeiros não recebem uma UF brasileira.

## Critérios de liberação

Comparar antes/depois: totais de reservas, fila, acompanhantes, leads, visitas, filas pendentes/processando e mensagens enviadas. Testar operações públicas e administrativas, edições e colagem de números com `+`, importação/exportação e mensagens em modo simulado. Confirmar destinatário E.164 completo nos adaptadores e ausência de `55` duplicado.

A publicação futura deve preparar banco e todos os consumidores antes de habilitar os novos formulários. Números internacionais já gravados exigem consumidores compatíveis; voltar o frontend antigo depois dessa liberação não é um rollback seguro. Para interromper a expansão, desabilitar os novos fluxos e manter os leitores/adaptadores internacionais. Não remover as colunas ou reverter telefones para formato nacional.


## Integrações e verificações offline

Evolution e PlugueChat recebem dígitos internacionais completos somente no adaptador de envio; filas novas guardam `+E.164`. Filas antigas e logs preservados são lidos com contexto legado BR, sem inferir pelo sufixo. Buscas por variantes precisam confirmar a identidade completa antes de suprimir um envio ou atualizar um destinatário.

Meta mantém a prioridade do snapshot original nos eventos de tracking e aplica DDI antes do hash SHA-256. O gatilho SQL também preserva `+DDI` nas novas capturas. Clientes estrangeiros do Asaas mantêm o telefone completo no sistema; o campo opcional `mobilePhone` é enviado apenas para BR no formato nacional esperado. A aceitação de celulares estrangeiros pelo Asaas deve ser homologada separadamente antes de ampliar esse adaptador.

```powershell
npm test
npm run build
npx vitest run --config supabase/functions/public-tracking/vitest.config.ts
node --test supabase/functions/create-company/index.test.mjs
```

A interface foi verificada em Chrome local: DDI somente no seletor, número nacional no campo, busca por país/DDI, colagem de BR/EUA/Canadá e troca para Portugal. Nenhuma mensagem de teste foi enviada a provedores reais.

## Publicação de 19/10/2026

- Backup das definições SQL, migrações, índices, gatilhos, campos relevantes dos registros e fontes das 18 funções Edge salvo fora do repositório, em área privada local.
- Ensaio transacional na base real com as quatro migrações, criação efetiva dos índices e backfill de amostras por tabela, terminado em `ROLLBACK`: nenhum conflito canônico, nenhum campo original alterado e nenhuma perda de registros no CRM.
- As quatro migrações `20261019115000` a `20261019122000` aplicadas atomicamente e registradas no histórico do Supabase.
- Dez agendamentos de envio/Meta pausados durante a troca das funções, após confirmar ausência de processamento em andamento. Estados originais restaurados após a atualização.
- As 18 funções Edge publicadas e baixadas novamente para comparação de fonte. Todas ativas, com configuração de JWT preservada e preflight HTTP respondendo 200. Nenhum worker foi acionado manualmente para testar mensagens.
- Frontend publicado pelo deployment `dpl_CCMMVn2xaWHm4ACP628WdohNsgL6`. [Domínio principal](https://plugguest.com.br) e [domínio Vercel](https://plugue-reservas.vercel.app) conferidos com HTTP 200 e bundle `/assets/index-Dlq3_pRp.js`.
- Snapshot do frontend com 299 arquivos, sem credenciais, backups ou testes; SHA-256 do manifesto: `6305a3ec405ec232ab973e7ebbb4c8b11fc7fcbc4b6a99a98d7774a4213b92ec`.
- Validação local: 1.019 testes da aplicação, regressão SQL com 735 casos de paridade, testes adicionais de compatibilidade de entrega e build aprovados. O typecheck global possui erros anteriores a esta entrega; a comparação com a base não mostrou novos diagnósticos.

O backfill de produção preenche somente os metadados novos. Cada lote bloqueia suas linhas por uma transação curta e compara um hash de todos os demais campos antes/depois; qualquer alteração inesperada aborta o lote. Valores não validados ficam intactos. Os recibos detalhados permanecem na área privada do backup.

Backfill concluído: **35.243 campos de telefone preenchidos**, em 95 lotes e 14 destinos tabela/campo. Foram examinados 36.690 registros/campos; 1.426 referências legadas permaneceram sem metadados estritos, mantendo a compatibilidade anterior de leitura e entrega. Não se trata de contagem de clientes únicos. Os guards históricos permanecem derivados, conforme o procedimento acima.

A conferência final encontrou **zero registros conversíveis pendentes** nos destinos do backfill, consultas CRM funcionando nas seis empresas e todos os 21 agendamentos com os estados originais. Nenhum campo original mudou nos lotes. Os diagnósticos TypeScript foram comparados novamente: 55 atuais contra 60 na base anterior, sem novos diagnósticos. O teste adicional do worker Evolution também passou (5 casos).
