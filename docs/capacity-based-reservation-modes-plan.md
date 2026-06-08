# Plano: regras de reserva por mesas ou por quantidade

## Objetivo

Permitir que uma empresa continue usando o mapa de mesas como comportamento padrão, sem configuração adicional, mas possa criar regras soberanas para datas, períodos ou dias da semana específicos.

Cada regra de horários escolhe como a disponibilidade pública será controlada:

1. **Por mesas**: mantém o comportamento atual. O mapa ativo, as mesas compatíveis livres e os limites configurados determinam a disponibilidade.
2. **Por quantidade**: a regra substitui o mapa de mesas. A disponibilidade é determinada pelos limites de pessoas e de reservas configurados para cada horário.

Exemplo:

```text
Evento em 12/06/2026
Modo: Por quantidade

18:00
Limite total de pessoas: 200
Máximo de pessoas por reserva: 2
Máximo de reservas: 100
```

Nesse exemplo, o sistema aceita novas reservas até atingir `200` pessoas ou `100` reservas, o que ocorrer primeiro. Não é necessário existir disponibilidade equivalente no mapa mensal.

## Contexto atual

As regras explícitas de horários já estão implementadas em:

- `reservation_schedule_rules`
- `reservation_schedule_rule_slots`
- `get_public_reservation_schedule(company_id, date)`
- `get_public_reservation_availability(company_id, date, party_size)`
- `create_public_reservation(reservation, status)`
- `ReservationScheduleRulesCard.tsx`

O modelo atual já suporta:

- regra semanal;
- regra para data específica;
- regra para intervalo de datas;
- prioridade;
- ativação e desativação;
- lista explícita de horários;
- máximo de pessoas por reserva;
- máximo de reservas por horário;
- fallback para `companies.opening_hours`;
- bloqueios por data ou faixa de horário;
- validação transacional para criação pública;
- pré-reserva com `pending_payment`.

Hoje, porém, toda reserva pública ainda exige uma mesa válida. Os limites configurados na regra funcionam como tetos adicionais, mas não substituem o mapa ativo.

## Decisões fechadas

### Compatibilidade

- Empresas existentes continuam funcionando sem qualquer configuração nova.
- Sem regra aplicável, o sistema usa `opening_hours`, o mapa mensal ativo e as mesas livres.
- Regras já existentes recebem `availability_mode = 'tables'`.
- Preencher `max_reservations_per_slot` não muda automaticamente uma regra para quantidade.
- O modo deve ser escolhido explicitamente para evitar alteração silenciosa de comportamento.

### Regra soberana

- Quando uma regra publicada corresponde à data consultada, seus horários substituem os horários padrão.
- Se a regra estiver no modo `tables`, o mapa ativo continua obrigatório.
- Se a regra estiver no modo `capacity`, o mapa ativo deixa de limitar a criação da reserva.
- Em `capacity`, a reserva pode ser criada com `table_id = NULL`.
- `blocked_dates` continua tendo precedência absoluta sobre os dois modos.
- O redirecionamento para WhatsApp de grandes grupos continua tendo precedência no fluxo público.

### Limites no modo `capacity`

Para cada horário:

- `max_guests_per_slot`: obrigatório. Limite físico de pessoas simultaneamente atendidas.
- `max_reservations_per_slot`: opcional. Limite de reservas iniciadas naquele horário. `NULL` significa sem limite adicional.
- `max_party_size_per_reservation`: opcional. Pode herdar o padrão da regra ou sobrescrever por horário.

Exemplo:

```text
Limite total: 200 pessoas
Máximo de reservas: 100
Máximo por reserva: 2 pessoas
```

O teto teórico é `200` pessoas, mas a quantidade efetiva pode ser menor se o limite de `100` reservas for atingido por grupos de uma pessoa.

### Sobreposição por duração

No modo `capacity`, o limite total de pessoas deve considerar reservas com intervalos sobrepostos, usando `reservations.duration_minutes`.

Exemplo:

```text
Duração padrão: 120 minutos
Capacidade: 200 pessoas

Reserva A: 18:00 até 20:00
Nova tentativa: 18:30
```

A reserva das `18:00` conta para a capacidade das `18:30`, pois os períodos se sobrepõem.

O limite `max_reservations_per_slot` continua contando somente reservas iniciadas exatamente no horário configurado. Ele controla o volume de chegadas por horário, enquanto `max_guests_per_slot` controla ocupação simultânea.

### Duração da reserva x intervalo da grade

O produto deve separar dois conceitos que hoje estão acoplados em `companies.reservation_duration`:

