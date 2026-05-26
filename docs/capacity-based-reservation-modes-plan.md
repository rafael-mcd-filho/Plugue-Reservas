# Plano: Modos de reserva (mesas ou capacidade por horário) com sobreposições por data

## Objetivo

Permitir que cada empresa configure **dois padrões coexistentes** de gestão de reservas e escolha qual usar:

1. **Padrão por Mesas** — modelo atual. Disponibilidade derivada do `table_map` ativo e das mesas livres no horário.
2. **Padrão por Capacidade** — novo modelo. Disponibilidade derivada de **faixas horárias com limite de pessoas e limite de reservas**, sem mapa de mesas.

Independente do padrão escolhido, a empresa pode criar **regras pontuais** (overrides) que sobrepõem o padrão em uma data específica ou em um intervalo de datas. Cada regra escolhe seu próprio modo (mesas ou capacidade), independente do padrão da empresa.

Exemplos práticos:

- Restaurante com padrão **Mesas** mas que troca para **Capacidade** no Réveillon.
- Restaurante com padrão **Capacidade** que usa **Mesas** durante eventos especiais.
- Restaurante que ativa **Capacidade** apenas em dezembro inteiro via regra `date_range`.

Este documento é um plano de produto e engenharia. Nenhuma parte está implementada ainda.

## Inspiração e contexto

O modelo de referência é o Dguets, que oferece dois caminhos por data: configurar por mapa de mesas (igual ao Plugue hoje) ou configurar por faixas de horário (giros) com limite de pessoas e limite de reservas. As capturas analisadas mostram esses dois campos lado a lado: `Limite de Reservas` e `Limite de Pessoas*`, além de `Capacidade Máxima por Reserva` e `Capacidade Mínima por Reserva`, com um toggle `Reserva online no ambiente` e o conceito de **giro** (faixa horária dentro de um ambiente, com `Horário mínimo` e `Horário máximo`, intervalo de agendamento e fechamento antecipado).

## Decisões fechadas

### Conceitual

- A empresa tem **dois padrões configuráveis simultaneamente**: padrão de Mesas (já existe via `opening_hours` + `table_maps`) e padrão de Capacidade (novo). Apenas um deles está em uso por vez, definido por `companies.default_reservation_mode`. O outro fica configurado e pode ser ativado com um clique sem perder dados.
- **Regras (overrides) são independentes do padrão.** Uma empresa em padrão Mesas pode ter regras em modo Capacidade e vice-versa.
- **Empresa sem nenhuma configuração nova continua funcionando como hoje**: usa `opening_hours` + `table_maps` + `max_guests_per_slot` da `companies`. Zero quebra para empresas existentes.
- Cancelados (`status = 'cancelled'`), no-show (`status = 'no_show'`) e pagamento expirado **não contam** para a capacidade do slot.
- Pendentes (`status = 'pending'`), confirmadas (`status = 'confirmed'`) e pendentes de pagamento (`status = 'pending_payment'`) **contam** para capacidade.
- Bloqueio por data (`blocked_dates`) continua existindo com **precedência absoluta** sobre tudo.
- O WhatsApp para grandes grupos (`large_party_whatsapp_threshold`) continua sobrepondo o fluxo no modo capacity. Antes de checar capacidade, se o `party_size` excede o limite, redireciona para WhatsApp.

### Modelagem

- `weekday`: `0 = Domingo, 6 = Sábado` (bate com Postgres `EXTRACT(DOW)` e JavaScript `Date.getDay()`).
- **Soft delete via `archived_at timestamptz NULL`**, não `is_active boolean`. Preserva histórico.
- **Snapshot na reserva**: `reservations.applied_override_id` (FK para `reservation_overrides`, NULL se foi padrão) e `reservations.created_in_mode` (`'tables' | 'capacity' | NULL`). NULL = histórico pré-feature.
- Para o MVP, **uma faixa horária não pode se sobrepor a outra** dentro do mesmo conjunto (padrão ou regra). Validação no app + RPC.
- Reserva cruzando duas faixas adjacentes (ex.: 20:45 com duração de 30 min): **conta apenas na faixa do `time` de início** no MVP. UI alerta admin quando a faixa seguinte tem capacidade menor.
- **Duração da reserva permanece global** (`companies.reservation_duration`) no MVP. Override por faixa fica para v2.

