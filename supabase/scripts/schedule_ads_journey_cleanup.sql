-- Optional rollout step for Ads journey V2.
-- Run only after the shadow migration has been applied and validated.
--
-- A state expires 30 days after its last eligible activity. This job keeps
-- expired rows for another 30 days for diagnostics, then removes them. The
-- frozen attribution snapshot on reservations is not deleted.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'cleanup-expired-ads-journey-states'
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
    'cleanup-expired-ads-journey-states',
    '23 6 * * *',
    $job$
    SELECT public.cleanup_expired_ads_journey_states(interval '30 days');
    $job$
);
