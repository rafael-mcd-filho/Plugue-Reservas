# Plano: Avaliações pós-visita (NPS + experiência)

**Status:** Planejamento
**Data:** 2026-06-03

---

## Contexto

Hoje, quando uma reserva é concluída (check-in), o ciclo termina ali. Existe a automação
`post_visit` ("Mensagem Pós-Visita", enfileirada às 08:00 do dia seguinte), mas ela só agradece
— não captura nenhum retorno do cliente.

**Objetivo:** ao concluir o check-in, gerar um link de avaliação vinculado àquela reserva e ao
lead. O cliente acessa o link e responde:

1. O que achou do **ambiente**
2. O que achou da **comida**
3. O que achou do **atendimento**
4. Qual a **chance de indicar a um amigo** (pergunta clássica de NPS)

Se a nota for baixa (ex.: não indicaria), abre-se um **campo de texto livre** — informando que a
avaliação é **anônima** — para o cliente dizer o que poderia melhorar. As respostas alimentam uma
**nova tela de relatórios** com NPS, satisfação por critério, taxa de resposta e leitura dos
comentários.

O link fica disponível como **variável de automação** (`{link_avaliacao}`) e também pode ser
**copiado/enviado manualmente** pela equipe a partir da reserva.

---

## Como encaixa no que já existe

| Já existe | Vamos reaproveitar |
|---|---|
| `public_tracking_code` + RPCs `SECURITY DEFINER` liberadas pra `anon` | Mesmo padrão de página pública por token |
| Rotas `/:slug/reserva/:code`, `/:slug/fila/:code` | Nova rota `/:slug/avaliacao/:token` |
| `public_rate_limits` (usado no cancelamento público) | Anti-spam no envio da resposta |
| Variáveis de automação `{link_acompanhamento}` etc. | Nova variável `{link_avaliacao}` |
| Automação `post_visit` (dia seguinte ao check-in) | Portadora natural do link de avaliação |
| Feature flags (`companyFeatures.ts`) e permissões (`companyPermissions.ts`) | Gatear módulo + tela de relatórios |

**Atenção (lição da regressão de funnel tracking):** o acesso público **não** deve depender de
política RLS de INSERT na tabela. Toda escrita/leitura pública passa por função RPC
`SECURITY DEFINER` com `GRANT EXECUTE ... TO anon`, igual às RPCs de reserva. Assim um futuro
"security hardening" que remova políticas amplas não quebra o fluxo.

---

## Modelo de dados — novos objetos

> **Resumo:** são criadas **2 tabelas novas** (`reservation_reviews` e `company_nps_configs`).
> Nenhuma tabela existente muda de schema — a `reservations` apenas ganha um *trigger*.

### `reservation_reviews`
Uma linha por reserva convidada a avaliar (o "convite" e a "resposta" vivem na mesma linha; as
colunas de resposta ficam nulas até o cliente responder).

| campo | tipo | descrição |
|---|---|---|
| `id` | uuid pk | |
| `company_id` | uuid | FK `companies` |
| `reservation_id` | uuid | FK `reservations`, **único** (1 avaliação por reserva) |
| `lead_id` | uuid nullable | FK `leads`, vínculo interno com o cliente |
| `review_token` | text | único, default hex de `gen_random_uuid()` — token público do link |
| `status` | text | `pending` \| `submitted` \| `expired` |
| `invited_at` | timestamptz | quando o check-in gerou o convite |
| `sent_at` | timestamptz nullable | quando o link foi enviado |
| `sent_channel` | text nullable | `whatsapp` \| `pluguechat` \| `manual` |
| `ambiance_rating` | smallint nullable | 1–5 |
| `food_rating` | smallint nullable | 1–5 |
| `service_rating` | smallint nullable | 1–5 (atendimento) |
| `recommend_score` | smallint nullable | 0–10 (**pergunta NPS**) |
| `nps_category` | text nullable | derivado: `detractor` (0–6), `passive` (7–8), `promoter` (9–10) |
| `comment` | text nullable | texto livre (anônimo) |
| `submitted_at` | timestamptz nullable | quando respondeu |
| `submitted_visitor_id` | text nullable | visitor_id do dispositivo que respondeu |
| `expires_at` | timestamptz nullable | prazo de validade do link |
| `created_at` / `updated_at` | timestamptz | |

