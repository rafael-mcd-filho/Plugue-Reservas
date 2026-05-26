# Plano: automacoes WhatsApp Oficial PlugueChat

## Objetivo

Criar uma implementacao nova de automacoes via API oficial do WhatsApp, exposta no produto como **PlugueChat**.

O fluxo atual via Evolution API deve continuar funcionando, mas a empresa deve usar apenas um canal ativo de WhatsApp por vez. A nova implementacao deve ser ativada por empresa via feature flag e selecionada como canal ativo antes de processar qualquer envio PlugueChat.

## Decisoes de produto

- O nome visivel no painel deve ser **PlugueChat** ou **WhatsApp Oficial PlugueChat**.
- O nome do provedor tecnico usado por baixo nao deve aparecer em telas, mensagens, historico, erros exibidos ao usuario, notificacoes ou textos publicos.
- O fluxo atual via Evolution deve aparecer no produto como **WhatsApp conectado**.
- A configuracao da API oficial deve ser uma feature ativavel por empresa.
- A feature recomendada e `pluguechat_official`.
- Cada empresa deve ter apenas um canal ativo de WhatsApp por vez: `evolution` ou `pluguechat_official`.
- O canal inativo pode permanecer configurado, mas nao deve enviar mensagens, processar fila ou criar novos disparos.
- Ao trocar o canal ativo, filas e disparos pendentes/agendados do canal anterior devem ser cancelados.
- `hiddenSession` deve ser sempre `true` no backend. Nao deve existir controle visual para isso.
- Nao deve haver botao de teste no MVP. A validacao operacional deve acontecer ao salvar a configuracao e/ou no primeiro envio real, com registro em log.
- Disparos tambem devem existir no PlugueChat, mas usando templates oficiais aprovados. Nao deve existir disparo oficial com texto livre.
- Templates de pagamento de reserva nao entram neste plano, porque pagamento antecipado ainda nao existe no produto atual.

## Feature flag por empresa

Adicionar uma feature por empresa:

- chave: `pluguechat_official`
- nome visivel: `PlugueChat Oficial`
- descricao sugerida: `Habilita automacoes por templates oficiais do WhatsApp via PlugueChat.`

Comportamento esperado:

- se `pluguechat_official = false`, a tela oficial nao aparece e nenhum envio oficial e processado;
- se `pluguechat_official = true`, a empresa pode configurar token, numero remetente, templates e historico oficial;
- a empresa so pode selecionar `pluguechat_official` como canal ativo se a feature estiver habilitada;
- se a feature for desligada para uma empresa que estava em `pluguechat_official`, o sistema deve voltar o canal ativo para `evolution` ou bloquear envios ate decisao operacional explicita.

Arquivos/funcoes que devem ser ajustados quando implementar:

- `src/lib/companyFeatures.ts`
- `supabase` RPC `get_company_feature_flags`
- `supabase` RPC `company_feature_enabled`
- telas de perfil/empresa que editam `company_feature_overrides`
- navegacao/tela de automacoes para exibir opcoes PlugueChat apenas quando a feature estiver ativa

## Canal ativo por empresa

Adicionar uma configuracao global por empresa para definir qual canal envia mensagens:

```sql
whatsapp_automation_channel text not null default 'evolution'
```

Valores permitidos:

- `evolution`: usa o fluxo atual, exibido no painel como **WhatsApp conectado**;
- `pluguechat_official`: usa templates oficiais, exibido como **PlugueChat Oficial**.

Regras:

- empresas existentes devem iniciar com `whatsapp_automation_channel = 'evolution'`;
- o canal ativo deve ser validado no backend em toda acao de configuracao, criacao de disparo e processamento de fila;
- o frontend deve enviar o canal esperado nas acoes sensiveis, mas o backend e a fonte final da verdade;
- se uma aba antiga estiver aberta com outro canal, qualquer acao deve falhar com mensagem sanitizada pedindo para atualizar a pagina;
- trocar de canal nao apaga configuracoes nem historico do canal anterior;
- trocar de canal cancela filas e disparos pendentes/agendados do canal anterior.

