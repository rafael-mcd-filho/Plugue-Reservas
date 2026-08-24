-- Incremental capture: the hourly job keeps the operational horizon fresh,
-- while the off-peak daily job expands the full 90-day horizon. The pipeline
-- uses a non-blocking advisory lock, so overlapping executions skip instead of
-- piling up database work.

DO $$
DECLARE
  _job record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR _job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'occupancy-capacity-snapshot-hourly',
        'occupancy-capacity-snapshot-daily'
      )
    LOOP
      PERFORM cron.unschedule(_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'occupancy-capacity-snapshot-hourly',
      '17 * * * *',
      'SELECT public._run_occupancy_capacity_snapshot_pipeline(7, 100);'
    );

    PERFORM cron.schedule(
      'occupancy-capacity-snapshot-daily',
      '43 2 * * *',
      'SELECT public._run_occupancy_capacity_snapshot_pipeline(90, 1000);'
    );
  END IF;
END;
$$;
