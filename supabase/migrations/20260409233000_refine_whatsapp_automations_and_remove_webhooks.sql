CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('internal_job_secret', NULL, now())
ON CONFLICT (key) DO NOTHING;

DROP TABLE IF EXISTS public.webhook_configs CASCADE;

DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
      'send-reservation-reminders',
      'check-whatsapp-status-every-10min',
      'process-whatsapp-message-queue',
      'send-post-visit-messages',
      'send-birthday-messages-hourly'
    )
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'send-reservation-reminders',
  '*/10 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);

SELECT cron.schedule(
  'check-whatsapp-status-every-10min',
  '*/10 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/check-whatsapp-status',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);

SELECT cron.schedule(
  'process-whatsapp-message-queue',
  '*/2 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/process-message-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);

SELECT cron.schedule(
  'send-post-visit-messages',
  '*/15 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/send-post-visit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);

SELECT cron.schedule(
  'send-birthday-messages-hourly',
  '5 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/send-birthday-messages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);
