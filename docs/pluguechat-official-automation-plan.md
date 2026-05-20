# Plano: automacoes WhatsApp Oficial PlugueChat

## Objetivo

Criar uma implementacao nova de automacoes via API oficial do WhatsApp, exposta no produto como **PlugueChat**.

O fluxo atual via Evolution API deve continuar funcionando. A nova implementacao deve ser ativada por empresa e por automacao, permitindo migracao gradual sem quebrar o que ja existe hoje.

## Decisoes de produto

- O nome visivel no painel deve ser **PlugueChat** ou **WhatsApp Oficial PlugueChat**.
- O nome do provedor tecnico usado por baixo nao deve aparecer em telas, mensagens, historico, erros exibidos ao usuario, notificacoes ou textos publicos.
- A configuracao da API oficial deve ser uma feature ativavel por empresa.
- A feature recomendada e `pluguechat_official`.
- `hiddenSession` deve ser sempre `true` no backend. Nao deve existir controle visual para isso.
- Nao deve haver botao de teste no MVP. A validacao operacional deve acontecer ao salvar a configuracao e/ou no primeiro envio real, com registro em log.
- A aba de disparo em massa nao entra no MVP da API oficial. Continua existindo apenas no fluxo atual, se habilitado.
- Templates de pagamento de reserva nao entram neste plano, porque pagamento antecipado ainda nao existe no produto atual.

## Feature flag por empresa

Adicionar uma feature por empresa:

- chave: `pluguechat_official`
- nome visivel: `PlugueChat Oficial`
- descricao sugerida: `Habilita automacoes por templates oficiais do WhatsApp via PlugueChat.`

Comportamento esperado:

- se `pluguechat_official = false`, a tela oficial nao aparece e nenhum envio oficial e processado;
- se `pluguechat_official = true`, a empresa pode configurar token, numero remetente, templates e historico oficial;
- se uma automacao PlugueChat estiver ativa para um tipo, ela tem prioridade sobre o envio atual via Evolution para aquele tipo;
- se nao houver automacao PlugueChat ativa para o tipo, o fluxo atual permanece igual.

Arquivos/funcoes que devem ser ajustados quando implementar:

- `src/lib/companyFeatures.ts`
- `supabase` RPC `get_company_feature_flags`
- `supabase` RPC `company_feature_enabled`
- telas de perfil/empresa que editam `company_feature_overrides`
- navegacao do painel para exibir a tela PlugueChat apenas quando a feature estiver ativa

## Tela no painel

Criar uma tela propria, por exemplo:

- `/:slug/admin/pluguechat`
- ou `/:slug/admin/automacoes-oficial`

Abas do MVP:

### Configuracao

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

Um card por automacao:

- ativo/inativo;
- `templateId`;
- nome do template cadastrado na Meta;
- lista de parametros esperados;
- preview dos valores que o sistema enviara.

O usuario nao edita texto livre nessa tela. O texto real deve ser o template aprovado na Meta.

### Historico

Mesmo conceito do historico atual:

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
- `template_name text not null`
- `parameter_map jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `unique(company_id, type)`

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

## Edge Functions sugeridas

### `pluguechat-api`

Responsavel por:

- salvar configuracao;
- substituir token;
- salvar templates;
- limpar historico/fila quando permitido;
- reenfileirar mensagens, se necessario.

Nao deve retornar o token salvo ao frontend.

### `process-pluguechat-message-queue`

Responsavel por:

- buscar mensagens pendentes;
- montar payload oficial;
- chamar a API oficial;
- salvar `provider_message_id`, status e erro;
- respeitar idempotencia;
- atualizar historico.

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

## Regras de prioridade

Para cada disparo automatico:

1. Verificar se a feature `pluguechat_official` esta ativa para a empresa.
2. Verificar se existe template PlugueChat ativo para o tipo da automacao.
3. Se existir, enfileirar/enviar pelo PlugueChat.
4. Se nao existir, seguir com o fluxo atual via Evolution.
5. Nunca enviar pelos dois canais para o mesmo evento.

A chave de idempotencia deve diferenciar o canal, mas preservar a regra de negocio:

- `pluguechat:reservation:{reservation_id}:{type}`
- `pluguechat:waitlist:{waitlist_id}:{type}`
- `pluguechat:birthday:{company_id}:{date_key}:{phone}`

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
- aniversario.

Ficam fora do MVP:

- disparo em massa oficial;
- mensagens de pagamento;
- templates de cobranca;
- templates de recuperacao de pagamento.

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

Antes de chamar o fluxo atual, verificar `pluguechat_official` e template ativo.

### Jobs agendados

Alterar os jobs:

- `send-reminders`
- `send-post-visit`
- `send-no-show-messages`
- `send-birthday-messages`

Cada job deve enfileirar PlugueChat quando a feature e o template estiverem ativos; caso contrario, manter a fila atual.

## Riscos e mitigacoes

- Envio duplicado: usar guarda de idempotencia por canal e tipo.
- Nome do provedor aparecer para cliente/admin: centralizar textos visiveis como PlugueChat e sanitizar erros.
- Token exposto: token so em Edge Functions/secret, nunca em resposta ao frontend.
- Template sem variavel obrigatoria: validar campos antes de salvar e antes de enviar.
- Template rejeitado pela Meta: historico deve mostrar falha operacional sem revelar provedor tecnico.
- Migracao parcial: prioridade PlugueChat por automacao, fallback para Evolution quando template oficial nao estiver ativo.

## Fases recomendadas

### Fase 1: base e configuracao

- Feature flag `pluguechat_official`.
- Tela com Configuracao, Mensagens e Historico.
- Tabelas oficiais PlugueChat.
- Salvar token e numero remetente.
- Templates configuraveis por automacao.

### Fase 2: envio transacional

- Confirmacao e cancelamento de reserva.
- Entrada e chamada da lista de espera.
- Historico e fila.
- Idempotencia e fallback para Evolution quando nao houver template ativo.

### Fase 3: jobs automaticos

- Lembrete 24h.
- Lembrete 1h.
- Pos-visita.
- No-show.
- Aniversario.

### Fase 4: operacao

- Reprocessamento manual de fila.
- Consulta de status, se a API oficial disponibilizar identificador/status.
- Relatorios simples por tipo/status.
