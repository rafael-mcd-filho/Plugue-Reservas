# Plano futuro: pagamento antecipado de reservas com Asaas

## Objetivo

Criar um módulo opcional de pagamento antecipado para datas/eventos especiais, como Dia dos Namorados, Dia das Mães, Réveillon ou menus fechados. A reserva só deve ser confirmada após pagamento aprovado. Enquanto o pagamento estiver pendente, a mesa fica bloqueada temporariamente; se o prazo expirar, a cobrança deve ser cancelada no Asaas e a mesa liberada.

Este documento é um plano de produto e engenharia. Não representa implementação já feita.

## Decisão de produto recomendada

Criar uma área própria no painel da empresa chamada **Pagamentos Antecipados**.

Essa aba deve permitir configurar regras como:

- nome da regra: `Dia dos Namorados`, `Réveillon`, `Menu especial`;
- data única ou intervalo de datas;
- valor fixo por reserva ou valor por pessoa;
- prazo de pagamento, por exemplo `10`, `15` ou `30` minutos;
- método inicial recomendado: Pix;
- texto exibido ao cliente antes de confirmar;
- política de expiração/cancelamento;
- escopo da regra: todas as reservas ou apenas reservas acima de X pessoas.

O MVP deve começar com Pix. Cartão pode ficar para uma fase posterior, porque adiciona mais complexidade de segurança, risco e experiência de checkout.

## Experiência do cliente

Fluxo público recomendado:

1. Cliente escolhe data, pessoas, horário e preenche dados.
2. Ao clicar em confirmar, o sistema verifica se existe regra de pagamento para aquela data.
3. Se não houver regra, segue o fluxo atual.
4. Se houver regra:
   - cria reserva como `pending_payment`;
   - bloqueia a mesa por tempo limitado;
   - cria cobrança Pix no Asaas;
   - salva QR Code, copia e cola e link de fallback;
   - leva o cliente para uma página pública persistente de pagamento.

Evitar depender apenas do modal. A tela de pagamento deve ter uma URL própria, por exemplo:

- `/reserva/:tracking_code/pagamento`
- ou `/pagamento/:payment_token`

Motivo: se o cliente recarregar a página, fechar o navegador, trocar de dispositivo ou voltar pelo WhatsApp, ele precisa conseguir retomar o pagamento sem perder o estado.

## Página pública de pagamento

A página deve buscar os dados no banco e renderizar conforme o status:

- `pending`: mostra QR Code Pix, código copia e cola, valor, resumo da reserva, contador de expiração e botão "Já paguei".
- `paid`: mostra reserva confirmada.
- `expired`: mostra que a pré-reserva expirou e oferece iniciar nova reserva.
- `cancelled`: mostra que o pagamento/reserva foi cancelado.
- `paid_after_expiration`: mostra mensagem de análise manual, se necessário.

Para Pix, a página pode mostrar o QR Code diretamente, sem redirecionar ao Asaas. O Asaas disponibiliza `encodedImage`, `payload` e `expirationDate` no endpoint de QR Code Pix.

Manter também o `invoiceUrl` do Asaas como fallback, mas não como caminho principal.

## Estados de reserva

Adicionar estados novos ou equivalentes:

- `pending_payment`: reserva criada, mesa temporariamente bloqueada, pagamento pendente.
- `payment_expired`: pagamento expirou e mesa foi liberada.
- `payment_cancelled`: pagamento/cobrança cancelado antes da confirmação.
- `confirmed`: reserva confirmada após pagamento aprovado.
- `paid_after_expiration`: pagamento detectado depois do prazo, exigindo validação operacional.

Ponto crítico: disponibilidade de mesas deve tratar `pending_payment` como ocupação apenas enquanto `expires_at` ainda não passou.

## Estados de pagamento

Tabela local deve controlar status independente do Asaas:

- `pending`: cobrança criada, aguardando pagamento.
- `paid`: pagamento aprovado/recebido e reserva confirmada.
- `expired`: prazo local expirado.
- `cancelled`: cobrança excluída/cancelada no Asaas.
- `failed`: erro ao criar, consultar ou cancelar cobrança.
- `late_paid`: pagamento detectado após expiração local.
- `refunded`: pagamento estornado, se isso entrar em uma fase futura.

## Modelo de dados sugerido

### `reservation_payment_rules`