1. **Duração padrão da reserva**: quanto tempo uma reserva ocupa mesa ou capacidade.
2. **Intervalo da grade pública**: de quanto em quanto tempo os horários são exibidos quando não há uma lista explícita de horários.

Hoje, `companies.reservation_duration` é usado tanto para gerar horários no fallback quanto como `reservations.duration_minutes` na criação pública. Isso gera risco operacional: se a empresa configura `60` para exibir horários de hora em hora, mas a mesa fica ocupada por `120` minutos, o sistema pode liberar mesa/capacidade cedo demais.

Decisão:

- `companies.reservation_duration` passa a significar somente duração padrão da reserva.
- criar `companies.reservation_slot_interval_minutes` para controlar o intervalo da grade pública padrão.
- no backfill, `reservation_slot_interval_minutes` deve receber o valor atual de `reservation_duration` para preservar o comportamento existente.
- regras com horários explícitos continuam persistindo a lista final de horários; o intervalo do gerador é uma conveniência da UI, não a fonte de verdade.
- regras podem sobrescrever a duração padrão da empresa, e cada horário pode sobrescrever a duração da regra.

Exemplo seguro:

```text
Intervalo da grade: 60 minutos
Duração da reserva: 120 minutos
Horários exibidos: 18:00, 19:00, 20:00

Reserva 18:00 ocupa mesa/capacidade até 20:00.
O horário 19:00 só aparece como disponível se ainda houver mesa/capacidade livre considerando essa sobreposição.
```

### Estados e publicação

Uma regra possui duas dimensões distintas:

1. **Escopo de atendimento**: para quais datas de reserva ela vale.
2. **Publicação**: a partir de quando ela pode alterar o fluxo público.

Estados exibidos na administração:

| Estado | Condição | Efeito |
|---|---|---|
| `Rascunho` | `enabled = false` | Salva, mas nunca participa da resolução. |
| `Agendada` | `enabled = true` e `publish_at > now()` | Passará a participar automaticamente na data e hora configuradas. |
| `Publicada` | `enabled = true` e (`publish_at IS NULL` ou `publish_at <= now()`) | Já participa da resolução para datas de reserva compatíveis com seu escopo. |
| `Encerrada` | Regra publicada cujo período terminou | Mantida para histórico, sem efeito em novas reservas. |
| `Arquivada` | `archived_at IS NOT NULL` | Fora da listagem principal e da resolução. |

Ao salvar, a interface oferece:

```text
Publicação:
( ) Salvar como rascunho
( ) Publicar imediatamente
( ) Agendar publicação
```

Uma regra publicada imediatamente para `12/06/2026` já altera, no mesmo instante, a disponibilidade exibida para clientes que consultarem reservas em `12/06/2026`, mesmo que a data ainda esteja no futuro.

Timestamps devem ser persistidos como `timestamptz`. A UI deve apresentar a data e hora no fuso operacional adotado pela aplicação.

## Prioridade de resolução

Para uma empresa `C`, uma data de reserva `D` e o instante atual `now()`:

1. Se `blocked_dates` bloquear o dia inteiro, não oferecer horários.
2. Resolver a primeira regra elegível com `archived_at IS NULL`, `enabled = true` e (`publish_at IS NULL` ou `publish_at <= now()`):
   - regra `date_specific` para `D`;
   - regra `date_range` contendo `D`;
   - regra `weekly` contendo o dia da semana de `D`.
3. Em empate dentro do mesmo nível, ordenar por `priority ASC, created_at DESC`.
4. Se não houver regra elegível, usar `companies.opening_hours` e modo `tables`.
5. Para cada horário, aplicar bloqueios parciais de `blocked_dates`.

Resumo:

```text
bloqueio total
  > regra de data específica publicada
  > regra de período publicada
  > regra semanal publicada
  > fallback por mesas
```

## Modelo de dados

### Alterações em `reservation_schedule_rules`

| Coluna | Tipo | Regra |
|---|---|---|
| `availability_mode` | text NOT NULL DEFAULT `'tables'` | CHECK IN (`'tables'`, `'capacity'`). |
| `publish_at` | timestamptz NULL | `NULL` com `enabled = true` significa publicação imediata. |
| `default_duration_minutes` | integer NULL | Duração padrão das reservas criadas pela regra. `NULL` herda `companies.reservation_duration`. |

As colunas atuais permanecem:

- `scope`
- `weekdays`
- `start_date`
- `end_date`
- `enabled`
- `priority`
- `max_party_size_per_reservation`
- `archived_at`

