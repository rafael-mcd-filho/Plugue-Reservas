-- Post-migration contract for the four temporal advanced-report RPCs.
--
-- Run only against a fully migrated local Supabase database. The transaction is
-- READ ONLY, has strict timeouts and always rolls back. It verifies the catalog,
-- ACLs, access gates and zero-data response invariants without changing fixtures.

BEGIN READ ONLY;

SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

DO $catalog_contract$
DECLARE
  _signatures constant text[] := ARRAY[
    'public.get_demand_temporal_analysis(uuid,date,date,text)',
    'public.get_occupancy_waitlist_series(uuid,date,date,text)',
    'public.get_attendance_outcome_series(uuid,date,date,text,text,text)',
    'public.get_customer_recurrence_visit_series(uuid,date,date,text,boolean)'
  ];
  _expected_defaults constant integer[] := ARRAY[1, 1, 3, 2];
  _signature text;
  _procedure regprocedure;
  _definition text;
  _position integer;
  _row pg_proc%ROWTYPE;
BEGIN
  FOR _position IN 1..array_length(_signatures, 1) LOOP
    _signature := _signatures[_position];
    _procedure := to_regprocedure(_signature);

    IF _procedure IS NULL THEN
      RAISE EXCEPTION 'RPC ausente ou com assinatura incorreta: %', _signature;
    END IF;

    SELECT * INTO STRICT _row FROM pg_proc WHERE oid = _procedure;

    IF _row.prorettype <> 'jsonb'::regtype THEN
      RAISE EXCEPTION '% deve retornar jsonb.', _signature;
    END IF;
    IF _row.provolatile <> 's' THEN
      RAISE EXCEPTION '% deve ser STABLE.', _signature;
    END IF;
    IF NOT _row.prosecdef THEN
      RAISE EXCEPTION '% deve ser SECURITY DEFINER.', _signature;
    END IF;
    IF _row.pronargdefaults <> _expected_defaults[_position] THEN
      RAISE EXCEPTION
        '% possui % argumentos default; esperado: %.',
        _signature,
        _row.pronargdefaults,
        _expected_defaults[_position];
    END IF;
    IF NOT COALESCE(
      _row.proconfig @> ARRAY['search_path=public, pg_temp']::text[],
      false
    ) THEN
      RAISE EXCEPTION '% nao fixa search_path em public, pg_temp.', _signature;
    END IF;

    IF has_function_privilege('anon', _procedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon recebeu EXECUTE indevido em %.', _signature;
    END IF;
    IF NOT has_function_privilege('authenticated', _procedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated nao possui EXECUTE em %.', _signature;
    END IF;
    IF NOT has_function_privilege('service_role', _procedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role nao possui EXECUTE em %.', _signature;
    END IF;

    _definition := pg_get_functiondef(_procedure);
    IF _definition ~* '\m(INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM|MERGE[[:space:]]+INTO|TRUNCATE)\M' THEN
      RAISE EXCEPTION '% deixou de ser somente leitura.', _signature;
    END IF;
    IF _definition ~* '(meta_event_queue|process_meta_event|facebook_capi|conversion_api)' THEN
      RAISE EXCEPTION '% passou a depender do pipeline da Meta.', _signature;
    END IF;
  END LOOP;
END;
$catalog_contract$;

-- Even a caller connected as postgres must be rejected by the application gate
-- when the JWT claims represent an anonymous user.
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $anonymous_gate$
DECLARE
  _company_id uuid;
BEGIN
  SELECT companies.id
  INTO _company_id
  FROM public.companies
  ORDER BY companies.created_at, companies.id
  LIMIT 1;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'O banco local precisa conter ao menos uma empresa para o teste.';
  END IF;

  BEGIN
    PERFORM public.get_demand_temporal_analysis(
      _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day'
    );
    RAISE EXCEPTION 'anon acessou get_demand_temporal_analysis.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_occupancy_waitlist_series(
      _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day'
    );
    RAISE EXCEPTION 'anon acessou get_occupancy_waitlist_series.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_attendance_outcome_series(
      _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day', 'all', 'all'
    );
    RAISE EXCEPTION 'anon acessou get_attendance_outcome_series.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_customer_recurrence_visit_series(
      _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day', false
    );
    RAISE EXCEPTION 'anon acessou get_customer_recurrence_visit_series.';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$anonymous_gate$;

-- service_role exercises the response contracts without requiring a test user.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $response_contract$
DECLARE
  _company_id uuid;
  _payload jsonb;
  _row jsonb;
