-- Phase 1: company-time-zone recurrence and selected-period visit evolution.

-- Keep the contact read model explicit in this migration. Besides making the
-- migration safe to retry, this avoids coupling it to the exact text returned
-- by PostgreSQL for a previous version of the function.
--
-- report_context is materialized so the company time zone is resolved once per
-- function call and reused by every reservation/waitlist branch.
CREATE OR REPLACE FUNCTION public._get_crm_contact_records(_company_id uuid)
RETURNS TABLE (
  company_id uuid,
  customer_key text,
  identity_kind text,
  identity_value text,
  canonical_event_key text,
  contact_record_key text,
  visit_id uuid,
  contact_id uuid,
  visit_origin text,
  lead_source text,
  role_kind text,
  record_date date,
  record_time time without time zone,
  record_at timestamptz,
  presence_date date,
  presence_time time without time zone,
  presence_at timestamptz,
  contact_created_at timestamptz,
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_birthdate date,
  phone_normalized text,
  email_normalized text,
  party_size integer,
  status text,
  normalized_status text,
  occasion text,
  origin_waitlist_id uuid,
  came_from_waitlist boolean,
  reservation_holder_name text,
  is_waitlist_suppressed boolean,
  is_canonical_presence boolean
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH report_context AS MATERIALIZED (
    SELECT public._company_report_time_zone(_company_id) AS time_zone
  ),
  raw_records AS (
    SELECT
      reservations.company_id,
      'reservation:' || reservations.id::text AS canonical_event_key,
      'reservation_holder:' || reservations.id::text AS contact_record_key,
      reservations.id AS visit_id,
      reservations.id AS contact_id,
      'reservation'::text AS visit_origin,
      'reservation_holder'::text AS lead_source,
      'holder'::text AS role_kind,
      reservations.date AS record_date,
      reservations.time AS record_time,
      (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone AS record_at,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::date,
        reservations.date
      ) AS presence_date,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::time,
        reservations.time
      ) AS presence_time,
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone
      ) AS presence_at,
      reservations.created_at AS contact_created_at,
      NULLIF(btrim(reservations.guest_name), '') AS guest_name,
      NULLIF(btrim(reservations.guest_phone), '') AS guest_phone,
      NULLIF(lower(btrim(reservations.guest_email)), '') AS guest_email,
      reservations.guest_birthdate AS guest_birthdate,
      public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
      NULLIF(lower(btrim(reservations.guest_email)), '') AS email_normalized,
      COALESCE(reservations.checked_in_party_size, reservations.party_size) AS party_size,
      reservations.status,
      CASE
        WHEN lower(btrim(reservations.status)) IN ('checked_in', 'completed') THEN 'checked_in'
        WHEN lower(btrim(reservations.status)) IN ('no-show', 'no_show') THEN 'no-show'
        WHEN lower(btrim(reservations.status)) IN (
          'pending_payment',
          'cancelled',
          'payment_expired',
          'payment_cancelled',
          'paid_after_expiration'
        ) THEN lower(btrim(reservations.status))
        ELSE 'confirmed'
      END AS normalized_status,
      reservations.occasion,
      reservations.origin_waitlist_id,
      reservations.origin_waitlist_id IS NOT NULL AS came_from_waitlist,
      NULLIF(btrim(reservations.guest_name), '') AS reservation_holder_name,
      1 AS contact_priority,
      0 AS contact_position,
      false AS is_waitlist_suppressed,
      lower(btrim(reservations.status)) IN ('checked_in', 'completed') AS is_canonical_presence
    FROM public.reservations
    CROSS JOIN report_context
    WHERE reservations.company_id = _company_id

    UNION ALL

    SELECT
      reservations.company_id,
      'reservation:' || reservations.id::text,
      'reservation_companion:' || reservation_companions.id::text,
      reservations.id,
      reservation_companions.id,
      'reservation',
      'reservation_companion',
      'companion',
      reservations.date,
      reservations.time,
      (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::date,
        reservations.date
      ),
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::time,
        reservations.time
      ),
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone
      ),
      reservation_companions.created_at,
      NULLIF(btrim(reservation_companions.name), ''),
      NULLIF(btrim(reservation_companions.phone), ''),
      NULLIF(lower(btrim(reservation_companions.email)), ''),
      reservation_companions.birthdate,
      public.normalize_whatsapp_phone(reservation_companions.phone),
      NULLIF(lower(btrim(reservation_companions.email)), ''),
      COALESCE(reservations.checked_in_party_size, reservations.party_size),
      reservations.status,
      CASE
        WHEN lower(btrim(reservations.status)) IN ('checked_in', 'completed') THEN 'checked_in'
        WHEN lower(btrim(reservations.status)) IN ('no-show', 'no_show') THEN 'no-show'
        WHEN lower(btrim(reservations.status)) IN (
          'pending_payment',
          'cancelled',
          'payment_expired',
          'payment_cancelled',
          'paid_after_expiration'
        ) THEN lower(btrim(reservations.status))
        ELSE 'confirmed'
      END,
      reservations.occasion,
      reservations.origin_waitlist_id,
      reservations.origin_waitlist_id IS NOT NULL,
      NULLIF(btrim(reservations.guest_name), ''),
      2,
      reservation_companions.position,
      false,
      lower(btrim(reservations.status)) IN ('checked_in', 'completed')
    FROM public.reservation_companions
    JOIN public.reservations
      ON reservations.id = reservation_companions.reservation_id
    CROSS JOIN report_context
    WHERE reservations.company_id = _company_id

    UNION ALL

    SELECT
      waitlist.company_id,
      'waitlist:' || waitlist.id::text,
      'waitlist_holder:' || waitlist.id::text,
      waitlist.id,
      waitlist.id,
      'waitlist',
      'waitlist_holder',
      'holder',
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      waitlist.created_at,
      NULLIF(btrim(waitlist.guest_name), ''),
      NULLIF(btrim(waitlist.guest_phone), ''),
      NULLIF(lower(btrim(waitlist.guest_email)), ''),
      waitlist.guest_birthdate,
      public.normalize_whatsapp_phone(waitlist.guest_phone),
      NULLIF(lower(btrim(waitlist.guest_email)), ''),
      COALESCE(waitlist.seated_party_size, waitlist.party_size),
      waitlist.status,
      'checked_in',
      NULL::text,
      NULL::uuid,
      true,
      NULLIF(btrim(waitlist.guest_name), ''),
      1,
      0,
      linkage.has_linked_presence,
      NOT linkage.has_linked_presence
    FROM public.waitlist
    CROSS JOIN report_context
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM public.reservations linked_reservation
        WHERE linked_reservation.origin_waitlist_id = waitlist.id
          AND linked_reservation.status IN ('checked_in', 'completed')
      ) AS has_linked_presence
    ) AS linkage
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'seated'

    UNION ALL

    SELECT
      waitlist.company_id,
      'waitlist:' || waitlist.id::text,
      'waitlist_companion:' || waitlist_companions.id::text,
      waitlist.id,
      waitlist_companions.id,
      'waitlist',
      'waitlist_companion',
      'companion',
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      waitlist_companions.created_at,
      NULLIF(btrim(waitlist_companions.name), ''),
      NULLIF(btrim(waitlist_companions.phone), ''),
      NULLIF(lower(btrim(waitlist_companions.email)), ''),
      waitlist_companions.birthdate,
      public.normalize_whatsapp_phone(waitlist_companions.phone),
      NULLIF(lower(btrim(waitlist_companions.email)), ''),
      COALESCE(waitlist.seated_party_size, waitlist.party_size),
      waitlist.status,
      'checked_in',
      NULL::text,
      NULL::uuid,
      true,
      NULLIF(btrim(waitlist.guest_name), ''),
      2,
      waitlist_companions.position,
      linkage.has_linked_presence,
      NOT linkage.has_linked_presence
    FROM public.waitlist_companions
    JOIN public.waitlist
      ON waitlist.id = waitlist_companions.waitlist_id
    CROSS JOIN report_context
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM public.reservations linked_reservation
        WHERE linked_reservation.origin_waitlist_id = waitlist.id
          AND linked_reservation.status IN ('checked_in', 'completed')
      ) AS has_linked_presence
    ) AS linkage
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'seated'
  ),
  labeled_records AS (
    SELECT
      raw_records.*,
      CASE
        WHEN raw_records.phone_normalized IS NOT NULL
          THEN 'phone:' || raw_records.phone_normalized
        WHEN raw_records.email_normalized IS NOT NULL
          THEN 'email:' || raw_records.email_normalized
        ELSE 'contact:' || raw_records.lead_source || ':' || raw_records.contact_id::text
      END AS customer_key,
      CASE
        WHEN raw_records.phone_normalized IS NOT NULL THEN 'phone'
        WHEN raw_records.email_normalized IS NOT NULL THEN 'email'
        ELSE 'contact'
      END AS identity_kind,
      CASE
        WHEN raw_records.phone_normalized IS NOT NULL THEN raw_records.phone_normalized
        WHEN raw_records.email_normalized IS NOT NULL THEN raw_records.email_normalized
        ELSE raw_records.lead_source || ':' || raw_records.contact_id::text
      END AS identity_value
    FROM raw_records
  ),
  ranked_records AS (
    SELECT
      labeled_records.*,
      row_number() OVER (
        PARTITION BY
          labeled_records.company_id,
          labeled_records.canonical_event_key,
          labeled_records.customer_key
        ORDER BY
          labeled_records.contact_priority,
          labeled_records.contact_position,
          labeled_records.contact_id
      ) AS event_contact_rank
    FROM labeled_records
  )
  SELECT
    ranked_records.company_id,
    ranked_records.customer_key,
    ranked_records.identity_kind,
    ranked_records.identity_value,
    ranked_records.canonical_event_key,
    ranked_records.contact_record_key,
    ranked_records.visit_id,
    ranked_records.contact_id,
    ranked_records.visit_origin,
    ranked_records.lead_source,
    ranked_records.role_kind,
    ranked_records.record_date,
    ranked_records.record_time,
    ranked_records.record_at,
    ranked_records.presence_date,
    ranked_records.presence_time,
    ranked_records.presence_at,
    ranked_records.contact_created_at,
    ranked_records.guest_name,
    ranked_records.guest_phone,
    ranked_records.guest_email,
    ranked_records.guest_birthdate,
    ranked_records.phone_normalized,
    ranked_records.email_normalized,
    ranked_records.party_size,
    ranked_records.status,
    ranked_records.normalized_status,
    ranked_records.occasion,
    ranked_records.origin_waitlist_id,
    ranked_records.came_from_waitlist,
    ranked_records.reservation_holder_name,
    ranked_records.is_waitlist_suppressed,
    ranked_records.is_canonical_presence
  FROM ranked_records
  WHERE ranked_records.event_contact_rank = 1;
