# Plano: mesas nas reservas e calendario operacional de capacidade

## Objetivo

Evoluir a operacao diaria de reservas para que a equipe consiga:

- ver rapidamente qual mesa foi atribuida a cada reserva;
- criar e editar reservas manuais sem quebrar a logica de disponibilidade;
- identificar reservas sem mesa antes do atendimento;
- consultar, ao selecionar uma data no calendario, a capacidade por horario, ocupacao, vagas restantes e lista de reservas daquele horario.

## Diagnostico atual

- A reserva publica ja escolhe uma mesa por melhor encaixe e grava `reservations.table_id`.
- `reservations.table_map_id` ja existe e e sincronizado a partir da mesa.
- `restaurant_tables` possui `number`, `capacity`, `section` e `table_map_id`.
- `table_maps` permite mapa padrao e mapas ativos por periodo.
- A visao de reservas de hoje e o calendario consultam reservas, mas nao fazem join com `restaurant_tables`, entao nao conseguem exibir `Mesa X`.
- A criacao manual em `Reservations.tsx` grava `table_id = null`.
- A edicao de data, horario ou quantidade de pessoas atualiza a reserva diretamente e nao revalida a mesa.
- `get_public_reservation_availability(company_id, date, party_size)` ja calcula disponibilidade por horario para o fluxo publico, mas responde a pergunta "cabe um grupo de X pessoas?", nao a pergunta operacional "qual a ocupacao total deste horario?".
- As regras de agenda ja permitem horarios explicitos e alguns limites por slot, mas ainda nao ha limite de pessoas por horario em `reservation_schedule_rule_slots`.

## Recomendacao para reserva manual

Nao recomendo obrigar mesa de forma cega em todos os casos. A melhor regra e: em modo por mesas, a mesa deve ser obrigatoria por padrao, mas o sistema deve permitir uma excecao explicita e rastreavel.

### Regra padrao

Quando a reserva manual tiver data, horario e quantidade de pessoas:

1. O sistema busca o mapa ativo para aquele momento.
2. Lista as mesas disponiveis que comportam o grupo.
3. Auto-seleciona a menor mesa disponivel que comporta o grupo.
4. Permite trocar manualmente por outra mesa disponivel.
5. Bloqueia a criacao se nao houver mesa disponivel.

### Excecao controlada

Quando nao houver mesa disponivel, ou quando a equipe ainda nao quiser alocar mesa, a UI pode oferecer "Alocar depois".

Essa acao deve:

- exigir motivo curto;
- marcar a reserva como pendente de mesa;
- destacar a reserva como `Sem mesa` nas telas operacionais;
- aparecer em filtros/alertas do dia;
- ser registrada no historico de auditoria.

Sugestao de permissao:

- `operator`: pode criar reserva sem mesa somente como "alocar depois", com motivo;
- `admin` e `superadmin`: podem confirmar override mesmo quando ha conflito, tambem com motivo;
- todos os perfis devem ver claramente que a reserva precisa de acao antes do atendimento.

### Casos em que mesa nao deve ser obrigatoria

- Regra futura de disponibilidade por quantidade, quando a reserva nao depende de mapa de mesas.
- Eventos em que a operacao usa capacidade geral e nao mesa nominal.
- Importacoes ou carga historica.
- Reserva antiga cuja mesa foi removida do mapa.

## Modelo de dados

### MVP sem tabela nova

Para exibir `Mesa X`, nao e necessario criar tabela nova. Basta consultar:

- `reservations.table_id`
- `reservations.table_map_id`
- `restaurant_tables.id`
- `restaurant_tables.number`
- `restaurant_tables.capacity`
- `restaurant_tables.section`
- `table_sections.name`

### Colunas recomendadas em `reservations`

Para tratar "sem mesa" sem ambiguidade, recomendo adicionar colunas simples:

```sql
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS table_assignment_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS table_assignment_note text;

ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_table_assignment_state_check
  CHECK (table_assignment_state IN ('assigned', 'pending', 'not_required'));
```

Backfill sugerido:

```sql
UPDATE public.reservations
SET table_assignment_state = CASE
  WHEN table_id IS NOT NULL THEN 'assigned'
  ELSE 'pending'
END
WHERE table_assignment_state IS NULL
   OR table_assignment_state NOT IN ('assigned', 'pending', 'not_required');
```

Sem essas colunas, `table_id IS NULL` mistura casos diferentes: reserva manual sem mesa, regra por capacidade, mesa excluida e historico antigo.

### Coluna recomendada em `reservation_schedule_rule_slots`

Para uma visao como a do dguests, com limite diferente por horario, recomendo adicionar:

```sql
ALTER TABLE public.reservation_schedule_rule_slots
  ADD COLUMN IF NOT EXISTS max_guests_per_slot integer;
```

Essa coluna representa o limite de pessoas simultaneamente atendidas naquele horario. Quando nula, o sistema usa fallback.

Fallback recomendado para `capacity_limit`:

1. `reservation_schedule_rule_slots.max_guests_per_slot`;
2. `companies.max_guests_per_slot`, se maior que zero;
3. soma da capacidade das mesas disponiveis no mapa ativo.

