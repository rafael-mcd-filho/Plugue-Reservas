DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
      'send-post-visit-messages',
      'send-birthday-messages-hourly',
      'send-birthday-messages-daily'
    )
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

-- Supabase/pg_cron schedules are evaluated in GMT by default.
-- 11:05 GMT = 08:05 in America/Fortaleza (UTC-3).
SELECT cron.schedule(
  'send-post-visit-messages',
  '5 11 * * *',
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

-- 12:05 GMT = 09:05 in America/Fortaleza (UTC-3).
SELECT cron.schedule(
  'send-birthday-messages-daily',
  '5 12 * * *',
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
