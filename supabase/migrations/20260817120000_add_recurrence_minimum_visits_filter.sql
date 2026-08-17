-- Preserve the existing report implementation as a private aggregate provider.
-- Renaming (instead of keeping an overload under the public name) is important:
-- PostgREST cannot safely choose between the eight-argument function and a
-- nine-argument function whose last argument has a default value.
ALTER FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text
) RENAME TO _get_customer_recurrence_report_without_min_filter;

REVOKE ALL ON FUNCTION public._get_customer_recurrence_report_without_min_filter(
  uuid, date, date, boolean, integer, integer, text, text
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._get_customer_recurrence_report_without_min_filter(
  uuid, date, date, boolean, integer, integer, text, text
)
IS 'Implementacao interna do relatorio de recorrencia. Use get_customer_recurrence_report.';

CREATE FUNCTION public.get_customer_recurrence_report(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _include_companions boolean DEFAULT false,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 25,
  _search text DEFAULT NULL,
  _comparison_mode text DEFAULT 'previous_period',
  _min_total_visits integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_include_companions boolean := COALESCE(_include_companions, false);
  _effective_min_total_visits integer := _min_total_visits;
  _search_text text := NULLIF(lower(btrim(COALESCE(_search, ''))), '');
  _search_digits text := NULLIF(regexp_replace(COALESCE(_search, ''), '\D', '', 'g'), '');
  _offset integer;
  _base_result jsonb;
  _customers jsonb;
  _filtered_customers_total integer;
  _result jsonb;
BEGIN
  -- Besides producing the aggregate sections, the private implementation
  -- centralizes authorization and validates all original arguments. Calling it
  -- with the requested page preserves the exact behavior of legacy clients.
  _base_result := public._get_customer_recurrence_report_without_min_filter(
    _company_id,
    _period_start,
    _period_end,
    _effective_include_companions,
    _page,
    _page_size,
    _search,
    _comparison_mode
  );

  -- Authorization intentionally happens above so invalid filter values never
  -- expose validation details to an unauthenticated caller.
  IF _effective_min_total_visits IS NOT NULL
    AND (_effective_min_total_visits < 1 OR _effective_min_total_visits > 1000000) THEN
    RAISE EXCEPTION 'min_total_visits deve estar entre 1 e 1000000.' USING ERRCODE = '22023';
  END IF;

  -- The overwhelmingly common no-filter request remains a single execution of
  -- the established report query. This also guarantees byte-for-byte equality
  -- of all existing sections, apart from the new auditable meta field.
  IF _effective_min_total_visits IS NULL THEN
    RETURN jsonb_set(
      _base_result,
      '{meta,min_total_visits}',
      'null'::jsonb,
      true
    );
  END IF;

  _offset := (_page - 1) * _page_size;

  -- Only the customer table is filtered here. Summary, comparison, frequency
  -- bands and monthly composition remain exactly as produced above.
  WITH visit_events AS MATERIALIZED (
    SELECT
      canonical_visits.company_id,
      canonical_visits.canonical_event_key,
      canonical_visits.presence_date AS visit_date,
      canonical_visits.presence_at AS visit_at,
      canonical_visits.guest_name,
      canonical_visits.guest_phone,
      canonical_visits.phone_normalized
    FROM public._get_customer_canonical_visit_events(
      _company_id,
      _period_end,
      _effective_include_companions
    ) AS canonical_visits
    WHERE canonical_visits.phone_normalized IS NOT NULL
  ),
  ranked_customer_visits AS (
    SELECT
      visit_events.*,
      row_number() OVER (
        PARTITION BY visit_events.company_id, visit_events.phone_normalized
        ORDER BY
          visit_events.visit_at DESC,
          visit_events.canonical_event_key DESC
      ) AS customer_visit_rank
    FROM visit_events
  ),
  customer_history AS (
    SELECT
      visit_events.company_id,
      visit_events.phone_normalized,
      min(visit_events.visit_date) AS first_visit_date,
      max(visit_events.visit_date) AS last_visit_date,
      count(*) FILTER (
        WHERE visit_events.visit_date < _period_start
      )::integer AS prior_visits,
      count(*) FILTER (
        WHERE visit_events.visit_date BETWEEN _period_start AND _period_end
      )::integer AS period_visits,
      count(*)::integer AS total_visits
    FROM visit_events
    GROUP BY visit_events.company_id, visit_events.phone_normalized
  ),
  latest_customer_contact AS (
    SELECT
      ranked_customer_visits.company_id,
      ranked_customer_visits.phone_normalized,
      ranked_customer_visits.guest_name,
      ranked_customer_visits.guest_phone
    FROM ranked_customer_visits
    WHERE ranked_customer_visits.customer_visit_rank = 1
  ),
  previous_customer_visit AS (
    SELECT
      ranked_customer_visits.company_id,
      ranked_customer_visits.phone_normalized,
      ranked_customer_visits.visit_date AS previous_visit_date
    FROM ranked_customer_visits
    WHERE ranked_customer_visits.customer_visit_rank = 2
  ),
  future_reservation_contacts AS (
    SELECT
      reservations.company_id,
      public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
      reservations.date AS reservation_date
    FROM public.reservations
    WHERE reservations.company_id = _company_id
      AND reservations.status IN ('confirmed', 'pending_payment')
      AND reservations.date >= _period_end
      AND reservations.guest_phone IS NOT NULL

    UNION ALL

    SELECT
      reservations.company_id,
      public.normalize_whatsapp_phone(reservation_companions.phone) AS phone_normalized,
      reservations.date AS reservation_date
    FROM public.reservation_companions
    JOIN public.reservations
      ON reservations.id = reservation_companions.reservation_id
    WHERE _effective_include_companions
      AND reservations.company_id = _company_id
      AND reservations.status IN ('confirmed', 'pending_payment')
      AND reservations.date >= _period_end
      AND reservation_companions.phone IS NOT NULL
  ),
  future_reservations AS (
    SELECT
      future_reservation_contacts.company_id,
      future_reservation_contacts.phone_normalized,
      min(future_reservation_contacts.reservation_date) AS next_reservation_date
    FROM future_reservation_contacts
    WHERE future_reservation_contacts.phone_normalized IS NOT NULL
    GROUP BY
      future_reservation_contacts.company_id,
      future_reservation_contacts.phone_normalized
  ),
  current_customers AS MATERIALIZED (
    SELECT
      customer_history.company_id,
      customer_history.phone_normalized,
      latest_customer_contact.guest_name,
      latest_customer_contact.guest_phone,
      customer_history.first_visit_date,
      customer_history.last_visit_date,
      previous_customer_visit.previous_visit_date,
      customer_history.prior_visits,
      customer_history.period_visits,
      customer_history.total_visits,
      CASE
        WHEN customer_history.prior_visits > 0 THEN 'returning'
        ELSE 'new'
      END AS customer_type,
      CASE
        WHEN customer_history.total_visits = 1 THEN 'one'
        WHEN customer_history.total_visits = 2 THEN 'two'
        WHEN customer_history.total_visits BETWEEN 3 AND 4 THEN 'three_four'
        ELSE 'five_plus'
      END AS frequency_band,
      future_reservations.next_reservation_date
    FROM customer_history
    JOIN latest_customer_contact
      ON latest_customer_contact.company_id = customer_history.company_id
     AND latest_customer_contact.phone_normalized = customer_history.phone_normalized
    LEFT JOIN previous_customer_visit
      ON previous_customer_visit.company_id = customer_history.company_id
     AND previous_customer_visit.phone_normalized = customer_history.phone_normalized
    LEFT JOIN future_reservations
      ON future_reservations.company_id = customer_history.company_id
     AND future_reservations.phone_normalized = customer_history.phone_normalized
    WHERE customer_history.period_visits > 0
  ),
  filtered_customers AS MATERIALIZED (
    SELECT current_customers.*
    FROM current_customers
    WHERE (
        _search_text IS NULL
        OR position(_search_text IN lower(COALESCE(current_customers.guest_name, ''))) > 0
        OR position(_search_text IN lower(COALESCE(current_customers.guest_phone, ''))) > 0
        OR (
          _search_digits IS NOT NULL
          AND position(_search_digits IN current_customers.phone_normalized) > 0
        )
      )
      AND (
        _effective_min_total_visits IS NULL
        OR current_customers.total_visits >= _effective_min_total_visits
      )
  ),
  numbered_customers AS (
    SELECT
      filtered_customers.*,
      row_number() OVER (
        ORDER BY
          filtered_customers.period_visits DESC,
          filtered_customers.total_visits DESC,
          filtered_customers.last_visit_date DESC,
          filtered_customers.guest_name NULLS LAST,
          filtered_customers.phone_normalized
      )::integer AS result_position
    FROM filtered_customers
  ),
  paged_customers AS (
    SELECT numbered_customers.*
    FROM numbered_customers
    ORDER BY result_position
    LIMIT _page_size
    OFFSET _offset
  ),
  response AS (
    SELECT
      (SELECT count(*)::integer FROM filtered_customers) AS filtered_total,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'customer_key', format('customer:%s', paged_customers.result_position),
              'phone_normalized', right(paged_customers.phone_normalized, 4),
              'guest_name', paged_customers.guest_name,
              'guest_phone', NULL::text,
              'first_visit_date', paged_customers.first_visit_date,
              'last_visit_date', paged_customers.last_visit_date,
              'previous_visit_date', paged_customers.previous_visit_date,
              'prior_visits', paged_customers.prior_visits,
              'period_visits', paged_customers.period_visits,
              'total_visits', paged_customers.total_visits,
              'customer_type', paged_customers.customer_type,
              'frequency_band', paged_customers.frequency_band,
              'next_reservation_date', paged_customers.next_reservation_date
            )
            ORDER BY paged_customers.result_position
          )
          FROM paged_customers
        ),
        '[]'::jsonb
      ) AS customers
  )
  SELECT response.filtered_total, response.customers
  INTO _filtered_customers_total, _customers
  FROM response;

  _result := jsonb_set(_base_result, '{customers}', _customers, true);
  _result := jsonb_set(
    _result,
    '{meta,filtered_customers_total}',
    to_jsonb(_filtered_customers_total),
    true
  );
  _result := jsonb_set(
    _result,
    '{meta,min_total_visits}',
    COALESCE(to_jsonb(_effective_min_total_visits), 'null'::jsonb),
    true
  );

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text, integer
)
IS 'Relatorio agregado de recorrencia com clientes paginados, busca e filtro minimo de visitas aplicados no servidor.';

REVOKE ALL ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text, integer
) TO authenticated, service_role;
