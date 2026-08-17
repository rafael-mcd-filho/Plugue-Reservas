CREATE OR REPLACE FUNCTION public.get_crm_leads_export_page(
  _company_id uuid,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 100,
  _created_from date DEFAULT NULL,
  _created_to date DEFAULT NULL,
  _state_code text DEFAULT NULL,
  _birthday_month integer DEFAULT NULL,
  _visit_from date DEFAULT NULL,
  _visit_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_state_code text := NULLIF(upper(btrim(COALESCE(_state_code, ''))), '');
  _has_visit_filter boolean := _visit_from IS NOT NULL OR _visit_to IS NOT NULL;
  _offset bigint;
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
      RAISE EXCEPTION 'Sem permissao para exportar dados de clientes.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _page IS NULL OR _page < 1 THEN
    RAISE EXCEPTION 'page deve ser maior ou igual a 1.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'page_size deve estar entre 1 e 100.' USING ERRCODE = '22023';
  END IF;

  IF _created_from IS NOT NULL AND _created_to IS NOT NULL AND _created_to < _created_from THEN
    RAISE EXCEPTION 'Intervalo de criacao invalido.' USING ERRCODE = '22023';
  END IF;

  IF _visit_from IS NOT NULL AND _visit_to IS NOT NULL AND _visit_to < _visit_from THEN
    RAISE EXCEPTION 'Intervalo de visitas invalido.' USING ERRCODE = '22023';
  END IF;

  IF _birthday_month IS NOT NULL AND (_birthday_month < 1 OR _birthday_month > 12) THEN
    RAISE EXCEPTION 'birthday_month deve estar entre 1 e 12.' USING ERRCODE = '22023';
  END IF;

  IF _effective_state_code = 'ALL' THEN
    _effective_state_code := NULL;
  END IF;

  IF _effective_state_code IS NOT NULL
    AND _effective_state_code <> 'UNKNOWN'
    AND _effective_state_code NOT IN (
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
      'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
    ) THEN
    RAISE EXCEPTION 'state_code invalido.' USING ERRCODE = '22023';
  END IF;

  -- bigint avoids an artificial last page. The caller can continue until
  -- meta.has_more=false without a silent export cap.
  _offset := (_page::bigint - 1) * _page_size::bigint;

  WITH filtered_leads AS MATERIALIZED (
    SELECT profiles.*
    FROM public._get_crm_lead_profiles(_company_id) AS profiles
    WHERE (_created_from IS NULL OR (profiles.first_seen_at AT TIME ZONE 'America/Fortaleza')::date >= _created_from)
      AND (_created_to IS NULL OR (profiles.first_seen_at AT TIME ZONE 'America/Fortaleza')::date <= _created_to)
      AND (
        _effective_state_code IS NULL
        OR (_effective_state_code = 'UNKNOWN' AND profiles.state_code IS NULL)
        OR (_effective_state_code <> 'UNKNOWN' AND profiles.state_code = _effective_state_code)
      )
      AND (
        _birthday_month IS NULL
        OR extract(month FROM profiles.latest_birthdate)::integer = _birthday_month
      )
  ),
  matched_visits AS MATERIALIZED (
    SELECT
      visits.*
    FROM public._get_customer_canonical_visit_events(
      _company_id,
      NULL,
      true
    ) AS visits
    JOIN filtered_leads
      ON filtered_leads.company_id = visits.company_id
     AND filtered_leads.customer_key = visits.customer_key
    WHERE (_visit_from IS NULL OR visits.presence_date >= _visit_from)
      AND (_visit_to IS NULL OR visits.presence_date <= _visit_to)
  ),
  matched_summaries AS MATERIALIZED (
    SELECT
      matched_visits.company_id,
      matched_visits.customer_key,
      count(*)::integer AS matched_visit_count,
      CASE
        WHEN bool_or(matched_visits.role_kind = 'holder')
          AND bool_or(matched_visits.role_kind = 'companion') THEN 'mixed'
        WHEN bool_or(matched_visits.role_kind = 'companion') THEN 'companion'
        ELSE 'reservation_holder'
      END AS matched_source,
      (array_agg(
        matched_visits.presence_date
        ORDER BY matched_visits.presence_at DESC, matched_visits.canonical_event_key DESC
      ))[1] AS last_matched_visit_date,
      (array_agg(
        matched_visits.presence_time
        ORDER BY matched_visits.presence_at DESC, matched_visits.canonical_event_key DESC
      ))[1] AS last_matched_visit_time,
      (array_agg(
        matched_visits.presence_at
        ORDER BY matched_visits.presence_at DESC, matched_visits.canonical_event_key DESC
      ))[1] AS last_matched_visit_at
    FROM matched_visits
    GROUP BY
      matched_visits.company_id,
      matched_visits.customer_key
  ),
  exportable_leads AS MATERIALIZED (
    SELECT
      filtered_leads.*,
      COALESCE(matched_summaries.matched_visit_count, 0) AS matched_visit_count,
      COALESCE(matched_summaries.matched_source, filtered_leads.source) AS matched_source,
      matched_summaries.last_matched_visit_date,
      matched_summaries.last_matched_visit_time,
      matched_summaries.last_matched_visit_at
    FROM filtered_leads
    LEFT JOIN matched_summaries
      ON matched_summaries.company_id = filtered_leads.company_id
     AND matched_summaries.customer_key = filtered_leads.customer_key
    WHERE NOT _has_visit_filter
       OR matched_summaries.matched_visit_count > 0
  ),
  lead_payloads AS MATERIALIZED (
    SELECT
      exportable_leads.*,
      jsonb_build_object(
        'customer_key', exportable_leads.customer_key,
        'phone_normalized', exportable_leads.phone_normalized,
        'display_phone', exportable_leads.display_phone,
        'latest_name', exportable_leads.latest_name,
        'latest_email', exportable_leads.latest_email,
        'latest_birthdate', exportable_leads.latest_birthdate,
        'first_seen_at', exportable_leads.first_seen_at,
        'last_visit_date', exportable_leads.last_visit_date,
        'last_visit_time', exportable_leads.last_visit_time,
        'state_code', exportable_leads.state_code,
        'state_name', exportable_leads.state_name,
        'source', exportable_leads.source,
        'canonical_visit_count', exportable_leads.canonical_visit_count,
        'is_import_only', exportable_leads.is_import_only,
        'crm_lead', CASE
          WHEN exportable_leads.crm_lead_id IS NULL THEN 'null'::jsonb
          ELSE jsonb_build_object(
            'id', exportable_leads.crm_lead_id,
            'notes', exportable_leads.crm_notes,
            'imported_at', exportable_leads.crm_imported_at,
            'imported_by_user_id', exportable_leads.crm_imported_by_user_id,
            'import_filename', exportable_leads.crm_import_filename
          )
        END,
        'matched_visit_count', exportable_leads.matched_visit_count,
        'matched_source', exportable_leads.matched_source,
        'last_matched_visit_date', exportable_leads.last_matched_visit_date,
        'last_matched_visit_time', exportable_leads.last_matched_visit_time,
        'last_matched_visit_at', exportable_leads.last_matched_visit_at
      ) AS lead_payload
    FROM exportable_leads
  ),
  raw_export_rows AS MATERIALIZED (
    SELECT
      lead_payloads.customer_key,
      lead_payloads.canonical_visit_count,
      lead_payloads.first_seen_at,
      matched_visits.presence_at,
      matched_visits.canonical_event_key,
      lead_payloads.lead_payload || jsonb_build_object(
        'row_key', 'presence:' || lead_payloads.customer_key || ':' || matched_visits.canonical_event_key,
        'row_kind', 'presence',
        'visit', jsonb_build_object(
          'id', matched_visits.canonical_event_key,
          'visit_id', matched_visits.visit_id,
          'created_at', matched_visits.contact_created_at,
          'date', matched_visits.presence_date,
          'time', matched_visits.presence_time,
          'party_size', matched_visits.party_size,
          'status', matched_visits.status,
          'normalized_status', matched_visits.normalized_status,
          'occasion', matched_visits.occasion,
          'lead_source', matched_visits.lead_source,
          'role_kind', matched_visits.role_kind,
          'visit_origin', matched_visits.visit_origin,
          'origin_waitlist_id', matched_visits.origin_waitlist_id,
          'came_from_waitlist', matched_visits.came_from_waitlist,
          'reservation_holder_name', matched_visits.reservation_holder_name
        )
      ) AS row_payload
    FROM lead_payloads
    JOIN matched_visits
      ON matched_visits.company_id = lead_payloads.company_id
     AND matched_visits.customer_key = lead_payloads.customer_key

    UNION ALL

    SELECT
      lead_payloads.customer_key,
      lead_payloads.canonical_visit_count,
      lead_payloads.first_seen_at,
      NULL::timestamptz AS presence_at,
      NULL::text AS canonical_event_key,
      lead_payloads.lead_payload || jsonb_build_object(
        'row_key', 'lead_only:' || lead_payloads.customer_key,
        'row_kind', 'lead_only',
        'visit', 'null'::jsonb
      ) AS row_payload
    FROM lead_payloads
    WHERE lead_payloads.matched_visit_count = 0
  ),
  ranked_export_rows AS MATERIALIZED (
    SELECT
      raw_export_rows.*,
      row_number() OVER (
        ORDER BY
          raw_export_rows.canonical_visit_count DESC,
          raw_export_rows.first_seen_at DESC,
          raw_export_rows.customer_key,
          raw_export_rows.presence_at DESC NULLS LAST,
          raw_export_rows.canonical_event_key DESC NULLS LAST
      ) AS row_position
    FROM raw_export_rows
  ),
  paged_export_rows AS (
    SELECT ranked_export_rows.*
    FROM ranked_export_rows
    WHERE ranked_export_rows.row_position > _offset
      AND ranked_export_rows.row_position <= _offset + _page_size
    ORDER BY ranked_export_rows.row_position
  ),
  export_stats AS (
    SELECT
      count(*)::bigint AS total_rows,
      count(*) FILTER (WHERE raw_export_rows.presence_at IS NOT NULL)::bigint AS matched_visits
    FROM raw_export_rows
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(
      (
        SELECT jsonb_agg(
          paged_export_rows.row_payload
          ORDER BY paged_export_rows.row_position
        )
        FROM paged_export_rows
      ),
      '[]'::jsonb
    ),
    'meta', jsonb_build_object(
      'page', _page,
      'page_size', _page_size,
      'total_rows', export_stats.total_rows,
      'total_pages', CASE
        WHEN export_stats.total_rows = 0 THEN 0
        ELSE ceil(export_stats.total_rows::numeric / _page_size)::bigint
      END,
      'filtered_leads', (SELECT count(*)::bigint FROM exportable_leads),
      'matched_visits', export_stats.matched_visits,
      'has_more', (_offset + _page_size::bigint) < export_stats.total_rows,
      'visit_filter_applied', _has_visit_filter,
      'generated_at', now()
    )
  )
  INTO _result
  FROM export_stats;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_crm_leads_export_page(
  uuid, integer, integer, date, date, text, integer, date, date
)
IS 'Exportacao paginada de leads e presencas canonicas, sem status operacionais de nao-presenca.';

REVOKE ALL ON FUNCTION public.get_crm_leads_export_page(
  uuid, integer, integer, date, date, text, integer, date, date
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_crm_leads_export_page(
  uuid, integer, integer, date, date, text, integer, date, date
) TO authenticated, service_role;
