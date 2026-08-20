-- Projection is asynchronous by design.  These jobs read tracking_events only;
-- they do not call, update or replace any Meta queue function/worker.
DO $$
DECLARE
  _job_id bigint;
BEGIN
  SELECT jobid INTO _job_id
  FROM cron.job
  WHERE jobname = 'project-tracking-funnel-read-model'
  LIMIT 1;

  IF _job_id IS NOT NULL THEN
    PERFORM cron.unschedule(_job_id);
  END IF;

  SELECT jobid INTO _job_id
  FROM cron.job
  WHERE jobname = 'reconcile-tracking-funnel-read-model'
  LIMIT 1;

  IF _job_id IS NOT NULL THEN
    PERFORM cron.unschedule(_job_id);
  END IF;
END;
$$;

SELECT cron.schedule(
  'project-tracking-funnel-read-model',
  '*/1 * * * *',
  $job$
    SELECT public._run_tracking_funnel_projection(25, 2000, interval '30 minutes');
  $job$
);

-- A wider daily repair window covers unusually late commits and isolated raw
-- deletions without putting that cost on every minute-level projection pass.
SELECT cron.schedule(
  'reconcile-tracking-funnel-read-model',
  '40 3 * * *',
  $job$
    SELECT public._run_tracking_funnel_reconciliation(interval '7 days', 200, 50000);
  $job$
);