Índices: `unique(reservation_id)`, `unique(review_token)`, `(company_id, submitted_at)`,
`(company_id, status)`.

### `company_nps_configs`
Configuração por empresa (mesmo espírito de `company_asaas_configs`).

| campo | tipo | descrição |
|---|---|---|
| `company_id` | uuid pk | |
| `enabled` | boolean | liga/desliga geração de avaliações |
| `ask_ambiance` | boolean | mostra pergunta de ambiente (default true) |
| `ask_food` | boolean | mostra pergunta de comida (default true) |
| `ask_service` | boolean | mostra pergunta de atendimento (default true) |
| `comment_trigger` | text | `always` (default) \| `detractor` \| `never` — quando abre o campo de texto |
| `intro_message` | text nullable | texto de boas-vindas customizado |
| `expiration_days` | int | validade do link em dias (default 30) |
| `created_at` / `updated_at` | timestamptz | |

---

## Geração do link (no check-in)

Trigger `AFTER UPDATE ON reservations` quando o status entra em `checked_in`/`completed`:

```
Reserva muda para checked_in
        ↓
company_nps_configs.enabled = true ?  ── não → não faz nada
        ↓ sim
INSERT em reservation_reviews (se ainda não existir):
  - review_token gerado
  - status = 'pending'
  - lead_id vinculado
  - expires_at = now() + expiration_days
```

Função `ensure_reservation_review()` `SECURITY DEFINER`. Como o convite nasce no check-in, o link
já existe quando a automação `post_visit` roda no dia seguinte — então `{link_avaliacao}` está
disponível.

---

## Integração com automações (variável `{link_avaliacao}`)

**Não é uma automação nova** — é só uma variável nova disponível para uso nas automações. Como o
link só nasce no check-in, a variável faz sentido apenas em automações que disparam **depois da
visita**: na prática, a `post_visit`. Se usada antes (confirmação, lembrete) renderiza vazia, então
ela é oferecida especificamente na `post_visit`.

A nova variável precisa ser registrada nos **três** pontos que hoje tratam `{link_acompanhamento}`:

1. **`src/lib/whatsapp-automations.ts`** — adicionar `link_avaliacao` à lista `variables` da
   automação `post_visit` (e ao `defaultTemplate`, sugerindo o uso).
2. **`supabase/functions/reservation-events/index.ts`** — em `replaceTemplateVars` e
   `buildPublicTrackingUrl` (novo `pathSegment` `"avaliacao"`).
3. **`supabase/functions/_shared/pluguechat.ts`** — em `buildReservationParameters`.

URL montada igual às demais: `${appOrigin}/${slug}/avaliacao/${review_token}`.

**Envio manual:** na [ReservationDetailsDialog.tsx](src/components/ReservationDetailsDialog.tsx) e na
lista de reservas, botão "Copiar link de avaliação" (visível quando há `reservation_review`),
marcando `sent_channel = 'manual'`.

**Na página de acompanhamento:** depois do check-in, a própria página `/:slug/reserva/:code`
(que já faz polling do status) passa a exibir um botão **"Avaliar sua experiência"**. Para isso, a
RPC `get_public_reservation_by_tracking_code` passa a devolver também `review_token` e
`review_status` quando o status é `checked_in`/`completed`. Vira um terceiro canal, sem depender de
mensagem enviada.

---

## Página pública de avaliação

Nova rota `/:slug/avaliacao/:token` → componente `ReservationReview.tsx`, no mesmo molde visual de
[ReservationTracking.tsx](src/pages/ReservationTracking.tsx) (logo da empresa, card central,
branding via `syncPublicCompanyIcons`).