Status recomendado para cancelamento:

```text
status = 'cancelled'
cancel_reason = 'channel_changed'
cancelled_at = now()
```

## Tela no painel

Usar a area de automacoes como ponto unico de configuracao. A tela deve deixar claro qual canal esta ativo e renderizar as abas seguintes conforme o canal selecionado.

Rota sugerida:

- manter `/:slug/admin/automacoes`

Abas sugeridas:

- `Canal`
- `Conexao`
- `Mensagens`
- `Disparos`
- `Historico`

### Canal

Primeira aba da tela de automacoes.

Conteudo:

- cards para escolher **WhatsApp conectado** ou **PlugueChat Oficial**;
- status resumido dos dois canais;
- aviso claro de que apenas um canal envia por vez;
- confirmacao antes de trocar o canal ativo.

Texto sugerido:

```text
Apenas um canal envia mensagens por vez. Ao trocar o canal, o outro fica pausado, mas suas configuracoes e historico sao mantidos.
```

Ao confirmar troca de canal:

- salvar o novo `whatsapp_automation_channel`;
- cancelar filas pendentes do canal anterior;
- cancelar disparos pendentes/agendados do canal anterior;
- manter historico e configuracoes.

### Conexao

Quando o canal ativo for `evolution`:

- exibir a conexao atual por QR Code/status da instancia;
- usar os mesmos componentes atuais, mas protegidos pela validacao de canal no backend.

Quando o canal ativo for `pluguechat_official`:

Campos:

- token da API oficial;
- numero remetente (`from`);
- status configurado/nao configurado;
- ultima falha tecnica, com mensagem sanitizada e sem nome do provedor.

Regras:

- o token nunca deve ser mostrado depois de salvo;
- permitir substituir o token;
- o numero remetente deve ser salvo normalizado;
- `hiddenSession` deve ser enviado sempre como `true`, sem opcao na UI.

### Mensagens

Quando o canal ativo for `evolution`:

- exibir os modelos de mensagens livres atuais;
- permitir ativar/desativar automacoes atuais;
- salvar apenas se `whatsapp_automation_channel = 'evolution'`.

Quando o canal ativo for `pluguechat_official`, exibir um card por automacao:

- ativo/inativo;
- campo `Template ID` (o operador fornece o ID ao cliente; o cliente apenas cola aqui);
- campo `Nome do template` (opcional, apenas para referencia interna);
- lista fixa de parametros que o sistema enviara para aquele tipo (somente leitura, informativa).

O usuario nao edita texto livre nem mapeamento de parametros. Os parametros sao fixos por tipo de automacao e definidos no codigo. O texto real e o template aprovado na Meta.

### Disparos

Quando o canal ativo for `evolution`:

- manter o disparo atual com texto livre, se a feature existente permitir.

Quando o canal ativo for `pluguechat_official`:

- permitir disparos via templates oficiais aprovados;
- escolher publico/segmento;
- escolher template;
- preencher ou mapear parametros obrigatorios;
- enviar agora ou agendar;
- nunca permitir texto livre como corpo da mensagem oficial.

Antes de criar qualquer disparo, o backend deve validar o canal ativo. Se o canal ativo mudou em outra aba, a criacao deve ser bloqueada.

### Historico

Quando o canal ativo for `evolution`, exibir o historico atual.

Quando o canal ativo for `pluguechat_official`, exibir historico oficial com:

- data/hora;
- tipo da automacao;
- telefone;
- template usado;
- status;
- erro sanitizado;
- resposta tecnica armazenada para suporte, sem expor nome do provedor na interface.

## Modelo de dados sugerido

### `pluguechat_official_configs`

- `id uuid primary key`
- `company_id uuid not null unique`
- `enabled boolean not null default true`
- `from_number text not null`
- `api_token_secret_ref text`
- `status text not null default 'configured'`
- `last_success_at timestamptz`
- `last_error text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

O token nao deve ficar acessivel pelo frontend. A estrategia recomendada e guardar o segredo em ambiente/secret seguro ou salvar referencia criptografada que so Edge Functions consigam usar.

### `pluguechat_automation_templates`

- `id uuid primary key`
- `company_id uuid not null`
- `type text not null`
- `enabled boolean not null default false`
- `template_id text not null`
- `template_name text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `unique(company_id, type)`