Campos sugeridos:

- `id uuid primary key`
- `company_id uuid not null`
- `name text not null`
- `enabled boolean not null default true`
- `date_start date not null`
- `date_end date not null`
- `amount_type text not null` (`fixed_per_reservation`, `per_person`)
- `amount numeric(10,2) not null`
- `payment_deadline_minutes integer not null default 15`
- `billing_type text not null default 'PIX'`
- `min_party_size integer`
- `max_party_size integer`
- `customer_notice text`
- `cancellation_policy text`
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
- `provider text not null default 'asaas'`
- `asaas_customer_id text`
- `asaas_payment_id text unique`
- `payment_token text unique not null`
- `billing_type text not null`
- `amount numeric(10,2) not null`
- `status text not null`
- `asaas_status text`
- `invoice_url text`
- `pix_payload text`
- `pix_qr_code_base64 text`
- `pix_expiration_date timestamptz`
- `expires_at timestamptz not null`
- `paid_at timestamptz`
- `cancelled_at timestamptz`
- `last_checked_at timestamptz`
- `error_details text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Índices:

- `(company_id, status, expires_at)`
- `(reservation_id)`
- `(payment_token)`
- `(asaas_payment_id)`

### `asaas_webhook_events`

Tabela para idempotência e auditoria:

- `id uuid primary key`
- `event_id text unique`
- `event_type text not null`
- `asaas_payment_id text`
- `payload jsonb not null`
- `processed_at timestamptz`
- `created_at timestamptz not null default now()`

## Edge Functions sugeridas

### `create-reservation-payment`

Responsável por:

- validar reserva e regra aplicável;
- criar reserva como `pending_payment`;
- reservar mesa temporariamente;
- criar ou reutilizar cliente no Asaas;
- criar cobrança Pix no Asaas;
- buscar QR Code Pix;
- salvar pagamento local;
- retornar `payment_token` ou URL pública de pagamento.

Não expor token do Asaas no frontend.

### `get-reservation-payment`

Responsável por:

- receber `payment_token` ou `tracking_code`;
- retornar status público do pagamento;
- retornar QR Code/copia e cola quando status for pendente;
- nunca retornar segredos internos.

### `check-reservation-payment`

Responsável pelo botão "Já paguei" e polling manual:

- consultar cobrança no Asaas;
- se status for pago, confirmar reserva;
- se status ainda pendente, manter pendente;
- se cobrança foi cancelada/expirada, atualizar status local.

### `asaas-webhook`

Responsável por:

- validar header `asaas-access-token`;
- registrar evento recebido;
- responder `200` rapidamente;
- processar evento com idempotência;
- confirmar reserva em eventos de pagamento recebido/confirmado;
- tratar eventos como cobrança removida, estorno ou falha.

### `expire-reservation-payments`

Job interno a cada 1 ou 2 minutos:

- busca pagamentos `pending` com `expires_at < now()`;
- consulta status no Asaas antes de cancelar;
- se pago, confirma reserva;
- se ainda pendente/vencido, exclui cobrança no Asaas;
- marca pagamento como `expired` ou `cancelled`;
- marca reserva como `payment_expired`;
- libera mesa.

## Integração com Asaas

Endpoints relevantes:

- Criar cobrança: `POST /v3/payments`
- Buscar QR Code Pix: `GET /v3/payments/{id}/pixQrCode`
- Consultar status da cobrança: `GET /v3/payments/{id}/status`
- Excluir cobrança pendente: `DELETE /v3/payments/{id}`

Para Pix:

- criar cobrança com `billingType: "PIX"`;
- usar `externalReference` apontando para `reservation_payment_id` ou `reservation_id`;
- buscar QR Code logo após criar a cobrança;
- exibir `encodedImage` e `payload` na página pública.

## Confirmação de pagamento

Usar fluxo híbrido:

1. Webhook confirma automaticamente quando chegar.
2. Página pública consulta nosso backend periodicamente.
3. Botão "Já paguei" força consulta à API do Asaas.

Não depender somente do webhook, porque pode haver atraso. Não depender somente de polling, porque o cliente pode fechar a página.

Status aceitos para confirmar:

- Pix: normalmente `RECEIVED`.
- Cartão, se entrar no futuro: avaliar `CONFIRMED` e regras de risco/chargeback.

## Expiração e cancelamento

Quando o prazo local expirar:

1. Consultar o status no Asaas antes de cancelar.
2. Se o Asaas indicar pago, confirmar reserva.
3. Se ainda não pago, chamar `DELETE /v3/payments/{id}`.
4. Marcar pagamento local como `expired` ou `cancelled`.
5. Marcar reserva como `payment_expired`.
6. Liberar a mesa.

Essa etapa evita que o cliente consiga pagar depois usando um QR Code/link antigo.

Caso raro: pagamento detectado após a expiração local. Regra recomendada:

- se a mesa ainda estiver livre, confirmar a reserva;
- se a mesa já foi ocupada por outra reserva, marcar como `paid_after_expiration` e alertar admin para contato/estorno.

## Admin e operação

Na reserva, mostrar:

- status do pagamento;
- valor;
- prazo de expiração;
- status Asaas;
- link público de pagamento;
- botão "Reenviar link";
- botão "Consultar status";
- botão "Cancelar cobrança";
- histórico de eventos.

Na aba de pagamentos antecipados:

- lista de regras;
- criar/editar/desativar regra;
- preview do impacto por data;
- aviso de conflito entre regras no mesmo período;
- relatório básico de pendentes, pagos, expirados e cancelados.

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
- Não bloquear mesa durante `pending_payment`.
- Bloquear mesa indefinidamente se job de expiração falhar.
- Webhook duplicado confirmar duas vezes.
- Cliente pagar depois da expiração.
- Cobrança Asaas criada mas não salva localmente.
- Reserva cancelada localmente e cobrança continuar ativa.
- Token do Asaas exposto no frontend.
- QR Code antigo ainda pagável se a cobrança não for excluída.
- Datas especiais com regra errada impactarem reservas normais.

## Mitigações

- Idempotência em webhooks e criação de cobranças.
- Transações/RPCs no banco para criar reserva + pagamento de forma consistente.
- Job de expiração com consulta ao Asaas antes de cancelar.
- Constraints para evitar mais de um pagamento ativo por reserva.
- Logs de webhook e de ações administrativas.
- Página pública persistente por token.
- Revalidação de disponibilidade antes de confirmar a reserva paga.
- Alerta admin para `paid_after_expiration`.

## Fases de implementação recomendadas

### Fase 1: MVP Pix

- Regras por data/período.
- Valor fixo ou por pessoa.
- Reserva `pending_payment`.
- Página pública de pagamento.
- Pix QR Code e copia e cola.
- Webhook Asaas.
- Botão "Já paguei" consultando API.
- Expiração automática com exclusão da cobrança.
- Confirmação da reserva após pagamento.

### Fase 2: Operação e relatórios

- Reenvio de link.
- Cancelamento manual da cobrança.
- Relatório de pagamentos.
- Histórico completo na reserva.
- Mensagens WhatsApp de pagamento pendente/expirado.

### Fase 3: Casos avançados

- Cartão.
- Estorno automático.
- Política de cancelamento por regra.
- Pagamento parcial/sinal.
- Regras por dia da semana, horário ou tamanho do grupo.
- Integração financeira mais completa.

## Perguntas em aberto

- O pagamento deve ser obrigatório para todos os horários da data ou apenas horários específicos?
- O valor será sinal abatido da conta ou taxa de reserva não reembolsável?
- Quanto tempo a mesa deve ficar bloqueada aguardando pagamento?
- O cliente poderá trocar data/horário depois de pagar?
- Quem pode cancelar/estornar manualmente?
- O pagamento deve existir por empresa ou por conta Asaas centralizada da plataforma?
- Haverá split ou repasse para a empresa no futuro?

## Referências oficiais Asaas

- Criar cobrança: https://docs.asaas.com/reference/criar-nova-cobranca
- Pix e QR Code dinâmico: https://docs.asaas.com/docs/payments-via-pix-or-dynamic-qr-code
- Obter QR Code Pix: https://docs.asaas.com/reference/obter-qr-code-para-pagamentos-via-pix
- Consultar status da cobrança: https://docs.asaas.com/reference/recuperar-status-de-uma-cobranca
- Excluir cobrança: https://docs.asaas.com/reference/excluir-cobranca
- Eventos de pagamento: https://docs.asaas.com/docs/webhooks-events
- Boas práticas de webhooks: https://docs.asaas.com/docs/about-webhooks
