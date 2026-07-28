-- Compares the Ads attribution used by the current Dashboard (legacy_v1)
-- with the 30-day rolling journey attribution (journey_v2).
--
-- Run manually in the Supabase SQL Editor. This is NOT a migration.
-- It never changes public application data: it only creates temporary tables
-- for the current SQL session and returns a report.
--
-- journey_v2 simulated here
-- -------------------------
-- A public reservation has an Ads journey when, for the same
-- (company_id, anonymous_id):
--
--   1. any visit/activity contains either:
--        - utm_medium exactly equal to "paid"; or
--        - a non-empty custom marker (default: pr_ad);
--   2. every gap between subsequent meaningful activities is at most 30 days;
--   3. the paid touch happened before or at reservation.created_at.
--
-- Organic activity renews an already-active chain. After a gap greater than
-- 30 days, organic activity starts a clean chain and does not reactivate Ads.
-- A new paid touch can reactivate it. Exactly 30 days is considered active.
--
-- Historical limits
-- -----------------
-- - anonymous_id only joins activity from the same browser/storage context.
-- - pr_ad is detectable only when it already exists in a stored URL.
-- - the custom marker is treated as valid when non-empty; there is no
--   historical campaign-code registry with which to validate it.
-- - session utm_medium is mutable. It is therefore used only as a
--   low-confidence fallback at last_seen_at, never backdated to started_at.
-- - missing/deleted history is reported as insufficient_data, not Organic.
--
-- Configuration
-- -------------
-- Edit only the SELECT that creates ads_attribution_v1_v2_config.
-- The date range uses reservations.date because that is how the current
-- Dashboard selects reservations. reservations.created_at remains the actual
-- conversion timestamp used in the journey.
--
-- This version is preset for the current month and for the company whose
-- name/slug/address matches "Beco Magico Joao Pessoa". company_id_filter can
-- still be filled later if the exact UUID is preferred.
-- Keep history_start_at NULL for an accurate rolling-chain comparison.

BEGIN;

SET LOCAL TIME ZONE 'America/Fortaleza';
SET LOCAL statement_timeout = '5min';

DROP TABLE IF EXISTS pg_temp.ads_attribution_v1_v2_comparison;
DROP TABLE IF EXISTS pg_temp.ads_attribution_v1_v2_config;

CREATE TEMP TABLE ads_attribution_v1_v2_config
ON COMMIT PRESERVE ROWS
AS
SELECT
  NULL::uuid AS company_id_filter,
  '%beco%magico%joao%pessoa%'::text AS company_search_pattern,
  date_trunc('month', current_date)::date AS reservation_date_start,
  (
    date_trunc('month', current_date)
    + interval '1 month'
    - interval '1 day'
  )::date AS reservation_date_end,
  NULL::timestamptz AS history_start_at,
  interval '30 days' AS inactivity_window,
  ARRAY['paid']::text[] AS v2_paid_medium_values,
  'pr_ad'::text AS custom_paid_param,
  300::integer AS detail_limit;

