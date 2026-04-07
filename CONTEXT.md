# Contexto do Projeto

Atualizado em: 2026-03-23

## Resumo Executivo

Este repositorio implementa uma plataforma multi-tenant de reservas para restaurantes, com:

- pagina publica por empresa (`/:slug`) para captacao de reservas;
- painel administrativo por unidade (`/:slug/admin/...`);
- painel global de superadmin para operar todas as empresas;
- integracao com Supabase para autenticacao, banco e edge functions;
- integracao com Evolution API para automacoes via WhatsApp;
- funil de conversao, fila de espera, leads e monitoramento operacional.

O nome exibido no produto e configuravel via `system_settings`, mas o branding atual no codigo gira em torno de `ReservaFacil`.

## Stack Tecnica

- Frontend: React 18 + TypeScript + Vite
- UI: Tailwind CSS + shadcn/ui + Radix
- Estado de dados: TanStack React Query
- Roteamento: React Router
- Backend: Supabase (Auth, Postgres, RPC, Storage, Edge Functions)
- Graficos: Recharts
- Testes: Vitest
- E2E preparado: Playwright

Scripts principais em `package.json`:

- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run test`

## Mapa de Arquitetura

### Frontend

- `src/App.tsx`
  Define as rotas, separa contexto global, area publica, area superadmin e area por empresa.

- `src/contexts/AuthContext.tsx`
  Carrega sessao Supabase, profile do usuario e roles (`superadmin`, `admin`, `operator`).

- `src/contexts/CompanySlugContext.tsx`
  Resolve o `slug` para `companyId` e restringe acesso de usuarios a sua propria empresa, exceto superadmin.

- `src/components/AppLayout.tsx`
  Layout lateral compartilhado entre painel global e painel de unidade.

- `src/integrations/supabase/client.ts`
  Cliente Supabase consumido pelo frontend.

### Backend / Infra

- `supabase/functions/*`
  Edge functions para criacao de empresa, gestao de usuarios, integracao WhatsApp, envio de mensagens, monitoramento e eventos.

- `supabase/migrations/*`
  Evolucao do schema e RPCs do banco.

- `src/integrations/supabase/types.ts`
  Melhor referencia local para entender o schema atual do banco.

## Perfis de Usuario e Rotas

### Publico

- `/:slug`
  Landing page da empresa com dados publicos, CTA de reserva e login administrativo discreto.

- `/:slug/fila/:code`
  Pagina publica para acompanhar posicao na fila de espera.

### Autenticacao

- `/login`
- `/cadastro`
- `/acesso-negado`

### Superadmin

- `/dashboard`
- `/empresas`
- `/empresas/:id`
- `/usuarios`
- `/configuracoes`
- `/saude`

### Admin/Operacao por Empresa

- `/:slug/admin`
- `/:slug/admin/reservas`
- `/:slug/admin/mesas`
- `/:slug/admin/calendario`
- `/:slug/admin/fila`
- `/:slug/admin/automacoes`
- `/:slug/admin/configuracoes`
- `/:slug/admin/usuarios`
- `/:slug/admin/leads`

## Fluxos Principais do Produto

### 1. Reserva publica

Arquivo central: `src/components/ReservationModal.tsx`

Fluxo:

1. Cliente escolhe data e tamanho da mesa.
2. Sistema calcula horarios possiveis com base em:
   - horario de funcionamento;
   - datas/bloqueios;
   - ocupacao por slot (`get_slot_occupancy`);
   - limite maximo de pessoas por horario;
   - disponibilidade real de mesas.
3. Ao escolher horario, a mesa e atribuida por melhor encaixe (menor mesa disponivel que suporta o grupo).
4. O cliente informa WhatsApp, nome e dados opcionais.
5. A reserva e gravada em `reservations` com status `confirmed`.
6. A edge function `reservation-events` pode disparar mensagem de confirmacao e webhooks.

Detalhes relevantes:

- usa `visitor_id` salvo em `localStorage`;
- reaproveita dados anteriores pelo telefone do cliente;
- grava eventos do funil de reserva;
- gera link para Google Calendar no sucesso.

### 2. Gestao de reservas

Arquivo central: `src/pages/Reservations.tsx`

Permite:

- listar reservas;
- filtrar por status, datas, nome e telefone;
- alterar status;
- excluir reserva;
- visualizar volume diario no mes;
- disparar `reservation-events` em cancelamento ou mudanca de status.

### 3. Mapa de mesas

Arquivo central: `src/pages/TableMap.tsx`

Permite:

- cadastrar/editar/remover mesas;
- separar mesas por secao (`salao`, `varanda`, `privativo`);
- inferir status operacional em tempo real:
  - `available`
  - `reserved`
  - `occupied`
  - `maintenance`

O status visual da mesa e calculado a partir das reservas do dia, nao apenas do campo persistido.

### 4. Fila de espera

Arquivo central: `src/pages/CompanyWaitlist.tsx`

Permite:

- adicionar cliente na fila;
- gerar `tracking_code`;
- copiar link publico de acompanhamento;
- chamar proximo cliente;
- marcar como sentado, expirado ou removido;
- disparar mensagens WhatsApp nos eventos da fila.

Arquivo publico relacionado: `src/pages/WaitlistTracking.tsx`

O cliente ve:

- pessoas na frente;
- tempo estimado;
- status da chamada;
- atualizacao automatica.

### 5. Dashboard e analytics

Arquivos centrais:

- `src/pages/Dashboard.tsx`
- `src/hooks/useDashboardData.ts`
- `src/hooks/useFunnelTracking.ts`
- `src/hooks/useFunnelData.ts`

Entregam:

- KPIs de reservas;
- comparacao com periodo anterior;
- heatmap por dia/horario;
- funil de conversao da reserva publica;
- metricas de fila de espera por empresa.

### 6. Leads / CRM leve

Arquivo central: `src/pages/Leads.tsx`

Agrupa reservas por telefone e transforma historico em base de leads, com:

- nome, email e nascimento;
- quantidade de reservas;
- historico detalhado;
- exportacao CSV.

### 7. Configuracoes por empresa

Arquivo central: `src/pages/CompanySettings.tsx`

Permite ajustar:

- horarios de funcionamento;
- duracao da reserva;
- capacidade maxima por horario;
- formas de pagamento;
- descricao publica;
- telefone, Instagram e WhatsApp;
- endereco e mapa;
- datas/horarios bloqueados.

### 8. Automacoes e webhooks

Arquivos centrais:

- `src/pages/CompanyAutomations.tsx`
- `src/components/company/AutomationsTab.tsx`
- `src/components/company/WebhooksTab.tsx`

Tipos de automacao mapeados no frontend:

- `confirmation_message`
- `reminder_24h`
- `reminder_1h`
- `cancellation_message`
- `post_visit`
- `birthday_message`
- `waitlist_entry`
- `waitlist_called`

Eventos de webhook suportados:

- `reservation_created`
- `reservation_cancelled`
- `status_changed`

## Modelo de Dados

Principais tabelas do schema `public`:

- `companies`
  Cadastro completo da empresa/unidade.

- `profiles`
  Perfil do usuario autenticado.

- `user_roles`
  Vinculo usuario -> role -> empresa.

- `reservations`
  Reservas propriamente ditas.

- `restaurant_tables`
  Mesas fisicas da unidade.

- `blocked_dates`
  Bloqueios de agenda totais ou por faixa horaria.

- `waitlist`
  Lista de espera com `tracking_code`.

- `automation_settings`
  Templates e flags de automacao por empresa.

- `webhook_configs`
  Endpoints externos assinantes de eventos.

- `company_whatsapp_instances`
  Estado da instancia WhatsApp por empresa.

- `whatsapp_message_logs`
  Historico de envio.

- `whatsapp_message_queue`
  Fila de retentativa.

- `reservation_funnel_logs`
  Eventos do funil de conversao.

- `system_settings`
  Configuracoes globais do sistema.

- `notifications`
  Avisos enviados para empresas.

- `audit_logs`
  Trilhas de acao do superadmin.

View importante:

- `companies_public`
  Versao publica/sanitizada dos dados das empresas.

RPCs relevantes:

- `get_company_status_by_slug`
- `get_occupied_table_ids`
- `get_slot_occupancy`
- `get_waitlist_by_tracking_code`
- `get_waitlist_ahead_count`
- `get_waitlist_avg_wait`
- `has_role`
- `has_role_in_company`

## Edge Functions

### Operacao administrativa

- `create-company`
  Cria empresa e usuario admin inicial com senha temporaria.

- `manage-user`
  Lista usuarios, bloqueia/desbloqueia, redefine senha, atualiza e cria usuarios.

- `system-health`
  Retorna saude do banco, Evolution API, fila de mensagens, WhatsApp e erros recentes.

### Eventos e mensageria

- `reservation-events`
  Processa eventos de reserva e fila. Pode enviar WhatsApp e webhooks.

- `process-message-queue`
  Reprocessa mensagens pendentes/expiradas da fila.

- `send-reminders`
  Envia lembretes de 1h e 24h para reservas confirmadas.

- `send-post-visit`
  Envia mensagem pos-visita para reservas concluidas aproximadamente 12h depois.

- `send-birthday-messages`
  Envia mensagem de aniversario com base em `guest_birthdate`.

- `expire-waitlist`
  Expira chamadas da fila que ficaram mais de 10 minutos sem comparecimento.

### WhatsApp / Evolution API

- `evolution-api`
  Cria instancia, busca QR code, consulta status, envia mensagens e desconecta instancia.

- `check-whatsapp-status`
  Sincroniza status das instancias WhatsApp com a Evolution API.

## Configuracoes Globais

A tabela `system_settings` e usada para:

- nome do sistema;
- logo do sistema;
- URL da Evolution API;
- token global da Evolution API.

O upload do logo global usa o bucket de storage `system-assets`.

## Arquivos-Chave Para Leitura Rapida

Se alguem precisar retomar o projeto rapidamente, estes sao os melhores pontos de entrada:

- `src/App.tsx`
- `src/contexts/AuthContext.tsx`
- `src/contexts/CompanySlugContext.tsx`
- `src/pages/CompanyPublicPage.tsx`
- `src/components/ReservationModal.tsx`
- `src/pages/Reservations.tsx`
- `src/pages/TableMap.tsx`
- `src/pages/CompanyWaitlist.tsx`
- `src/pages/Dashboard.tsx`
- `src/pages/CompanySettings.tsx`
- `src/pages/CompanyAutomations.tsx`
- `src/integrations/supabase/types.ts`
- `supabase/functions/reservation-events/index.ts`
- `supabase/functions/manage-user/index.ts`
- `supabase/functions/create-company/index.ts`

## Pontos de Atencao

### 1. Calendario ainda usa mock local

`src/pages/CalendarView.tsx` ainda consome `ReservationContext`, que por sua vez usa `src/data/mock.ts`.

Na pratica:

- reservas, mesas e fila ja estao em Supabase;
- a tela de calendario ainda nao esta alinhada com a fonte real de dados.

### 2. `ReservationProvider` parece legado parcial

O provider segue embrulhando algumas rotas, mas hoje o uso efetivo dele aparece no calendario mockado.

### 3. `DevToolbar` esta sempre montado

`src/components/DevToolbar.tsx` aparece em `App.tsx` sem gate por ambiente.

Comentario do proprio arquivo:

- "DEV ONLY"
- "Remover antes de ir para producao"

### 4. Tela de usuarios por empresa pode conflitar com a autorizacao real

`src/pages/CompanyUsers.tsx` e acessivel para `admin` de empresa, mas ela chama `manage-user`.

A edge function `manage-user` valida que o chamador seja `superadmin`.

Consequencia provavel:

- superadmin funciona;
- admin de empresa pode ter erro de permissao nessa tela.

### 5. Hardening de seguranca merece revisao

Em `supabase/config.toml`, varias funcoes estao com `verify_jwt = false`.

Algumas fazem validacao manual de token/role, por exemplo:

- `create-company`
- `manage-user`
- `evolution-api`
- `system-health`

Outras operam sem essa mesma checagem, o que pode ser aceitavel para jobs internos, mas merece revisao antes de endurecer producao.

### 6. Jobs agendados nao estao descritos no repositorio

As funcoes de lembrete, fila e aniversario existem, mas o repositorio nao mostra a configuracao do agendamento em si.

Possiveis cenarios:

- cron configurado fora do repo;
- scheduler do Supabase configurado em outro lugar;
- execucao manual/externa.

### 7. Documentacao original ainda e generica

O `README.md` ainda segue um template generico e nao descreve o dominio real do produto.

### 8. Cobertura de testes e minima

Hoje existe apenas um teste exemplo:

- `src/test/example.test.ts`

Ou seja, a maior parte da confianca atual do projeto depende de leitura de codigo e teste manual.

## Leitura Final

Estado atual do sistema:

- produto funcional em reservas, fila, mesas, dashboard e WhatsApp;
- modelo multi-tenant bem definido;
- backend concentrado em Supabase + Edge Functions;
- alguns pontos ainda com cheiro de transicao/legado (mock do calendario, toolbar DEV, autorizacao de usuarios por empresa).

Para continuidade do projeto, o caminho natural parece ser:

1. alinhar todas as telas ao Supabase real;
2. revisar permissao das edge functions;
3. explicitar os jobs agendados;
4. aumentar cobertura de testes;
5. substituir o README generico por documentacao do produto.
