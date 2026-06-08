# Plano: Pagamentos Centralizados com Saldo e Repasse

**Status:** Planejamento
**Data:** 2026-06-03

---

## Contexto

Hoje cada empresa vincula sua própria conta Asaas (`company_asaas_configs`), os pagamentos vão direto para a conta da empresa e a empresa precisa configurar token, webhook, etc.

**Novo modelo:**
- Uma única conta Asaas do Plugue processa todos os pagamentos
- Dinheiro fica no Plugue; empresa solicita repasse quando quiser
- Taxa cobrada por transação paga (descontada automaticamente)
- Empresa não configura nada de Asaas — só ativa o módulo de pré-pagamento

---

## Modelo de dados — novos objetos

### `platform_asaas_config`
Uma linha só. Token Asaas do Plugue. Gerenciado por super-admin.

### `platform_fee_configs`
Regras de taxa cobrada por transação paga.

| campo | tipo | descrição |
|---|---|---|
| `fee_type` | enum | `percentage`, `fixed`, `percentage_plus_fixed` |
| `fee_percentage` | numeric | ex: `2.5` para 2,5% |
| `fee_fixed_amount` | numeric | ex: `0.99` |
| `effective_from` | date | data de início de vigência |
| `company_id` | uuid nullable | null = regra padrão; preenchido = override por empresa |

### `company_wallet_transactions` (ledger)
Cada evento financeiro gera uma linha. Saldo = soma de todas as linhas da empresa.

| campo | tipo | descrição |
|---|---|---|
| `company_id` | uuid | |
| `type` | enum | `payment_credit`, `fee_debit`, `payout_debit`, `payout_reversal` |
| `amount` | numeric | positivo = crédito, negativo = débito |
| `reservation_payment_id` | uuid nullable | referência à transação de origem |
| `payout_request_id` | uuid nullable | referência ao repasse |
| `description` | text | texto legível para o extrato |
| `created_at` | timestamptz | |

Saldo disponível = `SELECT SUM(amount) FROM company_wallet_transactions WHERE company_id = ?`

### `company_payout_requests`
Pedido de repasse feito pela empresa.

| campo | tipo | descrição |
|---|---|---|
| `company_id` | uuid | |
| `requested_amount` | numeric | valor solicitado |
| `status` | enum | `pending`, `processing`, `completed`, `rejected` |
| `pix_key` | text | chave pix para o repasse |
| `asaas_transfer_id` | text nullable | ID do repasse no Asaas |
| `processed_at` | timestamptz | |
| `processed_by` | uuid | admin que processou |
| `rejection_reason` | text nullable | |

### Adições em `reservation_payments`
- `platform_fee_amount` — valor da taxa cobrada nesta transação
- `platform_fee_rate_snapshot` — snapshot da regra de taxa no momento do pagamento

---

## O que muda nas edge functions

### `create-reservation-payment`
- Remove busca de token em `company_asaas_configs`
- Busca token em `platform_asaas_config`
- `external_reference` = `plugue_{company_id}_{payment_token}` (identificação no webhook)

### `select-reservation-payment-method`
- Mesma mudança: token vem de `platform_asaas_config`
- Lógica de PIX/cartão sem alteração

### `asaas-webhook`
- Deixa de receber `?company_id` na URL
- Extrai `company_id` do `external_reference` do payload
- Um único endpoint para todos os pagamentos da plataforma

**Novo comportamento após confirmação de pagamento:**
```
Pagamento confirmado pelo Asaas
         ↓
Calcula taxa (busca platform_fee_configs para a empresa)
         ↓
Cria wallet_transaction: CREDIT (valor bruto)
Cria wallet_transaction: DEBIT  (taxa)
         ↓
Atualiza reservation_payment com platform_fee_amount
         ↓
Confirma reserva (igual hoje)
```

### `reconcile-reservation-payments` e `expire-reservation-payments`
- Só troca a fonte do token (platform em vez de company)

### Nova: `request-company-payout`
- Valida que saldo disponível cobre o valor solicitado
- Cria `company_payout_requests` com status `pending`
- Bloqueia o valor no ledger (wallet_transaction tipo `payout_pending`)

### Nova: `process-company-payout`
- Chama Asaas `/transfers` para enviar via PIX
- Atualiza status para `completed`
- Confirma a wallet_transaction de débito

---

## O que muda no painel das empresas

**Remove:**
- Aba/seção de configuração do Asaas (token, webhook)

**Adiciona:**
- **Aba "Financeiro"** — saldo disponível + extrato (wallet_transactions)
- **Botão "Solicitar repasse"** — formulário com chave PIX e valor
- **Histórico de repasses** — lista de payout_requests com status

**Sem mudança:**
- Tela de regras de pagamento (`reservation_payment_rules`)
- Histórico de pagamentos por reserva
- Ativação do módulo de pré-pagamento — agora só um toggle, sem config Asaas

---

## O que muda no super-admin

**Adiciona:**
- **Config Asaas da plataforma** — onde o token do Plugue é salvo
- **Config de taxas** — gerencia `platform_fee_configs` (padrão + overrides por empresa)
- **Fila de repasses** — lista payout_requests pendentes, botão de processar
- **Receita de taxas** — relatório de quanto o Plugue arrecadou por empresa/período

---

## Migração das empresas existentes

- Empresas com `company_asaas_configs` continuam no modelo antigo até uma data de corte
- Na data de corte, o sistema passa a ignorar a config delas e usa a conta da plataforma
- `company_asaas_configs` é arquivada (não deletada, para histórico)
- Novas empresas nunca precisam configurar Asaas

---

## Ordem de implementação

| Fase | Escopo |
|---|---|
| **1 — Base de dados** | Criar `platform_asaas_config`, `platform_fee_configs`, `company_wallet_transactions`, `company_payout_requests` + migrations |
| **2 — Webhook central** | Refatorar `asaas-webhook` para extrair `company_id` via `external_reference` |
| **3 — Pagamentos na conta plataforma** | Refatorar `create-reservation-payment` e `select-reservation-payment-method` |
| **4 — Ledger automático** | Após confirmação: calcular taxa, registrar crédito e débito no ledger |
| **5 — Painel empresa** | Tela de saldo, extrato e solicitação de repasse |
| **6 — Repasse admin** | Fila de repasses no super-admin + chamada Asaas para transferência PIX |
| **7 — Limpeza** | Remover tela de config Asaas das empresas, deprecar `company_asaas_configs` |

---

## Pontos em aberto (definir antes de iniciar)

1. **Qual a taxa padrão?** (ex: 2% ou R$ 1,00 fixo por transação paga)
2. **Repasse é manual** (admin aprova um a um) **ou automático** (cron processa a fila)?
3. **Saldo mínimo para repasse?** (ex: só pode sacar a partir de R$ 50)
4. **Extrato mostra valor bruto + taxa separados ou só o líquido?**