### Tabelas novas

Nao recomendo criar tabela nova no MVP.

Tabela nova so passa a fazer sentido se o produto precisar suportar uma reserva ocupando varias mesas ao mesmo tempo. Nesse caso, o modelo correto seria:

```sql
CREATE TABLE public.reservation_table_assignments (
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES public.restaurant_tables(id) ON DELETE RESTRICT,
  position integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, table_id)
);
```

Enquanto cada reserva ocupar uma unica mesa, `reservations.table_id` e suficiente.

## RPCs recomendadas

### `get_reservation_table_options`

Usada pela criacao manual, edicao e troca de mesa.

Entradas:

- `_company_id uuid`
- `_date date`
- `_time time`
- `_party_size integer`
- `_duration_minutes integer default null`
- `_reservation_id uuid default null`

Retorno:

- `table_id`
- `table_number`
- `section_code`
- `section_name`
- `capacity`
- `table_map_id`
- `table_map_name`
- `available`
- `conflict_reservation_id`
- `conflict_guest_name`
- `recommended`

Regras:

- usa `get_active_table_map`;
- ignora a propria reserva quando `_reservation_id` for informado;
- considera sobreposicao por `duration_minutes`;
- considera somente reservas que ocupam capacidade via `is_reservation_occupying_capacity`;
- recomenda a menor mesa disponivel que comporta o grupo.

### `create_panel_reservation`

Substitui o insert direto da criacao manual.

Responsabilidades:

- validar data, horario, quantidade e contato;
- resolver agenda ativa;
- validar limites de pessoas/reservas por slot;
- validar mesa quando `table_assignment_state = 'assigned'`;
- permitir `pending` somente com motivo;
- gravar auditoria com ator autenticado.

### `update_panel_reservation`

Substitui updates diretos de data, horario e quantidade.

Responsabilidades:

- se data/horario/quantidade mudar, revalidar a mesa atual;
- manter a mesa se continuar valida;
- autoatribuir nova mesa se a atual ficar invalida e houver opcao clara;
- exigir escolha ou `alocar depois` se nao houver mesa disponivel;
- registrar mudancas de mesa no historico.

### `assign_reservation_table`

Acao rapida para trocar ou atribuir mesa a uma reserva existente.

Entradas:

- `_reservation_id uuid`
- `_table_id uuid`
- `_note text default null`

Responsabilidades:

- validar permissao;
- validar capacidade e conflito;
- atualizar `table_id`, `table_assignment_state` e `table_assignment_note`;
- registrar auditoria.

### `get_admin_reservation_day_capacity`

RPC propria para o calendario operacional.

Entradas:

- `_company_id uuid`
- `_date date`

Retorno sugerido por horario:

- `time_slot`
- `slot_label`
- `source` (`opening_hours`, `weekly`, `date_specific`, `date_range`, `blocked`)
- `rule_id`
- `rule_name`
- `active_table_map_id`
- `active_table_map_name`
- `arrival_reservation_count`
- `arrival_guest_count`
- `occupying_reservation_count`
- `occupying_guest_count`
- `checked_in_guest_count`
- `capacity_limit`
- `remaining_capacity`
- `fill_rate`
- `total_tables`
- `occupied_tables`
- `available_tables`
- `unassigned_reservation_count`
- `blocked`

Definicoes:

- `arrival_guest_count`: pessoas em reservas que comecam exatamente no horario.
- `occupying_guest_count`: pessoas em reservas que se sobrepoem ao intervalo do horario, considerando `reservations.duration_minutes`.
- `remaining_capacity`: `capacity_limit - occupying_guest_count`, nunca menor que zero.
- `fill_rate`: `occupying_guest_count / capacity_limit`.
- Em modo por mesas, vagas restantes sao uma leitura operacional agregada. Elas nao garantem que qualquer grupo novo caiba, porque pode haver fragmentacao entre mesas.

## UI proposta

### Reservas de hoje

Adicionar tag em cada reserva:

- `Mesa 12`, quando `table_id` estiver atribuido;
- `Sem mesa`, quando `table_assignment_state = 'pending'`;
- `Por capacidade`, quando `table_assignment_state = 'not_required'`.

Tambem adicionar:

- filtro/alerta para reservas sem mesa;
- contador no resumo do dia;
- acao rapida "Atribuir mesa" no card ou no dialog de detalhes.

### Lista de reservas

Adicionar coluna ou chip de mesa:

- desktop: coluna "Mesa";
- mobile: chip no bloco de metadados;
- exportacao CSV: incluir mesa, secao e status de atribuicao.

### Dialog de detalhes

Adicionar bloco "Mesa":

- numero da mesa;
- secao;
- mapa ativo;
- capacidade;
- historico de mudanca no timeline;
- botao "Trocar mesa" para perfis permitidos.

### Criacao manual

Depois que data, horario e pessoas estiverem preenchidos:

- buscar mesas disponiveis;
- auto-selecionar a recomendada;
- mostrar selector agrupado por secao;
- exibir conflitos de forma clara;
- permitir "Alocar depois" com motivo.

