CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('internal_job_secret', NULL, now())
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'expire-reservation-payments'
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'expire-reservation-payments',
  '*/1 * * * *',
  $job$
  SELECT CASE
    WHEN COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '') <> ''
      THEN net.http_post(
        url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/expire-reservation-payments',
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