### Prioridade de resolução

Ordem de aplicação para uma data `D`:

1. `blocked_dates` cobre `D` total ou parcialmente → bloqueia respectivos horários.
2. Override com `scope = 'date_specific'` e `start_date = D`, ativo → vence.
3. Override com `scope = 'date_range'` e `D BETWEEN start_date AND end_date`, ativo → vence.
4. Padrão da empresa (definido por `default_reservation_mode`):
   - Se `'capacity'`: usa `default_capacity_schedule` filtrado por `weekday`.
   - Se `'tables'`: usa `opening_hours` + `table_maps` (caminho atual).
5. Empate dentro do mesmo nível resolve por `priority` (menor vence) e depois `created_at` mais recente.
6. Se padrão é `'capacity'` mas o dia da semana não tem faixas configuradas: **fallback para `opening_hours`** + alerta visual na admin.

### Asaas (pagamento antecipado)

- Pagamento antecipado em modo Capacidade **não entra no MVP de Capacidade**. Será feature separada, posterior à entrega do capacity puro.
- Quando entrar, a regra é: reservas em `pending_payment` ocupam capacidade. Se expirar (10 min padrão), são canceladas e capacidade volta automaticamente (o cálculo deixa de contar).

## Modelo de dados

### Alterações em tabelas existentes

**`companies`**:

| Coluna | Tipo | Notas |
|---|---|---|
| `default_reservation_mode` | text DEFAULT `'tables'` CHECK IN (`'tables'`, `'capacity'`) | Define qual padrão está em uso. Empresas existentes recebem `'tables'`. |

**`reservations`**:

| Coluna | Tipo | Notas |
|---|---|---|
| `applied_override_id` | uuid NULL FK `reservation_overrides(id)` ON DELETE SET NULL | Aponta qual override estava ativo na criação. NULL = padrão. |
| `created_in_mode` | text NULL CHECK IN (`'tables'`, `'capacity'`) | Modo efetivo no momento da criação. NULL = histórico pré-feature. |

### Tabelas novas

**`default_capacity_schedule`** — padrão semanal de Capacidade da empresa.

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid FK `companies` ON DELETE CASCADE | |
| `weekday` | int NOT NULL CHECK 0..6 | 0=Dom, 6=Sáb |
| `start_time` | time NOT NULL | Início da faixa, ex.: 19:00 |
| `end_time` | time NOT NULL | Fim da faixa. > `start_time`. |
| `slot_interval_minutes` | int NOT NULL DEFAULT 30 | Intervalo entre horários ofertados. |
| `max_guests` | int NOT NULL | Limite de pessoas na faixa. |
| `max_reservations` | int NULL | Limite de reservas. NULL = ilimitado. |
| `min_party_size` | int NOT NULL DEFAULT 1 | |
| `max_party_size` | int NOT NULL DEFAULT 20 | |
| `last_booking_time` | time NULL | Fechamento antecipado. NULL = aceita até `end_time`. |
| `online_booking_enabled` | boolean DEFAULT true | |
| `archived_at` | timestamptz NULL | Soft delete |
| `created_at`, `updated_at` | timestamptz | |

Restrições: `end_time > start_time`, `max_party_size >= min_party_size`, UNIQUE `(company_id, weekday, start_time) WHERE archived_at IS NULL`. Validação de não-sobreposição entre faixas do mesmo `weekday` feita por RPC e validação no app.

