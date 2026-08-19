-- Give each recurrence row a stable, opaque reference to its latest canonical
-- contact. Unlike the former positional customer:N key, contact_record_key does
-- not change when another customer enters the report. It also contains no phone,
-- email or CRM customer_key.
DO $migration$
DECLARE
  _signature regprocedure;
  _definition text;
  _updated_definition text;
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public._get_customer_recurrence_report_without_min_filter(uuid,date,date,boolean,integer,integer,text,text)'::regprocedure,
    'public.get_customer_recurrence_report(uuid,date,date,boolean,integer,integer,text,text,integer)'::regprocedure
  ]
  LOOP
    _definition := pg_get_functiondef(_signature);

    _updated_definition := replace(
      _definition,
      E'      canonical_visits.canonical_event_key,\n      canonical_visits.presence_date AS visit_date,',
      E'      canonical_visits.canonical_event_key,\n      canonical_visits.contact_record_key AS profile_ref,\n      canonical_visits.presence_date AS visit_date,'
    );
    IF _updated_definition = _definition THEN
      RAISE EXCEPTION 'Nao foi possivel incluir profile_ref nos eventos de %.', _signature;
    END IF;
    _definition := _updated_definition;

    _updated_definition := replace(
      _definition,
      E'      ranked_customer_visits.phone_normalized,\n      ranked_customer_visits.guest_name,',
      E'      ranked_customer_visits.phone_normalized,\n      ranked_customer_visits.profile_ref,\n      ranked_customer_visits.guest_name,'
    );
    IF _updated_definition = _definition THEN
      RAISE EXCEPTION 'Nao foi possivel selecionar profile_ref mais recente em %.', _signature;
    END IF;
    _definition := _updated_definition;

    _updated_definition := replace(
      _definition,
      E'      latest_customer_contact.guest_name,\n      latest_customer_contact.guest_phone,\n      customer_history.first_visit_date,',
      E'      latest_customer_contact.guest_name,\n      latest_customer_contact.guest_phone,\n      latest_customer_contact.profile_ref,\n      customer_history.first_visit_date,'
    );
    IF _updated_definition = _definition THEN
      RAISE EXCEPTION 'Nao foi possivel propagar profile_ref para os clientes de %.', _signature;
    END IF;
    _definition := _updated_definition;

    _updated_definition := replace(
      _definition,
      E'''customer_key'', format(''customer:%s'', paged_customers.result_position),',
      E'''customer_key'', format(''customer:%s'', paged_customers.result_position),\n            ''profile_ref'', paged_customers.profile_ref,'
    );
    IF _updated_definition = _definition THEN
      RAISE EXCEPTION 'Nao foi possivel publicar profile_ref nas linhas de %.', _signature;
    END IF;

    EXECUTE _updated_definition;
  END LOOP;
END;
$migration$;

COMMENT ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text, integer
)
IS 'Relatorio agregado de recorrencia com paginacao irrestrita, busca, filtro minimo de visitas e profile_ref opaca para abrir o perfil CRM sob demanda.';

CREATE OR REPLACE FUNCTION public.get_customer_recurrence_lead_profile(
  _company_id uuid,
  _profile_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_profile_ref text := btrim(COALESCE(_profile_ref, ''));
  _result jsonb;
BEGIN
  -- Authenticate and authorize before validating caller-controlled values. This
  -- prevents anonymous and cross-company callers from using validation errors
  -- as an oracle for the existence or shape of references.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;

    IF public.has_company_panel_permission(
      auth.uid(),
      _company_id,
      'leads_view'
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Sem permissao para visualizar dados de clientes.'
        USING ERRCODE = '42501';
    END IF;

    IF public.company_feature_enabled(
      _company_id,
      'advanced_reports'
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Relatorios avancados nao estao habilitados para esta empresa.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  -- Only references emitted by _get_crm_contact_records are accepted. CRM
  -- identities (phone:/email:/contact:) and positional customer:N values are
  -- deliberately invalid on this endpoint.
  IF _effective_profile_ref !~
    '^(reservation_holder|reservation_companion|waitlist_holder|waitlist_companion):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'profile_ref invalida.' USING ERRCODE = '22023';
  END IF;

  WITH resolved_contacts AS MATERIALIZED (
    SELECT
      contact_records.customer_key,
      contact_records.phone_normalized
    FROM public._get_crm_contact_records(_company_id) AS contact_records
    WHERE contact_records.contact_record_key = _effective_profile_ref
      AND contact_records.phone_normalized IS NOT NULL
  ),
  unique_contact AS (
    -- A reference is expected to identify exactly one contact inside exactly
    -- one company. Any duplicate or ambiguous state fails closed.
    SELECT min(resolved_contacts.customer_key) AS customer_key
    FROM resolved_contacts
    HAVING count(*) = 1
      AND count(DISTINCT resolved_contacts.customer_key) = 1
  ),
  target_profile AS (
    SELECT profiles.*
    FROM unique_contact
    JOIN public._get_crm_lead_profiles(_company_id) AS profiles
      ON profiles.customer_key = unique_contact.customer_key
    WHERE profiles.phone_normalized IS NOT NULL
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'customer_key', target_profile.customer_key,
    'identity_kind', target_profile.identity_kind,
    'phone_normalized', target_profile.phone_normalized,
    'display_phone', target_profile.display_phone,
    'latest_name', target_profile.latest_name,
    'latest_email', target_profile.latest_email,
    'latest_birthdate', target_profile.latest_birthdate,
    'first_seen_at', target_profile.first_seen_at,
    'last_visit_date', target_profile.last_visit_date,
    'last_visit_time', target_profile.last_visit_time,
    'state_code', target_profile.state_code,
    'state_name', target_profile.state_name,
    'source', target_profile.source,
    'canonical_visit_count', target_profile.canonical_visit_count,
    'is_import_only', target_profile.is_import_only,
    'crm_lead', CASE
      WHEN target_profile.crm_lead_id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'id', target_profile.crm_lead_id,
        'notes', target_profile.crm_notes,
        'imported_at', target_profile.crm_imported_at,
        'imported_by_user_id', target_profile.crm_imported_by_user_id,
        'import_filename', target_profile.crm_import_filename
      )
    END
  )
  INTO _result
  FROM target_profile;

  -- Forged, stale and cross-company references return SQL NULL. No fallback by
  -- name, final phone digits or positional row is allowed.
  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_customer_recurrence_lead_profile(uuid, text)
IS 'Abre sob demanda o perfil CRM associado a uma profile_ref opaca do relatorio de recorrencia, com isolamento por empresa e falha fechada.';

REVOKE ALL ON FUNCTION public.get_customer_recurrence_lead_profile(uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_customer_recurrence_lead_profile(uuid, text)
TO authenticated, service_role;
