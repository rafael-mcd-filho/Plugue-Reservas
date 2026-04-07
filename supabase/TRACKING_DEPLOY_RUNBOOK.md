# Tracking Deploy Runbook

Este runbook cobre a ativacao da nova camada de tracking via banco, painel de eventos e envio via Meta CAPI.

## 1. Pre-requisitos

- Supabase CLI instalada e autenticada
- Projeto vinculado ao ref `hdpxqqiudiotanrybvcf`
- Ambiente de producao com build web atualizado

## 2. Vincular o projeto

```sh
supabase link --project-ref hdpxqqiudiotanrybvcf
```

## 3. Aplicar migrations

Aplicar a migration que cria:

- `tracking_sessions`
- `tracking_journeys`
- `tracking_events`
- `company_tracking_settings`
- `meta_event_queue`
- `meta_event_attempts`
- colunas de tracking em `reservations`

Comando:

```sh
supabase db push
```

Migration principal:

- `supabase/migrations/20260405103000_add_database_first_tracking_and_meta_queue.sql`

## 4. Publicar edge functions

Publicar as funcoes novas/alteradas:

```sh
supabase functions deploy public-tracking
supabase functions deploy process-meta-event-queue
supabase functions deploy system-health
```

Se houver alteracoes paralelas no ambiente, publicar tambem:

```sh
supabase functions deploy reservation-events
```

## 5. Configurar secrets

### Obrigatoria

Secret usada para jobs internos e processamento seguro da fila:

```sh
supabase secrets set INTERNAL_JOB_SECRET="gere-um-segredo-forte-aqui"
```

### Opcional

Versao da Graph API da Meta:

```sh
supabase secrets set META_GRAPH_API_VERSION="v22.0"
```

## 6. Atualizar frontend

Subir o build web com os arquivos novos:

- dashboard com funil novo e painel ao vivo
- tela `/:slug/admin/eventos`
- timeline de tracking dentro da reserva

Validacao local:

```sh
npm run build
```

## 7. Validar tracking publico

### Debug no navegador

Acesse a pagina publica com:

```txt
/:slug?funnel_debug=1
```

O painel flutuante deve mostrar:

- `page_view`
- `date_select`
- `time_select`
- `form_fill`

### Validacao no admin

Abrir:

```txt
/:slug/admin/eventos
```

Conferir:

- bloco de metricas
- tabela `Log de eventos`
- fila Meta
- tentativas Meta

## 8. Validar dashboard

Abrir:

```txt
/:slug/admin
```

Conferir:

- funil com contagem por sessoes/jornadas
- checkbox `Mostrar apenas unicos`
- painel `Ao Vivo Agora` com janela de 5 minutos

## 9. Processar fila Meta manualmente

### Pela tela admin

Usar o botao:

- `Processar fila Meta`

### Via HTTP com secret interno

```sh
curl -X POST "https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/process-meta-event-queue" ^
  -H "Content-Type: application/json" ^
  -H "x-job-secret: SEU_INTERNAL_JOB_SECRET" ^
  -d "{}"
```

## 10. Configurar Meta por unidade

Na tela:

```txt
/:slug/admin/eventos
```

Preencher:

- `Pixel ID`
- `Access Token`
- `Test Event Code` se necessario

Ativar os toggles desejados:

- `PageView`
- `InitiateCheckout`
- `Lead`

## 11. Checklist de aceite

- migration aplicada sem erro
- edge functions publicadas
- `page_view` aparecendo em `admin/eventos`
- `time_select` aparecendo em `admin/eventos` e entrando na Meta como `InitiateCheckout`
- `reservation_created` aparecendo em `admin/eventos` e entrando na Meta como `Lead`
- fila Meta registrando payload e resposta
- painel ao vivo populando com atividade recente

## 12. Observacao sobre cron

O worker `process-meta-event-queue` ja esta pronto para processamento automatico, mas o agendamento por cron nao foi colocado em migration porque depende da estrategia segura de entrega do `INTERNAL_JOB_SECRET` para o job HTTP.

A recomendacao e:

- configurar o secret no ambiente
- testar o endpoint manualmente
- so depois criar o agendamento automatizado com o mesmo header `x-job-secret`
