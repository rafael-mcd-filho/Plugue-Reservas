-- Focused PGlite regression for
-- 20260819115000_add_recurrence_lead_profile_lookup.sql.
--
-- Run this after the bootstrap/fixtures and all @apply-* steps in
-- crm_leads_server_read_model_regression.sql. That harness intentionally saves
-- the two temporary `recurrence_profile_*_baseline` tables immediately before
-- applying this migration.

DO $recurrence_profile_regression$
DECLARE
  _baseline record;
  _current_definition text;
  _definition_without_profile_ref text;
  _current_owner oid;
  _current_acl text;
  _current_config text[];
  _current_volatility "char";
  _current_security_definer boolean;
  _baseline_payload jsonb;
  _current_payload jsonb;
  _payload_without_profile_ref jsonb;
  _profile_ref text;
  _profile jsonb;
  _expected_customer_key text;
BEGIN
  IF to_regclass('pg_temp.recurrence_profile_definition_baseline') IS NULL
    OR to_regclass('pg_temp.recurrence_profile_payload_baseline') IS NULL THEN
    RAISE EXCEPTION 'Execute este teste pelo harness crm_leads_server_read_model_regression.sql.';
  END IF;

  FOR _baseline IN
    SELECT *
    FROM recurrence_profile_definition_baseline
    ORDER BY signature
  LOOP
    SELECT
      pg_get_functiondef(procedures.oid),
      procedures.proowner,
      procedures.proacl::text,
      procedures.proconfig,
      procedures.provolatile,
      procedures.prosecdef
    INTO STRICT
      _current_definition,
      _current_owner,
      _current_acl,
      _current_config,
      _current_volatility,
      _current_security_definer
    FROM pg_proc AS procedures
    WHERE procedures.oid = _baseline.procedure_oid;

    -- Exactly four data-flow additions are permitted in each existing report
    -- definition: capture, latest-contact selection, propagation and JSON field.
    IF (
        length(_current_definition)
        - length(replace(
          _current_definition,
          E'      canonical_visits.contact_record_key AS profile_ref,\n',
          ''
        ))
      ) / length(E'      canonical_visits.contact_record_key AS profile_ref,\n') <> 1
      OR (
        length(_current_definition)
        - length(replace(
          _current_definition,
          E'      ranked_customer_visits.profile_ref,\n',
          ''
        ))
      ) / length(E'      ranked_customer_visits.profile_ref,\n') <> 1
      OR (
        length(_current_definition)
        - length(replace(
          _current_definition,
          E'      latest_customer_contact.profile_ref,\n',
          ''
        ))
      ) / length(E'      latest_customer_contact.profile_ref,\n') <> 1
      OR (
        length(_current_definition)
        - length(replace(
          _current_definition,
          E'            ''profile_ref'', paged_customers.profile_ref,\n',
          ''
        ))
      ) / length(E'            ''profile_ref'', paged_customers.profile_ref,\n') <> 1 THEN
      RAISE EXCEPTION 'profile_ref nao foi inserida exatamente quatro vezes em %.',
        _baseline.signature;
    END IF;

    _definition_without_profile_ref := replace(
      replace(
        replace(
          replace(
            _current_definition,
            E'      canonical_visits.contact_record_key AS profile_ref,\n',
            ''
          ),
          E'      ranked_customer_visits.profile_ref,\n',
          ''
        ),
        E'      latest_customer_contact.profile_ref,\n',
        ''
      ),
      E'            ''profile_ref'', paged_customers.profile_ref,\n',
      ''
    );

    IF _definition_without_profile_ref IS DISTINCT FROM _baseline.definition THEN
      RAISE EXCEPTION 'A migration alterou mais que o fluxo de profile_ref em %.',
        _baseline.signature;
    END IF;

    IF _current_owner IS DISTINCT FROM _baseline.proowner
      OR _current_acl IS DISTINCT FROM _baseline.proacl
      OR _current_config IS DISTINCT FROM _baseline.proconfig
      OR _current_volatility IS DISTINCT FROM _baseline.provolatile
      OR _current_security_definer IS DISTINCT FROM _baseline.prosecdef THEN
      RAISE EXCEPTION 'Owner/ACL/config/volatilidade/security definer mudou em %.',
        _baseline.signature;
    END IF;

    IF position('_offset bigint;' IN _current_definition) = 0
      OR position('_page > 10000' IN _current_definition) > 0
      OR position('page deve estar entre 1 e 10000' IN _current_definition) > 0 THEN
      RAISE EXCEPTION 'A protecao de paginacao irrestrita regrediu em %.',
        _baseline.signature;
    END IF;
  END LOOP;

  -- Exercise the unchanged base path (minimum NULL) and the reconstructed path
  -- (minimum active). Removing only profile_ref -- and the naturally refreshed
  -- generated_at -- must reproduce the exact pre-migration payload.
  FOR _baseline IN
    SELECT scenario, payload
    FROM recurrence_profile_payload_baseline
    ORDER BY scenario
  LOOP
    _baseline_payload := _baseline.payload;
    _current_payload := public.get_customer_recurrence_report(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      DATE '2026-08-01', DATE '2026-08-13', false,
      84, 12, NULL, 'previous_period',
      CASE WHEN _baseline.scenario = 'minimum_active' THEN 2 ELSE NULL END
    );

    IF jsonb_array_length(_current_payload -> 'customers') = 0
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(_current_payload -> 'customers') AS customer
        WHERE customer ->> 'profile_ref' IS NULL
          OR customer ->> 'profile_ref' !~
            '^(reservation_holder|reservation_companion|waitlist_holder|waitlist_companion):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR customer ->> 'phone_normalized' !~ '^[0-9]{4}$'
          OR customer ->> 'guest_phone' IS NOT NULL
          OR customer ? 'crm_customer_key'
          OR customer ->> 'customer_key' LIKE 'phone:%'
      ) THEN
      RAISE EXCEPTION 'profile_ref/mascaramento invalido no cenario %: %',
        _baseline.scenario,
        _current_payload -> 'customers';
    END IF;

    SELECT jsonb_set(
      _current_payload,
      '{customers}',
      COALESCE(
        jsonb_agg(customer.value - 'profile_ref' ORDER BY customer.ordinality),
        '[]'::jsonb
      ),
      true
    )
    INTO _payload_without_profile_ref
    FROM jsonb_array_elements(_current_payload -> 'customers')
      WITH ORDINALITY AS customer(value, ordinality);

    IF (_payload_without_profile_ref #- '{meta,generated_at}')
      IS DISTINCT FROM (_baseline_payload #- '{meta,generated_at}') THEN
      RAISE EXCEPTION 'Payload fora de profile_ref mudou no cenario %.',
        _baseline.scenario;
    END IF;

    -- Every emitted reference resolves exactly once inside the same tenant and
    -- its phone still agrees with the only four digits shown by the report.
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_current_payload -> 'customers') AS customer
      CROSS JOIN LATERAL (
        SELECT
          count(*) AS matches,
          min(contact_records.phone_normalized) AS phone_normalized
        FROM public._get_crm_contact_records(
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        ) AS contact_records
        WHERE contact_records.contact_record_key = customer ->> 'profile_ref'
          AND contact_records.phone_normalized IS NOT NULL
      ) AS resolved
      WHERE resolved.matches <> 1
        OR right(resolved.phone_normalized, 4)
          IS DISTINCT FROM customer ->> 'phone_normalized'
    ) THEN
      RAISE EXCEPTION 'Uma profile_ref nao resolveu de forma exata em %.',
        _baseline.scenario;
    END IF;
  END LOOP;

  IF to_regprocedure(
      'public.get_customer_recurrence_lead_profile(uuid,text)'
    ) IS NULL
    OR has_function_privilege(
      'anon',
      'public.get_customer_recurrence_lead_profile(uuid,text)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.get_customer_recurrence_lead_profile(uuid,text)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'service_role',
      'public.get_customer_recurrence_lead_profile(uuid,text)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Assinatura ou matriz de grants da RPC de perfil invalida.';
  END IF;

  IF NOT EXISTS (
      SELECT 1
      FROM pg_proc AS procedures
      WHERE procedures.oid =
        'public.get_customer_recurrence_lead_profile(uuid,text)'::regprocedure
        AND procedures.prosecdef
        AND procedures.provolatile = 's'
        AND procedures.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
    ) THEN
    RAISE EXCEPTION 'RPC de perfil deve ser STABLE/SECURITY DEFINER com search_path fixo.';
  END IF;

  SELECT customer ->> 'profile_ref'
  INTO STRICT _profile_ref
  FROM jsonb_array_elements(_current_payload -> 'customers') AS customer
  LIMIT 1;

  SELECT contact_records.customer_key
  INTO STRICT _expected_customer_key
  FROM public._get_crm_contact_records(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ) AS contact_records
  WHERE contact_records.contact_record_key = _profile_ref
    AND contact_records.phone_normalized IS NOT NULL;

  _profile := public.get_customer_recurrence_lead_profile(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    _profile_ref
  );

  IF _profile IS NULL
    OR _profile ->> 'customer_key' IS DISTINCT FROM _expected_customer_key
    OR _profile ->> 'phone_normalized' IS NULL
    OR _profile ->> 'display_phone' IS NULL THEN
    RAISE EXCEPTION 'Perfil CRM exato nao foi retornado sob demanda: %', _profile;
  END IF;

  -- Same UUID in another tenant and a syntactically valid forged UUID both fail
  -- closed; there is no fallback by last four digits or name.
  IF public.get_customer_recurrence_lead_profile(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      _profile_ref
    ) IS NOT NULL
    OR public.get_customer_recurrence_lead_profile(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'reservation_holder:ffffffff-ffff-4fff-8fff-ffffffffffff'
    ) IS NOT NULL THEN
    RAISE EXCEPTION 'Referencia forjada ou de outra empresa resolveu indevidamente.';
  END IF;
END;
$recurrence_profile_regression$;

SELECT
  'customer recurrence lead profile regression passed'::text AS regression,
  true AS passed;