**`reservation_overrides`** — regras pontuais que sobrepõem o padrão.

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid FK `companies` ON DELETE CASCADE | |
| `name` | text NOT NULL | Ex.: "Réveillon 2026", "Black Friday" |
| `mode` | text NOT NULL CHECK IN (`'tables'`, `'capacity'`) | |
| `scope` | text NOT NULL CHECK IN (`'date_specific'`, `'date_range'`) | |
| `start_date` | date NOT NULL | |
| `end_date` | date NOT NULL | Igual a `start_date` se `scope='date_specific'`. |
| `table_map_id` | uuid NULL FK `table_maps` ON DELETE SET NULL | Obrigatório se `mode='tables'`. NULL se `mode='capacity'`. |
| `priority` | int DEFAULT 100 | Menor vence empate. |
| `archived_at` | timestamptz NULL | |
| `created_at`, `updated_at` | timestamptz | |

Restrições: `end_date >= start_date`, CHECK coerência entre `mode` e `table_map_id`. UNIQUE `(company_id, name) WHERE archived_at IS NULL`. Index `(company_id, scope, start_date, end_date) WHERE archived_at IS NULL`.

**`override_capacity_slots`** — faixas de um override em modo Capacidade.

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `override_id` | uuid FK `reservation_overrides` ON DELETE CASCADE | |
| `start_time`, `end_time`, `slot_interval_minutes`, `max_guests`, `max_reservations`, `min_party_size`, `max_party_size`, `last_booking_time`, `online_booking_enabled` | (mesmas de `default_capacity_schedule`) | |
| `created_at`, `updated_at` | timestamptz | |

UNIQUE `(override_id, start_time)`.

### Tabelas que NÃO mudam

`opening_hours` (campo em `companies`), `restaurant_tables`, `table_maps`, `blocked_dates`, `waitlist`, `reservation_funnel_logs`.

## Fluxo de disponibilidade

### Modo `tables` (preservado)

Sem mudança significativa. A única diferença é que, quando há um override de modo `tables` ativo para a data, o `table_map_id` ativo passa a ser o do override em vez do resolvido por `get_active_table_map` (active_from/active_to). Empresas sem overrides seguem o caminho atual intacto.

### Modo `capacity` (novo)

1. **Resolução da configuração ativa** para data `D`:
   - RPC `resolve_active_schedule(company_id, date)` retorna:
     ```
     {
       source: 'override' | 'default' | 'fallback',
       override_id: uuid | NULL,
       mode: 'tables' | 'capacity',
       slots: [...] | NULL   // faixas, se mode=capacity
       table_map_id: uuid | NULL // se mode=tables
     }
     ```
2. **Geração de horários** (cliente): para cada faixa, gerar slots de `start_time` até `last_booking_time` (ou `end_time` se nulo), em passos de `slot_interval_minutes`.
3. **Ocupação por faixa**: RPC `get_capacity_slot_occupancy(company_id, date, slots_input jsonb)` retorna por faixa:
   - `guests_used` = SUM(party_size) de reservas elegíveis entre `start_time` e `end_time` da faixa.
   - `reservations_used` = COUNT(*) das mesmas.
4. **Cálculo de disponibilidade por horário**:
   - Disponível se `guests_used + party_size <= max_guests` E `(max_reservations IS NULL OR reservations_used + 1 <= max_reservations)` E `party_size BETWEEN min_party_size AND max_party_size` E `online_booking_enabled = true` E horário `<= last_booking_time` (quando definido).
5. **Validação no insert** (trigger `before_insert_reservation_check_capacity`): refaz o cálculo no server para impedir race condition. Rejeita com mensagem amigável se estoura.

## Estratégia localhost-first

A regra é **escrever e validar o máximo possível antes de qualquer migration ou edge function ir para produção**.

### Setup inicial (one-time, ~1h)