### Alterações em `reservation_schedule_rule_slots`

| Coluna | Tipo | Regra |
|---|---|---|
| `duration_minutes` | integer NULL | Duração das reservas iniciadas neste horário. `NULL` herda `reservation_schedule_rules.default_duration_minutes` e depois `companies.reservation_duration`. |
| `max_guests_per_slot` | integer NULL | Obrigatório para cada horário quando a regra usa `capacity`. |

As colunas atuais permanecem:

- `time`
- `sort_order`
- `max_party_size_per_reservation`
- `max_reservations_per_slot`

### Alterações em `reservations`

| Coluna | Tipo | Regra |
|---|---|---|
| `applied_schedule_rule_id` | uuid NULL FK `reservation_schedule_rules(id)` ON DELETE SET NULL | Snapshot da regra aplicada na criação pública. |
| `created_in_mode` | text NULL | CHECK IN (`'tables'`, `'capacity'`). `NULL` identifica histórico anterior à funcionalidade. |

`reservations.table_id` já aceita `NULL`. Nenhuma alteração estrutural adicional é necessária nessa coluna.

### Alterações em `companies`

| Coluna | Tipo | Regra |
|---|---|---|
| `reservation_slot_interval_minutes` | integer NOT NULL DEFAULT 30 | Intervalo da grade pública padrão quando não há regra aplicável. |

Backfill:

```sql
UPDATE public.companies
SET reservation_slot_interval_minutes = COALESCE(reservation_slot_interval_minutes, reservation_duration, 30);
```

Depois da migration:

- `reservation_duration` controla ocupação;
- `reservation_slot_interval_minutes` controla geração de horários padrão.

### Estruturas descartadas do plano anterior

Não criar:

- `companies.default_reservation_mode`;
- `default_capacity_schedule`;
- `reservation_overrides`;
- `override_capacity_slots`.

Essas estruturas duplicariam responsabilidades já atendidas por `reservation_schedule_rules` e `reservation_schedule_rule_slots`.

## Fluxo de disponibilidade pública

### Resolução inicial

Atualizar `get_public_reservation_schedule(company_id, date)` para retornar também:

```text
availability_mode
publish_at
```

O fallback sem regra retorna:

```text
source = 'default'
rule_id = NULL
availability_mode = 'tables'
```

### Modo `tables`

Preservar o comportamento atual:

1. Gerar os horários da regra ou do fallback.
2. Resolver o mapa mensal ativo.
3. Buscar mesas compatíveis com `party_size`.
4. Remover mesas ocupadas por reservas sobrepostas.
5. Usar a duração resolvida do horário para calcular sobreposição.
6. Aplicar `companies.max_guests_per_slot`.
7. Aplicar `max_party_size_per_reservation`.
8. Aplicar `max_reservations_per_slot`.
9. Aplicar bloqueios.

A criação pública continua exigindo `table_id`.

### Modo `capacity`

Para cada horário permitido:

1. Não consultar mesas para decidir disponibilidade.
2. Resolver a duração efetiva do horário.
3. Somar `party_size` das reservas que ocupam capacidade e cujo intervalo sobrepõe o intervalo da nova reserva.
4. Contar reservas iniciadas exatamente no horário.
5. Aplicar `max_guests_per_slot`.
6. Aplicar `max_reservations_per_slot`, quando preenchido.
7. Aplicar `max_party_size_per_reservation`, quando preenchido.
8. Aplicar bloqueios.

A criação pública aceita `table_id = NULL`.

Reservas com os seguintes estados contam para ocupação enquanto forem válidas:

- `pending`
- `confirmed`
- `pending_payment`

Reservas canceladas, expiradas ou marcadas como no-show não contam.

### Concorrência

`create_public_reservation` deve continuar validando no servidor, dentro da mesma transação da inserção.

No modo `tables`, manter:

- lock por empresa, data e horário;
- lock por mesa e data;
- revalidação da mesa antes do insert.

No modo `capacity`, usar lock por empresa e data antes de recalcular a capacidade. Um lock apenas por horário não é suficiente, pois duas reservas concorrentes em horários diferentes podem ter duração sobreposta.

## Interface administrativa

### Aba `Programação`

Criar uma aba dedicada e mover para ela o conteúdo atual de `ReservationScheduleRulesCard`.

Estrutura sugerida:

```text
Programação de reservas

Sem uma regra aplicável, a disponibilidade é controlada
pelo mapa mensal de mesas.

Regras semanais
  - Jantar de sexta       Por mesas       Publicada

Exceções por data ou período
  - Evento 12/06          Por quantidade  Agendada

[ Nova regra ]
```