Estados esperados:

- carregando mesas;
- mesa recomendada selecionada;
- sem mesa disponivel;
- reserva pendente de mesa;
- conflito detectado ao salvar.

### Edicao de reserva

Quando alterar data, horario ou pessoas:

- recalcular opcoes de mesa;
- manter mesa atual se ainda for valida;
- sugerir nova mesa se a atual nao for valida;
- impedir salvar em conflito, exceto override permitido;
- se salvar como pendente, exigir motivo.

### Calendario

Manter o calendario a esquerda e transformar o painel da data selecionada em uma visao operacional.

Topo:

- total de reservas;
- pessoas previstas;
- pessoas presentes;
- reservas sem mesa;
- ocupacao maxima do dia.

Lista por horario:

- horario;
- barra de ocupacao;
- pessoas ocupando capacidade;
- capacidade limite;
- vagas restantes;
- quantidade de reservas;
- mesas ocupadas/livres;
- indicador de bloqueio ou lotacao.

Ao clicar em um horario:

- abrir/listar reservas daquele horario;
- destacar reservas sem mesa;
- permitir check-in, no-show, editar e atribuir mesa.

Toggle recomendado:

- `Chegadas`: usa reservas que comecam naquele horario.
- `Ocupacao`: usa reservas sobrepostas ao intervalo, considerando duracao.

## Fases de implementacao

### Fase 1: visibilidade da mesa

- Fazer join de reservas com `restaurant_tables`.
- Exibir tag `Mesa X` nas reservas de hoje.
- Exibir `Sem mesa` quando nao houver `table_id`.
- Incluir mesa no dialog de detalhes.

Entrega pequena, sem migration obrigatoria.

### Fase 2: criacao manual com atribuicao de mesa

- Criar `get_reservation_table_options`.
- Atualizar modal de reserva manual.
- Autoatribuir mesa recomendada.
- Permitir "Alocar depois" com motivo.
- Adicionar `table_assignment_state` e `table_assignment_note`, se aprovado.

### Fase 3: edicao segura

- Criar `update_panel_reservation` ou equivalente.
- Revalidar mesa ao alterar data, horario ou pessoas.
- Adicionar acao de troca de mesa.
- Incluir mesa no historico de auditoria.

### Fase 4: calendario operacional por capacidade

- Criar `get_admin_reservation_day_capacity`.
- Trocar o painel da data selecionada no calendario.
- Adicionar barras por horario e lista filtrada.
- Adicionar filtro/alerta de reservas sem mesa.

### Fase 5: limites por horario

- Adicionar `max_guests_per_slot` em `reservation_schedule_rule_slots`.
- Atualizar a tela de regras de agenda.
- Usar esse limite na RPC do calendario e, se desejado, tambem na disponibilidade publica.

### Fase 6: modo por quantidade

Se o produto for aceitar reservas sem mesa por design:

- adicionar `availability_mode` em `reservation_schedule_rules`;
- adicionar `created_in_mode` e `applied_schedule_rule_id` em `reservations`;
- alterar `create_public_reservation` para exigir mesa somente no modo `tables`;
- marcar reservas por quantidade como `table_assignment_state = 'not_required'`.

Essa fase se conecta ao plano existente de regras por mesas ou por quantidade.

## Criterios de aceite

- Toda reserva publica em modo por mesas aparece com `Mesa X`.
- Toda reserva manual em modo por mesas nasce com mesa atribuida ou com estado `Sem mesa` explicito.
- Ao editar data, horario ou pessoas, o sistema nao deixa uma mesa conflitante salva silenciosamente.
- A equipe consegue filtrar reservas sem mesa no dia.
- O calendario mostra, por horario, pessoas previstas, capacidade, vagas restantes e reservas daquele horario.
- Canceladas, no-show e pagamentos expirados nao ocupam capacidade.
- Reservas pendentes de pagamento ocupam capacidade enquanto ainda podem ser pagas.

## Decisoes em aberto

- O operador pode criar reserva sem mesa, ou isso deve ser restrito a admin?
- O sistema deve permitir override de conflito de mesa ou apenas "alocar depois"?
- O produto precisa suportar uma reserva em varias mesas?
- A capacidade por horario deve usar sempre limite configurado ou pode cair para soma de assentos do mapa ativo?
- O painel publico deve mostrar vagas restantes reais ou apenas horarios disponiveis?
- Reservas manuais devem passar pelas mesmas regras publicas de maximo por horario, ou admins podem ultrapassar com override?

## Riscos

- "Vagas restantes" em modo por mesas pode ser interpretado como garantia para qualquer grupo, mas a disponibilidade real depende da distribuicao das mesas.
- Updates diretos em `reservations` podem contornar validacoes se nao forem substituidos por RPCs.
- `table_id = null` precisa ser desambiguado antes de virar indicador operacional forte.
- O arquivo de tipos do Supabase deve ser regenerado ou ajustado apos migrations, porque o frontend usa colunas recentes como `table_map_id`.