Observacao: o campo `parameter_map` foi removido. Os parametros de cada tipo de automacao sao fixos no codigo (ver secao "Mapeamento de dados"). A empresa informa apenas o `template_id` fornecido pelo operador. Todos os templates cadastrados para um mesmo tipo devem usar exatamente os mesmos nomes de parametro padrao.

### `pluguechat_message_queue`

- `id uuid primary key`
- `company_id uuid not null`
- `reservation_id uuid`
- `waitlist_id uuid`
- `phone text not null`
- `type text not null`
- `template_id text not null`
- `template_name text`
- `parameters jsonb not null default '{}'::jsonb`
- `status text not null default 'pending'`
- `attempts integer not null default 0`
- `max_attempts integer not null default 3`
- `scheduled_for timestamptz not null default now()`
- `expires_at timestamptz not null default now() + interval '2 hours'`
- `last_attempt_at timestamptz`
- `provider_message_id text`
- `error_details text`
- `cancel_reason text`
- `cancelled_at timestamptz`
- `created_at timestamptz not null default now()`

### `pluguechat_message_logs`

- `id uuid primary key`
- `company_id uuid not null`
- `reservation_id uuid`
- `waitlist_id uuid`
- `phone text not null`
- `type text not null`
- `template_id text not null`
- `template_name text`
- `parameters jsonb not null default '{}'::jsonb`
- `status text not null`
- `provider_message_id text`
- `provider_status text`
- `error_details text`
- `created_at timestamptz not null default now()`

### `pluguechat_broadcasts`

- `id uuid primary key`
- `company_id uuid not null`
- `template_id text not null`
- `template_name text`
- `parameter_map jsonb not null default '{}'::jsonb`
- `audience_filter jsonb not null default '{}'::jsonb`
- `status text not null default 'draft'`
- `scheduled_for timestamptz`
- `started_at timestamptz`
- `finished_at timestamptz`
- `cancel_reason text`
- `cancelled_at timestamptz`
- `created_by uuid`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Status sugeridos:

- `draft`
- `scheduled`
- `processing`
- `completed`
- `cancelled`
- `failed`

### `pluguechat_broadcast_recipients`

- `id uuid primary key`
- `broadcast_id uuid not null`
- `company_id uuid not null`
- `customer_id uuid`
- `lead_id uuid`
- `phone text not null`
- `parameters jsonb not null default '{}'::jsonb`
- `queue_id uuid`
- `status text not null default 'pending'`
- `provider_message_id text`
- `error_details text`
- `created_at timestamptz not null default now()`

Observacao: ao trocar de canal, disparos PlugueChat pendentes/agendados devem ser marcados como `cancelled`, e seus recipients pendentes tambem devem ser cancelados. O mesmo principio deve ser aplicado nas tabelas atuais de disparo/fila do WhatsApp conectado.

## Edge Functions sugeridas

### `pluguechat-api`

Responsavel por:

- salvar configuracao;
- substituir token;
- salvar templates;
- criar/editar disparos PlugueChat;
- limpar historico/fila quando permitido;
- reenfileirar mensagens, se necessario.

Nao deve retornar o token salvo ao frontend. Toda acao deve validar que `whatsapp_automation_channel = 'pluguechat_official'`, exceto salvar configuracao preparatoria quando a feature esta habilitada e o canal ainda nao foi trocado.

### `whatsapp-automation-channel`

Responsavel por:

- ler o canal ativo;
- trocar o canal ativo;
- validar se `pluguechat_official` esta habilitado antes de permitir a troca para PlugueChat;
- cancelar filas e disparos pendentes/agendados do canal anterior;
- registrar auditoria da troca.

Esta funcao deve ser o unico caminho de troca de canal pelo frontend.

