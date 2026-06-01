# Plano: regras de horarios de reserva

## Objetivo

Permitir que a empresa configure os horarios de reserva online por regras explicitas, sem depender apenas de `inicio + fim + intervalo`.

O caso principal que precisa funcionar:

```text
Terca a quinta: 18:00, 19:30, 20:30, 21:30
Sexta: 18:00, 18:30, 21:30
Sabado: 18:00, 21:00
Domingo: 18:00, 19:30, 20:30, 21:30
```

A regra define quais horarios aparecem. A disponibilidade continua sendo calculada por mesas, reservas existentes, bloqueios e limite de pessoas por horario.

## Estado atual

Hoje existe `reservation_schedule_overrides`, que permite criar regra pontual por data com:

- `date`
- `start_time`
- `end_time`
- `slot_interval_minutes`
- `label`

Limitacao: essa modelagem nao representa bem horarios quebrados como `18:00, 18:30, 21:30`, porque um intervalo fixo abriria horarios indesejados entre eles.

No modal publico, `ReservationModal.tsx` consulta `get_public_schedule_overrides` e, quando existe override para a data, gera horarios pela janela configurada.

## Decisao de produto

Criar um novo modelo de regras com lista explicita de horarios.

Tipos de regra:

- `weekly`: recorrente por dia da semana.
- `date_specific`: uma data especifica.
- `date_range`: periodo de datas.

Prioridade para uma data:

```text
1. blocked_dates
2. regra date_specific
3. regra date_range
4. regra weekly
5. opening_hours + reservation_duration atual
```

Se uma regra existir para a data, ela substitui a grade padrao. Bloqueios continuam tendo precedencia absoluta.

## Modelo de dados

### `reservation_schedule_rules`

Tabela principal das regras.

```text
id uuid primary key
company_id uuid not null references companies(id) on delete cascade
name text not null
scope text not null check in ('weekly', 'date_specific', 'date_range')
weekdays int[] null
start_date date null
end_date date null
enabled boolean not null default true
priority integer not null default 100
max_party_size_per_reservation integer null
archived_at timestamptz null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Validacoes:

- `name` nao pode ser vazio.
- `weekdays` obrigatorio para `weekly`.
- `weekdays` deve conter apenas numeros de `0` a `6`.
- `start_date` obrigatoria para `date_specific` e `date_range`.
- `end_date` obrigatoria para `date_range`.
- `end_date >= start_date`.
- `max_party_size_per_reservation`, quando preenchido, deve estar entre `1` e `20`.
- Para `date_specific`, `end_date` pode ser igual a `start_date` ou nulo, mas a RPC deve tratar como data unica.
- Soft delete via `archived_at`.

Indices:

```text
(company_id, scope, enabled, archived_at)
(company_id, start_date, end_date) where archived_at is null
```

### `reservation_schedule_rule_slots`

Horarios explicitos de cada regra.

```text
id uuid primary key
rule_id uuid not null references reservation_schedule_rules(id) on delete cascade
time time not null
sort_order integer not null default 100
max_party_size_per_reservation integer null
max_reservations_per_slot integer null
created_at timestamptz not null default now()
```

Restricoes:

```text
unique (rule_id, time)
```

Os limites do horario sao opcionais:

- `max_party_size_per_reservation` sobrescreve o limite padrao da regra naquele horario;
- `max_reservations_per_slot` limita a quantidade de reservas iniciadas naquele horario;
- campos vazios preservam o comportamento anterior.

## RPC publica de resolucao

Criar uma RPC publica:

```text
get_public_reservation_schedule(_company_id uuid, _date date)
```

Retorno sugerido:

```text
source text              -- blocked | date_specific | date_range | weekly | default
rule_id uuid null
rule_name text null
slots jsonb             -- ["18:00", "18:30", "21:30"]
max_party_size_per_reservation integer null
```

Comportamento:

1. Verifica se a empresa existe e esta ativa.
2. Se a data estiver bloqueada o dia inteiro em `blocked_dates`, retorna `source = 'blocked'` e `slots = []`.
3. Procura regra ativa `date_specific`.
4. Procura regra ativa `date_range`.
5. Procura regra ativa `weekly` pelo `EXTRACT(DOW FROM _date)`.
6. Se nao houver regra, usa `companies.opening_hours` e `companies.reservation_duration` para gerar os horarios atuais.

Ordenacao entre regras do mesmo nivel:

```text
priority asc, created_at desc
```

## Integracao com disponibilidade

A RPC publica `get_public_reservation_availability(company_id, date, party_size)` centraliza o calculo de vagas para evitar divergencia entre frontend e servidor.

Para cada horario permitido, ela considera:

- mesas compativeis com o tamanho do grupo e com o mapa ativo;
- mesas ocupadas por reservas com sobreposicao de duracao;
- `max_guests_per_slot`;
- maximo de pessoas por reserva herdado da regra ou sobrescrito no horario;
- maximo de reservas configurado no horario;
- `blocked_dates` por faixa de horario;
- reservas `pending_payment` ainda dentro do prazo.

Exemplo:

```text
Regra de sexta retorna: 18:00, 18:30, 21:30