1. Instalar Supabase CLI e Docker Desktop.
2. Completar `supabase/config.toml` adicionando seções `[db]`, `[api]`, `[studio]`, `[auth]` faltantes.
3. `supabase start` → roda Postgres + PostgREST + Auth + Studio + Storage local.
4. `supabase db reset` aplica todas as migrations existentes no banco local.
5. Configurar `.env.development.local` com `VITE_SUPABASE_URL=http://localhost:54321` e a anon key local.
6. Verificar que o app conecta no Supabase local rodando `npm run dev`.

### Camadas de implementação por ordem de risco (do mais seguro pro menos)

| Camada | Banco necessário? | Onde testa | Quando vai pra prod |
|---|---|---|---|
| 1. Lógica pura em `src/lib/` (resolução de prioridades, cálculo de slots, validação de overlap) | Não | Vitest | Junto com a UI |
| 2. Tipos TypeScript e interfaces compartilhadas | Não | TS compiler | Junto com a UI |
| 3. Componentes UI com mocks (admin de configuração) | Não | Playwright/manual + Storybook se quiser | Junto com a UI |
| 4. Migration de schema (novas tabelas + colunas) | Sim, local | `supabase db reset` + SQL manual | Após camada 7 aprovada |
| 5. RPCs (`resolve_active_schedule`, `get_capacity_slot_occupancy`, `validate_capacity_reservation`) | Sim, local | psql + supabase client local | Após camada 7 aprovada |
| 6. Trigger de validação | Sim, local | INSERT manual via SQL | Após camada 7 aprovada |
| 7. UI integrada (admin + público) conectada no local | Sim, local | Manual + E2E | Aprovação → janela de deploy |
| 8. Edge functions novas (se houver) | Sim, local + `functions serve` | `curl` local | Após camada 7 |
| 9. Asaas em modo capacity (feature posterior) | Sim, local + ngrok pra webhook | Manual com sandbox Asaas | Após capacity em prod estável |

### Política de deploy

- Camadas 1–7 ficam em branch local até estarem **completamente funcionais e revisadas**.
- Camada 7 só vira commit em main quando o usuário aprovar testando localmente.
- Migration em prod (`supabase db push`) acontece em **uma única janela**, junto com deploy da UI e edge functions correspondentes.
- Runbook de deploy é criado antes da janela (modelo: `supabase/RESERVATION_PREPAYMENT_DEPLOY_RUNBOOK.md`).
- Cada camada cria uma seção no runbook com rollback.

### Limitações da abordagem local

- Webhooks externos (Asaas) precisam de ngrok ou similar para chegar no `functions serve` local. Adequado para validação, não para load test.
- RLS testing com múltiplos usuários reais requer criar contas no Auth local (Studio facilita).
- Performance em escala (mil reservas por dia) só é validável em staging real. Mas o algoritmo correto é validável local.

## Impactos no fluxo atual e em integrações