### `process-pluguechat-message-queue`

Responsavel por:

- buscar mensagens pendentes;
- montar payload oficial;
- chamar a API oficial;
- salvar `provider_message_id`, status e erro;
- respeitar idempotencia;
- atualizar historico;
- antes de enviar cada mensagem, validar que `whatsapp_automation_channel = 'pluguechat_official'`.

### `process-pluguechat-broadcasts`

Responsavel por:

- buscar disparos PlugueChat agendados/pendentes;
- expandir destinatarios;
- criar itens em `pluguechat_message_queue`;
- respeitar limite operacional/cadencia;
- antes de criar ou processar recipients, validar que `whatsapp_automation_channel = 'pluguechat_official'`.

### `_shared/pluguechat.ts`

Helper interno para:

- normalizar telefone;
- montar parametros;
- chamar o endpoint de envio;
- interpretar erro;
- sanitizar erro para UI;
- manter `hiddenSession: true` sempre fixo.

Payload interno esperado:

```json
{
  "from": "5585999999999",
  "to": "5585888888888",
  "body": {
    "parameters": {
      "nome": "Joao",
      "Reserva": "18/05/2026 as 20:00"
    },
    "templateId": "template_id"
  },
  "options": {
    "hiddenSession": true
  }
}
```

## Regras de canal ativo e envio

Nao existe prioridade por automacao nem fallback automatico entre canais. A empresa usa um unico canal ativo.

Para cada envio automatico:

1. Buscar `whatsapp_automation_channel` da empresa.
2. Se o canal ativo for `evolution`, processar apenas pelo fluxo atual do WhatsApp conectado.
3. Se o canal ativo for `pluguechat_official`, processar apenas pelo PlugueChat.
4. Se o canal ativo for `pluguechat_official` e nao houver template ativo para o tipo, nao enviar pelo Evolution. Registrar falha operacional ou ignorar conforme regra do evento.
5. Nunca enviar pelos dois canais para o mesmo evento.

Para cada acao manual:

1. O frontend envia `expected_channel`.
2. O backend busca o canal atual da empresa.
3. Se `expected_channel` for diferente do canal atual, bloquear a acao.
4. Retornar erro sanitizado orientando atualizar a pagina.

A chave de idempotencia deve diferenciar o canal, mas preservar a regra de negocio:

- `evolution:reservation:{reservation_id}:{type}`
- `evolution:waitlist:{waitlist_id}:{type}`
- `evolution:birthday:{company_id}:{date_key}:{phone}`
- `pluguechat:reservation:{reservation_id}:{type}`
- `pluguechat:waitlist:{waitlist_id}:{type}`
- `pluguechat:birthday:{company_id}:{date_key}:{phone}`

Ao trocar de canal:

- nao apagar configuracoes;
- nao apagar historico;
- cancelar filas pendentes/agendadas do canal anterior;
- cancelar disparos pendentes/agendados do canal anterior;
- o processador de fila deve validar o canal ativo antes de cada envio, cobrindo tambem o caso de jobs ja iniciados.

## Automacoes do MVP

Entram no MVP:

- confirmacao de reserva;
- cancelamento de reserva;
- lembrete 24h;
- lembrete 1h;
- entrada na lista de espera;
- chamada da lista de espera;
- pos-visita;
- no-show;
- aniversario;
- disparos via templates oficiais aprovados.

Ficam fora do MVP:

- mensagens de pagamento;
- templates de cobranca;
- templates de recuperacao de pagamento.

Observacao sobre disparos oficiais:

- o disparo PlugueChat deve usar apenas templates oficiais;
- o usuario escolhe template e publico;
- parametros obrigatorios devem ser preenchidos/mapeados antes de agendar/enviar;
- se a empresa trocar de canal, disparos oficiais pendentes/agendados devem ser cancelados.

## Templates para submeter na Meta

Os nomes abaixo sao sugestoes tecnicas para cadastro. Usar nomes sem acento, em minusculo e com `_`.