**Roteiro das perguntas (uma por tela, leve no mobile):**

Abertura: *"Conta pra gente como foi! Leva menos de 1 minuto e é anônimo 💛"*

| # | Pergunta | Escala | Campo gravado |
|---|---|---|---|
| 1 | "Como foi o nosso **ambiente**?" | ⭐ 1–5 (1 = não gostei · 5 = amei) | `ambiance_rating` |
| 2 | "E a **comida**, o que achou?" | ⭐ 1–5 | `food_rating` |
| 3 | "Como foi o nosso **atendimento**?" | ⭐ 1–5 | `service_rating` |
| 4 | "Qual a chance de **indicar** a gente pra um amigo?" | 0–10 (**NPS**) — *0 = de jeito nenhum · 10 = com certeza* | `recommend_score` |

**Ramificação (no fim, conforme a nota da pergunta 4 / NPS):**

| Faixa | Categoria | Texto do campo livre | Tela final |
|---|---|---|---|
| 9–10 | Promotor | *"Que alegria! 🎉 Quer deixar um elogio ou contar o que mais te marcou?"* (opcional) | *"Muito obrigado! Esperamos te ver de novo em breve."* |
| 7–8 | Neutro | *"Faltou pouco pra nota 10! O que deixaria sua experiência ainda melhor?"* (opcional) | *"Valeu pelo retorno, vamos melhorar!"* |
| 0–6 | Detrator | *"Poxa, sentimos muito que não tenha sido como esperava 😔 O que podemos melhorar? Sua resposta é anônima e vai direto pra equipe."* (incentivado) | *"Obrigado por nos contar. Vamos cuidar disso."* |

Todo campo de texto leva o aviso **"Sua avaliação é anônima"**. O `comment_trigger` da
`company_nps_configs` controla quem vê o campo: `always` (todos, recomendado), `detractor`
(só 0–6) ou `never`.

**RPCs públicas (`SECURITY DEFINER`, `GRANT EXECUTE ... TO anon`):**

- `get_public_review_by_token(_token)` → retorna branding da empresa + config (quais perguntas
  mostrar, intro, validade) + `status` (se já respondida/expirada). **Não** expõe dados pessoais.
- `submit_public_review(_token, _ambiance, _food, _service, _recommend, _comment, _visitor_id)` →
  valida token/validade, aplica rate-limit (`public_rate_limits`, escopo
  `public_review_submit_visitor`), grava respostas, define `status = 'submitted'`.

### Bloqueio de resposta única (3 camadas)
1. **Banco:** `unique(reservation_id)` garante uma avaliação por reserva.
2. **Concorrência:** `submit_public_review` trava a linha (`FOR UPDATE`, igual ao
   `cancel_public_reservation`) e, se `status` já for `submitted`, retorna `already_answered` sem
   regravar — mesmo com dois cliques simultâneos.
3. **Anti-spam:** rate-limit por `visitor_id`.

Respondida a avaliação, tanto a página pública quanto a de acompanhamento mostram
"Avaliação já enviada — obrigado".

---

## Tela de relatórios (nova)

Rota `/:slug/admin/avaliacoes` — permissão `nps_view`, feature `nps_surveys`. Item novo no menu
([AppLayout.tsx](src/components/AppLayout.tsx)), no grupo de relatórios.

**Cartões de topo:**
- **NPS** (`% promotores − % detratores`)
- **Satisfação ambiente** (média 1–5 + distribuição)
- **Satisfação comida** (média 1–5 + distribuição)
- **Satisfação atendimento** (média 1–5 + distribuição)
- **Taxa de resposta** (`submitted / enviados`)

**Gráficos:** evolução do NPS no período, distribuição das notas de recomendação
(detratores/neutros/promotores), distribuição das estrelas. Reaproveitar `recharts`
(`components/ui/chart.tsx`), como o [Dashboard.tsx](src/pages/Dashboard.tsx).

