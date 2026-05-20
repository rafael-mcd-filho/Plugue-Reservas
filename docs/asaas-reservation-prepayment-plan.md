# Plano futuro: pagamento antecipado de reservas com Asaas

## Objetivo

Criar um módulo opcional de pagamento antecipado para datas/eventos especiais, como Dia dos Namorados, Dia das Mães, Réveillon ou menus fechados. A reserva só deve ser confirmada após pagamento aprovado. Enquanto o pagamento estiver pendente, a mesa fica bloqueada temporariamente; se o prazo expirar, o link/cobrança pendente deve ser removido no Asaas e a mesa liberada.

Este documento é um plano de produto e engenharia. Não representa implementação já ativada em produção.

## Decisão de produto recomendada

Criar uma área própria no painel da empresa chamada **Pagamentos Antecipados**.

### Decisões fechadas

- A conta Asaas será por empresa, usando sempre a conta real da empresa: cada empresa cadastra o próprio token.
- A regra do MVP vale para o dia inteiro, sem filtro por horário.
- O valor pago será tratado como **sinal abatido da conta**, não como taxa de reserva.
- O MVP usa Pix e cartão via **link de pagamento do Asaas**. Nossa página mostra as opções finais e redireciona para o link do método escolhido.
- Não coletamos CPF/CNPJ nem dados de cartão no nosso frontend. Esses dados ficam no checkout do Asaas, quando o Asaas exigir.
- O prazo padrão de pagamento será de `10` minutos. Esse prazo é local do nosso sistema; ao expirar, consultamos o Asaas e removemos o link pendente via API.
- A automação atual de confirmação de reserva só deve ser disparada quando o pagamento for aprovado e a reserva virar `confirmed`.
- Não é necessária uma nova mensagem de WhatsApp para confirmação de pagamento no MVP.
- O mapa de mesas continua sendo resolvido pela regra atual: a pré-reserva usa o `table_id` e `table_map_id` do mapa ativo para a data/hora escolhida.
- A implementação deve começar pelo front e contratos visuais; migrations e Edge Functions devem entrar depois, preferencialmente fora do horário comercial.
- Regras não devem ter edição livre no MVP: para alterar valor, período ou prazo, a empresa deve desativar a regra atual e criar uma nova.
- Regra nunca usada pode ser excluída. Regra já usada em reserva/pagamento deve ser apenas arquivada, preservando histórico.
- Regras novas devem poder ser criadas a partir de uma cópia de uma regra existente, sem editar a regra original.
- Regras ativadas para um período com reservas já existentes não são retroativas: reservas antigas continuam no fluxo em que foram criadas.
- Depois de pagar, o cliente não poderá alterar data, horário ou pessoas sozinho; qualquer alteração será tratada via suporte/operação da empresa.
- Estornos não serão feitos pelo painel no MVP. A empresa fará estornos diretamente no Asaas.
- Não haverá split ou repasse automático no MVP.
- O contrato do MVP fica fechado em: Pix + cartão por `paymentLinks`, prazo padrão de `10` minutos, sem edição de regra usada, sem estorno no painel e sem split.
- O evento de conversão/tráfego deve ser disparado quando a pré-reserva for criada, mesmo que o pagamento ainda esteja pendente. Pagamento aprovado ou expirado não deve duplicar nem desfazer o evento de conversão.

Essa aba deve permitir configurar regras como:

- nome da regra: `Dia dos Namorados`, `Réveillon`, `Menu especial`;
- data única ou intervalo de datas;
- valor do sinal, fixo por reserva ou por pessoa;
- valor cobrado no Pix;
- valor cobrado no cartão;
- parcelamento máximo do cartão, por exemplo `1x` ou `2x`;
- prazo de pagamento em minutos, com padrão de `10`;
- métodos aceitos: Pix, cartão ou ambos;
- texto exibido ao cliente antes de confirmar;
- política de expiração/cancelamento.

Para o cliente, a comunicação deve mostrar opções finais de pagamento sem explicar diferença de taxa/juros:

