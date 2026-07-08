CREATE OR REPLACE FUNCTION public.normalize_whatsapp_phone(_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH digits AS (
    SELECT regexp_replace(COALESCE(_phone, ''), '\D', '', 'g') AS value
  )
  SELECT CASE
    WHEN value = '' THEN NULL
    WHEN value !~ '^55' AND length(value) <= 11 THEN '55' || value
    ELSE value
  END
  FROM digits;
$$;

CREATE TABLE IF NOT EXISTS public.lead_reactivation_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  phone text NOT NULL,
  phone_normalized text NOT NULL,
  guest_name text,
  last_visit_date date NOT NULL,
  last_visit_source text,
  days_without_visit integer NOT NULL DEFAULT 30,
  channel text NOT NULL CHECK (channel IN ('evolution', 'pluguechat_official')),
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'queued', 'skipped', 'failed')),
  dispatch_key text NOT NULL,
  queue_id uuid,
  skip_reason text,
  error_details text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, phone_normalized, last_visit_date, days_without_visit),
  UNIQUE (dispatch_key)
);

CREATE INDEX IF NOT EXISTS idx_lead_reactivation_dispatches_company_created
  ON public.lead_reactivation_dispatches(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_reactivation_dispatches_phone
  ON public.lead_reactivation_dispatches(company_id, phone_normalized, last_visit_date DESC);

ALTER TABLE public.lead_reactivation_dispatches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view lead reactivation dispatches"
  ON public.lead_reactivation_dispatches;

CREATE POLICY "Company staff can view lead reactivation dispatches"
ON public.lead_reactivation_dispatches
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
  OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, company_id)
);

DROP TRIGGER IF EXISTS trg_touch_lead_reactivation_dispatches_updated_at
  ON public.lead_reactivation_dispatches;

CREATE TRIGGER trg_touch_lead_reactivation_dispatches_updated_at
BEFORE UPDATE ON public.lead_reactivation_dispatches
FOR EACH ROW
EXECUTE FUNCTION public.touch_whatsapp_broadcasts_updated_at();

DROP FUNCTION IF EXISTS public.get_lead_reactivation_candidates(uuid, integer, integer, date, boolean, boolean);