**Lista de comentários (anônima):** filtra por categoria/período, mostra o texto livre **sem nome**.
Futuro: marcar como "lido/resolvido".

**Dados:** leitura direta da tabela via RLS (membros da empresa) ou RPC agregadora
`get_company_nps_summary(company_id, from, to)`.

---

## Segurança / RLS

- `reservation_reviews`: RLS ligada. `SELECT` para usuários autenticados com acesso à empresa
  (reaproveitar helper de company-access já existente). Escrita só via service role / funções
  `SECURITY DEFINER`. **Sem políticas públicas** — acesso anônimo somente pelas RPCs.
- `company_nps_configs`: admin lê/edita a própria; superadmin tudo.
- Anti-abuso público idêntico ao cancelamento (rate-limit por `visitor_id`).

### Anonimato — apenas informado (decidido)
O anonimato é só uma **mensagem** ao cliente, para incentivá-lo a responder com sinceridade.
Internamente a linha continua vinculada a `reservation_id` e `lead_id` (necessário para taxa de
resposta, dedupe e disparo via automação). Por coerência com o que foi dito ao cliente, a
**recomendação** é a tela de relatórios não exibir o nome ao lado do comentário — mas, como o
vínculo existe, é decisão do produto mostrá-lo ou não.

---

## Ordem de implementação

| Fase | Escopo |
|---|---|
| **1 — Base de dados** | `reservation_reviews`, `company_nps_configs`, índices, RLS + trigger `ensure_reservation_review` |
| **2 — RPCs públicas** | `get_public_review_by_token`, `submit_public_review` (definer + grant anon + rate-limit) |
| **3 — Página pública** | Rota `/:slug/avaliacao/:token` + `ReservationReview.tsx` (fluxo de perguntas + campo condicional) |
| **4 — Variável de automação** | `{link_avaliacao}` nos 3 pontos + `post_visit` + botão "Copiar link" manual |
| **5 — Config da empresa** | Aba/seção para ligar o módulo e ajustar perguntas/textos |
| **6 — Relatórios** | Tela `/:slug/admin/avaliacoes` + permissão + feature flag + agregação |
| **7 — Tipos & testes** | Regenerar `src/integrations/supabase/types.ts`, testes de render de template e de cálculo de NPS |

---

## Decisões já tomadas

- **Anonimato:** apenas informado; vínculo interno mantido.
- **Envio:** não há automação nova; o `{link_avaliacao}` fica disponível para uso (na `post_visit`),
  no botão manual e na página de acompanhamento após o check-in.
- **Resposta única:** bloqueada em 3 camadas (ver seção de segurança).
- **Escalas:** ambiente/comida/atendimento em **estrelas 1–5**; indicar (NPS) em **0–10**, com âncoras "0 = de jeito nenhum · 10 = com certeza". *Regra:* estrela para avaliar aspectos, 0–10 só para o NPS — uma única troca de escala, na última pergunta.
- **Campo de texto:** `comment_trigger = always` — aparece para todos; muda só a mensagem conforme a
  nota (elogio quando boa, sugestão de melhoria quando ruim).
- **Validade do link:** **30 dias**; expirado, mostra "Este link de avaliação expirou".
- **Plano:** feature própria **`nps_surveys`** (nova chave em `companyFeatures.ts`).
- **Comentário:** exibido **sem nome** na tela, coerente com o aviso de anonimato.
- **Perguntas opcionais por empresa:** comida via `ask_food` (negócios sem cozinha) e atendimento via `ask_service` (modelos self-service/buffet) podem desligar.
- **Pergunta "chance de voltar" removida:** era redundante com o NPS (alta correlação); o atendimento entrou no lugar, cobrindo o principal driver que faltava.

## Melhorias futuras (fora do escopo inicial)

- Lembrete automático para quem recebeu o link e não respondeu em X dias.
- Marcar comentários como "lido/resolvido" na tela de relatórios.
- Aprovar comentário positivo de promotor para virar depoimento na página pública.
