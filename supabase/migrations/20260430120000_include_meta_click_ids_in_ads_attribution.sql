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
        OR NULLIF(btrim(COALESCE(te.metadata ->> 'fbclid', '')), '') IS NOT NULL
        OR NULLIF(btrim(COALESCE(te.metadata ->> 'fbc', '')), '') IS NOT NULL
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
                OR NULLIF(btrim(COALESCE(ts.fbclid, '')), '') IS NOT NULL
                OR NULLIF(btrim(COALESCE(ts.fbc, '')), '') IS NOT NULL
              )
          )
        )
        OR (
          te.reservation_id IS NOT NULL
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
                OR NULLIF(btrim(COALESCE(r.attribution_snapshot ->> 'fbclid', '')), '') IS NOT NULL
                OR NULLIF(btrim(COALESCE(r.origin_fbc, r.attribution_snapshot ->> 'fbc', '')), '') IS NOT NULL
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