18:00 aparece disponivel se houver mesa/capacidade.
18:30 aparece esgotado se todas as mesas compativeis estiverem ocupadas.
21:30 aparece disponivel se houver mesa/capacidade.
19:00 nao aparece, mesmo que existam mesas livres.
```

## Validacao no servidor

Hoje o modal publico insere diretamente em `reservations` quando nao ha pagamento antecipado. Isso deixa espaco para corrida entre dois clientes tentando ocupar a ultima vaga.

Plano recomendado:

### Fase 1

Manter o fluxo atual, mas usar a nova RPC para mostrar horarios no modal.

### Fase 2

Adicionar validacao server-side antes de aceitar a reserva:

- o horario precisa existir na regra ativa da data;
- a data nao pode estar bloqueada;
- o horario nao pode estar dentro de um bloqueio parcial;
- a mesa escolhida precisa continuar livre;
- `max_guests_per_slot` nao pode ser excedido;
- o tamanho do grupo nao pode exceder `max_party_size_per_reservation` da regra ativa, quando configurado;
- o tamanho do grupo nao pode exceder o limite sobrescrito no horario, quando configurado;
- a quantidade de reservas iniciadas no horario nao pode exceder `max_reservations_per_slot`;
- a mesa precisa estar livre durante toda a duracao da nova reserva;
- `pending_payment` valido conta como ocupacao.

Essa validacao pode ser feita por:

1. trigger `BEFORE INSERT OR UPDATE` em `reservations`; ou
2. RPC `create_public_reservation` para substituir o insert direto do frontend.

Recomendacao: usar RPC para criacao publica de reserva, porque permite retornar mensagens melhores e controlar a transacao com advisory lock por empresa/data/horario.

## UI administrativa

Adicionar a configuracao dentro de **Reservas e Regras**.

Estrutura sugerida:

```text
Reservas e Regras

Grade semanal
- Terca a quinta: 18:00, 19:30, 20:30, 21:30
- Sexta: 18:00, 18:30, 21:30
- Sabado: 18:00, 21:00
- Domingo: 18:00, 19:30, 20:30, 21:30

Excecoes
- Datas especificas
- Periodos
```

Editor de regra:

```text
Nome
Tipo: recorrente semanal | data especifica | periodo
Dias da semana, quando recorrente
Data ou periodo, quando excecao
Horarios
Ativo
Prioridade
Maximo de pessoas por reserva (opcional)
Por horario: maximo de pessoas por reserva e maximo de reservas (opcionais)
```

Controles de horarios:

- adicionar horario individual;
- remover horario;
- ordenar automaticamente;
- opcional: gerar horarios por intervalo como atalho, mas salvar a lista explicita.

Exemplo do atalho:

```text
Gerar de 18:00 ate 22:00 a cada 30 min
```

Depois de gerar, o admin pode remover `19:00`, `19:30`, etc. O banco salva apenas os horarios finais.

## Modal publico

Alteracoes em `ReservationModal.tsx`:

1. Remover o uso de `get_public_schedule_overrides`.
2. Consultar `get_public_reservation_schedule(companyId, selectedDate)`.
3. Usar `slots` retornados como `timeSlots`.
4. Se `source = 'blocked'`, mostrar nenhum horario disponivel.
5. Continuar aplicando filtro de horarios passados para a data de hoje.
6. Continuar calculando disponibilidade por horario como hoje.

## Migracao dos overrides atuais

Converter os registros de `reservation_schedule_overrides` para o novo modelo.

Exemplo:

```text
reservation_schedule_overrides
date: 2026-06-12
start_time: 18:00
end_time: 21:00
slot_interval_minutes: 30
label: Dia dos Namorados
```

Vira:

```text
reservation_schedule_rules
scope: date_specific
start_date: 2026-06-12
end_date: 2026-06-12
name: Dia dos Namorados

reservation_schedule_rule_slots
18:00
18:30
19:00
19:30
20:00
20:30
21:00
```

Manter a tabela antiga durante uma versao como fallback, mas parar de usar no frontend depois da migracao.

## Testes

### Banco/RPC

Casos principais:

- data sem regra usa `opening_hours`;
- regra weekly vence padrao;
- regra date_range vence weekly;
- regra date_specific vence date_range;
- `blocked_dates` vence tudo;
- regra weekly com multiplos weekdays funciona;
- horarios retornam ordenados;
- regra arquivada nao entra;
- regra desativada nao entra.

### Frontend

Casos principais:

- modal publico mostra somente horarios explicitos da regra;
- horario removido da regra deixa de aparecer;
- horario cheio fica esgotado/desabilitado;
- troca de data recarrega regra correta;
- hoje remove horarios que ja passaram;
- admin cria regra semanal com varios dias;
- admin cria excecao por data especifica.
- admin configura maximo de pessoas por reserva em uma regra.
- modal publico impede avancar quando o grupo excede o maximo da regra ativa.
- admin sobrescreve o maximo de pessoas em um horario especifico.
- horario fica indisponivel quando atinge o maximo de reservas configurado.
- mesa ocupada por uma reserva em andamento nao reaparece em um horario sobreposto.

## Fases de implementacao

### Fase 1: base de banco

- Criar tabelas novas.
- Criar RLS.
- Criar trigger de `updated_at`.
- Criar RPC `get_public_reservation_schedule`.
- Migrar dados de `reservation_schedule_overrides`.

### Fase 2: UI administrativa

- Criar hooks para CRUD das regras e slots.
- Criar componente de lista de regras.
- Criar modal de criacao/edicao.
- Substituir `ScheduleOverridesCard`.

### Fase 3: modal publico

- Trocar `get_public_schedule_overrides` pela nova RPC.
- Adaptar geracao de `timeSlots`.
- Validar comportamento com bloqueios e disponibilidade.

### Fase 4: validacao transacional

- Criar RPC `create_public_reservation` ou trigger.
- Migrar o insert publico para a RPC.
- Garantir lock por empresa/data/horario.
- Revalidar mesa e capacidade no servidor.

### Fase 5: limpeza

- Remover uso da tabela antiga.
- Remover `get_public_schedule_overrides`.
- Atualizar tipos Supabase.
- Atualizar documentacao operacional.