$$;

-- CREATE OR REPLACE preserves the current ACL, but reassert the internal-only
-- contract explicitly so a drifted environment cannot expose raw CRM records.
REVOKE ALL ON FUNCTION public._get_crm_contact_records(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The recurrence aggregate and canonical-visit helper both read this contact
-- model, so updating it once keeps the report, profile dialog and new temporal
-- series on the same company-local calendar without rewriting either wrapper.

CREATE OR REPLACE FUNCTION public.get_customer_recurrence_visit_series(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _granularity text DEFAULT 'day',
  _include_companions boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
  _result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;
    IF public.has_company_panel_permission(auth.uid(), _company_id, 'leads_view') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Sem permissao para visualizar dados de clientes.' USING ERRCODE = '42501';
    END IF;
    IF public.company_feature_enabled(_company_id, 'advanced_reports') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Relatorios avancados nao estao habilitados para esta empresa.' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM public._validate_advanced_report_range(_period_start, _period_end, 366);
  IF _granularity IS NULL OR _granularity NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Granularidade invalida.' USING ERRCODE = '22023';
  END IF;

  _time_zone := public._company_report_time_zone(_company_id);

  WITH bounds AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', _period_start::timestamp)::date
        WHEN 'month' THEN date_trunc('month', _period_start::timestamp)::date
        ELSE _period_start
      END AS first_bucket,
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', _period_end::timestamp)::date
        WHEN 'month' THEN date_trunc('month', _period_end::timestamp)::date
        ELSE _period_end
      END AS last_bucket,
      CASE _granularity
        WHEN 'week' THEN interval '1 week'
        WHEN 'month' THEN interval '1 month'
        ELSE interval '1 day'
      END AS bucket_step
  ),
  buckets AS MATERIALIZED (
    SELECT generated.bucket::date AS period
    FROM bounds
    CROSS JOIN LATERAL generate_series(
      bounds.first_bucket::timestamp,
      bounds.last_bucket::timestamp,
      bounds.bucket_step
    ) AS generated(bucket)
  ),
  canonical_visits AS MATERIALIZED (
    SELECT visits.*
    FROM public._get_customer_canonical_visit_events(
      _company_id,
      _period_end,
      COALESCE(_include_companions, false)
    ) AS visits
    WHERE visits.phone_normalized IS NOT NULL
  ),
  ranked AS (
    SELECT
      canonical_visits.*,
      row_number() OVER (
        PARTITION BY canonical_visits.company_id, canonical_visits.phone_normalized
        ORDER BY canonical_visits.presence_at, canonical_visits.canonical_event_key
      ) AS visit_number
    FROM canonical_visits
  ),
  selected AS (
    SELECT
      CASE _granularity
        WHEN 'week' THEN date_trunc('week', ranked.presence_date::timestamp)::date
        WHEN 'month' THEN date_trunc('month', ranked.presence_date::timestamp)::date
        ELSE ranked.presence_date
      END AS period,
      ranked.visit_number
    FROM ranked
    WHERE ranked.presence_date BETWEEN _period_start AND _period_end
  ),
  series AS (
    SELECT
      buckets.period,
      count(*) FILTER (WHERE selected.visit_number IS NOT NULL)::bigint AS total_visits,
      count(*) FILTER (WHERE selected.visit_number = 1)::bigint AS first_visits,
      count(*) FILTER (WHERE selected.visit_number > 1)::bigint AS return_visits,
      COALESCE(round(
        100.0 * count(*) FILTER (WHERE selected.visit_number > 1)
          / NULLIF(count(*) FILTER (WHERE selected.visit_number IS NOT NULL), 0),
        1
      ), 0) AS return_visit_rate
    FROM buckets
    LEFT JOIN selected ON selected.period = buckets.period
    GROUP BY buckets.period
  )
  SELECT jsonb_build_object(
    'series', COALESCE((
      SELECT jsonb_agg(to_jsonb(series) ORDER BY series.period)
      FROM series
    ), '[]'::jsonb),
    'meta', jsonb_build_object(
      'period_start', _period_start,
      'period_end', _period_end,
      'time_zone', _time_zone,
      'granularity', _granularity,
      'include_companions', COALESCE(_include_companions, false),
      'visit_definition', 'canonical_attended_visit',
      'generated_at', statement_timestamp()
    )
  ) INTO _result;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_customer_recurrence_visit_series(uuid, date, date, text, boolean) IS
  'Evolucao de primeiras visitas e visitas de retorno no periodo, usando visitas canonicas e o fuso da empresa.';

REVOKE ALL ON FUNCTION public.get_customer_recurrence_visit_series(uuid, date, date, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_recurrence_visit_series(uuid, date, date, text, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text, integer
) IS 'Relatorio de recorrencia no fuso da empresa, com paginacao irrestrita, busca, filtro minimo de visitas e profile_ref opaca.';
