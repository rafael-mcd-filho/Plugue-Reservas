-- Enable Ads journey V2 in shadow mode for Beco Magico - Joao Pessoa.
-- Customer-facing dashboards continue using the legacy attribution method.

DO $$
DECLARE
  _company_id uuid := '1e0da55b-f8e9-4199-80b6-79c64e93cb7a';
  _company_slug text;
BEGIN
  SELECT company.slug
  INTO _company_slug
  FROM public.companies AS company
  WHERE company.id = _company_id;

  IF _company_slug IS DISTINCT FROM 'beco-magico-joao-pessoa' THEN
    RAISE EXCEPTION
      'Expected Beco Magico - Joao Pessoa at company %, found slug %',
      _company_id,
      _company_slug;
  END IF;

  INSERT INTO public.company_tracking_settings (
    company_id,
    ads_attribution_mode
  )
  VALUES (
    _company_id,
    'shadow'
  )
  ON CONFLICT (company_id) DO UPDATE
  SET
    ads_attribution_mode = EXCLUDED.ads_attribution_mode,
    updated_at = now();
END;
$$;

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