- **Sinal da reserva:** `R$ 100,00`
- **Pix:** `R$ 100,00`
- **Cartão:** `R$ 110,00 em até 2x`

Internamente, o sistema deve manter separado o valor do sinal abatido da conta e o valor efetivamente cobrado em cada método.

## Experiência do cliente

Fluxo público recomendado:

1. Cliente escolhe data, pessoas, horário e preenche dados.
2. Ao clicar em confirmar, o sistema verifica se existe regra de pagamento para aquela data.
3. Se não houver regra, segue o fluxo atual.
4. Se houver regra:
   - cria reserva como `pending_payment`;
   - bloqueia a mesa por tempo limitado;
   - cria pagamento local com token público, snapshot da regra e opções Pix/cartão;
   - dispara o evento normal de conversão/tráfego da reserva criada;
   - leva o cliente para uma página pública persistente de pagamento.
5. Na página de pagamento, o cliente escolhe Pix ou cartão:
   - o backend cria um link de pagamento Asaas específico para o método escolhido;
   - para Pix, cria link com `billingType: "PIX"`;
   - para cartão, cria link com `billingType: "CREDIT_CARD"` e parcelamento máximo quando configurado;
   - salva `asaas_payment_link_id`, URL do link e referência externa;
   - redireciona o cliente para o checkout do Asaas;
   - mantém apenas um link ativo por pré-reserva.

Evitar depender apenas do modal. A tela de pagamento deve ter uma URL própria, por exemplo:

- `/reserva/:tracking_code/pagamento`
- ou `/pagamento/:payment_token`

Motivo: se o cliente recarregar a página, fechar o navegador, trocar de dispositivo ou voltar pelo WhatsApp, ele precisa conseguir retomar o pagamento sem perder o estado.

## Página pública de pagamento

A página deve buscar os dados no banco e renderizar conforme o status:

- `awaiting_method`: mostra sinal da reserva, opções Pix/cartão, valor final por método e contador de expiração.
- `pending`: mostra método escolhido, valor cobrado, resumo da reserva, contador de expiração, botão para abrir o link Asaas enquanto estiver válido e botão "Já paguei".
- `paid`: mostra reserva confirmada.
- `expired`: mostra que a pré-reserva expirou e oferece iniciar nova reserva.
- `cancelled`: mostra que o pagamento/reserva foi cancelado.
- `paid_after_expiration`: mostra mensagem de análise manual, se necessário.

Para Pix e cartão, o checkout acontece no link do Asaas. A nossa página não mostra QR Code Pix nem coleta dados de cartão no MVP.

## Estados de reserva

Adicionar estados novos ou equivalentes:

- `pending_payment`: reserva criada, mesa temporariamente bloqueada, pagamento pendente.
- `payment_expired`: pagamento expirou e mesa foi liberada.
- `payment_cancelled`: pagamento/link cancelado antes da confirmação.
- `confirmed`: reserva confirmada após pagamento aprovado.
- `paid_after_expiration`: pagamento detectado depois do prazo, exigindo validação operacional.

Ponto crítico: disponibilidade de mesas deve tratar `pending_payment` como ocupação apenas enquanto `expires_at` ainda não passou.

## Estados de pagamento

Tabela local deve controlar status independente do Asaas:

- `awaiting_method`: pré-reserva criada, cliente ainda não escolheu Pix ou cartão.
- `pending`: link Asaas criado, aguardando pagamento.
- `paid`: pagamento aprovado/recebido e reserva confirmada.
- `expired`: prazo local expirado.
- `cancelled`: link/cobrança cancelado antes da confirmação.
- `failed`: erro ao criar, consultar ou cancelar link/cobrança.
- `late_paid`: pagamento detectado após expiração local.
- `refunded`: pagamento estornado, se isso entrar em uma fase futura.

## Modelo de dados sugerido

### `company_asaas_configs`

Campos sugeridos:

