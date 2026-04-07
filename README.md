# Plugue Reservas

Sistema multi-tenant de reservas para restaurantes com pagina publica por empresa, painel administrativo por unidade, painel global de superadmin e automacoes via WhatsApp integradas ao Supabase.

## Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Supabase
- Vitest
- Playwright

## Rodando localmente

```sh
npm install
npm run dev
```

Aplicacao local: `http://127.0.0.1:8080`

## Scripts

- `npm run dev` inicia o servidor local
- `npm run build` gera o build de producao
- `npm run preview` abre o build localmente
- `npm run lint` executa o ESLint
- `npm run test` executa a suite do Vitest

## Estrutura principal

- `src/` frontend React
- `supabase/migrations/` migracoes SQL
- `supabase/functions/` edge functions
- `public/` assets estaticos

## Dominios do produto

- Pagina publica por empresa em `/:slug`
- Painel administrativo por unidade em `/:slug/admin/...`
- Painel global em rotas como `/dashboard`, `/empresas` e `/configuracoes`

## Observacoes

- O branding exibido no sistema pode ser configurado em `system_settings`
- A integracao de dados e autenticacao e feita via Supabase
- O deploy operacional do novo tracking e da Meta CAPI esta documentado em `supabase/TRACKING_DEPLOY_RUNBOOK.md`
