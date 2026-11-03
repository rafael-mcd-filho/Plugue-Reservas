# Horários marcados como lotados

O checkbox **Lotado** fica em cada horário do bloco de uma regra de reservas.
Ao salvar, o horário continua publicado, aparece como **Lotado** na página
pública e deixa de aceitar novas reservas pela página pública.
Administradores e operadores continuam podendo criar e alterar reservas manuais
pelo painel, respeitando as validações normais de capacidade e disponibilidade.
Desmarcar o checkbox restaura a disponibilidade calculada normalmente.

A marcação acompanha os dias e o período da regra. Para fechar somente uma data,
use uma regra de data específica. Reservas existentes continuam disponíveis para
consulta, edição, cancelamento e check-in. No modo por capacidade, todos os horários
continuam exigindo capacidade total, inclusive os marcados como lotados.

## Publicação

1. Aplicar `supabase/migrations/20261103120000_add_manually_full_schedule_slots.sql`.
2. Aplicar `supabase/migrations/20261103121000_allow_panel_bookings_in_full_slots.sql`,
   que restringe a marcação à página pública e mantém as reservas manuais pelo painel.
3. Publicar o frontend com o checkbox e o texto sobre o bloqueio público.

A primeira migration adiciona `reservation_schedule_rule_slots.is_full` com padrão
`false`, preservando os horários existentes. O banco mantém as assinaturas e
permissões dos RPCs e valida as definições esperadas antes de alterá-las.
Se alguma definição divergir, a aplicação da migration falha para revisão.

Em ambientes que já receberam a primeira migration, aplique a corretiva antes de
publicar o frontend atualizado. O bloqueio continua valendo para o RPC público de
criação de reservas, inclusive em chamadas diretas à API.

## Validação local

```powershell
npx vitest run src/components/company/ReservationScheduleRulesCard.test.tsx src/components/ReservationModal.test.tsx src/components/CalendarSlotAvailability.test.tsx src/lib/calendar-slot-availability.test.ts
node supabase/tests/run_manually_full_schedule_slots_regression.mjs
npm run build
```

Os testes SQL usam um banco PGlite em memória, sem acessar o Supabase remoto.
