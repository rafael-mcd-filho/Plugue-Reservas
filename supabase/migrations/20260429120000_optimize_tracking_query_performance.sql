CREATE INDEX IF NOT EXISTS idx_tracking_events_public_company_event_time
ON public.tracking_events(company_id, event_name, occurred_at DESC)
INCLUDE (session_id, journey_id, reservation_id, anonymous_id)
WHERE tracking_source = 'public';

CREATE INDEX IF NOT EXISTS idx_tracking_events_public_time_event
ON public.tracking_events(occurred_at DESC, event_name)
INCLUDE (company_id, session_id, journey_id, reservation_id, anonymous_id)
WHERE tracking_source = 'public';

CREATE INDEX IF NOT EXISTS idx_meta_event_queue_company_status_created
ON public.meta_event_queue(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_meta_event_queue_company_meta_created
ON public.meta_event_queue(company_id, meta_event_name, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_tracking_funnel_counts(
  _company_id uuid DEFAULT NULL,
  _start_at timestamptz DEFAULT NULL,
  _end_at timestamptz DEFAULT NULL,
  _unique_only boolean DEFAULT false,
  _ads_only boolean DEFAULT false
)
RETURNS TABLE(step text, event_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH steps AS (
    SELECT *
    FROM (VALUES
      ('page_view'::text, 1),
      ('date_select'::text, 2),
      ('time_select'::text, 3),
      ('form_fill'::text, 4),
      ('completed'::text, 5)
    ) AS ordered_steps(step, sort_order)
  ),
  filtered_events AS (
    SELECT
      CASE
        WHEN te.event_name = 'page_view' THEN 'page_view'
        WHEN te.event_name = 'date_select' THEN 'date_select'
        WHEN te.event_name = 'time_select' THEN 'time_select'
        WHEN te.event_name IN ('form_fill', 'lead_captured') THEN 'form_fill'
        WHEN te.event_name = 'reservation_created' THEN 'completed'
        ELSE NULL
      END AS step,
      CASE
        WHEN _unique_only THEN te.anonymous_id
        WHEN te.event_name = 'page_view' THEN COALESCE(te.session_id::text, te.anonymous_id)
        WHEN te.event_name = 'reservation_created' THEN COALESCE(te.reservation_id::text, te.journey_id::text, te.session_id::text, te.anonymous_id)
        ELSE COALESCE(te.journey_id::text, te.session_id::text, te.anonymous_id)
      END AS identity_key
    FROM public.tracking_events te
    WHERE te.tracking_source = 'public'
      AND (_company_id IS NULL OR te.company_id = _company_id)
      AND (_start_at IS NULL OR te.occurred_at >= _start_at)
      AND (_end_at IS NULL OR te.occurred_at <= _end_at)
      AND te.event_name IN (
        'page_view',
        'date_select',
        'time_select',
        'form_fill',
        'lead_captured',
        'reservation_created'
      )
      AND (
        NOT _ads_only
        OR (
          te.session_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.tracking_sessions ts
            WHERE ts.id = te.session_id
              AND (
                lower(btrim(COALESCE(ts.utm_medium, ''))) IN (
                  'ads',
                  'cpc',
                  'cpm',
                  'cpv',
                  'paid',
                  'paid-social',
                  'paid_social',
                  'ppc',
                  'social_paid'
                )
                OR lower(btrim(COALESCE(ts.utm_medium, ''))) LIKE 'paid%'
              )
          )
        )
        OR (
          te.session_id IS NULL
          AND te.reservation_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.reservations r
            WHERE r.id = te.reservation_id
              AND (
                lower(btrim(COALESCE(r.attribution_snapshot ->> 'utm_medium', ''))) IN (
                  'ads',
                  'cpc',
                  'cpm',
                  'cpv',
                  'paid',
                  'paid-social',
                  'paid_social',
                  'ppc',
                  'social_paid'
                )
                OR lower(btrim(COALESCE(r.attribution_snapshot ->> 'utm_medium', ''))) LIKE 'paid%'
              )
          )
        )
      )
  )
  SELECT
    steps.step,
    COALESCE(count(DISTINCT filtered_events.identity_key), 0)::bigint AS event_count
  FROM steps
  LEFT JOIN filtered_events
    ON filtered_events.step = steps.step
  GROUP BY steps.step, steps.sort_order
  ORDER BY steps.sort_order;
$$;

REVOKE ALL ON FUNCTION public.get_tracking_funnel_counts(uuid, timestamptz, timestamptz, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tracking_funnel_counts(uuid, timestamptz, timestamptz, boolean, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_live_funnel_presence(
  _company_id uuid DEFAULT NULL,
  _window_minutes integer DEFAULT 5
)
RETURNS TABLE(stage text, stage_count integer, total_active integer, window_minutes integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT GREATEST(COALESCE(_window_minutes, 5), 1) AS minutes
  ),
  stages AS (
    SELECT *
    FROM (VALUES
      ('page_view'::text, 1),
      ('date_select'::text, 2),
      ('time_select'::text, 3),
      ('form_fill'::text, 4),
      ('completed'::text, 5)
    ) AS ordered_stages(stage, sort_order)
  ),
  latest_events AS (
    SELECT DISTINCT ON (
      CASE
        WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
        ELSE 'anonymous:' || te.anonymous_id
      END
    )
      CASE
        WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
        ELSE 'anonymous:' || te.anonymous_id
      END AS presence_key,
      CASE
        WHEN te.event_name = 'reservation_created' THEN 'completed'
        WHEN te.event_name IN ('form_fill', 'lead_captured') THEN 'form_fill'
        WHEN te.event_name = 'time_select' THEN 'time_select'
        WHEN te.event_name IN ('date_select', 'booking_started') THEN 'date_select'
        WHEN te.event_name = 'page_view' THEN 'page_view'
        ELSE NULL
      END AS stage
    FROM public.tracking_events te
    CROSS JOIN params
    WHERE te.tracking_source = 'public'
      AND (_company_id IS NULL OR te.company_id = _company_id)
      AND te.occurred_at >= now() - make_interval(mins => params.minutes)
      AND te.event_name IN (
        'page_view',
        'booking_started',
        'date_select',
        'time_select',
        'form_fill',
        'lead_captured',
        'reservation_created'
      )
    ORDER BY
      CASE
        WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
        ELSE 'anonymous:' || te.anonymous_id
      END,
      te.occurred_at DESC
  ),
  counted AS (
    SELECT latest_events.stage, count(*)::integer AS stage_count
    FROM latest_events
    WHERE latest_events.stage IS NOT NULL
    GROUP BY latest_events.stage
  ),
  total AS (
    SELECT count(*)::integer AS total_active
    FROM latest_events
    WHERE latest_events.stage IS NOT NULL
  )
  SELECT
    stages.stage,
    COALESCE(counted.stage_count, 0)::integer AS stage_count,
    total.total_active,
    params.minutes AS window_minutes
  FROM stages
  CROSS JOIN params
  CROSS JOIN total
  LEFT JOIN counted
    ON counted.stage = stages.stage
  ORDER BY stages.sort_order;
$$;

REVOKE ALL ON FUNCTION public.get_live_funnel_presence(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_live_funnel_presence(uuid, integer) TO authenticated;
