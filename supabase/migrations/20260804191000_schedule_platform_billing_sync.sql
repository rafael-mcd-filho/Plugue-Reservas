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
    WHERE jobname = 'sync-platform-billing-invoices'
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

-- Runs every four hours, but deliberately performs no HTTP request until the
-- singleton config is explicitly enabled and both required secrets exist.
SELECT cron.schedule(
  'sync-platform-billing-invoices',
  '0 */4 * * *',
  $job$
  SELECT CASE
    WHEN COALESCE((
      SELECT pbc.module_enabled
      FROM public.platform_billing_config pbc
      WHERE pbc.id = true
      LIMIT 1
    ), false) = true
      AND EXISTS (
        SELECT 1
        FROM public.platform_billing_config pbc
        WHERE pbc.id = true
          AND pbc.api_token_encrypted IS NOT NULL
          AND pbc.token_validated_at IS NOT NULL
          AND pbc.token_last_error IS NULL
      )
      AND COALESCE((
        SELECT value
        FROM public.system_settings
        WHERE key = 'internal_job_secret'
        LIMIT 1
      ), '') <> ''
      THEN net.http_post(
        url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/platform-billing',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-job-secret', COALESCE((
            SELECT value
            FROM public.system_settings
            WHERE key = 'internal_job_secret'
            LIMIT 1
          ), '')
        ),
        body := jsonb_build_object('action', 'sync_all')
      )
    ELSE NULL
  END AS request_id;
  $job$
);
