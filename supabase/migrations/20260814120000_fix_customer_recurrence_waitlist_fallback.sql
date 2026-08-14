CREATE OR REPLACE FUNCTION public.get_customer_recurrence_report(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _include_companions boolean DEFAULT false,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 25,
  _search text DEFAULT NULL,
  _comparison_mode text DEFAULT 'previous_period'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_include_companions boolean := COALESCE(_include_companions, false);
  _period_days integer;
  _comparison_start date;
  _comparison_end date;
  _search_text text := NULLIF(lower(btrim(COALESCE(_search, ''))), '');
  _search_digits text := NULLIF(regexp_replace(COALESCE(_search, ''), '\D', '', 'g'), '');
  _effective_comparison_mode text := lower(btrim(COALESCE(_comparison_mode, 'previous_period')));
  _offset integer;
  _result jsonb;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_company_panel_permission(auth.uid(), _company_id, 'leads_view') THEN
      RAISE EXCEPTION 'Sem permissao para visualizar dados de clientes.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.company_feature_enabled(_company_id, 'advanced_reports') THEN
      RAISE EXCEPTION 'Relatorios avancados nao estao habilitados para esta empresa.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_end < _period_start THEN
    RAISE EXCEPTION 'Intervalo de datas invalido.' USING ERRCODE = '22023';
  END IF;

  -- O intervalo e inclusivo; uma diferenca de 365 dias representa 366 dias.
  IF (_period_end - _period_start) > 365 THEN
    RAISE EXCEPTION 'O periodo nao pode ultrapassar 366 dias.' USING ERRCODE = '22023';
  END IF;

  IF _page IS NULL OR _page < 1 OR _page > 10000 THEN
    RAISE EXCEPTION 'page deve estar entre 1 e 10000.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'page_size deve estar entre 1 e 100.' USING ERRCODE = '22023';
  END IF;

  IF _search_text IS NOT NULL AND char_length(_search_text) > 200 THEN
    RAISE EXCEPTION 'search nao pode ultrapassar 200 caracteres.' USING ERRCODE = '22023';
  END IF;

  IF _effective_comparison_mode NOT IN ('month_to_date', 'previous_period') THEN
    RAISE EXCEPTION 'comparison_mode deve ser month_to_date ou previous_period.' USING ERRCODE = '22023';
  END IF;

  _period_days := (_period_end - _period_start) + 1;
  -- Presets mensais comparam o mesmo recorte do mes anterior. Intervalos
  -- personalizados comparam um intervalo de mesmo tamanho imediatamente anterior.
  IF _effective_comparison_mode = 'month_to_date' THEN
    IF _period_start <> date_trunc('month', _period_start)::date
      OR date_trunc('month', _period_end)::date <> date_trunc('month', _period_start)::date THEN
      RAISE EXCEPTION 'month_to_date exige um intervalo dentro de um unico mes e iniciado no dia 1.' USING ERRCODE = '22023';
    END IF;

    _comparison_start := date_trunc('month', _period_start - interval '1 month')::date;
    _comparison_end := LEAST(
      _comparison_start + (_period_days - 1),
      (date_trunc('month', _comparison_start) + interval '1 month - 1 day')::date
    );
  ELSE
    _comparison_end := _period_start - 1;
    _comparison_start := _period_start - _period_days;
  END IF;
  _offset := (_page - 1) * _page_size;

  WITH raw_visit_events AS (
    SELECT
      reservations.company_id,
      'reservation:' || reservations.id::text AS canonical_event_key,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date,
        reservations.date
      ) AS visit_date,
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza'
      ) AS visit_at,
      NULLIF(btrim(reservations.guest_name), '') AS guest_name,
      NULLIF(btrim(reservations.guest_phone), '') AS guest_phone,
      public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
      1 AS contact_priority,
      0 AS contact_position
    FROM public.reservations
    WHERE reservations.company_id = _company_id
      AND reservations.status IN ('checked_in', 'completed')
      AND reservations.guest_phone IS NOT NULL
      AND COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date,
        reservations.date
      ) <= _period_end

    UNION ALL

    SELECT
      reservations.company_id,
      'reservation:' || reservations.id::text AS canonical_event_key,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date,
        reservations.date
      ) AS visit_date,
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza'
      ) AS visit_at,
      NULLIF(btrim(reservation_companions.name), '') AS guest_name,
      NULLIF(btrim(reservation_companions.phone), '') AS guest_phone,
      public.normalize_whatsapp_phone(reservation_companions.phone) AS phone_normalized,
      2 AS contact_priority,
      reservation_companions.position AS contact_position
    FROM public.reservation_companions
    JOIN public.reservations
      ON reservations.id = reservation_companions.reservation_id
    WHERE _effective_include_companions
      AND reservations.company_id = _company_id
      AND reservations.status IN ('checked_in', 'completed')
      AND reservation_companions.phone IS NOT NULL
      AND COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date,
        reservations.date
      ) <= _period_end

    UNION ALL

    SELECT
      waitlist.company_id,
      'waitlist:' || waitlist.id::text AS canonical_event_key,
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ) AS visit_date,
      COALESCE(waitlist.seated_at, waitlist.created_at) AS visit_at,
      NULLIF(btrim(waitlist.guest_name), '') AS guest_name,
      NULLIF(btrim(waitlist.guest_phone), '') AS guest_phone,
      public.normalize_whatsapp_phone(waitlist.guest_phone) AS phone_normalized,
      1 AS contact_priority,
      0 AS contact_position
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'seated'
      AND waitlist.guest_phone IS NOT NULL
      AND COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ) <= _period_end
      AND NOT EXISTS (
        SELECT 1
        FROM public.reservations linked_reservation
        WHERE linked_reservation.origin_waitlist_id = waitlist.id
          AND linked_reservation.status IN ('checked_in', 'completed')
      )

    UNION ALL

    SELECT
      waitlist.company_id,
      'waitlist:' || waitlist.id::text AS canonical_event_key,
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ) AS visit_date,
      COALESCE(waitlist.seated_at, waitlist.created_at) AS visit_at,
      NULLIF(btrim(waitlist_companions.name), '') AS guest_name,
      NULLIF(btrim(waitlist_companions.phone), '') AS guest_phone,
      public.normalize_whatsapp_phone(waitlist_companions.phone) AS phone_normalized,
      2 AS contact_priority,
      waitlist_companions.position AS contact_position
    FROM public.waitlist_companions
    JOIN public.waitlist
      ON waitlist.id = waitlist_companions.waitlist_id
    WHERE _effective_include_companions
      AND waitlist.company_id = _company_id
      AND waitlist.status = 'seated'
      AND waitlist_companions.phone IS NOT NULL
      AND COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ) <= _period_end
      AND NOT EXISTS (
        SELECT 1
        FROM public.reservations linked_reservation
        WHERE linked_reservation.origin_waitlist_id = waitlist.id
          AND linked_reservation.status IN ('checked_in', 'completed')
      )
  ),
  -- Um contato aparece apenas uma vez dentro do mesmo evento (por exemplo, se o
  -- titular tambem foi cadastrado como acompanhante). Eventos canonicos distintos
  -- no mesmo dia continuam contando como visitas distintas de forma intencional.
  ranked_event_contacts AS (
    SELECT
      raw_visit_events.*,
      row_number() OVER (
        PARTITION BY
          raw_visit_events.company_id,
          raw_visit_events.canonical_event_key,
          raw_visit_events.phone_normalized
        ORDER BY
          raw_visit_events.contact_priority,
          raw_visit_events.contact_position,
          raw_visit_events.guest_name NULLS LAST,
          raw_visit_events.guest_phone NULLS LAST
      ) AS event_contact_rank
    FROM raw_visit_events
    WHERE raw_visit_events.phone_normalized IS NOT NULL
  ),
  visit_events AS MATERIALIZED (
    SELECT
      ranked_event_contacts.company_id,
      ranked_event_contacts.canonical_event_key,
      ranked_event_contacts.visit_date,
      ranked_event_contacts.visit_at,
      ranked_event_contacts.guest_name,
      ranked_event_contacts.guest_phone,
      ranked_event_contacts.phone_normalized
    FROM ranked_event_contacts
    WHERE ranked_event_contacts.event_contact_rank = 1
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
      count(*) FILTER (
        WHERE visit_events.visit_date < _comparison_start
      )::integer AS comparison_prior_visits,
      count(*) FILTER (
        WHERE visit_events.visit_date BETWEEN _comparison_start AND _comparison_end
      )::integer AS comparison_period_visits,
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
  comparison_customers AS (
    SELECT
      customer_history.first_visit_date,
      customer_history.comparison_prior_visits AS prior_visits,
      customer_history.comparison_period_visits AS period_visits
    FROM customer_history
    WHERE customer_history.comparison_period_visits > 0
  ),
  current_summary AS (
    SELECT
      count(*)::integer AS identified_customers,
      count(*) FILTER (WHERE current_customers.customer_type = 'returning')::integer AS returning_customers,
      count(*) FILTER (WHERE current_customers.customer_type = 'new')::integer AS new_customers,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE current_customers.customer_type = 'returning')
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS recurrence_rate,
      count(*) FILTER (WHERE current_customers.period_visits >= 2)::integer AS repeated_in_period,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE current_customers.period_visits >= 2)
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS repeat_rate,
      COALESCE(sum(current_customers.period_visits - 1), 0)::integer AS additional_visits,
      COALESCE(sum(current_customers.period_visits), 0)::integer AS period_visits,
      COALESCE(round(avg(current_customers.period_visits)::numeric, 2), 0) AS avg_visits_per_customer
    FROM current_customers
  ),
  comparison_summary AS (
    SELECT
      count(*)::integer AS identified_customers,
      count(*) FILTER (WHERE comparison_customers.prior_visits > 0)::integer AS returning_customers,
      count(*) FILTER (WHERE comparison_customers.prior_visits = 0)::integer AS new_customers,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE comparison_customers.prior_visits > 0)
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS recurrence_rate,
      count(*) FILTER (WHERE comparison_customers.period_visits >= 2)::integer AS repeated_in_period,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE comparison_customers.period_visits >= 2)
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS repeat_rate,
      COALESCE(sum(comparison_customers.period_visits - 1), 0)::integer AS additional_visits,
      COALESCE(sum(comparison_customers.period_visits), 0)::integer AS period_visits,
      COALESCE(round(avg(comparison_customers.period_visits)::numeric, 2), 0) AS avg_visits_per_customer
    FROM comparison_customers
  ),
  frequency_band_definitions AS (
    SELECT *
    FROM (VALUES
      (1, 'one'::text, '1 visita'::text, 1, 1),
      (2, 'two'::text, '2 visitas'::text, 2, 2),
      (3, 'three_four'::text, '3-4 visitas'::text, 3, 4),
      (4, 'five_plus'::text, '5+ visitas'::text, 5, NULL::integer)
    ) AS definitions(sort_order, key, label, min_visits, max_visits)
  ),
  frequency_band_rollup AS (
    SELECT
      frequency_band_definitions.sort_order,
      frequency_band_definitions.key,
      frequency_band_definitions.label,
      frequency_band_definitions.min_visits,
      frequency_band_definitions.max_visits,
      count(current_customers.phone_normalized) FILTER (
        WHERE current_customers.total_visits >= frequency_band_definitions.min_visits
          AND (
            frequency_band_definitions.max_visits IS NULL
            OR current_customers.total_visits <= frequency_band_definitions.max_visits
          )
      )::integer AS customers,
      COALESCE(
        round(
          100.0 * count(current_customers.phone_normalized) FILTER (
            WHERE current_customers.total_visits >= frequency_band_definitions.min_visits
              AND (
                frequency_band_definitions.max_visits IS NULL
                OR current_customers.total_visits <= frequency_band_definitions.max_visits
              )
          ) / NULLIF((SELECT count(*) FROM current_customers), 0),
          1
        ),
        0
      ) AS percentage
    FROM frequency_band_definitions
    LEFT JOIN current_customers ON true
    GROUP BY
      frequency_band_definitions.sort_order,
      frequency_band_definitions.key,
      frequency_band_definitions.label,
      frequency_band_definitions.min_visits,
      frequency_band_definitions.max_visits
  ),
  report_months AS (
    SELECT
      month_series::date AS month_start,
      LEAST(
        (month_series + interval '1 month - 1 day')::date,
        _period_end
      ) AS month_end
    FROM generate_series(
      date_trunc('month', _period_end)::date - interval '5 months',
      date_trunc('month', _period_end)::date,
      interval '1 month'
    ) AS month_series
  ),
  monthly_customers AS (
    SELECT
      report_months.month_start,
      visit_events.company_id,
      visit_events.phone_normalized,
      customer_history.first_visit_date
    FROM report_months
    JOIN visit_events
      ON visit_events.visit_date BETWEEN report_months.month_start AND report_months.month_end
    JOIN customer_history
      ON customer_history.company_id = visit_events.company_id
     AND customer_history.phone_normalized = visit_events.phone_normalized
    GROUP BY
      report_months.month_start,
      visit_events.company_id,
      visit_events.phone_normalized,
      customer_history.first_visit_date
  ),
  monthly_rollup AS (
    SELECT
      report_months.month_start,
      count(monthly_customers.phone_normalized)::integer AS identified_customers,
      count(monthly_customers.phone_normalized) FILTER (
        WHERE monthly_customers.first_visit_date >= report_months.month_start
      )::integer AS new_customers,
      count(monthly_customers.phone_normalized) FILTER (
        WHERE monthly_customers.first_visit_date < report_months.month_start
      )::integer AS returning_customers,
      COALESCE(
        round(
          100.0 * count(monthly_customers.phone_normalized) FILTER (
            WHERE monthly_customers.first_visit_date < report_months.month_start
          ) / NULLIF(count(monthly_customers.phone_normalized), 0),
          1
        ),
        0
      ) AS recurrence_rate
    FROM report_months
    LEFT JOIN monthly_customers
      ON monthly_customers.month_start = report_months.month_start
    GROUP BY report_months.month_start
  ),
  filtered_customers AS MATERIALIZED (
    SELECT current_customers.*
    FROM current_customers
    WHERE _search_text IS NULL
      OR position(_search_text IN lower(COALESCE(current_customers.guest_name, ''))) > 0
      OR position(_search_text IN lower(COALESCE(current_customers.guest_phone, ''))) > 0
      OR (
        _search_digits IS NOT NULL
        AND position(_search_digits IN current_customers.phone_normalized) > 0
      )
  ),
  paged_customers AS (
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
    ORDER BY
      filtered_customers.period_visits DESC,
      filtered_customers.total_visits DESC,
      filtered_customers.last_visit_date DESC,
      filtered_customers.guest_name NULLS LAST,
      filtered_customers.phone_normalized
    LIMIT _page_size
    OFFSET _offset
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'identified_customers', current_summary.identified_customers,
      'returning_customers', current_summary.returning_customers,
      'new_customers', current_summary.new_customers,
      'recurrence_rate', current_summary.recurrence_rate,
      'repeated_in_period', current_summary.repeated_in_period,
      'repeat_rate', current_summary.repeat_rate,
      'additional_visits', current_summary.additional_visits,
      'period_visits', current_summary.period_visits,
      'avg_visits_per_customer', current_summary.avg_visits_per_customer
    ),
    'comparison', jsonb_build_object(
      'period_start', _comparison_start,
      'period_end', _comparison_end,
      'identified_customers', comparison_summary.identified_customers,
      'returning_customers', comparison_summary.returning_customers,
      'new_customers', comparison_summary.new_customers,
      'recurrence_rate', comparison_summary.recurrence_rate,
      'repeated_in_period', comparison_summary.repeated_in_period,
      'repeat_rate', comparison_summary.repeat_rate,
      'additional_visits', comparison_summary.additional_visits,
      'period_visits', comparison_summary.period_visits,
      'avg_visits_per_customer', comparison_summary.avg_visits_per_customer
    ),
    'frequency_bands', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'key', frequency_band_rollup.key,
            'label', frequency_band_rollup.label,
            'min_visits', frequency_band_rollup.min_visits,
            'max_visits', frequency_band_rollup.max_visits,
            'customers', frequency_band_rollup.customers,
            'percentage', frequency_band_rollup.percentage
          )
          ORDER BY frequency_band_rollup.sort_order
        )
        FROM frequency_band_rollup
      ),
      '[]'::jsonb
    ),
    'monthly_composition', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'month', monthly_rollup.month_start,
            'identified_customers', monthly_rollup.identified_customers,
            'new_customers', monthly_rollup.new_customers,
            'returning_customers', monthly_rollup.returning_customers,
            'recurrence_rate', monthly_rollup.recurrence_rate
          )
          ORDER BY monthly_rollup.month_start
        )
        FROM monthly_rollup
      ),
      '[]'::jsonb
    ),
    'customers', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            -- Identificador opaco e valido apenas para a posicao no resultado. Ele
            -- nao deriva do telefone e serve somente como chave de renderizacao.
            'customer_key', format('customer:%s', paged_customers.result_position),
            -- A busca acontece no banco; o payload entrega apenas os ultimos
            -- digitos necessarios para identificacao visual e nunca o telefone completo.
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
          ORDER BY
            paged_customers.period_visits DESC,
            paged_customers.total_visits DESC,
            paged_customers.last_visit_date DESC,
            paged_customers.guest_name NULLS LAST,
            paged_customers.phone_normalized
        )
        FROM paged_customers
      ),
      '[]'::jsonb
    ),
    'meta', jsonb_build_object(
      'period_start', _period_start,
      'period_end', _period_end,
      'comparison_mode', _effective_comparison_mode,
      'include_companions', _effective_include_companions,
      'page', _page,
      'page_size', _page_size,
      'customers_total', (SELECT count(*)::integer FROM current_customers),
      'filtered_customers_total', (SELECT count(*)::integer FROM filtered_customers),
      'generated_at', now()
    )
  )
  INTO _result
  FROM current_summary
  CROSS JOIN comparison_summary;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text
)
IS 'Relatorio agregado de recorrencia por telefone normalizado, com comparativo, frequencia, composicao mensal e clientes paginados.';

REVOKE ALL ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text
) TO authenticated, service_role;