Não criar uma segunda tela de regras concorrente. A tela existente deve evoluir.

### Editor da regra

Manter:

- nome;
- recorrência semanal, data específica ou período;
- prioridade;
- horários explícitos;
- gerador de horários por intervalo;
- duração padrão da reserva nesta regra;
- máximo padrão de pessoas por reserva;
- ativação e arquivamento.

Adicionar:

- modo de disponibilidade: `Por mesas` ou `Por quantidade`;
- publicação: `Rascunho`, `Publicar imediatamente` ou `Agendar publicação`;
- data e hora de publicação, quando agendada;
- badge de estado na listagem;
- badge do modo na listagem.

### Editor dos horários

Modo `tables`:

| Horário | Duração | Máx. pessoas por reserva | Máx. reservas |
|---|---|---|---|
| 18:00 | Herda o padrão | Herda o padrão | Sem limite |

Modo `capacity`:

| Horário | Duração | Limite total de pessoas | Máx. pessoas por reserva | Máx. reservas |
|---|---|---|---|---|
| 18:00 | 120 min | 200 | 2 | 100 |

Adicionar ação para replicar os valores de um horário aos demais horários da regra.

O intervalo configurado no gerador cria ou recria a lista de horários. Depois de gerada, a disponibilidade usa os horários explícitos e a duração configurada, não o intervalo do gerador.

## Modal público

### Modo `tables`

Preservar:

- consulta de mesas;
- seleção automática da menor mesa compatível;
- mensagens de disponibilidade de mesa;
- criação com `table_id`.

### Modo `capacity`

Alterar:

- não buscar ou selecionar mesa;
- não bloquear avanço por ausência de `selectedTableId`;
- exibir lotação com base nos limites da regra;
- criar reserva com `table_id = NULL`;
- omitir texto de mesa na confirmação.

O cliente não precisa saber se a operação interna usa mesa ou quantidade. A diferença pública deve aparecer somente quando necessária para explicar indisponibilidade.

## Pré-pagamento

O fluxo de pré-pagamento deve funcionar nos dois modos desde a entrega da funcionalidade.

Regras:

- `pending_payment` válido ocupa capacidade;
- pagamento expirado libera capacidade automaticamente;
- `create-reservation-payment` continua chamando `create_public_reservation`;
- uma pré-reserva em modo `capacity` aceita `table_id = NULL`;
- a confirmação de pagamento não deve procurar conflito de mesa quando `table_id IS NULL`;
- expiração e cancelamento devem manter o snapshot `created_in_mode`.

Validar o fluxo completo com PIX e cartão no sandbox antes do deploy.

## Telas internas

### Lista e calendário

- Exibir badge `Por quantidade` quando `created_in_mode = 'capacity'`.
- Tratar `table_id = NULL` sem mensagem enganosa.
- Permitir filtrar reservas com mesa e por quantidade.

### Mapa de mesas

- Reservas por quantidade não ocupam uma mesa automaticamente.
- Exibir contador informativo para reservas por quantidade na data selecionada.
- A atribuição manual de mesa no check-in pode ser implementada como evolução separada.

### Reservas criadas pelo operador

Decisão inicial:

- regras controlam obrigatoriamente a criação pública;
- reservas internas continuam podendo ser inseridas pelo operador;
- reservas internas válidas contam na ocupação usada para novas reservas públicas;
- a interface interna deve alertar quando uma inclusão manual ultrapassar a capacidade configurada.

Uma trava obrigatória para operações internas pode ser adicionada depois, com permissão explícita de override.

## RPCs e validações

### Atualizar

| RPC | Alteração |
|---|---|
| `get_public_reservation_schedule(company_id, date)` | Ignorar regras não publicadas e retornar `availability_mode`. |
| `get_public_reservation_availability(company_id, date, party_size)` | Ramificar cálculo entre mesas e quantidade e usar duração efetiva por horário. |
| `create_public_reservation(reservation, status)` | Exigir mesa somente em `tables`; validar quantidade; aceitar `table_id = NULL` em `capacity`; gravar `duration_minutes` resolvido. |
| `upsert_reservation_schedule_rule(...)` | Persistir `availability_mode`, `publish_at`, `default_duration_minutes`, `duration_minutes` por horário e `max_guests_per_slot`. |

### Preservar

- advisory locks;
- bloqueios totais e parciais;
- limites de tamanho de grupo;
- prioridade de regras;
- expiração de `pending_payment`;
- RLS atual das regras.

