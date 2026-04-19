DO $$
DECLARE
  _existing_job_id bigint;
BEGIN
  _existing_job_id := (
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'mark-confirmed-reservations-no-show'
    LIMIT 1
  );

  IF _existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(_existing_job_id);
  END IF;
END;
$$;

-- Run once a day at 05:05 in America/Fortaleza.
-- Supabase/pg_cron schedules are evaluated in GMT by default, so 08:05 GMT
-- corresponds to 05:05 in Fortaleza (UTC-3).
SELECT cron.schedule(
  'mark-confirmed-reservations-no-show',
  '5 8 * * *',
  $$SELECT public.mark_confirmed_reservations_as_no_show(((now() AT TIME ZONE 'America/Fortaleza')::date));$$
);

-- Backfill missed no-show updates as soon as this migration is applied.
SELECT public.mark_confirmed_reservations_as_no_show(((now() AT TIME ZONE 'America/Fortaleza')::date));