| Sistema/Tela | Impacto | Tratamento |
|---|---|---|
| `companies.opening_hours` | Continua. Vira fallback de modo tables sem schedule, e fallback de modo capacity quando `default_capacity_schedule` não cobre o dia. | Sem mudança no schema. |
| `companies.max_guests_per_slot` | Continua. Fallback de modo tables. Irrelevante em modo capacity. | Sem mudança. |
| `companies.reservation_duration` | Continua. Define duração padrão de toda reserva. | Sem mudança no MVP. |
| `table_maps.active_from/active_to` | Continua. Só se aplica quando o modo é `tables` E não há override de mesa explícito. | Documentar interação. |
| `reservations.table_id` | Pode ser NULL em mais reservas. Já é permitido. | Tratar nas telas internas. |
| `reservations` (nova coluna `applied_override_id`) | Permite auditoria. | Coluna nova nullable. |
| `reservations` (nova coluna `created_in_mode`) | Permite filtros e exibição. | Coluna nova nullable. |
| `blocked_dates` | Continua. Precedência absoluta. | Sem mudança. |
| **`ReservationModal.tsx`** | Refator: consulta `resolve_active_schedule` antes de gerar slots. Caminho atual é fallback. | Mudança grande nesse arquivo. |
| **`CompanySettings.tsx` — aba Reservas/Agenda** | Refator: nova aba "Programação". Padrão de Mesas e padrão de Capacidade lado a lado. Toggle de modo padrão. Lista de overrides. | Mudança grande. |
| **Lista de espera (`waitlist`)** | Em modo capacity, cliente entra na fila quando bate `max_guests` ou `max_reservations`. Lógica nova no modal. | Adaptar lógica. |
| **`Reservations.tsx` (listagem interna)** | Reservas sem `table_id` precisam ser exibidas como "por capacidade". Badge ou ícone. | Componente de linha. |
| **Calendário interno** | Idem. Filtros precisam tratar `table_id IS NULL`. | UI ajuste. |
| **Mapa de mesas (`Tables.tsx`)** | Reservas de capacity **não aparecem no mapa**. Banner com contagem: "12 reservas por capacidade hoje, não visíveis no mapa". | Banner + link para listagem filtrada. |
| **Check-in** | Operador atribui mesa manualmente quando cliente de capacity chega. Fluxo opcional. | Componente novo de atribuição. |
| **Edição de reserva pelo operador** | Mudar `time` ou `party_size` precisa revalidar capacidade. Trigger cobre. | Mensagem amigável no erro. |
| **Importação em massa de reservas** | Pode estourar capacidade. Decisão MVP: importação **bypassa** validação, com aviso na UI. | Flag no parâmetro da função de import. |
| **Funil de tracking** | Sem impacto. Passos são os mesmos. | — |
| **Lembretes / pós-visita / aniversário** | Sem impacto. Leem só `reservations`. | — |
| **WhatsApp grande grupo** | Continua sobrepondo. | — |
| **Pré-pagamento Asaas** | **Feature posterior.** Modo capacity entra primeiro sem Asaas. Quando Asaas entrar em capacity: pending_payment ocupa capacidade, expiração libera. | Plano separado de implementação após capacity em prod. |

## Mudanças na UI

### Aba "Programação" (novo, substitui o que está hoje em "Reservas" + "Agenda")

```
┌─────────────────────────────────────────────────────────┐
│ Programação                                             │
├─────────────────────────────────────────────────────────┤
│ Modo padrão da empresa:  ◉ Por mesas  ○ Por capacidade  │
│                                                         │
│ ┌─ Padrão por mesas ──────────────────────────────────┐ │
│ │ Horários de funcionamento (já existe)              │ │
│ │ Mapa de mesas padrão: [seleção]                    │ │
│ │ Limite global de convidados por slot: [valor]      │ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Padrão por capacidade ────────────────────────────┐ │
│ │ Por dia da semana, configure os giros (faixas):    │ │
│ │  • Dom  [+ adicionar faixa]                        │ │
│ │  • Seg  [+ adicionar faixa]                        │ │
│ │  • Ter  19:00-22:00 100p/30 reservas [editar]      │ │
│ │  • ...                                             │ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│ Regras pontuais (overrides)                             │
│ ┌────────────────────────────────────────────────────┐ │
│ │ Réveillon 2026  31/12/2026  Capacidade  [editar]   │ │
│ │ Black Friday    24-26/11    Mesas       [editar]   │ │
│ │ [+ Nova regra]                                     │ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│ Datas bloqueadas (mantido)                              │
└─────────────────────────────────────────────────────────┘
```

### Editor de faixa (giro)

Modal ou sheet com:

- Horário mínimo / Horário máximo (`start_time` / `end_time`)
- Intervalo de agendamento (`slot_interval_minutes`)
- Limite de pessoas (`max_guests`)
- Limite de reservas (`max_reservations`) — campo com toggle "ilimitado"
- Capacidade mínima por reserva (`min_party_size`)
- Capacidade máxima por reserva (`max_party_size`)
- Fechamento antecipado (`last_booking_time`) — toggle "usar fim da faixa"
- Toggle "Reserva online" (`online_booking_enabled`)
- Botão "Copiar configurações de outro giro" (dentro da mesma página)