### Mensagens públicas

Retornar mensagens específicas:

- `Horário bloqueado para reservas.`
- `Este horário aceita reservas online de até N pessoas.`
- `Limite de reservas atingido para este horário.`
- `Limite de pessoas atingido para este horário.`
- `Mesa indisponível para este horário.`

## Fases de implementação

### Fase 0 - Alinhamento e baseline

- Confirmar este plano.
- Registrar testes manuais do comportamento atual por mesas.
- Aplicar migrations existentes em Supabase local.

### Fase 1 - Migration e tipos

- Adicionar colunas nas tabelas existentes.
- Separar `reservation_duration` de `reservation_slot_interval_minutes`.
- Migrar regras atuais para `availability_mode = 'tables'`.
- Atualizar tipos gerados do Supabase.
- Atualizar tipos de hooks e funções puras.

### Fase 2 - RPCs locais

- Atualizar resolução de regra publicada.
- Atualizar disponibilidade por modo.
- Atualizar criação pública transacional.
- Adicionar lock por empresa e data em `capacity`.
- Testar concorrência e sobreposição por duração.

### Fase 3 - Aba `Programação`

- Mover a tela atual de regras para a aba dedicada.
- Adicionar seletor de modo.
- Adicionar publicação imediata, rascunho e agendamento.
- Adicionar duração padrão por regra e duração opcional por horário.
- Adicionar limite total de pessoas em horários de `capacity`.
- Adicionar badges e ação de replicar valores.

### Fase 4 - Modal público

- Preservar caminho atual de mesas.
- Adicionar caminho sem mesa para `capacity`.
- Ajustar indicadores de lotação e confirmação.
- Garantir fallback intacto sem regras.

### Fase 5 - Pré-pagamento e telas internas

- Validar pré-reserva, PIX, cartão, expiração e cancelamento nos dois modos.
- Adicionar badges e filtros internos.
- Adicionar contador informativo no mapa de mesas.

### Fase 6 - Validação e deploy

- Rodar suíte automatizada.
- Executar matriz manual em Supabase local.
- Revisar RLS e permissões.
- Preparar migration de produção e rollback.
- Monitorar rejeições por limite após deploy.

## Matriz mínima de testes

| Cenário | Resultado esperado |
|---|---|
| Empresa sem regras | Continua usando mesas e `opening_hours`. |
| Regra antiga | Continua usando mesas após migration. |
| Regra `tables` com máximo de reservas | Fecha ao atingir o limite ou ao acabar mesas, o que ocorrer primeiro. |
| Regra `capacity` com 200 pessoas e 100 reservas | Ignora o mapa e fecha no primeiro limite atingido. |
| Regra `capacity` com horários sobrepostos | Considera ocupação pela duração. |
| Duração 120 min com grade 60 min | Reserva das 18:00 ocupa mesa/capacidade também às 19:00. |
| Regra desativada | Não altera disponibilidade. |
| Regra agendada para o futuro | Não altera disponibilidade antes de `publish_at`. |
| Regra publicada para data futura | Altera imediatamente consultas para essa data. |
| Bloqueio parcial | Remove somente horários cobertos. |
| `pending_payment` válido | Ocupa vaga. |
| Pagamento expirado | Libera vaga. |
| Duas criações concorrentes no limite | Somente a criação que cabe é aceita. |

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Regra existente mudar de comportamento | Default e migration explícitos para `tables`. |
| Campo antigo continuar ambíguo | Separar duração de reserva e intervalo da grade, com backfill preservando o valor atual. |
| Venda acima da capacidade em horários adjacentes | Contar sobreposição por duração e usar lock por empresa/data. |
| Modal continuar exigindo mesa em `capacity` | Separar claramente os caminhos e cobrir com teste de integração. |
| Pré-pagamento segurar vaga após expiração | Reusar expiração existente e testar liberação automática. |
| Operador não perceber reservas sem mesa | Badge, filtro e contador no mapa. |
| Duas telas de regras divergirem | Evoluir `ReservationScheduleRulesCard` como única fonte administrativa. |

## Fora do primeiro escopo

- modo global padrão por quantidade sem regra;
- ambientes independentes com capacidade própria;
- capacidade mínima por reserva;
- atribuição automática de mesa para reservas por quantidade;
- bloqueio rígido de operações internas acima da capacidade.

Esses itens podem ser adicionados depois sem alterar a decisão central: mesas são o fallback e regras publicadas podem substituir o mapa de forma explícita.
