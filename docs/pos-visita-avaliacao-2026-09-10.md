# Pós-visita: avaliação por canal — 10/09/2026

## Escopo e publicação

Pacote autorizado para publicação por migration + Edge no Supabase, seguido de commit/push em `main` para o deploy automático na Vercel. Não inclui os pacotes descartados de otimização, reservas/Meta nem o plano Flutter.

Status no fechamento deste documento: migration aplicada e confirmada no histórico remoto; Edge `send-post-visit` publicada e ativa na versão 35, com autenticação interna preservada. Frontend seguirá neste commit/push para deploy automático na Vercel; o estado Ready e o domínio precisam ser conferidos após o push.

## Como funciona

- O liga/desliga permanece na tela **Avaliações**, em `company_nps_configs.enabled`. Avaliações e as duas telas de automação compartilham a consulta e sua invalidação.
- Com avaliações ativas, `link_avaliacao` aparece nas variáveis disponíveis dos dois canais. Com avaliações desligadas, carregando ou com erro, não aparece como disponível. Nenhum texto, ID ou formato salvo é apagado automaticamente.
- API não oficial/Evolution: a variável recebe o link completo. Sem a variável no texto, não se acrescenta convite ou link.
- PlugueChat configurado como **Não — somente nome e data**: envia só esses dois parâmetros, independentemente da ativação das avaliações.
- PlugueChat configurado como **Sim — inclui o código da avaliação**: envia nome, data e apenas o token após `/avaliacao/`. O endereço completo até essa parte, incluindo o slug da empresa, deve estar no template aprovado.
- A escolha Sim/Não descreve o formato do template; não ativa avaliações. É necessário conferir o ID e as variáveis aprovadas antes de salvar. O sistema não consulta ou troca templates externos.
- No contrato novo, mensagens que precisam de avaliação só são enfileiradas se a coleta estiver ativa e existir link/token válido. Falta de configuração ou falha na consulta é sinalizada; não se envia um campo obrigatório vazio. Mensagens sem avaliação continuam.
- A consulta de ativação é feita uma vez por lote, não por destinatário.

## Compatibilidade que permite o rollout

A primeira versão do pacote faria João Pessoa parar de enfileirar pós-visitas: template ativo, avaliações desligadas e formato antigo ainda nulo. Também mudaria Recife de URL completa para token sem confirmar o template externo. **Essa regressão foi removida antes da publicação.**

Templates existentes com `post_visit_include_review_link = NULL` (ou coluna ausente) mantêm o caminho anterior até escolher e salvar explicitamente Sim/Não:

- mesmo builder já utilizado em produção;
- três parâmetros, com URL completa ou valor vazio como antes;
- sem aplicar a nova trava de ativação NPS ao envio legado;
- mesmo comportamento anterior de marcação de `sent_at`;
- sem ativar avaliações, alterar IDs, escolher formatos ou reescrever dados das empresas.

Isso preserva os envios atuais, mas **não corrige automaticamente o conteúdo de templates antigos**. Para receber apenas o token no PlugueChat, é preciso revisar o template com prefixo fixo e salvar Sim. O aviso da interface explica essa transição. Após adotar o contrato novo, as regras de ativação passam a valer para ele.

A skill de frontend foi usada somente para manter os avisos coerentes com essa transição, dentro do layout existente.

## Limites preservados

- Reservas, disponibilidade, check-in, chamada da fila, pagamentos e eventos Meta não têm regras alteradas.
- Cron, janela das 08h, workers, prioridade, expiração e política de retry não foram modificados.
- Mensagens já enfileiradas não são alteradas, apagadas ou reenviadas. Desativar avaliações não cancela mensagens que já estão na fila.
- Mensagens puladas no contrato novo não ganham uma fila retroativa de recuperação.
- No contrato novo, `reservation_reviews.sent_at` só é marcado se a avaliação estiver efetivamente incluída no novo enfileiramento. Continua significando enfileiramento, não comprovação de entrega. Não há correção retroativa do histórico.
- Diagnósticos agregados, sem dados de clientes: `skipped_missing_review`, `skipped_review_disabled`, `skipped_review_config_unavailable`, `review_config_unavailable`, `legacy_templates_preserved`. O último conta mensagens avaliadas pelo ramo legado, não é contador de entregas.

## Validação

- 638 testes aprovados em 71 arquivos; 135 específicos de pós-visita/ativação/migration.
- Matriz de modo nulo/coluna ausente, Sim/Não, NPS ativo/inativo/ausente/erro, URL/token ausentes, preservação de configurações, lotes mistos, idempotência e autorização.
- Migration executada duas vezes em PostgreSQL local/PGlite, sem mudança de reservas, registros existentes ou RLS.
- Regressão SQL do hotfix original de reserva/Meta aprovada.
- Build Vite aprovado em diretório temporário com configuração sintética. Esse artefato **não** será publicado; a Vercel construirá o commit com seu ambiente de produção.
- Checagem TypeScript anterior registrou 65 erros preexistentes e nenhum novo diagnóstico; a checagem global não é limpa.
- Nenhuma mensagem de teste enviada a clientes.

## Alvos e ordem de publicação

1. Supabase `Reservas`, projeto `hdpxqqiudiotanrybvcf`: aplicada somente `20260910120000_configure_pluguechat_post_visit_review.sql`, com `--skip-vault`. Coluna booleana nullable, sem default/backfill, sem apagar dados; estado conferido no schema e no histórico. O dry-run confirmou somente essa migration, sem seeds/roles. Espera por lock limitada a 3 segundos e statement a 30 segundos somente na sessão da migration, com reset ao final; teste PGlite repetido com esses limites e aprovado.
2. Republicar somente `send-post-visit` com o helper novo. Manter `verify_jwt=false` e a autenticação interna existente. O helper compartilhado `pluguechat.ts` voltou integralmente ao HEAD, evitando mudanças em outras funções.
3. Commit e push dos arquivos deste pacote para `origin/main`. A Vercel confirmou integração GitHub com `rafael-mcd-filho/Plugue-Reservas`, projeto `plugue-reservas` e production branch `main`.
4. Acompanhar o deploy desse commit até Ready e conferir `https://plugguest.com.br`. Não fazer deploy manual paralelo.
5. Conferir schema, estado da Edge e autenticação sem disparar lote para clientes. Formatos dos templates permanecem nulos até revisão explícita na interface.

Antes da publicação, João Pessoa e Recife tinham pós-visita ativo; Goiânia, inativo. Os três formatos estavam nulos. Não havia mensagens de pós-visita pendentes/em processamento nos estados consultados — fotografia da consulta, não garantia permanente.

Após aplicar a migration e publicar a Edge, nova consulta confirmou que os três formatos continuaram nulos e que as ativações de pós-visita e avaliações foram preservadas.

## Referências de reversão

- Produção frontend anterior: `dpl_9sgrBiqQyieN9fPCWq7DhuQ1DoMp`, commit `bf8a8f5c63e732501320a96998cc7bb2bd567fc4`.
- Edge anterior: `send-post-visit` versão 34; fonte baixada antes da publicação para `C:/Users/adami/AppData/Local/Temp/plugue-post-visit-production-before-cfa729bd4af8487bbdf5b48aeb768ec2`.
- Em caso de falha, não apagar coluna/dados. Avaliar a reversão da aplicação/Edge separadamente, considerando se algum template já adotou Sim/Não. A versão anterior ignora essa escolha, portanto uma reversão da Edge após mudança de formato exige revisão.