### Editor de override (regra)

Sheet ou rota dedicada com:

- Nome
- Escopo (data específica / intervalo) e datas
- Modo (mesas / capacidade)
- Se mesas: selector de `table_map`
- Se capacidade: lista de faixas (mesmo editor acima)
- Prioridade
- Botão arquivar

### Página pública (`ReservationModal`)

Mudança visível mínima:

- Em modo capacity, o card de confirmação não menciona mesa. Texto: "Reserva confirmada para [data] às [hora] para [N] pessoas".
- Indicador de vagas restantes opcional ("3 lugares restantes nesta faixa") → **fora do MVP**.

### Telas internas

- `Reservations.tsx`: badge "Por capacidade" em reservas com `created_in_mode = 'capacity'`.
- Calendário: filtro "Apenas com mesa" / "Apenas por capacidade".
- Mapa de mesas: banner "X reservas por capacidade hoje" com link para listagem filtrada.

## RPCs e validações

| RPC | Assinatura | Propósito |
|---|---|---|
| `resolve_active_schedule(company_id uuid, target_date date)` | Retorna `{ source, override_id, mode, slots jsonb, table_map_id }` | Núcleo da resolução de prioridade. Usada pelo modal público e pelas telas internas. |
| `get_capacity_slot_occupancy(company_id uuid, target_date date, slots_input jsonb)` | Retorna `[{ slot_index, guests_used, reservations_used }]` | Usado pelo modal para calcular disponibilidade. |
| `validate_capacity_reservation(company_id uuid, target_date date, target_time time, party_size int)` | Retorna boolean + reason text | Server-side validation. Chamada pelo trigger. |
| `get_public_company_by_slug(slug)` (atualizar) | Adicionar campo `default_reservation_mode` no retorno | Para o modal saber o modo. |

Trigger:

- `before_insert_reservation_check_capacity` em `reservations`: se o modo efetivo (resolvido pelo trigger) for `'capacity'`, chama `validate_capacity_reservation` e aborta com erro amigável se não couber. Também roda em UPDATE quando `party_size`, `time` ou `date` mudam.

RLS:

- `default_capacity_schedule`, `reservation_overrides`, `override_capacity_slots`:
  - SELECT público apenas via RPCs SECURITY DEFINER (caminho do `get_public_company_by_slug`).
  - INSERT/UPDATE/DELETE para usuários admin ou operador com permissão "Configurações".

## Fases de implementação

### Fase 0 — Setup localhost + alinhamento (sem código de produto)

- Completar `supabase/config.toml` para suportar `supabase start` local.
- Validar fluxo: `supabase start` → `supabase db reset` → app conectando no local.
- Confirmar copy em PT-BR de todos os campos.
- Mockup da aba "Programação" (esboço HTML ou Figma).

### Fase 1 — Lógica pura e tipos (sem migration)

- `src/lib/reservation-schedule.ts`: tipos `Schedule`, `CapacitySlot`, `Override`, função `resolveActiveSchedule()` (lógica de prioridade), função `generateCapacityTimeSlots()`.
- `src/lib/reservation-availability.ts`: cálculo client-side de disponibilidade por slot.
- Testes Vitest cobrindo: resolução de prioridade, overlap de faixas, geração de slots, edge cases (faixa sem `last_booking_time`, `max_reservations=NULL`).

### Fase 2 — UI admin com mocks (sem banco)

- Componentes da aba "Programação" com dados estáticos.
- Editor de faixa e editor de override.
- Validação de não-sobreposição no client.
- Storybook ou rota de dev para visualizar isolado.

### Fase 3 — Migration local

- Migration nova com as 2 tabelas + 2 colunas em `reservations` + 1 coluna em `companies`.
- RPCs `resolve_active_schedule`, `get_capacity_slot_occupancy`, `validate_capacity_reservation`.
- Trigger `before_insert_reservation_check_capacity`.
- RLS policies.
- Aplicar apenas no Supabase local via `supabase db reset`.
- Testar via psql/Studio: INSERT direto, chamada de RPC.

