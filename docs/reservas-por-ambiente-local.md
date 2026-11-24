# Reservas por ambiente — implementação local

Esta entrega reúne o frontend, os contratos e o backend de reservas por ambiente. Em 24/11/2026, após autorização explícita do usuário para configurar a empresa de teste em produção, foram aplicadas as duas migrações de suporte e atualizadas as funções `create-reservation-payment` e `get-reservation-payment`. O usuário posteriormente autorizou a publicação integral, incluindo o frontend e as respostas de escolha/verificação do pagamento. A configuração por ambiente foi habilitada apenas na empresa **TESTE — Plug Guest** (`teste-plugguest`); as outras empresas continuam com suas configurações anteriores. Nenhuma reserva ou cobrança real foi criada para a validação.

## Configuração da empresa de teste

- Data: **24/12/2026**, com apenas **21:00** publicado.
- Disponibilidade: **por mesas**, conforme ajuste solicitado pelo usuário. Estoque real do mapa: 10 mesas na Sacada e 38 na área normal; sem limite adicional de quantidade de reservas ou capacidade total do horário. Os tetos por ambiente de 40/150 pessoas permanecem como limites adicionais.
- **Sacada Premium:** 40 pessoas, **R$150 por pessoa**.
- **Reserva normal:** 150 pessoas, **R$100 por pessoa**.
- Pix e cartão à vista usam o mesmo valor informado por ambiente; prazo de pagamento de 10 minutos.
- Duração herdada da empresa: 60 minutos.
- Mapa **Natal — 24/12/2026** (`1474fa59-3111-40c5-a403-e985856ada9a`), ativo entre 24/12 às 00:00 e 25/12 às 00:00 no fuso de São Paulo. Base de mesas aprovada pelo usuário: 10 mesas de 4 na Sacada; 37 mesas de 4 e uma de 2 na área normal.
- A regra de disponibilidade e a regra de pagamento são específicas para essa data. Os mapas e configurações de outras empresas foram preservados.

O modo inicialmente configurado por capacidade foi alterado para mesas em 24/11/2026. A validação no banco confirmou que grupos de duas pessoas encontram mesas e grupos de cinco não encontram mesa única adequada (a maior mesa cadastrada tem quatro lugares). Cada reserva pública ocupa uma mesa inteira e não combina mesas automaticamente. A combinação de mesas continua disponível na operação manual do painel.

Após a publicação do frontend, o cenário fica disponível em `https://plugguest.com.br/teste-plugguest`, selecionando 24/12 no calendário. O desenvolvimento local continua disponível em `http://localhost:8080/teste-plugguest`. A prévia fictícia em 8097 permanece independente dos dados reais.

Antes da aplicação, a migração foi validada com as definições atuais das funções do banco, incluindo as alterações intermediárias de `is_full` e a assinatura de cinco parâmetros de `assign_reservation_tables`. Foi executada uma transação completa com `ROLLBACK`, seguida da aplicação atômica. A aplicação verificou hashes das reservas, agendas e regras comerciais das outras empresas. A verificação pública confirmou o único horário, as duas cotas/preços e o preparo de pagamento com `dry_run`, sem criar registros de reserva/pagamento.

## Comportamento

A regra de disponibilidade controla a escolha de ambiente por horário. O botão **Escolher ambiente** abre a seleção de ambientes permitidos. Em disponibilidade por mesas, o sistema usa as mesas e o mapa vigentes; pode haver também um teto de pessoas por ambiente. Em disponibilidade por capacidade, cada ambiente exige uma cota e a soma não pode superar a capacidade total do horário.

| Pagamento | Horário permite escolher ambiente | Fluxo público |
| --- | --- | --- |
| Sem pagamento ativo | Não | Fluxo atual |
| Sem pagamento ativo | Sim | Cliente escolhe ambiente |
| Valor único | Não | Fluxo atual |
| Valor único | Sim | Sem escolha; sistema aloca entre ambientes permitidos |
| Preço por ambiente | Sim | Cliente escolhe ambiente e vê os preços |
| Preço por ambiente | Não | Configuração incompatível; ativação comercial bloqueada |

A regra comercial mantém unidade por pessoa ou por reserva, meios de pagamento, prazo e políticas. O modo por ambiente carrega as seções elegíveis nas datas escolhidas. Uma regra ativa deve cobrir os horários abertos e os ambientes elegíveis do período; o servidor informa a incompatibilidade antes da ativação.

Os valores são calculados no servidor. A reserva guarda o ambiente atribuído e o pagamento preserva ambiente e preço no snapshot. Reserva pendente de pagamento segura a disponibilidade até expirar. Alteração de mesa e confirmação tardia respeitam o ambiente e suas cotas.

## Arquivos de migração

1. `supabase/migrations/20261124120000_add_reservation_section_pricing.sql`
2. `supabase/migrations/20261124121000_expose_contracted_reservation_section.sql`

Esses arquivos já foram aplicados no banco compartilhado conforme a autorização acima. Para reproduzir o cenário isoladamente, podem ser usados em um banco local. O frontend possui fallback restrito para o schema anterior: mantém a listagem e a reserva padrão, mas impede salvar seleção de ambientes em um banco sem a estrutura nova.

## Verificação offline

```text
npx.cmd vitest run src/components/ReservationModal.test.tsx src/components/company/ReservationScheduleRulesCard.test.tsx src/hooks/useReservationScheduleRules.sections.test.tsx src/pages/CompanyPrepayments.test.tsx src/lib/reservation-section-options.test.ts src/lib/reservation-payment-requirement.test.ts src/lib/asaas-reservation-transport.test.ts
node --test supabase/functions/_shared/reservation-payment-requirement.test.mjs supabase/functions/_shared/reservation-payment-routing.test.mjs
node supabase/tests/run_reservation_section_pricing_regression.mjs
node supabase/tests/run_reservation_section_tracking_regression.mjs
npm.cmd run build
```

As regressões SQL usam PostgreSQL em memória via PGlite, sem conectar ao Supabase ou ao provedor de pagamentos. O teste de duas submissões valida rechecagem transacional; não substitui um teste de concorrência com múltiplas conexões PostgreSQL.

Validação de publicação em 24/11/2026: 149 testes Vitest e 68 testes Node passaram, assim como as duas regressões SQL e o build. A comparação de TypeScript com a base encontrou os mesmos 46 diagnósticos preexistentes, sem novos erros. A verificação visual automatizada anterior foi interrompida pela ferramenta por não conseguir confirmar a URL do navegador; não foi concluído um teste visual completo. Os ajustes visuais de alinhamento e deduplicação dos valores de Pix/cartão estão incluídos no frontend.

## Prévia isolada

O diretório ignorado `.section-pricing-preview.local` contém uma prévia dos componentes reais com respostas fictícias, sem credenciais nem operações externas:

```text
npx.cmd vite --config .section-pricing-preview.local/vite.config.ts
```

Abra `http://127.0.0.1:8097/`. Para conferir a configuração por capacidade, use `http://127.0.0.1:8097/?capacity=1`. A prévia bloqueia o envio final e a gravação de configurações.
