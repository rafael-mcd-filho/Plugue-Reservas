-- A state remains attributable for 15 days after its latest eligible
-- activity. Keep expired state for another 30 days for diagnostics, then
-- remove it. Reservation snapshots are immutable and are never deleted here.
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

  PERFORM cron.schedule(
    'cleanup-expired-ads-journey-states',
    '23 6 * * *',
    $job$
    SELECT public.cleanup_expired_ads_journey_states(interval '30 days');
    $job$
  );
END;
$$;