### Fase 4 — Conectar UI admin ao banco local

- Substituir mocks por chamadas reais.
- CRUD funcional de padrão capacity, overrides, faixas.
- Indicador visual quando override sobrepõe padrão.

### Fase 5 — Adaptar fluxo público

- `ReservationModal` consulta `resolve_active_schedule` na seleção de data.
- Gerar slots a partir da configuração ativa.
- Calcular disponibilidade com `get_capacity_slot_occupancy`.
- Fallback intacto para empresas sem nada configurado.
- Teste manual local: empresa A (sem nada), B (default capacity), C (default tables + override capacity).

### Fase 6 — Adaptar telas internas

- Badge "Por capacidade" em `Reservations.tsx`.
- Filtros no calendário.
- Banner no mapa de mesas.
- Fluxo de atribuição de mesa em check-in.
- Edição de reserva pelo operador disparando revalidação.

### Fase 7 — Validação completa local + revisão

- Walkthrough do usuário (você) no localhost com cenários reais.
- Checklist de regressão: empresa atual sem mudança continua igual.
- Performance check: tempo de carregamento do modal público.
- Aprovação para ir pra prod.

### Fase 8 — Deploy de produção

- Runbook escrito em `supabase/CAPACITY_MODE_DEPLOY_RUNBOOK.md` com passos e rollback.
- Janela combinada: `supabase db push` + deploy do front + deploy de edge functions (se houver).
- Monitoramento na primeira semana: contagem de erros do trigger, taxa de uso por modo, alertas de capacidade.

### Fase 9 — Polish e features adjacentes (pós-prod)

- Indicador de vagas restantes na página pública.
- Botão "Gerar regra semanal a partir das configurações atuais" para conversão automática.
- Importação de configuração entre datas.
- Telemetria de adoção e métricas.

### Fase 10 — Asaas em modo capacity (separada)

- Plano próprio em outro doc.
- Premissas: capacity em prod estável + pending_payment integrado ao cálculo de capacidade.

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Empresas existentes verem comportamento diferente após deploy | Fallback total quando não há configuração nova. Zero migração automática. |
| Reservas concorrentes estourarem o limite (race condition) | Validação no insert via trigger refazendo o cálculo server-side. |
| UI ficar confusa com dois padrões + overrides | Aba dedicada, copy clara, mockup antes de codar. |
| Cliente reservar e mesa não estar atribuída no atendimento | Banner visível no mapa de mesas + fluxo de atribuição manual no check-in. |
| Duração de reserva cruzando faixas gera ambiguidade | Decidir explicitamente que a faixa do `time` de início é a que conta. Documentar e avisar admin na UI. |
| Sobreposição entre overrides gera resultado inesperado | Logging do schedule resolvido + alerta visual na UI quando há conflito. |
| Asaas quebrar quando capacity entrar em prod | Asaas em modo capacity é feature **posterior**, separada. Capacity puro vai primeiro. |
| Setup localhost atrasar o início | Fase 0 dedicada e isolada. Pode ser feita em paralelo ao alinhamento de copy. |

## Métricas de sucesso

- Adoção: % de empresas com `default_reservation_mode = 'capacity'` ou com pelo menos um override capacity após 60 dias.
- Erros: taxa de inserts rejeitados por validação de capacidade (deve cair com o tempo conforme admins ajustam limites).
- Conversão: comparar funil de empresas em modo capacity vs. modo tables.
- Suporte: número de chamados relacionados a "minha reserva sumiu" ou "mesa não foi atribuída".

## Próximos passos imediatos

1. Aprovar este documento.
2. Mockup da aba "Programação" (esboço rápido).
3. Iniciar Fase 0: setup do Supabase local.
4. Iniciar Fase 1: lógica pura e tipos em paralelo ao mockup.
