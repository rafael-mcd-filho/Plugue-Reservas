-- Remove qualquer job anterior com este nome, caso exista
DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'send-no-show-messages'
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

-- Agendar envio de mensagens de no-show às 09:05 (horário de Fortaleza, UTC-3 = 12:05 UTC)
SELECT cron.schedule(
  'send-no-show-messages',
  '5 12 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/send-no-show-messages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);
