-- Agendamento dos jobs de processamento da fila e disparos PlugueChat

-- Remove jobs anteriores com esses nomes, caso existam de execuções anteriores
DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
      'process-pluguechat-message-queue',
      'process-pluguechat-broadcasts'
    )
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

-- Processar fila de mensagens PlugueChat a cada 2 minutos (mesmo intervalo da fila Evolution)
SELECT cron.schedule(
  'process-pluguechat-message-queue',
  '*/2 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/process-pluguechat-message-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);

-- Processar disparos PlugueChat a cada 5 minutos (mesmo intervalo dos disparos Evolution)
SELECT cron.schedule(
  'process-pluguechat-broadcasts',
  '*/5 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/process-pluguechat-broadcasts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);