BEGIN
  SELECT companies.id
  INTO _company_id
  FROM public.companies
  ORDER BY companies.created_at, companies.id
  LIMIT 1;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'O banco local precisa conter ao menos uma empresa para o teste.';
  END IF;

  _payload := public.get_demand_temporal_analysis(
    _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day'
  );
  IF jsonb_typeof(_payload) <> 'object'
    OR jsonb_array_length(_payload -> 'entry_mode_created_trend') <> 1
    OR jsonb_array_length(_payload -> 'entry_mode_visit_trend') <> 1
    OR jsonb_array_length(_payload -> 'lead_time_trend') <> 1
    OR _payload #>> '{meta,period_start}' <> '1900-01-01'
    OR _payload #>> '{meta,period_end}' <> '1900-01-01'
    OR _payload #>> '{meta,granularity}' <> 'day' THEN
    RAISE EXCEPTION 'Contrato estrutural invalido em demanda: %', _payload;
  END IF;
  _row := _payload #> '{entry_mode_created_trend,0}';
  IF (_row ->> 'online_reservations')::bigint <> 0
    OR (_row ->> 'affiliate_reservations')::bigint <> 0
    OR (_row ->> 'manual_reservations')::bigint <> 0
    OR (_row ->> 'waitlist_reservations')::bigint <> 0 THEN
    RAISE EXCEPTION 'Demanda nao zerou um periodo sem dados: %', _row;
  END IF;

  _payload := public.get_occupancy_waitlist_series(
    _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day'
  );
  _row := _payload #> '{series,0}';
  IF jsonb_typeof(_payload) <> 'object'
    OR jsonb_array_length(_payload -> 'series') <> 1
    OR _payload #>> '{meta,event_semantics}' <> 'event_timestamp'
    OR (_row ->> 'entries')::bigint <> 0
    OR (_row ->> 'seated')::bigint <> 0
    OR (_row ->> 'dropped')::bigint <> 0
    OR (_row ->> 'average_wait_minutes')::numeric <> 0 THEN
    RAISE EXCEPTION 'Contrato/invariante invalido em ocupacao: %', _payload;
  END IF;

  _payload := public.get_attendance_outcome_series(
    _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day', 'all', 'all'
  );
  _row := _payload #> '{series,0}';
  IF jsonb_typeof(_payload) <> 'object'
    OR jsonb_array_length(_payload -> 'series') <> 1
    OR _payload #>> '{meta,attendance_rate_formula}' <> 'attended / (attended + no_show)'
    OR (_row ->> 'reservations')::integer <> 0
    OR (_row ->> 'reserved_people')::integer <> 0
    OR (_row ->> 'lost_people')::integer <> 0
    OR (_row ->> 'attendance_rate')::numeric <> 0
    OR (_row ->> 'realized_reservation_rate')::numeric <> 0 THEN
    RAISE EXCEPTION 'Contrato/invariante invalido em comparecimento: %', _payload;
  END IF;

  _payload := public.get_customer_recurrence_visit_series(
    _company_id, DATE '1900-01-01', DATE '1900-01-01', 'day', false
  );
  _row := _payload #> '{series,0}';
  IF jsonb_typeof(_payload) <> 'object'
    OR jsonb_array_length(_payload -> 'series') <> 1
    OR _payload #>> '{meta,visit_definition}' <> 'canonical_attended_visit'
    OR (_row ->> 'total_visits')::bigint <> 0
    OR (_row ->> 'first_visits')::bigint <> 0
    OR (_row ->> 'return_visits')::bigint <> 0
    OR (_row ->> 'return_visit_rate')::numeric <> 0 THEN
    RAISE EXCEPTION 'Contrato/invariante invalido em recorrencia: %', _payload;
  END IF;
END;
$response_contract$;

DO $functional_series$
DECLARE
  _company_id constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  _payload jsonb;
  _day_one jsonb;
  _day_two jsonb;
  _filtered jsonb;
