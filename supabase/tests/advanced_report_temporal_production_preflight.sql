-- Production-safe catalog preflight for the temporal advanced-report release.
--
-- Run only after all seven 20260827 migrations have been applied. This script
-- reads catalog metadata, assumes no fixture IDs or business totals and always
-- rolls back. Functional scenarios belong to the PGlite-only regression suite.

BEGIN READ ONLY;

SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

DO $rpc_catalog_contract$
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

    IF _row.prorettype <> 'jsonb'::regtype
      OR _row.provolatile <> 's'
      OR NOT _row.prosecdef
      OR _row.pronargdefaults <> _expected_defaults[_position]
      OR NOT COALESCE(
        _row.proconfig @> ARRAY['search_path=public, pg_temp']::text[],
        false
      ) THEN
      RAISE EXCEPTION 'Contrato de funcao invalido em %.', _signature;
    END IF;

    IF has_function_privilege('anon', _procedure::oid, 'EXECUTE')
      OR NOT has_function_privilege('authenticated', _procedure::oid, 'EXECUTE')
      OR NOT has_function_privilege('service_role', _procedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'ACL invalida em %.', _signature;
    END IF;

    _definition := pg_get_functiondef(_procedure);
    IF _definition ~* '\m(INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM|MERGE[[:space:]]+INTO|TRUNCATE)\M' THEN
      RAISE EXCEPTION '% deixou de ser somente leitura.', _signature;
    END IF;
    IF _definition ~* '(meta_event_queue|process_meta_event|facebook_capi|conversion_api)' THEN
      RAISE EXCEPTION '% passou a depender do pipeline Meta.', _signature;
    END IF;
  END LOOP;
END;
$rpc_catalog_contract$;

DO $crm_helper_contract$
DECLARE
  _helper constant regprocedure :=
    'public._get_crm_contact_records(uuid)'::regprocedure;
  _definition text := pg_get_functiondef(_helper);
  _time_zone_lookups integer;
BEGIN
  IF has_function_privilege('anon', _helper::oid, 'EXECUTE')
    OR has_function_privilege('authenticated', _helper::oid, 'EXECUTE')
    OR has_function_privilege('service_role', _helper::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'O helper interno de CRM possui EXECUTE indevido.';
  END IF;

  _time_zone_lookups := (
    length(_definition)
      - length(replace(
        _definition,
        'public._company_report_time_zone(_company_id)',
        ''
      ))
  ) / length('public._company_report_time_zone(_company_id)');

  IF position('report_context AS MATERIALIZED' IN _definition) = 0
    OR _time_zone_lookups <> 1 THEN
    RAISE EXCEPTION 'O helper de CRM nao materializa um unico fuso por chamada.';
  END IF;
END;
$crm_helper_contract$;

DO $index_contract$
DECLARE
  _expected constant text[] := ARRAY[
    'idx_waitlist_company_seated_event',
    'idx_waitlist_company_expired_event',
    'idx_waitlist_company_removed_event'
  ];
  _index_name text;
  _ready boolean;
  _valid boolean;
BEGIN
  FOREACH _index_name IN ARRAY _expected LOOP
    SELECT indexes.indisready, indexes.indisvalid
    INTO _ready, _valid
    FROM pg_index AS indexes
    JOIN pg_class AS index_class ON index_class.oid = indexes.indexrelid
    JOIN pg_namespace AS namespaces ON namespaces.oid = index_class.relnamespace
    WHERE namespaces.nspname = 'public'
      AND index_class.relname = _index_name;

    IF NOT FOUND OR NOT _ready OR NOT _valid THEN
      RAISE EXCEPTION 'Indice ausente ou invalido: %.', _index_name;
    END IF;
  END LOOP;
END;
$index_contract$;

ROLLBACK;