No PlugueChat, salvar o `templateId` retornado/cadastrado e mapear os parametros exatamente como o template oficial esperar. Nomes de parametros sao sensiveis a maiusculas/minusculas quando o provedor os exigir.

### `reserva_confirmada`

Categoria sugerida: `Utility`

Texto:

```text
Ola, {{1}}. Sua reserva para {{2}} pessoa(s) no dia {{3}} as {{4}} esta confirmada.

Acompanhe sua reserva por aqui:
{{5}}
```

Parametros PlugueChat:

- `nome`
- `pessoas`
- `data`
- `hora`
- `link_acompanhamento`

### `reserva_cancelada`

Categoria sugerida: `Utility`

Texto:

```text
Ola, {{1}}. Sua reserva do dia {{2}} as {{3}} foi cancelada.

Se precisar, voce pode acompanhar os detalhes por aqui:
{{4}}
```

Parametros PlugueChat:

- `nome`
- `data`
- `hora`
- `link_acompanhamento`

### `lembrete_reserva_24h`

Categoria sugerida: `Utility`

Texto:

```text
Ola, {{1}}. Lembrete da sua reserva amanha, dia {{2}}, as {{3}}, para {{4}} pessoa(s).
```

Parametros PlugueChat:

- `nome`
- `data`
- `hora`
- `pessoas`

### `lembrete_reserva_1h`

Categoria sugerida: `Utility`

Texto:

```text
Ola, {{1}}. Lembrete da sua reserva hoje as {{2}}, para {{3}} pessoa(s).
```

Parametros PlugueChat:

- `nome`
- `hora`
- `pessoas`

### `fila_entrada`

Categoria sugerida: `Utility`

Texto:

```text
Ola, {{1}}. Voce entrou na lista de espera para {{2}} pessoa(s).

Sua posicao atual e {{3}}.

Acompanhe por aqui:
{{4}}
```

Parametros PlugueChat:

- `nome`
- `pessoas`
- `posicao`
- `link_acompanhamento`

### `fila_chamada`

Categoria sugerida: `Utility`

Texto:

```text
{{1}}, sua mesa esta pronta. Dirija-se a recepcao.

Voce tem {{2}} minutos para se apresentar.
```

Parametros PlugueChat:

- `nome`
- `tempo_limite_minutos`

### `pos_visita_agradecimento`

Categoria sugerida: `Marketing`

Texto:

```text
Ola, {{1}}. Obrigado pela visita no dia {{2}}. Esperamos que tenha tido uma boa experiencia.
```

Parametros PlugueChat:

- `nome`
- `data`

### `reserva_no_show`

Categoria sugerida: `Utility`

Texto:

```text
Ola, {{1}}. Identificamos que voce tinha uma reserva no dia {{2}} as {{3}} e nao compareceu.

Se houve algum imprevisto, tudo bem. O registro da reserva foi atualizado.
```

Parametros PlugueChat:

- `nome`
- `data`
- `hora`

### `aniversario_cliente`

Categoria sugerida: `Marketing`

Texto:

```text
Ola, {{1}}. Seu aniversario esta chegando em {{2}} dia(s).

Quando quiser comemorar conosco, sera um prazer receber voce.
```

Parametros PlugueChat:

- `nome`
- `dias_para_aniversario`

## Mapeamento de dados

Valores padrao:

- `nome`: `guest_name`, nome do acompanhante ou nome do lead;
- `pessoas`: `party_size`;
- `data`: data formatada como `dd/MM/yyyy`;
- `hora`: horario formatado como `HH:mm`;
- `link_acompanhamento`: URL publica da reserva ou fila;
- `posicao`: posicao atual na lista de espera;
- `tempo_limite_minutos`: `5`;
- `dias_para_aniversario`: `4`.

## Pontos de implementacao

### Eventos imediatos

Alterar `reservation-events` para:

- reserva criada;
- reserva cancelada;
- entrada na fila;
- chamada da fila.

Antes de qualquer envio, verificar o canal ativo:

- se `whatsapp_automation_channel = 'evolution'`, seguir com o fluxo atual;
- se `whatsapp_automation_channel = 'pluguechat_official'`, enfileirar PlugueChat apenas se houver template ativo para o tipo;
- se nao houver template PlugueChat ativo, nao fazer fallback para Evolution.

### Jobs agendados

Alterar os jobs:

- `send-reminders`
- `send-post-visit`
- `send-no-show-messages`
- `send-birthday-messages`

Cada job deve verificar o canal ativo da empresa:

- canal `evolution`: manter a fila atual;
- canal `pluguechat_official`: enfileirar PlugueChat quando houver template ativo;
- canal `pluguechat_official` sem template ativo: nao enfileirar no Evolution.

### Troca de canal

Implementar fluxo atomico para trocar o canal:

1. Validar permissao do usuario.
2. Validar feature `pluguechat_official` quando o destino for PlugueChat.
3. Atualizar `whatsapp_automation_channel`.
4. Cancelar filas pendentes/agendadas do canal anterior.
5. Cancelar disparos pendentes/agendados do canal anterior.
6. Registrar auditoria.
7. Invalidar caches/queries no frontend.

### Abas antigas abertas

Todas as acoes sensiveis devem receber `expected_channel` e validar no backend:

- salvar automacao;
- conectar/desconectar WhatsApp conectado;
- salvar configuracao PlugueChat;
- criar/agendar disparo;
- reprocessar fila;
- reenviar mensagem.

## Riscos e mitigacoes

- Envio duplicado: usar guarda de idempotencia por canal e tipo.
- Nome do provedor aparecer para cliente/admin: centralizar textos visiveis como PlugueChat e sanitizar erros.
- Token exposto: token so em Edge Functions/secret, nunca em resposta ao frontend.
- Template sem variavel obrigatoria: validar campos antes de salvar e antes de enviar.
- Template com parametros divergentes do padrao: o operador e responsavel por garantir que os templates cadastrados na Meta usam exatamente os nomes de parametro padrao de cada tipo. Divergencia causara envio com variavel vazia ou mensagem rejeitada.
- Template rejeitado pela Meta: historico deve mostrar falha operacional sem revelar provedor tecnico.
- Canal antigo continuar rodando escondido: backend deve validar `whatsapp_automation_channel` antes de toda acao e antes de cada envio.
- Fila acumulada do canal anterior: troca de canal deve cancelar filas e disparos pendentes/agendados do canal anterior.
- Duas abas abertas com estados diferentes: acoes devem enviar `expected_channel` e o backend deve bloquear se o canal ativo mudou.
- Feature PlugueChat desligada com canal PlugueChat ativo: bloquear envios oficiais e acionar correcao operacional para voltar a `evolution`.
- Disparo oficial com texto livre: nao permitir texto livre no PlugueChat; usar apenas templates oficiais aprovados.

## Fases recomendadas

### Fase 1: base e configuracao

- Feature flag `pluguechat_official`.
- Campo/camada de canal ativo `whatsapp_automation_channel`.
- Tela de automacoes com abas Canal, Conexao, Mensagens, Disparos e Historico.
- Tabelas oficiais PlugueChat.
- Salvar token e numero remetente.
- Templates configuraveis por automacao.
- Troca de canal com cancelamento de filas/disparos pendentes do canal anterior.

### Fase 2: envio transacional

- Confirmacao e cancelamento de reserva.
- Entrada e chamada da lista de espera.
- Historico e fila.
- Idempotencia por canal.
- Sem fallback para Evolution quando o canal ativo for PlugueChat.

### Fase 3: disparos PlugueChat

- Criacao de disparo oficial por template.
- Segmentacao/publico.
- Agendamento.
- Cancelamento ao trocar canal.
- Historico e status por destinatario.

### Fase 4: jobs automaticos

- Lembrete 24h.
- Lembrete 1h.
- Pos-visita.
- No-show.
- Aniversario.

### Fase 5: operacao

- Reprocessamento manual de fila.
- Consulta de status, se a API oficial disponibilizar identificador/status.
- Relatorios simples por tipo/status.