- `company_id uuid primary key`
- `provider text not null default 'asaas'`
- `api_token text not null`
- `webhook_auth_token text not null`
- `status text not null`
- `last_validated_at timestamptz`
- `last_error text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

O token deve ficar acessível apenas via service role/Edge Function. O frontend nunca deve ler esse valor diretamente.

### `reservation_payment_rules`

Campos sugeridos:

- `id uuid primary key`
- `company_id uuid not null`
- `name text not null`
- `enabled boolean not null default true`
- `date_start date not null`
- `date_end date not null`
- `amount_type text not null` (`fixed_per_reservation`, `per_person`)
- `base_amount numeric(10,2) not null`
- `pix_enabled boolean not null default true`
- `pix_amount numeric(10,2)`
- `credit_card_enabled boolean not null default false`
- `credit_card_amount numeric(10,2)`
- `max_credit_card_installments integer`
- `payment_deadline_minutes integer not null default 10`
- `customer_notice text`
- `cancellation_policy text`
- `created_by uuid`
- `activated_at timestamptz`
- `archived_at timestamptz`
- `archived_by uuid`
- `archived_reason text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Índices:

- `(company_id, enabled, date_start, date_end)`

### `reservation_payments`

Campos sugeridos:

- `id uuid primary key`
- `company_id uuid not null`
- `reservation_id uuid not null`
- `rule_id uuid`
- `rule_snapshot jsonb`
- `provider text not null default 'asaas'`
- `asaas_payment_link_id text`
- `asaas_payment_id text`
- `payment_token text unique not null`
- `billing_type text` (`PIX`, `CREDIT_CARD`, nulo enquanto estiver `awaiting_method`)
- `base_amount numeric(10,2) not null`
- `charged_amount numeric(10,2)` (nulo enquanto estiver `awaiting_method`)
- `max_installments integer`
- `status text not null`
- `asaas_status text`
- `payment_link_url text`
- `payment_link_external_reference text`
- `payment_link_deleted_at timestamptz`
- `selected_at timestamptz`
- `expires_at timestamptz not null`
- `paid_at timestamptz`
- `cancelled_at timestamptz`
- `last_checked_at timestamptz`
- `error_details text`
- `metadata jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Índices:

- `(company_id, status, expires_at)`
- `(reservation_id)`
- `(payment_token)`
- `(asaas_payment_link_id)`
- `(asaas_payment_id)`

Observação: `asaas_payment_id` só aparece depois que o Asaas gerar uma cobrança a partir do link e enviar webhook. O vínculo inicial do nosso fluxo é `asaas_payment_link_id`.

### `asaas_webhook_events`

Tabela para idempotência e auditoria:

- `id uuid primary key`
- `company_id uuid`
- `event_id text unique`
- `event_type text not null`
- `asaas_payment_link_id text`
- `asaas_payment_id text`
- `reservation_payment_id uuid`
- `payload jsonb not null`
- `processed_at timestamptz`
- `processing_status text`
- `error_details text`
- `created_at timestamptz not null default now()`

## Edge Functions sugeridas

### `create-reservation-payment`

Responsável por:

- validar reserva e regra aplicável;
- criar reserva como `pending_payment`;
- reservar mesa temporariamente;
- criar pagamento local como `awaiting_method`, com `payment_token`, `rule_snapshot`, `base_amount`, valores por método e prazo de expiração;
- disparar o evento normal de conversão/tráfego da reserva criada;
- retornar `payment_token` ou URL pública de pagamento.

Não expor token do Asaas no frontend.

### `select-reservation-payment-method`

Responsável por:

- receber `payment_token` e método escolhido (`PIX` ou `CREDIT_CARD`);
- validar se o pagamento ainda está dentro do prazo local;
- validar se o método está habilitado na regra/snapshot;
- garantir idempotência para não criar dois links ativos para a mesma pré-reserva;
- criar link de pagamento Asaas conforme método escolhido;
- preencher título, descrição e `externalReference` para facilitar busca no painel/API do Asaas;
- atualizar pagamento local para `pending`, com `billing_type`, `charged_amount`, `max_installments`, `asaas_payment_link_id`, `payment_link_url` e `payment_link_external_reference`;
- retornar os dados necessários para a página pública abrir ou redirecionar para o link Asaas.

### `get-reservation-payment`

Responsável por:

- receber `payment_token` ou `tracking_code`;
- retornar status público do pagamento;
- retornar opções Pix/cartão quando status for `awaiting_method`;
- retornar URL do link Asaas quando status for `pending`;
- nunca retornar segredos internos.

### `check-reservation-payment`

Responsável pelo botão "Já paguei" e polling manual:

- se o pagamento ainda estiver `awaiting_method`, retornar que o cliente precisa escolher Pix ou cartão;
- se o link estiver criado mas ainda não houver `asaas_payment_id`, consultar o link e informar que ainda aguardamos webhook/geração da cobrança;
- se já houver `asaas_payment_id`, consultar `GET /v3/payments/{id}/status`;
- se status for pago, confirmar reserva;
- se status ainda pendente, manter pendente;
- se prazo local expirou, remover link/cobrança quando possível e atualizar status local.

### `asaas-webhook`

Responsável por:

- validar header `asaas-access-token`;
- registrar evento recebido;
- responder `200` rapidamente;
- processar evento com idempotência;
- localizar o pagamento local por `payment.paymentLink` ou por `payment.id`;
- salvar `asaas_payment_id` local quando o webhook trouxer a cobrança gerada pelo link;
- confirmar reserva em eventos de pagamento recebido/confirmado;
- tratar eventos como cobrança removida, estorno ou falha.

### `expire-reservation-payments`

Job interno a cada 1 ou 2 minutos:

- busca pagamentos `awaiting_method` ou `pending` com `expires_at < now()`;
- quando ainda estiver `awaiting_method`, marca como expirado sem chamar Asaas, porque nenhum link foi criado;
- quando estiver `pending`, consulta status da cobrança se `asaas_payment_id` já existir;
- se pago, confirma reserva;
- se ainda não pago, remove o link Asaas;
- se já houver cobrança gerada e ainda pendente, tenta excluir a cobrança também;
- marca pagamento como `expired` ou `cancelled`;
- marca reserva como `payment_expired`;
- libera mesa.

## Integração com Asaas

### Endpoints principais do MVP

| Endpoint | Uso no nosso fluxo |
| --- | --- |
| `POST /v3/paymentLinks` | Criar um link de pagamento único para a pré-reserva e método escolhido. |
| `GET /v3/paymentLinks` | Listar/buscar links por `name` ou `externalReference` para validação operacional e teste de token. |
| `GET /v3/paymentLinks/{id}` | Recuperar um link específico no botão "Já paguei" quando ainda não recebemos webhook com a cobrança gerada. |
| `DELETE /v3/paymentLinks/{id}` | Remover o link quando o prazo local de 10 minutos expirar. |
| `GET /v3/payments/{id}/status` | Consultar status da cobrança gerada pelo link, apenas depois que o webhook informar `payment.id`. |
| `DELETE /v3/payments/{id}` | Cancelar/excluir uma cobrança pendente gerada pelo link, se ela já existir e ainda não estiver paga. |

### Criação de link

Campos recomendados ao criar link:

- `name`: `Reserva {tracking_code} - {data} {hora} - {Pix|Cartao}`
- `description`: `Sinal de reserva | {nome_regra} | {pessoas} pessoas | {cliente} | Ref {tracking_code}`
- `value`: valor final cobrado no método escolhido
- `billingType`: `PIX` ou `CREDIT_CARD`
- `chargeType`: `DETACHED` para cobrança única, ou `INSTALLMENT` para cartão parcelado
- `maxInstallmentCount`: máximo de parcelas quando cartão parcelado estiver habilitado
- `externalReference`: `PR-{payment_token}-{PIX|CREDIT_CARD}`
- `notificationEnabled`: `false`, para evitar mensagens diretas do Asaas no MVP
- `callback.successUrl`: URL pública `/pagamento/:payment_token`
- `callback.autoRedirect`: `true`

O título, descrição e `externalReference` devem facilitar busca tanto para o gestor no painel do Asaas quanto para consultas por API.

### Por que link em vez de cobrança direta

Cobrança direta (`POST /v3/payments`) exige cliente Asaas e tende a exigir CPF/CNPJ antes da criação. Como o MVP quer reduzir atrito no nosso formulário e não coletar dados financeiros no nosso frontend, o fluxo padrão será `paymentLinks`.

Ponto operacional: pelo link de pagamento, o Asaas pode criar o cliente no momento em que a cobrança é gerada. Se o cliente já existir no Asaas, pode haver cadastro duplicado no Asaas. No MVP, isso fica fora do nosso banco e não bloqueia a reserva.

Se no futuro precisarmos mostrar QR Code Pix direto na nossa página ou controlar o cliente Asaas localmente, aí a cobrança direta pode voltar como alternativa. Não é o caminho do MVP atual.

## Confirmação de pagamento

Usar fluxo híbrido:

1. Webhook confirma automaticamente quando chegar.
2. Página pública consulta nosso backend periodicamente.
3. Botão "Já paguei" força consulta ao backend.

Não depender somente do webhook, porque pode haver atraso. Não depender somente de polling, porque o cliente pode fechar a página.

Status aceitos para confirmar:

- Pix: normalmente `RECEIVED`.
- Cartão: usar status aprovado/confirmado pelo Asaas, normalmente `CONFIRMED` ou equivalente retornado para cobrança de cartão, validando também eventos de webhook.

Pagamento aprovado confirma a reserva e dispara a automação atual de confirmação. Não deve reenviar evento de conversão/tráfego, porque esse evento já foi registrado quando a pré-reserva foi criada.

## Tracking, tráfego e eventos

O pagamento antecipado não muda a regra de atribuição de tráfego. Se o cliente chegou ao final do formulário e criou a pré-reserva, o evento de conversão deve ser enviado normalmente. O fato de pagar ou não pagar depois não deve ser tratado como falha do tráfego.

Matriz recomendada:

| Momento | Status local | Evento/efeito |
| --- | --- | --- |
| Cliente envia os dados da reserva com regra ativa | reserva `pending_payment`, pagamento `awaiting_method` | registra evento normal de reserva criada/conversão e preserva `visitor_id`, UTMs, `fbp`, `fbc`, `fbclid` e jornada |
| Cliente escolhe Pix ou cartão | pagamento `pending` | cria link Asaas e registra evento interno `payment_link_created`, sem novo evento de conversão |
| Pagamento aprovado | reserva `confirmed`, pagamento `paid` | dispara confirmação operacional/WhatsApp atual, sem duplicar conversão |
| Prazo expira sem pagamento | reserva `payment_expired`, pagamento `expired` ou `cancelled` | libera mesa e registra evento interno de expiração, sem desfazer conversão |
| Pagamento detectado após expiração | reserva `paid_after_expiration`, pagamento `late_paid` | registra evento operacional para análise manual, sem evento de conversão adicional |

Regras importantes:

- `reservation_created` ou evento equivalente de conversão deve ser disparado na criação da pré-reserva `pending_payment`.
- Pagamento aprovado não deve disparar outro `reservation_created`, `Schedule` ou evento equivalente na Meta.
- Expiração de pagamento não deve disparar evento negativo para tráfego nem apagar atribuição.
- Eventos internos de pagamento podem existir para auditoria: `payment_link_created`, `payment_paid`, `payment_expired`, `payment_cancelled`, `payment_late_paid`.
- A automação de confirmação de reserva deve ficar separada do tracking: só dispara quando a reserva virar `confirmed`.

## Expiração e cancelamento

Quando o prazo local expirar:

1. Se houver `asaas_payment_id`, consultar status no Asaas antes de cancelar.
2. Se o Asaas indicar pago, confirmar reserva.
3. Se ainda não pago, chamar `DELETE /v3/paymentLinks/{id}` para remover o link.
4. Se uma cobrança já tiver sido gerada e ainda estiver pendente, tentar chamar `DELETE /v3/payments/{id}` também.
5. Marcar pagamento local como `expired` ou `cancelled`.
6. Marcar reserva como `payment_expired`.
7. Liberar a mesa.

Essa etapa evita que o cliente consiga pagar depois usando um link antigo.

Caso raro: pagamento detectado após a expiração local. Regra recomendada:

- se a mesa ainda estiver livre, confirmar a reserva;
- se a mesa já foi ocupada por outra reserva, marcar como `paid_after_expiration` e alertar admin para contato/estorno.

O Asaas não controla esse prazo de 10 minutos como regra operacional da reserva. O limite é do nosso sistema: ao vencer `expires_at`, o job consulta o status quando possível e remove o link pendente.

## Admin e operação

Na reserva, mostrar:

- status do pagamento;
- valor do sinal;
- valor cobrado;
- método usado: Pix ou cartão;
- parcelamento, quando houver;
- prazo de expiração;
- status Asaas;
- link público de pagamento;
- link Asaas, apenas enquanto ainda estiver válido;
- botão "Consultar status";
- botão "Cancelar cobrança/link";
- histórico de eventos.

Na aba de pagamentos antecipados:

- lista de regras;
- criar/desativar regra;
- clonar regra para criar uma nova versão desativada;
- excluir regra apenas quando nunca foi usada;
- arquivar regra já usada, sem apagar histórico;
- preview do impacto por data;
- aviso de conflito entre regras no mesmo período;
- aviso de não retroatividade para reservas já existentes no período da regra;
- configuração de Pix/cartão por regra, com valor final por método e máximo de parcelas no cartão;
- tela operacional de pagamentos individuais compacta, com cliente, reserva, valor, status, expiração, filtro por período, paginação e botão "Consultar status";
- status da integração Asaas, última validação, botão "Testar conexão" e URL do webhook;
- relatório básico de pendentes, pagos, expirados e cancelados;
- resumo financeiro filtrável por período, usando como padrão a data de criação da reserva/pagamento (`created_at`), não a data da visita;
- filtro do resumo com períodos predefinidos e opção personalizada usando o calendário de intervalo padrão do sistema;
- gráfico diário de reservas pagas, pendentes e expiradas dentro do período filtrado.

## WhatsApp

Alterar fluxo de automações:

- confirmação normal só deve sair depois do pagamento aprovado;
- ao criar `pending_payment`, opcionalmente enviar mensagem com link de pagamento;
- ao expirar, opcionalmente enviar mensagem de expiração;
- ao confirmar pagamento, disparar a confirmação atual da reserva.

Novos tipos possíveis:

- `payment_pending`
- `payment_expired`

## Riscos principais

- Confirmar reserva antes do pagamento.
- Não enviar evento de conversão quando a pré-reserva for criada.
- Duplicar evento de conversão quando o pagamento for aprovado.
- Não bloquear mesa durante `pending_payment`.
- Bloquear mesa indefinidamente se job de expiração falhar.
- Webhook duplicado confirmar duas vezes.
- Cliente pagar depois da expiração.
- Link Asaas criado mas não salvo localmente.
- Link removido, mas cobrança já gerada continuar ativa.
- Reserva cancelada localmente e link/cobrança continuar ativo no Asaas.
- Token do Asaas exposto no frontend.
- Datas especiais com regra errada impactarem reservas normais.

## Mitigações

- Idempotência em webhooks e criação de links.
- Matriz de eventos separando tracking, pagamento e automação operacional.
- Transações/RPCs no banco para criar reserva + pagamento de forma consistente.
- Job de expiração com consulta ao Asaas antes de cancelar.
- Constraints para evitar mais de um pagamento ativo por reserva.
- Logs de webhook e de ações administrativas.
- Página pública persistente por token.
- Revalidação de disponibilidade antes de confirmar a reserva paga.
- Alerta admin para `paid_after_expiration`.
- Cartão sempre via link de pagamento do Asaas no MVP, sem checkout transparente no nosso frontend.

## Fases de implementação recomendadas

### Fase 0: Front e contrato sem ativação real

- Feature visual `reservation_prepayment`.
- Menu e tela **Pagamentos Antecipados** no painel da empresa.
- Tela de configuração Asaas por empresa, sem expor token salvo.
- Status visual da integração com a conta real Asaas, teste de conexão e URL do webhook.
- Tela de regras por data/período, com valor do sinal por reserva ou por pessoa.
- Contrato visual para Pix e cartão, incluindo valor final por método e parcelamento máximo.
- Aba de regras com ativas, desativadas e arquivadas.
- Clonagem de regra para criar nova versão sem editar a regra original.
- Aviso de não retroatividade para reservas já existentes.
- Exclusão visual apenas para regra sem uso; regra usada deve virar arquivada.
- Aba operacional de pagamentos individuais com filtro por período, paginação e ação visual de consulta.
- Aba de resumo financeiro com filtro por data de criação e gráfico diário de pagas, pendentes e expiradas.
- Períodos predefinidos no resumo financeiro, com opção personalizada no calendário de intervalo do sistema.
- Badges para os novos status de reserva.
- Página pública `/pagamento/:payment_token` com estados visuais.
- Matriz de eventos/tracking para garantir conversão na criação da pré-reserva, sem duplicidade no pagamento aprovado.
- Contratos de payload para as Edge Functions.
- Nenhuma reserva real deve nascer como `pending_payment` nesta fase.

### Fase 1: MVP Pix e cartão por link Asaas

- Regras por data/período.
- Valor fixo ou por pessoa.
- Valor final separado para Pix e cartão.
- Parcelamento máximo do cartão.
- Reserva `pending_payment`.
- Página pública de pagamento.
- Link Asaas para Pix.
- Link Asaas para cartão.
- Evento de conversão enviado na criação da pré-reserva `pending_payment`.
- Confirmação operacional enviada apenas quando o pagamento aprovar.
- Webhook Asaas.
- Botão "Já paguei" consultando nosso backend.
- Expiração automática com remoção do link Asaas e da cobrança gerada, quando existir.
- Confirmação da reserva após pagamento.

### Fase 2: Operação e relatórios

- Cancelamento manual da cobrança/link.
- Relatório de pagamentos.
- Histórico completo na reserva.
- Mensagens WhatsApp de pagamento pendente/expirado.

### Fase 3: Casos avançados

- Cobrança direta com QR Code Pix próprio na nossa página, se houver necessidade futura.
- Checkout transparente de cartão, se houver necessidade futura.
- Estorno automático, se a empresa quiser operar isso no painel no futuro.
- Política de cancelamento por regra.
- Pagamento parcial/sinal.
- Regras por dia da semana, horário ou tamanho do grupo.
- Integração financeira mais completa.

## Decisões fora do MVP

- Cliente não altera data, horário ou pessoas sozinho após pagar; mudança é via suporte/operação.
- Estorno é feito pela empresa diretamente no Asaas, fora do painel.
- Não haverá split ou repasse automático.
- Não teremos cobrança direta como fluxo inicial do MVP.

## Referências oficiais Asaas

- Criar link de pagamento: https://docs.asaas.com/reference/criar-um-link-de-pagamentos
- Listar links de pagamento: https://docs.asaas.com/reference/listar-links-de-pagamentos
- Recuperar um link de pagamento: https://docs.asaas.com/reference/recuperar-um-unico-link-de-pagamentos
- Remover link de pagamento: https://docs.asaas.com/reference/remover-um-link-de-pagamentos
- Guia de links de pagamento: https://docs.asaas.com/docs/creating-a-payment-link
- Consultar status da cobrança gerada: https://docs.asaas.com/reference/recuperar-status-de-uma-cobranca
- Excluir cobrança gerada: https://docs.asaas.com/reference/excluir-cobranca
- Eventos de pagamento: https://docs.asaas.com/docs/webhooks-events
- Boas práticas de webhooks: https://docs.asaas.com/docs/about-webhooks
