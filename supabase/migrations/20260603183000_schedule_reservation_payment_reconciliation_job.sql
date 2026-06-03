CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('internal_job_secret', NULL, now())
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_reservation_payments_reconcile_queue
ON public.reservation_payments(company_id, status, last_checked_at, created_at)
WHERE asaas_payment_id IS NOT NULL
   OR payment_link_external_reference IS NOT NULL
   OR asaas_payment_link_id IS NOT NULL;

DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'reconcile-reservation-payments'
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'reconcile-reservation-payments',
  '*/10 * * * *',
  $job$
  SELECT CASE
    WHEN COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '') <> ''
      AND EXISTS (
        SELECT 1
        FROM public.reservation_payment_rules
        WHERE enabled = true
          AND archived_at IS NULL
        LIMIT 1
      )
      THEN net.http_post(
        url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/reconcile-reservation-payments',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
        ),
        body := jsonb_build_object(
          'limit', 25,
          'batch_size', 5,
          'delay_ms', 500,
          'stale_minutes', 30,
          'lookback_days', 120
        )
      )
    ELSE NULL
  END AS request_id;
  $job$
);
