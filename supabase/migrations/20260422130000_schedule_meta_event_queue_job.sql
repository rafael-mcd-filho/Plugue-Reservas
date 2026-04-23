CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('internal_job_secret', NULL, now())
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  _existing_job_id bigint;
BEGIN
  SELECT jobid
  INTO _existing_job_id
  FROM cron.job
  WHERE jobname = 'process-meta-event-queue'
  LIMIT 1;

  IF _existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(_existing_job_id);
  END IF;
END;
$$;

SELECT cron.schedule(
  'process-meta-event-queue',
  '*/1 * * * *',
  $job$
  SELECT CASE
    WHEN COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '') <> ''
      THEN net.http_post(
        url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/process-meta-event-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
        ),
        body := '{}'::jsonb
      )
    ELSE NULL
  END AS request_id;
  $job$
);