CREATE OR REPLACE FUNCTION public.get_lead_reactivation_candidates(
  _company_id uuid DEFAULT NULL,
  _days_without_visit integer DEFAULT 30,
  _limit integer DEFAULT 500,
  _reference_date date DEFAULT NULL,
  _exclude_future_reservations boolean DEFAULT true,
  _match_exact_days boolean DEFAULT false
)
RETURNS TABLE (
  lead_key text,
  company_id uuid,
  guest_name text,
  guest_phone text,
  phone_normalized text,
  last_visit_date date,
  last_visit_at timestamptz,
  last_visit_source text,
  last_reservation_id uuid,
  last_waitlist_id uuid,
  days_since_visit integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      COALESCE(_reference_date, (now() AT TIME ZONE 'America/Fortaleza')::date) AS reference_date,
      GREATEST(COALESCE(_days_without_visit, 30), 1) AS days_without_visit,
      LEAST(GREATEST(COALESCE(_limit, 500), 1), 1000) AS result_limit,
      COALESCE(_exclude_future_reservations, true) AS exclude_future_reservations,
      COALESCE(_match_exact_days, false) AS match_exact_days
  ),
  access AS (
    SELECT 1
    WHERE auth.role() = 'service_role'
       OR (
        _company_id IS NOT NULL
        AND (
          public.has_role(auth.uid(), 'superadmin'::public.app_role)
          OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
          OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, _company_id)
        )
      )
  ),
  visit_events AS (
    SELECT
      reservations.company_id,
      reservations.guest_name,
      reservations.guest_phone,
      public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
      COALESCE((reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date, reservations.date) AS visit_date,
      COALESCE(reservations.checked_in_at, (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza') AS visit_at,
      'reservation_guest'::text AS visit_source,
      reservations.id AS reservation_id,
      NULL::uuid AS waitlist_id,
      1 AS source_priority
    FROM public.reservations
    WHERE reservations.status IN ('checked_in', 'completed')
      AND reservations.guest_phone IS NOT NULL

    UNION ALL

    SELECT
      reservation_companions.company_id,
      reservation_companions.name AS guest_name,
      reservation_companions.phone AS guest_phone,
      public.normalize_whatsapp_phone(reservation_companions.phone) AS phone_normalized,
      COALESCE((reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date, reservations.date) AS visit_date,
      COALESCE(reservations.checked_in_at, (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza') AS visit_at,
      'reservation_companion'::text AS visit_source,
      reservations.id AS reservation_id,
      NULL::uuid AS waitlist_id,
      2 AS source_priority
    FROM public.reservation_companions
    JOIN public.reservations
      ON reservations.id = reservation_companions.reservation_id
    WHERE reservations.status IN ('checked_in', 'completed')
      AND reservation_companions.phone IS NOT NULL

    UNION ALL

    SELECT
      waitlist.company_id,
      waitlist.guest_name,
      waitlist.guest_phone,
      public.normalize_whatsapp_phone(waitlist.guest_phone) AS phone_normalized,
      COALESCE((waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date, (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date) AS visit_date,
      COALESCE(waitlist.seated_at, waitlist.created_at) AS visit_at,
      'waitlist_guest'::text AS visit_source,
      NULL::uuid AS reservation_id,
      waitlist.id AS waitlist_id,
      3 AS source_priority
    FROM public.waitlist
    WHERE waitlist.status = 'seated'
      AND waitlist.guest_phone IS NOT NULL

    UNION ALL

    SELECT
      waitlist_companions.company_id,
      waitlist_companions.name AS guest_name,
      waitlist_companions.phone AS guest_phone,
      public.normalize_whatsapp_phone(waitlist_companions.phone) AS phone_normalized,
      COALESCE((waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date, (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date) AS visit_date,
      COALESCE(waitlist.seated_at, waitlist.created_at) AS visit_at,
      'waitlist_companion'::text AS visit_source,
      NULL::uuid AS reservation_id,
      waitlist.id AS waitlist_id,
      4 AS source_priority
    FROM public.waitlist_companions
    JOIN public.waitlist
      ON waitlist.id = waitlist_companions.waitlist_id
    WHERE waitlist.status = 'seated'
      AND waitlist_companions.phone IS NOT NULL
  ),
  scoped_events AS (
    SELECT visit_events.*
    FROM visit_events
    WHERE EXISTS (SELECT 1 FROM access)
      AND (_company_id IS NULL OR visit_events.company_id = _company_id)
      AND visit_events.phone_normalized IS NOT NULL
  ),
  latest_visits AS (
    SELECT
      scoped_events.*,
      row_number() OVER (
        PARTITION BY scoped_events.company_id, scoped_events.phone_normalized
        ORDER BY scoped_events.visit_at DESC NULLS LAST, scoped_events.source_priority ASC
      ) AS rn
    FROM scoped_events
  ),
  eligible AS (
    SELECT
      latest_visits.*,
      params.reference_date,
      params.days_without_visit,
      params.exclude_future_reservations,
      params.match_exact_days,
      (params.reference_date - latest_visits.visit_date)::integer AS days_since_visit
    FROM latest_visits
    CROSS JOIN params
    WHERE latest_visits.rn = 1
      AND (
        (params.match_exact_days AND latest_visits.visit_date = params.reference_date - params.days_without_visit)
        OR (NOT params.match_exact_days AND latest_visits.visit_date <= params.reference_date - params.days_without_visit)
      )
  )
  SELECT
    format(
      'lead:%s:%s:%s',
      eligible.company_id,
      eligible.phone_normalized,
      eligible.visit_date
    ) AS lead_key,
    eligible.company_id,
    eligible.guest_name,
    eligible.guest_phone,
    eligible.phone_normalized,
    eligible.visit_date AS last_visit_date,
    eligible.visit_at AS last_visit_at,
    eligible.visit_source AS last_visit_source,
    eligible.reservation_id AS last_reservation_id,
    eligible.waitlist_id AS last_waitlist_id,
    eligible.days_since_visit
  FROM eligible
  CROSS JOIN params
  WHERE NOT (
    eligible.exclude_future_reservations
    AND EXISTS (
      SELECT 1
      FROM public.reservations future_reservations
      WHERE future_reservations.company_id = eligible.company_id
        AND future_reservations.date >= eligible.reference_date
        AND future_reservations.status IN ('confirmed', 'pending_payment')
        AND (
          public.normalize_whatsapp_phone(future_reservations.guest_phone) = eligible.phone_normalized
          OR EXISTS (
            SELECT 1
            FROM public.reservation_companions future_companions
            WHERE future_companions.reservation_id = future_reservations.id
              AND public.normalize_whatsapp_phone(future_companions.phone) = eligible.phone_normalized
          )
        )
    )
  )
  ORDER BY eligible.visit_date ASC, eligible.guest_name ASC
  LIMIT (SELECT result_limit FROM params);
$$;

REVOKE ALL ON FUNCTION public.normalize_whatsapp_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_whatsapp_phone(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_lead_reactivation_candidates(uuid, integer, integer, date, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_lead_reactivation_candidates(uuid, integer, integer, date, boolean, boolean) TO authenticated, service_role;

DO $$
DECLARE
  _job record;
BEGIN
  FOR _job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'send-reactivation-messages-daily'
  LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

-- 12:10 GMT = 09:10 in America/Fortaleza (UTC-3).
SELECT cron.schedule(
  'send-reactivation-messages-daily',
  '10 12 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://hdpxqqiudiotanrybvcf.supabase.co/functions/v1/send-reactivation-messages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $job$
);