CREATE TEMP TABLE ads_attribution_v1_v2_comparison
ON COMMIT PRESERVE ROWS
AS
WITH
selected_companies AS (
  SELECT
    company.id,
    company.name,
    company.slug
  FROM public.companies company
  CROSS JOIN ads_attribution_v1_v2_config config
  WHERE (
    config.company_id_filter IS NOT NULL
    AND company.id = config.company_id_filter
  )
  OR (
    config.company_id_filter IS NULL
    AND config.company_search_pattern IS NOT NULL
    AND translate(
      lower(concat_ws(
        ' ',
        company.name,
        company.slug,
        company.address
      )),
      'áàâãäéèêëíìîïóòôõöúùûüç',
      'aaaaaeeeeiiiiooooouuuuc'
    ) LIKE config.company_search_pattern
  )
),
reservation_base AS (
  SELECT
    r.id AS reservation_id,
    r.company_id,
    r.created_at AS reservation_created_at,
    r.date AS reservation_date,
    r.status AS reservation_status,
    r.source AS reservation_source,
    r.origin_tracking_session_id,
    r.origin_tracking_journey_id,
    r.origin_anonymous_id,
    r.origin_affiliate_link_id,
    r.origin_fbc,
    r.visitor_id,
    r.attribution_snapshot,
    ts.anonymous_id AS session_anonymous_id,
    ts.utm_source AS session_utm_source,
    ts.utm_medium AS session_utm_medium,
    ts.utm_campaign AS session_utm_campaign,
    ts.fbclid AS session_fbclid,
    ts.fbc AS session_fbc
  FROM public.reservations r
  JOIN selected_companies selected_company
    ON selected_company.id = r.company_id
  CROSS JOIN ads_attribution_v1_v2_config config
  LEFT JOIN public.tracking_sessions ts
    ON ts.id = r.origin_tracking_session_id
   AND ts.company_id = r.company_id
  WHERE r.date >= config.reservation_date_start
    AND r.date <= config.reservation_date_end
    AND r.created_at <= now()
),
reservation_public_state AS (
  SELECT
    rb.*,
    (
      rb.origin_tracking_session_id IS NOT NULL
      OR NULLIF(btrim(COALESCE(rb.origin_anonymous_id, '')), '') IS NOT NULL
      OR NULLIF(
        btrim(COALESCE(rb.attribution_snapshot ->> 'tracking_source', '')),
        ''
      ) = 'public_web'
    ) AS is_public_reservation
  FROM reservation_base rb
),
reservation_identity AS (
  SELECT
    rps.*,
    CASE
      WHEN rps.is_public_reservation THEN COALESCE(
        NULLIF(btrim(rps.origin_anonymous_id), ''),
        NULLIF(btrim(rps.session_anonymous_id), ''),
        NULLIF(btrim(rps.attribution_snapshot ->> 'anonymous_id'), ''),
        NULLIF(btrim(public_event.anonymous_id), ''),
        NULLIF(btrim(rps.visitor_id), '')
      )
      ELSE NULL
    END AS resolved_anonymous_id
  FROM reservation_public_state rps
  LEFT JOIN LATERAL (
    SELECT te.anonymous_id
    FROM public.tracking_events te
    WHERE te.company_id = rps.company_id
      AND te.reservation_id = rps.reservation_id
      AND te.tracking_source = 'public'
      AND te.event_name = 'reservation_created'
      AND NULLIF(btrim(te.anonymous_id), '') IS NOT NULL
    ORDER BY te.created_at DESC
    LIMIT 1
  ) public_event ON true
),
reservation_legacy_values AS (
  SELECT
    ri.*,
    COALESCE(
      NULLIF(lower(btrim(ri.attribution_snapshot ->> 'utm_medium')), ''),
      NULLIF(lower(btrim(ri.session_utm_medium)), '')
    ) AS legacy_effective_utm_medium,
    (
      NULLIF(
        btrim(COALESCE(ri.attribution_snapshot ->> 'fbclid', '')),
        ''
      ) IS NOT NULL
      OR NULLIF(
        btrim(COALESCE(ri.attribution_snapshot ->> 'fbc', '')),
        ''
      ) IS NOT NULL
      OR NULLIF(btrim(COALESCE(ri.session_fbclid, '')), '') IS NOT NULL
      OR NULLIF(btrim(COALESCE(ri.origin_fbc, '')), '') IS NOT NULL
      OR NULLIF(btrim(COALESCE(ri.session_fbc, '')), '') IS NOT NULL
    ) AS legacy_has_meta_click
  FROM reservation_identity ri
),
reservation_classified AS (
  SELECT
    rlv.*,
    COALESCE((
      rlv.legacy_effective_utm_medium = ANY (ARRAY[
        'ads',
        'cpc',
        'cpm',
        'cpv',
        'paid',
        'paid-social',
        'paid_social',
        'ppc',
        'social_paid'
      ]::text[])
      OR rlv.legacy_effective_utm_medium LIKE 'paid%'
    ), false) AS legacy_has_paid_utm,
    COALESCE((
      COALESCE((
        rlv.legacy_effective_utm_medium = ANY (ARRAY[
          'ads',
          'cpc',
          'cpm',
          'cpv',
          'paid',
          'paid-social',
          'paid_social',
          'ppc',
          'social_paid'
        ]::text[])
        OR rlv.legacy_effective_utm_medium LIKE 'paid%'
      ), false)
      OR rlv.legacy_has_meta_click
    ), false) AS legacy_has_ads_marker,
    CASE
      WHEN rlv.reservation_source = 'waitlist' THEN 'waitlist'
      WHEN NOT rlv.is_public_reservation THEN 'manual'
      WHEN rlv.origin_affiliate_link_id IS NOT NULL THEN 'affiliate'
      WHEN (
        rlv.legacy_effective_utm_medium = ANY (ARRAY[
          'ads',
          'cpc',
          'cpm',
          'cpv',
          'paid',
          'paid-social',
          'paid_social',
          'ppc',
          'social_paid'
        ]::text[])
        OR rlv.legacy_effective_utm_medium LIKE 'paid%'
        OR rlv.legacy_has_meta_click
      ) THEN 'ads'
      ELSE 'direct_organic'
    END AS legacy_origin_category
  FROM reservation_legacy_values rlv
),
analysis_targets AS (
  SELECT
    rc.*,
    rc.legacy_origin_category = 'ads' AS legacy_is_ads,
    (
      COALESCE(rc.reservation_source, 'reservation') <> 'waitlist'
      AND rc.is_public_reservation
    ) AS is_v2_eligible
  FROM reservation_classified rc
),
target_identities AS (
  SELECT
    at.company_id,
    at.resolved_anonymous_id AS anonymous_id,
    max(at.reservation_created_at) AS max_target_created_at
  FROM analysis_targets at
  WHERE at.is_v2_eligible
    AND at.resolved_anonymous_id IS NOT NULL
  GROUP BY at.company_id, at.resolved_anonymous_id
),
scoped_sessions AS (
  SELECT
    ts.*,
    ti.max_target_created_at
  FROM public.tracking_sessions ts
  JOIN target_identities ti
    ON ti.company_id = ts.company_id
   AND ti.anonymous_id = ts.anonymous_id
  CROSS JOIN ads_attribution_v1_v2_config config
  WHERE ts.started_at <= ti.max_target_created_at
    AND (
      config.history_start_at IS NULL
      OR ts.started_at >= config.history_start_at
      OR ts.last_seen_at >= config.history_start_at
    )
    AND ts.anonymous_id NOT LIKE 'smoke-anon-%'
    AND COALESCE(ts.first_page_url, '') NOT LIKE 'https://smoke-test.local/%'
),
session_initial_url_values AS (
  SELECT
    ss.id AS session_id,
    url_value.url,
    url_value.url_order
  FROM scoped_sessions ss
  CROSS JOIN LATERAL unnest(
    ARRAY[ss.first_page_url, ss.landing_path]::text[]
  ) WITH ORDINALITY AS url_value(url, url_order)
  WHERE NULLIF(btrim(url_value.url), '') IS NOT NULL
),
session_initial_url_parsed AS (
  SELECT
    siuv.*,
    NULLIF(lower(btrim((
      regexp_match(
        siuv.url,
        '(?i)(?:^|[?&])utm_source=([^&#]+)'
      )
    )[1])), '') AS detected_utm_source,
    NULLIF(lower(btrim((
      regexp_match(
        siuv.url,
        '(?i)(?:^|[?&])utm_medium=([^&#]+)'
      )
    )[1])), '') AS detected_utm_medium,
    NULLIF(btrim((
      regexp_match(
        siuv.url,
        '(?i)(?:^|[?&])utm_campaign=([^&#]+)'
      )
    )[1]), '') AS detected_utm_campaign,
    NULLIF(btrim((
      regexp_match(
        siuv.url,
        '(?i)(?:^|[?&])' || config.custom_paid_param || '=([^&#]+)'
      )
    )[1]), '') AS detected_custom_marker
  FROM session_initial_url_values siuv
  CROSS JOIN ads_attribution_v1_v2_config config
),
session_initial_paid_marker AS (
  SELECT DISTINCT ON (siup.session_id)
    siup.session_id,
    CASE
      WHEN siup.detected_custom_marker IS NOT NULL
        THEN 'custom_param_in_initial_url'
      ELSE 'paid_utm_in_initial_url'
    END AS paid_evidence,
    siup.detected_utm_source AS paid_utm_source,
    siup.detected_utm_medium AS paid_utm_medium,
    siup.detected_utm_campaign AS paid_utm_campaign,
    siup.detected_custom_marker AS paid_custom_marker
  FROM session_initial_url_parsed siup
  CROSS JOIN ads_attribution_v1_v2_config config
  WHERE siup.detected_utm_medium = ANY (config.v2_paid_medium_values)
     OR siup.detected_custom_marker IS NOT NULL
  ORDER BY
    siup.session_id,
    (siup.detected_custom_marker IS NOT NULL) DESC,
    siup.url_order
),
session_last_url_parsed AS (
  SELECT
    ss.id AS session_id,
    NULLIF(lower(btrim((
      regexp_match(
        ss.last_page_url,
        '(?i)(?:^|[?&])utm_source=([^&#]+)'
      )
    )[1])), '') AS detected_utm_source,
    NULLIF(lower(btrim((
      regexp_match(
        ss.last_page_url,
        '(?i)(?:^|[?&])utm_medium=([^&#]+)'
      )
    )[1])), '') AS detected_utm_medium,
    NULLIF(btrim((
      regexp_match(
        ss.last_page_url,
        '(?i)(?:^|[?&])utm_campaign=([^&#]+)'
      )
    )[1]), '') AS detected_utm_campaign,
    NULLIF(btrim((
      regexp_match(
        ss.last_page_url,
        '(?i)(?:^|[?&])' || config.custom_paid_param || '=([^&#]+)'
      )
    )[1]), '') AS detected_custom_marker
  FROM scoped_sessions ss
  CROSS JOIN ads_attribution_v1_v2_config config
),
session_start_activities AS (
  SELECT
    ss.company_id,
    ss.anonymous_id,
    ss.started_at AS activity_at,
    'session_start'::text AS activity_kind,
    'session_start:' || ss.id::text AS activity_key,
    NULL::uuid AS reservation_id,
    sipm.session_id IS NOT NULL AS is_paid_touch,
    sipm.paid_evidence,
    sipm.paid_utm_source,
    sipm.paid_utm_medium,
    sipm.paid_utm_campaign,
    sipm.paid_custom_marker
  FROM scoped_sessions ss
  CROSS JOIN ads_attribution_v1_v2_config config
  LEFT JOIN session_initial_paid_marker sipm
    ON sipm.session_id = ss.id
  WHERE config.history_start_at IS NULL
     OR ss.started_at >= config.history_start_at
),
session_end_activities AS (
  SELECT
    ss.company_id,
    ss.anonymous_id,
    ss.last_seen_at AS activity_at,
    'session_last_seen'::text AS activity_kind,
    'session_last_seen:' || ss.id::text AS activity_key,
    NULL::uuid AS reservation_id,
    (
      slup.detected_utm_medium = ANY (config.v2_paid_medium_values)
      OR slup.detected_custom_marker IS NOT NULL
      OR lower(btrim(COALESCE(ss.utm_medium, '')))
        = ANY (config.v2_paid_medium_values)
    ) AS is_paid_touch,
    CASE
      WHEN slup.detected_custom_marker IS NOT NULL
        THEN 'custom_param_in_last_url'
      WHEN slup.detected_utm_medium = ANY (config.v2_paid_medium_values)
        THEN 'paid_utm_in_last_url'
      WHEN lower(btrim(COALESCE(ss.utm_medium, '')))
        = ANY (config.v2_paid_medium_values)
        THEN 'session_utm_fallback_low_confidence'
      ELSE NULL
    END AS paid_evidence,
    COALESCE(
      slup.detected_utm_source,
      NULLIF(lower(btrim(ss.utm_source)), '')
    ) AS paid_utm_source,
    COALESCE(
      slup.detected_utm_medium,
      NULLIF(lower(btrim(ss.utm_medium)), '')
    ) AS paid_utm_medium,
    COALESCE(
      slup.detected_utm_campaign,
      NULLIF(btrim(ss.utm_campaign), '')
    ) AS paid_utm_campaign,
    slup.detected_custom_marker AS paid_custom_marker
  FROM scoped_sessions ss
  CROSS JOIN ads_attribution_v1_v2_config config
  LEFT JOIN session_last_url_parsed slup
    ON slup.session_id = ss.id
  WHERE ss.last_seen_at IS NOT NULL
    AND ss.last_seen_at <= ss.max_target_created_at
    AND (
      config.history_start_at IS NULL
      OR ss.last_seen_at >= config.history_start_at
    )
),
tracking_event_raw AS (
  SELECT
    te.*,
    CASE
      WHEN te.occurred_at BETWEEN
        te.created_at - interval '1 day'
        AND te.created_at + interval '1 day'
        THEN te.occurred_at
      ELSE te.created_at
    END AS safe_activity_at,
    ti.max_target_created_at
  FROM public.tracking_events te
  JOIN target_identities ti
    ON ti.company_id = te.company_id
   AND ti.anonymous_id = te.anonymous_id
  WHERE te.tracking_source = 'public'
    AND te.event_name IN (
      'page_view',
      'booking_started',
      'date_select',
      'time_select',
      'form_fill',
      'lead_captured',
      'reservation_created'
    )
    AND te.anonymous_id NOT LIKE 'smoke-anon-%'
    AND COALESCE(te.page_url, '') NOT LIKE 'https://smoke-test.local/%'
    AND NOT (
      te.event_name = 'reservation_created'
      AND EXISTS (
        SELECT 1
        FROM analysis_targets target_reservation
        WHERE target_reservation.company_id = te.company_id
          AND target_reservation.reservation_id = te.reservation_id
      )
    )
),
scoped_tracking_events AS (
  SELECT ter.*
  FROM tracking_event_raw ter
  CROSS JOIN ads_attribution_v1_v2_config config
  WHERE ter.safe_activity_at <= ter.max_target_created_at
    AND (
      config.history_start_at IS NULL
      OR ter.safe_activity_at >= config.history_start_at
    )
),
tracking_event_url_values AS (
  SELECT
    ste.id AS tracking_event_id,
    url_value.url,
    url_value.url_order
  FROM scoped_tracking_events ste
  CROSS JOIN LATERAL unnest(
    ARRAY[ste.page_url, ste.path, ste.event_source_url]::text[]
  ) WITH ORDINALITY AS url_value(url, url_order)
  WHERE NULLIF(btrim(url_value.url), '') IS NOT NULL
),
tracking_event_url_parsed AS (
  SELECT
    teuv.*,
    NULLIF(lower(btrim((
      regexp_match(
        teuv.url,
        '(?i)(?:^|[?&])utm_source=([^&#]+)'
      )
    )[1])), '') AS detected_utm_source,
    NULLIF(lower(btrim((
      regexp_match(
        teuv.url,
        '(?i)(?:^|[?&])utm_medium=([^&#]+)'
      )
    )[1])), '') AS detected_utm_medium,
    NULLIF(btrim((
      regexp_match(
        teuv.url,
        '(?i)(?:^|[?&])utm_campaign=([^&#]+)'
      )
    )[1]), '') AS detected_utm_campaign,
    NULLIF(btrim((
      regexp_match(
        teuv.url,
        '(?i)(?:^|[?&])' || config.custom_paid_param || '=([^&#]+)'
      )
    )[1]), '') AS detected_custom_marker
  FROM tracking_event_url_values teuv
  CROSS JOIN ads_attribution_v1_v2_config config
),
tracking_event_paid_marker AS (
  SELECT DISTINCT ON (teup.tracking_event_id)
    teup.tracking_event_id,
    CASE
      WHEN teup.detected_custom_marker IS NOT NULL
        THEN 'custom_param_in_event_url'
      ELSE 'paid_utm_in_event_url'
    END AS paid_evidence,
    teup.detected_utm_source AS paid_utm_source,
    teup.detected_utm_medium AS paid_utm_medium,
    teup.detected_utm_campaign AS paid_utm_campaign,
    teup.detected_custom_marker AS paid_custom_marker
  FROM tracking_event_url_parsed teup
  CROSS JOIN ads_attribution_v1_v2_config config
  WHERE teup.detected_utm_medium = ANY (config.v2_paid_medium_values)
     OR teup.detected_custom_marker IS NOT NULL
  ORDER BY
    teup.tracking_event_id,
    (teup.detected_custom_marker IS NOT NULL) DESC,
    teup.url_order
),
tracking_event_activities AS (
  SELECT
    ste.company_id,
    ste.anonymous_id,
    ste.safe_activity_at AS activity_at,
    'tracking_event:' || ste.event_name AS activity_kind,
    'tracking_event:' || ste.id::text AS activity_key,
    ste.reservation_id,
    tepm.tracking_event_id IS NOT NULL AS is_paid_touch,
    tepm.paid_evidence,
    tepm.paid_utm_source,
    tepm.paid_utm_medium,
    tepm.paid_utm_campaign,
    tepm.paid_custom_marker
  FROM scoped_tracking_events ste
  LEFT JOIN tracking_event_paid_marker tepm
    ON tepm.tracking_event_id = ste.id
),
reservation_url_values AS (
  SELECT
    at.reservation_id,
    url_value.url,
    url_value.url_order
  FROM analysis_targets at
  CROSS JOIN LATERAL unnest(ARRAY[
    at.attribution_snapshot ->> 'page_url',
    at.attribution_snapshot ->> 'landing_url',
    at.attribution_snapshot ->> 'path',
    at.attribution_snapshot ->> 'event_source_url'
  ]::text[]) WITH ORDINALITY AS url_value(url, url_order)
  WHERE at.is_v2_eligible
    AND at.resolved_anonymous_id IS NOT NULL
    AND NULLIF(btrim(url_value.url), '') IS NOT NULL
),
reservation_url_parsed AS (
  SELECT
    ruv.*,
    NULLIF(lower(btrim((
      regexp_match(
        ruv.url,
        '(?i)(?:^|[?&])utm_source=([^&#]+)'
      )
    )[1])), '') AS detected_utm_source,
    NULLIF(lower(btrim((
      regexp_match(
        ruv.url,
        '(?i)(?:^|[?&])utm_medium=([^&#]+)'
      )
    )[1])), '') AS detected_utm_medium,
    NULLIF(btrim((
      regexp_match(
        ruv.url,
        '(?i)(?:^|[?&])utm_campaign=([^&#]+)'
      )
    )[1]), '') AS detected_utm_campaign,
    NULLIF(btrim((
      regexp_match(
        ruv.url,
        '(?i)(?:^|[?&])' || config.custom_paid_param || '=([^&#]+)'
      )
    )[1]), '') AS detected_custom_marker
  FROM reservation_url_values ruv
  CROSS JOIN ads_attribution_v1_v2_config config
),
reservation_paid_url_marker AS (
  SELECT DISTINCT ON (rup.reservation_id)
    rup.reservation_id,
    CASE
      WHEN rup.detected_custom_marker IS NOT NULL
        THEN 'custom_param_at_reservation'
      ELSE 'paid_utm_in_reservation_url'
    END AS paid_evidence,
    rup.detected_utm_source AS paid_utm_source,
    rup.detected_utm_medium AS paid_utm_medium,
    rup.detected_utm_campaign AS paid_utm_campaign,
    rup.detected_custom_marker AS paid_custom_marker
  FROM reservation_url_parsed rup
  CROSS JOIN ads_attribution_v1_v2_config config
  WHERE rup.detected_utm_medium = ANY (config.v2_paid_medium_values)
     OR rup.detected_custom_marker IS NOT NULL
  ORDER BY
    rup.reservation_id,
    (rup.detected_custom_marker IS NOT NULL) DESC,
    rup.url_order
),
reservation_activities AS (
  SELECT
    at.company_id,
    at.resolved_anonymous_id AS anonymous_id,
    at.reservation_created_at AS activity_at,
    'target_reservation'::text AS activity_kind,
    'target_reservation:' || at.reservation_id::text AS activity_key,
    at.reservation_id,
    (
      lower(btrim(COALESCE(
        at.attribution_snapshot ->> 'utm_medium',
        ''
      ))) = ANY (config.v2_paid_medium_values)
      OR rpum.reservation_id IS NOT NULL
    ) AS is_paid_touch,
    CASE
      WHEN rpum.reservation_id IS NOT NULL THEN rpum.paid_evidence
      WHEN lower(btrim(COALESCE(
        at.attribution_snapshot ->> 'utm_medium',
        ''
      ))) = ANY (config.v2_paid_medium_values)
        THEN 'paid_utm_at_reservation'
      ELSE NULL
    END AS paid_evidence,
    COALESCE(
      rpum.paid_utm_source,
      NULLIF(lower(btrim(
        at.attribution_snapshot ->> 'utm_source'
      )), '')
    ) AS paid_utm_source,
    COALESCE(
      rpum.paid_utm_medium,
      NULLIF(lower(btrim(
        at.attribution_snapshot ->> 'utm_medium'
      )), '')
    ) AS paid_utm_medium,
    COALESCE(
      rpum.paid_utm_campaign,
      NULLIF(btrim(
        at.attribution_snapshot ->> 'utm_campaign'
      ), '')
    ) AS paid_utm_campaign,
    rpum.paid_custom_marker
  FROM analysis_targets at
  CROSS JOIN ads_attribution_v1_v2_config config
  LEFT JOIN reservation_paid_url_marker rpum
    ON rpum.reservation_id = at.reservation_id
  WHERE at.is_v2_eligible
    AND at.resolved_anonymous_id IS NOT NULL
),
timeline_raw AS (
  SELECT * FROM session_start_activities
  UNION ALL
  SELECT * FROM session_end_activities
  UNION ALL
  SELECT * FROM tracking_event_activities
  UNION ALL
  SELECT * FROM reservation_activities
),
timeline_points AS (
  SELECT
    tr.company_id,
    tr.anonymous_id,
    tr.activity_at,
    bool_or(tr.is_paid_touch) AS is_paid_touch,
    count(*) FILTER (
      WHERE tr.activity_kind <> 'target_reservation'
    )::integer AS observed_activity_count,
    string_agg(
      DISTINCT tr.activity_kind,
      ', ' ORDER BY tr.activity_kind
    ) AS activity_kinds
  FROM timeline_raw tr
  WHERE tr.activity_at IS NOT NULL
  GROUP BY tr.company_id, tr.anonymous_id, tr.activity_at
),
timeline_with_previous AS (
  SELECT
    tp.*,
    lag(tp.activity_at) OVER (
      PARTITION BY tp.company_id, tp.anonymous_id
      ORDER BY tp.activity_at
    ) AS previous_activity_at
  FROM timeline_points tp
),
timeline_island_flags AS (
  SELECT
    twp.*,
    CASE
      WHEN twp.previous_activity_at IS NULL THEN 1
      WHEN twp.activity_at - twp.previous_activity_at
        > config.inactivity_window THEN 1
      ELSE 0
    END AS starts_new_activity_island
  FROM timeline_with_previous twp
  CROSS JOIN ads_attribution_v1_v2_config config
),
timeline_islands AS (
  SELECT
    tif.*,
    sum(tif.starts_new_activity_island) OVER (
      PARTITION BY tif.company_id, tif.anonymous_id
      ORDER BY tif.activity_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS activity_island
  FROM timeline_island_flags tif
),
timeline_state AS (
  SELECT
    ti.*,
    min(ti.activity_at) OVER (
      PARTITION BY
        ti.company_id,
        ti.anonymous_id,
        ti.activity_island
    ) AS activity_island_started_at,
    min(ti.activity_at) FILTER (WHERE ti.is_paid_touch) OVER (
      PARTITION BY
        ti.company_id,
        ti.anonymous_id,
        ti.activity_island
      ORDER BY ti.activity_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS first_paid_at_so_far,
    max(ti.activity_at) FILTER (WHERE ti.is_paid_touch) OVER (
      PARTITION BY
        ti.company_id,
        ti.anonymous_id,
        ti.activity_island
      ORDER BY ti.activity_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS last_paid_at_so_far,
    sum(ti.observed_activity_count) OVER (
      PARTITION BY
        ti.company_id,
        ti.anonymous_id,
        ti.activity_island
      ORDER BY ti.activity_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS observed_activity_count_in_island,
    sum(ti.observed_activity_count) OVER (
      PARTITION BY ti.company_id, ti.anonymous_id
      ORDER BY ti.activity_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS observed_history_count_so_far
  FROM timeline_islands ti
),
reservation_v2_state AS (
  SELECT
    at.reservation_id,
    state.company_id,
    state.anonymous_id,
    state.activity_island,
    state.activity_island_started_at,
    state.previous_activity_at,
    state.first_paid_at_so_far,
    state.last_paid_at_so_far,
    state.observed_activity_count_in_island,
    state.observed_history_count_so_far,
    (
      config.history_start_at IS NOT NULL
      AND state.activity_island_started_at
        <= config.history_start_at + config.inactivity_window
    ) AS history_may_be_truncated
  FROM analysis_targets at
  CROSS JOIN ads_attribution_v1_v2_config config
  LEFT JOIN timeline_state state
    ON state.company_id = at.company_id
   AND state.anonymous_id = at.resolved_anonymous_id
   AND state.activity_at = at.reservation_created_at
  WHERE at.is_v2_eligible
    AND at.resolved_anonymous_id IS NOT NULL
),
comparison_base AS (
  SELECT
    at.company_id,
    company.name AS company_name,
    at.reservation_id,
    at.reservation_created_at,
    at.reservation_date,
    at.reservation_status,
    at.reservation_source,
    at.is_public_reservation,
    at.is_v2_eligible,
    at.origin_affiliate_link_id IS NOT NULL AS is_affiliate,
    at.resolved_anonymous_id,
    at.legacy_origin_category,
    at.legacy_has_ads_marker,
    at.legacy_is_ads,
    CASE
      WHEN NOT at.is_v2_eligible THEN false
      WHEN at.resolved_anonymous_id IS NULL THEN NULL
      WHEN rvs.reservation_id IS NULL THEN NULL
      WHEN rvs.last_paid_at_so_far IS NOT NULL THEN true
      WHEN COALESCE(rvs.observed_history_count_so_far, 0) = 0 THEN NULL
      WHEN rvs.history_may_be_truncated THEN NULL
      ELSE false
    END AS v2_had_paid_touch,
    rvs.activity_island_started_at,
    rvs.previous_activity_at,
    rvs.first_paid_at_so_far,
    rvs.last_paid_at_so_far,
    rvs.observed_activity_count_in_island,
    rvs.observed_history_count_so_far,
    rvs.history_may_be_truncated
  FROM analysis_targets at
  LEFT JOIN public.companies company
    ON company.id = at.company_id
  LEFT JOIN reservation_v2_state rvs
    ON rvs.reservation_id = at.reservation_id
),
comparison AS (
  SELECT
    cb.*,
    CASE
      WHEN cb.legacy_origin_category IN ('waitlist', 'manual', 'affiliate')
        THEN false
      ELSE cb.v2_had_paid_touch
    END AS v2_is_ads_with_legacy_precedence,
    CASE
      WHEN NOT cb.is_v2_eligible THEN 'excluded_non_public_or_waitlist'
      WHEN cb.resolved_anonymous_id IS NULL
        THEN 'insufficient_anonymous_identity'
      WHEN cb.v2_had_paid_touch IS NULL
        AND cb.history_may_be_truncated
        THEN 'insufficient_truncated_history'
      WHEN cb.v2_had_paid_touch IS NULL
        THEN 'insufficient_observed_history'
      WHEN cb.v2_had_paid_touch
        THEN COALESCE(last_paid.paid_evidence, 'paid_touch_in_active_chain')
      ELSE 'no_paid_touch_in_active_chain'
    END AS v2_reason,
    last_paid.paid_utm_source AS v2_last_paid_utm_source,
    last_paid.paid_utm_medium AS v2_last_paid_utm_medium,
    last_paid.paid_utm_campaign AS v2_last_paid_utm_campaign,
    last_paid.paid_custom_marker AS v2_last_paid_custom_marker,
    CASE
      WHEN cb.last_paid_at_so_far IS NULL THEN NULL
      ELSE round(
        extract(epoch FROM (
          cb.reservation_created_at - cb.last_paid_at_so_far
        ))::numeric / 86400,
        2
      )
    END AS days_from_last_paid_touch,
    CASE
      WHEN cb.v2_had_paid_touch THEN
        cb.reservation_created_at + config.inactivity_window
      ELSE NULL
    END AS v2_expires_at_after_reservation,
    CASE
      WHEN NOT cb.is_v2_eligible THEN 'excluded_non_public'
      WHEN cb.v2_had_paid_touch IS NULL THEN 'insufficient_data'
      WHEN cb.legacy_is_ads AND cb.v2_had_paid_touch THEN 'both_ads'
      WHEN cb.legacy_is_ads AND NOT cb.v2_had_paid_touch
        THEN 'legacy_only_ads'
      WHEN NOT cb.legacy_is_ads AND cb.v2_had_paid_touch
        THEN 'v2_only_ads'
      ELSE 'neither_ads'
    END AS comparison_status
  FROM comparison_base cb
  CROSS JOIN ads_attribution_v1_v2_config config
  LEFT JOIN LATERAL (
    SELECT
      paid.paid_evidence,
      paid.paid_utm_source,
      paid.paid_utm_medium,
      paid.paid_utm_campaign,
      paid.paid_custom_marker
    FROM timeline_raw paid
    WHERE paid.company_id = cb.company_id
      AND paid.anonymous_id = cb.resolved_anonymous_id
      AND paid.is_paid_touch
      AND paid.activity_at = cb.last_paid_at_so_far
    ORDER BY
      (paid.paid_custom_marker IS NOT NULL) DESC,
      CASE paid.paid_evidence
        WHEN 'session_utm_fallback_low_confidence' THEN 2
        ELSE 1
      END,
      paid.activity_key
    LIMIT 1
  ) last_paid ON true
)
SELECT *
FROM comparison;

CREATE INDEX ads_attribution_v1_v2_comparison_company_status_idx
ON ads_attribution_v1_v2_comparison(company_id, comparison_status);

CREATE INDEX ads_attribution_v1_v2_comparison_reservation_idx
ON ads_attribution_v1_v2_comparison(reservation_id);

COMMIT;

-- Report sections:
--   summary_all: overall impact
--   summary_company: impact per company
--   summary_status: agreements/divergences per company
--   detail_difference: auditable differences/insufficient rows
--
-- v2_journey_ads_count is the requested independent Ads journey flag.
-- v2_same_precedence_ads_count shows the V2 result while retaining the old
-- waitlist/manual/affiliate precedence, which isolates the attribution-method
-- change from a change in category precedence.

WITH
summary_all AS (
  SELECT
    10::integer AS report_order,
    'summary_all'::text AS report_section,
    NULL::uuid AS company_id,
    'ALL_COMPANIES'::text AS company_name,
    'all'::text AS comparison_status,
    count(*)::bigint AS reservation_count,
    count(*) FILTER (WHERE comparison.legacy_is_ads)::bigint
      AS legacy_ads_count,
    count(*) FILTER (WHERE comparison.v2_had_paid_touch IS TRUE)::bigint
      AS v2_journey_ads_count,
    count(*) FILTER (
      WHERE comparison.v2_is_ads_with_legacy_precedence IS TRUE
    )::bigint AS v2_same_precedence_ads_count,
    (
      count(*) FILTER (WHERE comparison.v2_had_paid_touch IS TRUE)
      - count(*) FILTER (WHERE comparison.legacy_is_ads)
    )::bigint AS ads_delta_journey,
    (
      count(*) FILTER (
        WHERE comparison.v2_is_ads_with_legacy_precedence IS TRUE
      )
      - count(*) FILTER (WHERE comparison.legacy_is_ads)
    )::bigint AS ads_delta_same_precedence,
    NULL::uuid AS reservation_id,
    NULL::timestamptz AS reservation_created_at,
    NULL::jsonb AS details
  FROM ads_attribution_v1_v2_comparison comparison
),
summary_company AS (
  SELECT
    20::integer AS report_order,
    'summary_company'::text AS report_section,
    comparison.company_id,
    COALESCE(
      comparison.company_name,
      comparison.company_id::text
    ) AS company_name,
    'all'::text AS comparison_status,
    count(*)::bigint AS reservation_count,
    count(*) FILTER (WHERE comparison.legacy_is_ads)::bigint
      AS legacy_ads_count,
    count(*) FILTER (WHERE comparison.v2_had_paid_touch IS TRUE)::bigint
      AS v2_journey_ads_count,
    count(*) FILTER (
      WHERE comparison.v2_is_ads_with_legacy_precedence IS TRUE
    )::bigint AS v2_same_precedence_ads_count,
    (
      count(*) FILTER (WHERE comparison.v2_had_paid_touch IS TRUE)
      - count(*) FILTER (WHERE comparison.legacy_is_ads)
    )::bigint AS ads_delta_journey,
    (
      count(*) FILTER (
        WHERE comparison.v2_is_ads_with_legacy_precedence IS TRUE
      )
      - count(*) FILTER (WHERE comparison.legacy_is_ads)
    )::bigint AS ads_delta_same_precedence,
    NULL::uuid AS reservation_id,
    NULL::timestamptz AS reservation_created_at,
    NULL::jsonb AS details
  FROM ads_attribution_v1_v2_comparison comparison
  GROUP BY comparison.company_id, comparison.company_name
),
summary_status AS (
  SELECT
    30::integer AS report_order,
    'summary_status'::text AS report_section,
    comparison.company_id,
    COALESCE(
      comparison.company_name,
      comparison.company_id::text
    ) AS company_name,
    comparison.comparison_status,
    count(*)::bigint AS reservation_count,
    count(*) FILTER (WHERE comparison.legacy_is_ads)::bigint
      AS legacy_ads_count,
    count(*) FILTER (WHERE comparison.v2_had_paid_touch IS TRUE)::bigint
      AS v2_journey_ads_count,
    count(*) FILTER (
      WHERE comparison.v2_is_ads_with_legacy_precedence IS TRUE
    )::bigint AS v2_same_precedence_ads_count,
    (
      count(*) FILTER (WHERE comparison.v2_had_paid_touch IS TRUE)
      - count(*) FILTER (WHERE comparison.legacy_is_ads)
    )::bigint AS ads_delta_journey,
    (
      count(*) FILTER (
        WHERE comparison.v2_is_ads_with_legacy_precedence IS TRUE
      )
      - count(*) FILTER (WHERE comparison.legacy_is_ads)
    )::bigint AS ads_delta_same_precedence,
    NULL::uuid AS reservation_id,
    NULL::timestamptz AS reservation_created_at,
    jsonb_build_object(
      'meaning',
      CASE comparison.comparison_status
        WHEN 'both_ads' THEN 'V1 and V2 classify as Ads'
        WHEN 'legacy_only_ads' THEN 'Only the current classifier marks Ads'
        WHEN 'v2_only_ads' THEN 'Only the rolling journey marks Ads'
        WHEN 'neither_ads' THEN 'Neither classifier marks Ads'
        WHEN 'excluded_non_public' THEN 'Manual/waitlist: V2 not applicable'
        ELSE 'Historical identity or activity is insufficient'
      END
    ) AS details
  FROM ads_attribution_v1_v2_comparison comparison
  GROUP BY
    comparison.company_id,
    comparison.company_name,
    comparison.comparison_status
),
detail_difference AS (
  SELECT
    40::integer AS report_order,
    'detail_difference'::text AS report_section,
    comparison.company_id,
    COALESCE(
      comparison.company_name,
      comparison.company_id::text
    ) AS company_name,
    comparison.comparison_status,
    1::bigint AS reservation_count,
    CASE WHEN comparison.legacy_is_ads THEN 1 ELSE 0 END::bigint
      AS legacy_ads_count,
    CASE
      WHEN comparison.v2_had_paid_touch IS TRUE THEN 1
      ELSE 0
    END::bigint AS v2_journey_ads_count,
    CASE
      WHEN comparison.v2_is_ads_with_legacy_precedence IS TRUE THEN 1
      ELSE 0
    END::bigint AS v2_same_precedence_ads_count,
    (
      CASE WHEN comparison.v2_had_paid_touch IS TRUE THEN 1 ELSE 0 END
      - CASE WHEN comparison.legacy_is_ads THEN 1 ELSE 0 END
    )::bigint AS ads_delta_journey,
    (
      CASE
        WHEN comparison.v2_is_ads_with_legacy_precedence IS TRUE THEN 1
        ELSE 0
      END
      - CASE WHEN comparison.legacy_is_ads THEN 1 ELSE 0 END
    )::bigint AS ads_delta_same_precedence,
    comparison.reservation_id,
    comparison.reservation_created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'reservation_date', comparison.reservation_date,
      'reservation_status', comparison.reservation_status,
      'reservation_source', comparison.reservation_source,
      'anonymous_id', comparison.resolved_anonymous_id,
      'is_affiliate', comparison.is_affiliate,
      'legacy_origin_category', comparison.legacy_origin_category,
      'legacy_has_ads_marker', comparison.legacy_has_ads_marker,
      'v2_reason', comparison.v2_reason,
      'activity_island_started_at', comparison.activity_island_started_at,
      'activity_before_reservation_at', comparison.previous_activity_at,
      'observed_activity_count_in_island',
        comparison.observed_activity_count_in_island,
      'observed_history_count', comparison.observed_history_count_so_far,
      'v2_first_paid_at', comparison.first_paid_at_so_far,
      'v2_last_paid_at', comparison.last_paid_at_so_far,
      'v2_expires_at_after_reservation',
        comparison.v2_expires_at_after_reservation,
      'days_from_last_paid_touch', comparison.days_from_last_paid_touch,
      'last_paid_utm_source', comparison.v2_last_paid_utm_source,
      'last_paid_utm_medium', comparison.v2_last_paid_utm_medium,
      'last_paid_utm_campaign', comparison.v2_last_paid_utm_campaign,
      'last_paid_custom_marker', comparison.v2_last_paid_custom_marker
    )) AS details
  FROM ads_attribution_v1_v2_comparison comparison
  CROSS JOIN ads_attribution_v1_v2_config config
  WHERE comparison.comparison_status IN (
    'legacy_only_ads',
    'v2_only_ads',
    'insufficient_data'
  )
  ORDER BY comparison.reservation_created_at DESC
  LIMIT (SELECT detail_limit FROM ads_attribution_v1_v2_config)
)
SELECT
  report_section,
  company_id,
  company_name,
  comparison_status,
  reservation_count,
  legacy_ads_count,
  v2_journey_ads_count,
  v2_same_precedence_ads_count,
  ads_delta_journey,
  ads_delta_same_precedence,
  reservation_id,
  reservation_created_at,
  details
FROM (
  SELECT * FROM summary_all
  UNION ALL
  SELECT * FROM summary_company
  UNION ALL
  SELECT * FROM summary_status
  UNION ALL
  SELECT * FROM detail_difference
) report
ORDER BY
  report_order,
  company_name NULLS FIRST,
  comparison_status,
  reservation_created_at DESC NULLS LAST;
