-- Run this in the Supabase SQL Editor after applying:
-- supabase/migrations/20260429120000_optimize_tracking_query_performance.sql
--
-- Expected result: every row should have status = 'ok'.
-- Any status = 'diff' means the new RPC is producing a different metric
-- from the previous frontend calculation for that scenario.

SET TIME ZONE 'America/Fortaleza';

DROP TABLE IF EXISTS pg_temp.tracking_funnel_compare;
DROP TABLE IF EXISTS pg_temp.tracking_live_compare;

CREATE TEMP TABLE tracking_funnel_compare AS
WITH periods AS (
  SELECT
    'today'::text AS period_key,
    date_trunc('day', now()) AS start_at,
    date_trunc('day', now()) + interval '1 day' - interval '1 millisecond' AS end_at
  UNION ALL
  SELECT
    'yesterday',
    date_trunc('day', now() - interval '1 day'),
    date_trunc('day', now()) - interval '1 millisecond'
  UNION ALL
  SELECT
    'last_7_days',
    date_trunc('day', now() - interval '6 days'),
    date_trunc('day', now()) + interval '1 day' - interval '1 millisecond'
  UNION ALL
  SELECT
    'this_week',
    date_trunc('week', now()),
    date_trunc('day', now()) + interval '1 day' - interval '1 millisecond'
  UNION ALL
  SELECT
    'last_week',
    date_trunc('week', now() - interval '1 week'),
    date_trunc('week', now()) - interval '1 millisecond'
  UNION ALL
  SELECT
    'this_month',
    date_trunc('month', now()),
    date_trunc('day', now()) + interval '1 day' - interval '1 millisecond'
  UNION ALL
  SELECT
    'last_month',
    date_trunc('month', now() - interval '1 month'),
    date_trunc('month', now()) - interval '1 millisecond'
),
company_scopes AS (
  SELECT NULL::uuid AS company_id, 'ALL_COMPANIES'::text AS company_name
  UNION ALL
  SELECT id, name
  FROM public.companies
  WHERE status = 'active'
),
modes AS (
  SELECT *
  FROM (VALUES
    (false, false),
    (true, false),
    (false, true),
    (true, true)
  ) AS mode_flags(unique_only, ads_only)
),
steps AS (
  SELECT *
  FROM (VALUES
    ('page_view'::text, 1),
    ('date_select'::text, 2),
    ('time_select'::text, 3),
    ('form_fill'::text, 4),
    ('completed'::text, 5)
  ) AS ordered_steps(step, sort_order)
),
scenarios AS (
  SELECT
    periods.period_key,
    periods.start_at,
    periods.end_at,
    company_scopes.company_id,
    company_scopes.company_name,
    modes.unique_only,
    modes.ads_only
  FROM periods
  CROSS JOIN company_scopes
  CROSS JOIN modes
),
old_funnel_events AS (
  SELECT
    scenarios.period_key,
    scenarios.company_id,
    scenarios.company_name,
    scenarios.unique_only,
    scenarios.ads_only,
    CASE
      WHEN te.event_name = 'page_view' THEN 'page_view'
      WHEN te.event_name = 'date_select' THEN 'date_select'
      WHEN te.event_name = 'time_select' THEN 'time_select'
      WHEN te.event_name IN ('form_fill', 'lead_captured') THEN 'form_fill'
      WHEN te.event_name = 'reservation_created' THEN 'completed'
      ELSE NULL
    END AS step,
    CASE
      WHEN scenarios.unique_only THEN te.anonymous_id
      WHEN te.event_name = 'page_view' THEN COALESCE(te.session_id::text, te.anonymous_id)
      WHEN te.event_name = 'reservation_created' THEN COALESCE(te.reservation_id::text, te.journey_id::text, te.session_id::text, te.anonymous_id)
      ELSE COALESCE(te.journey_id::text, te.session_id::text, te.anonymous_id)
    END AS identity_key
  FROM scenarios
  JOIN public.tracking_events te
    ON te.tracking_source = 'public'
   AND (scenarios.company_id IS NULL OR te.company_id = scenarios.company_id)
   AND te.occurred_at >= scenarios.start_at
   AND te.occurred_at <= scenarios.end_at
   AND te.event_name IN (
      'page_view',
      'date_select',
      'time_select',
      'form_fill',
      'lead_captured',
      'reservation_created'
    )
  WHERE (
    NOT scenarios.ads_only
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
),
old_funnel_counts AS (
  SELECT
    period_key,
    company_id,
    company_name,
    unique_only,
    ads_only,
    step,
    count(DISTINCT identity_key)::bigint AS old_count
  FROM old_funnel_events
  WHERE step IS NOT NULL
  GROUP BY period_key, company_id, company_name, unique_only, ads_only, step
),
new_funnel_counts AS (
  SELECT
    scenarios.period_key,
    scenarios.company_id,
    scenarios.company_name,
    scenarios.unique_only,
    scenarios.ads_only,
    new_counts.step,
    new_counts.event_count::bigint AS new_count
  FROM scenarios
  CROSS JOIN LATERAL public.get_tracking_funnel_counts(
    scenarios.company_id,
    scenarios.start_at,
    scenarios.end_at,
    scenarios.unique_only,
    scenarios.ads_only
  ) AS new_counts
)
SELECT
  'funnel'::text AS check_type,
  scenarios.period_key,
  scenarios.company_name,
  scenarios.unique_only,
  scenarios.ads_only,
  steps.step AS metric,
  COALESCE(old_funnel_counts.old_count, 0)::bigint AS old_count,
  COALESCE(new_funnel_counts.new_count, 0)::bigint AS new_count,
  COALESCE(new_funnel_counts.new_count, 0)::bigint - COALESCE(old_funnel_counts.old_count, 0)::bigint AS delta,
  NULL::integer AS old_total_active,
  NULL::integer AS new_total_active,
  NULL::integer AS total_delta,
  CASE
    WHEN COALESCE(old_funnel_counts.old_count, 0) = COALESCE(new_funnel_counts.new_count, 0) THEN 'ok'
    ELSE 'diff'
  END AS status
FROM scenarios
CROSS JOIN steps
LEFT JOIN old_funnel_counts
  ON old_funnel_counts.period_key = scenarios.period_key
 AND old_funnel_counts.company_id IS NOT DISTINCT FROM scenarios.company_id
 AND old_funnel_counts.unique_only = scenarios.unique_only
 AND old_funnel_counts.ads_only = scenarios.ads_only
 AND old_funnel_counts.step = steps.step
LEFT JOIN new_funnel_counts
  ON new_funnel_counts.period_key = scenarios.period_key
 AND new_funnel_counts.company_id IS NOT DISTINCT FROM scenarios.company_id
 AND new_funnel_counts.unique_only = scenarios.unique_only
 AND new_funnel_counts.ads_only = scenarios.ads_only
 AND new_funnel_counts.step = steps.step;

CREATE TEMP TABLE tracking_live_compare AS
WITH company_scopes AS (
  SELECT NULL::uuid AS company_id, 'ALL_COMPANIES'::text AS company_name
  UNION ALL
  SELECT id, name
  FROM public.companies
  WHERE status = 'active'
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
old_live_events AS (
  SELECT DISTINCT ON (
    company_scopes.company_id,
    CASE
      WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
      ELSE 'anonymous:' || te.anonymous_id
    END
  )
    company_scopes.company_id,
    company_scopes.company_name,
    CASE
      WHEN te.event_name = 'reservation_created' THEN 'completed'
      WHEN te.event_name IN ('form_fill', 'lead_captured') THEN 'form_fill'
      WHEN te.event_name = 'time_select' THEN 'time_select'
      WHEN te.event_name IN ('date_select', 'booking_started') THEN 'date_select'
      WHEN te.event_name = 'page_view' THEN 'page_view'
      ELSE NULL
    END AS stage
  FROM company_scopes
  JOIN public.tracking_events te
    ON te.tracking_source = 'public'
   AND (company_scopes.company_id IS NULL OR te.company_id = company_scopes.company_id)
   AND te.occurred_at >= now() - interval '5 minutes'
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
    company_scopes.company_id,
    CASE
      WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
      ELSE 'anonymous:' || te.anonymous_id
    END,
    te.occurred_at DESC
),
old_live_counts AS (
  SELECT
    company_id,
    company_name,
    stage,
    count(*)::integer AS old_count
  FROM old_live_events
  WHERE stage IS NOT NULL
  GROUP BY company_id, company_name, stage
),
old_live_totals AS (
  SELECT
    company_id,
    company_name,
    count(*)::integer AS old_total_active
  FROM old_live_events
  WHERE stage IS NOT NULL
  GROUP BY company_id, company_name
),
new_live_counts AS (
  SELECT
    company_scopes.company_id,
    company_scopes.company_name,
    new_counts.stage,
    new_counts.stage_count,
    new_counts.total_active
  FROM company_scopes
  CROSS JOIN LATERAL public.get_live_funnel_presence(company_scopes.company_id, 5) AS new_counts
)
SELECT
  'live_presence'::text AS check_type,
  NULL::text AS period_key,
  company_scopes.company_name,
  NULL::boolean AS unique_only,
  NULL::boolean AS ads_only,
  stages.stage AS metric,
  COALESCE(old_live_counts.old_count, 0)::bigint AS old_count,
  COALESCE(new_live_counts.stage_count, 0)::bigint AS new_count,
  COALESCE(new_live_counts.stage_count, 0)::bigint - COALESCE(old_live_counts.old_count, 0)::bigint AS delta,
  COALESCE(old_live_totals.old_total_active, 0)::integer AS old_total_active,
  COALESCE(new_live_counts.total_active, 0)::integer AS new_total_active,
  COALESCE(new_live_counts.total_active, 0)::integer - COALESCE(old_live_totals.old_total_active, 0)::integer AS total_delta,
  CASE
    WHEN COALESCE(old_live_counts.old_count, 0) = COALESCE(new_live_counts.stage_count, 0)
     AND COALESCE(old_live_totals.old_total_active, 0) = COALESCE(new_live_counts.total_active, 0)
      THEN 'ok'
    ELSE 'diff'
  END AS status
FROM company_scopes
CROSS JOIN stages
LEFT JOIN old_live_counts
  ON old_live_counts.company_id IS NOT DISTINCT FROM company_scopes.company_id
 AND old_live_counts.stage = stages.stage
LEFT JOIN old_live_totals
  ON old_live_totals.company_id IS NOT DISTINCT FROM company_scopes.company_id
LEFT JOIN new_live_counts
  ON new_live_counts.company_id IS NOT DISTINCT FROM company_scopes.company_id
 AND new_live_counts.stage = stages.stage;

SELECT *
FROM tracking_funnel_compare
UNION ALL
SELECT *
FROM tracking_live_compare
ORDER BY
  status,
  check_type,
  period_key NULLS LAST,
  company_name,
  unique_only NULLS LAST,
  ads_only NULLS LAST,
  metric;
