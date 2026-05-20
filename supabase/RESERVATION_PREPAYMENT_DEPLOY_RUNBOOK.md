# Deploy futuro: pagamentos antecipados de reservas

Este runbook descreve como aplicar os artefatos criados para o MVP Asaas quando a feature for ativada em producao. Nada aqui foi executado automaticamente.

## 1. Revisar antes do deploy

- Confirmar que o frontend publico ja chama `create-reservation-payment`, `get-reservation-payment`, `select-reservation-payment-method` e `check-reservation-payment`.
- Confirmar que a pagina publica cria link de pagamento por metodo e redireciona para o checkout Asaas.
- Confirmar se o parcelamento de cartao via `POST /v3/paymentLinks` atende ao comportamento desejado de `em ate Xx`.
- Confirmar que o `INTERNAL_JOB_SECRET` esta configurado para jobs internos.

## 2. Aplicar banco

```bash
supabase db push
```

Migration principal:

- `supabase/migrations/20260519170000_add_asaas_reservation_prepayments.sql`

Ela cria:

- configuracao Asaas por empresa;
- regras de pagamento antecipado;
- pagamentos de reserva;
- eventos internos de pagamento;
- log idempotente de webhooks Asaas;
- ajuste de disponibilidade para `pending_payment` expirar pelo prazo local.

## 3. Deploy das Edge Functions

```bash
supabase functions deploy save-asaas-config
supabase functions deploy create-reservation-payment
supabase functions deploy get-reservation-payment
supabase functions deploy select-reservation-payment-method
supabase functions deploy check-reservation-payment
supabase functions deploy asaas-webhook
supabase functions deploy expire-reservation-payments
```

## 4. Segredos e ambiente

```bash
supabase secrets set ASAAS_USER_AGENT="PlugueReservas/1.0"
```

Para homologacao em Sandbox, aponte as Edge Functions para a API Sandbox e salve um token Sandbox na empresa de teste:

```bash
supabase secrets set ASAAS_API_BASE_URL="https://api-sandbox.asaas.com/v3"
```

Para producao, remova essa secret ou aponte explicitamente para a API real:

```bash
supabase secrets set ASAAS_API_BASE_URL="https://api.asaas.com/v3"
```

Opcionalmente, se quiser um token global alem do token por empresa:

```bash
supabase secrets set ASAAS_WEBHOOK_AUTH_TOKEN="<token-global-forte>"
```

O endpoint Asaas padrao usado pelas functions e `https://api.asaas.com/v3`. Sandbox e producao usam bases e tokens diferentes; nao misture token Sandbox com URL de producao nem token real com URL Sandbox.

## 4.1. Revisao antes de producao

- Rodar `npm run build`.
- Validar em staging com `ASAAS_API_BASE_URL="https://api-sandbox.asaas.com/v3"`.
- Testar `save-asaas-config` com token Sandbox e conferir se a validacao por `GET /v3/paymentLinks?limit=1` passa.
- Criar link Pix e link cartao por `select-reservation-payment-method`.
- Confirmar webhook no painel Sandbox usando a URL da Edge Function de staging.
- Confirmar que o evento de conversao nasce na pre-reserva e nao duplica quando o pagamento aprova.
- Testar expiracao com link sem pagamento e verificar remocao no Asaas.
- Revisar logs de `asaas_webhook_events`, `reservation_payment_events` e status da reserva.

## 5. Job de expiracao

Agendar `expire-reservation-payments` a cada 1 ou 2 minutos, enviando o header:

```http
x-job-secret: <INTERNAL_JOB_SECRET>
```

Endpoint:

```text
https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/expire-reservation-payments
```

## 6. Webhook Asaas

Cada empresa deve configurar no Asaas:

- URL: `https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/asaas-webhook`
- Token de autenticacao: `webhook_auth_token` gerado para a empresa
- Eventos: cobrancas/pagamentos, principalmente `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_DELETED` e `PAYMENT_REFUNDED`

## 7. Smoke test

1. Ativar feature `reservation_prepayment` para uma empresa de teste.
2. Salvar token Asaas da empresa pelo endpoint `save-asaas-config`.
3. Criar regra ativa para uma data futura.
4. Criar uma reserva publica nessa data.
5. Verificar se a reserva nasce `pending_payment` e se o evento de conversao foi criado.
6. Escolher Pix e validar criacao de `paymentLink` com `billingType: PIX`.
7. Repetir com cartao e validar criacao de `paymentLink` com `billingType: CREDIT_CARD` e parcelamento configurado.
8. Validar no Asaas se `name`, `description` e `externalReference` facilitam encontrar o link.
9. Pagar pelo link e confirmar que a reserva vira `confirmed` sem duplicar conversao.
10. Deixar outro link expirar e confirmar que ele e removido no Asaas, a reserva vira `payment_expired` e a mesa e liberada.
