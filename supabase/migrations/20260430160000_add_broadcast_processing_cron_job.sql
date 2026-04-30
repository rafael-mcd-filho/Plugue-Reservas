-- Remove qualquer job anterior com este nome, caso exista
DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'process-whatsapp-broadcasts'
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

-- Agendar processamento de disparos em massa a cada 5 minutos
SELECT cron.schedule(
  'process-whatsapp-broadcasts',
  '*/5 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/process-whatsapp-broadcasts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);