BEGIN
  _payload := public.get_demand_temporal_analysis(
    _company_id, DATE '2026-08-01', DATE '2026-08-03', 'day'
  );

  SELECT item INTO _day_one
  FROM jsonb_array_elements(_payload -> 'entry_mode_created_trend') AS item
  WHERE item ->> 'period' = '2026-08-01';

  SELECT item INTO _day_two
  FROM jsonb_array_elements(_payload -> 'entry_mode_created_trend') AS item
  WHERE item ->> 'period' = '2026-08-02';

  IF (_day_one ->> 'online_reservations')::integer <> 1
    OR (_day_one ->> 'online_people')::integer <> 2
    OR (_day_one ->> 'manual_reservations')::integer <> 1
    OR (_day_one ->> 'manual_people')::integer <> 4
    OR (_day_two ->> 'waitlist_reservations')::integer <> 1
    OR (_day_two ->> 'affiliate_reservations')::integer <> 1
    OR _payload #>> '{meta,time_zone}' <> 'America/Manaus' THEN
    RAISE EXCEPTION 'Demanda nao agrupou captacao/origem no fuso esperado: %', _payload;
  END IF;

  SELECT item INTO _day_one
  FROM jsonb_array_elements(_payload -> 'lead_time_trend') AS item
  WHERE item ->> 'period' = '2026-08-01';

  SELECT item INTO _day_two
  FROM jsonb_array_elements(_payload -> 'lead_time_trend') AS item
  WHERE item ->> 'period' = '2026-08-02';

  IF (_day_one ->> 'scheduled_reservations')::integer <> 2
    OR (_day_one ->> 'same_day_reservations')::integer <> 1
    OR (_day_one ->> 'average_lead_days')::numeric <> 0.5
    OR (_day_one ->> 'same_day_rate')::numeric <> 50.0
    OR (_day_two ->> 'scheduled_reservations')::integer <> 1
    OR (_day_two ->> 'average_lead_days')::numeric <> 1.0 THEN
    RAISE EXCEPTION 'Antecedencia incluiu fila ou calculou buckets incorretos: %', _payload;
  END IF;

  SELECT item INTO _day_two
  FROM jsonb_array_elements(_payload -> 'entry_mode_visit_trend') AS item
  WHERE item ->> 'period' = '2026-08-02';

  IF (_day_two ->> 'online_reservations')::integer <> 1
    OR (_day_two ->> 'waitlist_reservations')::integer <> 1 THEN
    RAISE EXCEPTION 'Demanda por data da visita ficou inconsistente: %', _payload;
  END IF;

  _payload := public.get_attendance_outcome_series(
    _company_id, DATE '2026-08-01', DATE '2026-08-02', 'day', 'all', 'all'
  );
  _day_one := _payload #> '{series,0}';
  _day_two := _payload #> '{series,1}';

  IF (_day_one ->> 'reservations')::integer <> 4
    OR (_day_one ->> 'attended')::integer <> 1
    OR (_day_one ->> 'no_show')::integer <> 1
    OR (_day_one ->> 'cancelled')::integer <> 1
    OR (_day_one ->> 'scheduled')::integer <> 1
    OR (_day_one ->> 'reserved_people')::integer <> 12
    OR (_day_one ->> 'attended_people')::integer <> 3
    OR (_day_one ->> 'lost_people')::integer <> 7
    OR (_day_one ->> 'attendance_rate')::numeric <> 50.0
    OR (_day_one ->> 'realized_reservation_rate')::numeric <> 25.0
    OR (_day_one ->> 'realized_people_rate')::numeric <> 25.0
    OR (_day_two ->> 'reservations')::integer <> 0 THEN
    RAISE EXCEPTION 'Comparecimento calculou resultados/taxas incorretos: %', _payload;
  END IF;

  _filtered := public.get_attendance_outcome_series(
    _company_id, DATE '2026-08-01', DATE '2026-08-01', 'day', 'attended', 'online'
  );
  IF (_filtered #>> '{series,0,reservations}')::integer <> 1
    OR (_filtered #>> '{series,0,attended}')::integer <> 1
    OR (_filtered #>> '{series,0,reserved_people}')::integer <> 4 THEN
    RAISE EXCEPTION 'Filtros de comparecimento nao foram aplicados: %', _filtered;
  END IF;
END;
$functional_series$;

DO $invalid_parameters$
DECLARE
  _company_id uuid;
BEGIN
  SELECT companies.id
  INTO STRICT _company_id
  FROM public.companies
  ORDER BY companies.created_at, companies.id
  LIMIT 1;

  BEGIN
    PERFORM public.get_demand_temporal_analysis(
      _company_id, DATE '2026-01-01', DATE '2026-01-01', 'hour'
    );
    RAISE EXCEPTION 'Demanda aceitou granularidade invalida.';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_occupancy_waitlist_series(
      _company_id, DATE '2026-01-01', DATE '2026-01-01', 'hour'
    );
    RAISE EXCEPTION 'Ocupacao aceitou granularidade invalida.';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_attendance_outcome_series(
      _company_id, DATE '2026-01-01', DATE '2026-01-01', 'hour', 'all', 'all'
    );
    RAISE EXCEPTION 'Comparecimento aceitou granularidade invalida.';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.get_customer_recurrence_visit_series(
      _company_id, DATE '2026-01-01', DATE '2026-01-01', 'hour', false
    );
    RAISE EXCEPTION 'Recorrencia aceitou granularidade invalida.';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$invalid_parameters$;

ROLLBACK;
