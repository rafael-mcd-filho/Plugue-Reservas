-- Explicit maintenance tools; nothing invokes these as part of a deploy.
CREATE OR REPLACE FUNCTION public.report_international_phone_migration(
  _table_name text, _raw_column text, _limit integer DEFAULT 1000, _after uuid DEFAULT NULL
)
RETURNS TABLE (
  row_id uuid, raw_phone text, current_e164 text, proposed_e164 text,
  proposed_country text, previous_identity text, migration_status text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _e164 text := _raw_column || '_e164'; _country text := _raw_column || '_country'; _input text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Somente service_role pode inspecionar a migracao.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public._international_phone_targets() t
    WHERE t.table_name = _table_name AND t.raw_column = _raw_column)
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = _table_name AND column_name = _e164)
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = _table_name AND column_name = 'id' AND udt_name = 'uuid') THEN
    RAISE EXCEPTION 'Destino de migracao invalido.' USING ERRCODE = '22023';
  END IF;
  IF _limit IS NULL OR _limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Lote deve conter entre 1 e 10000 registros.' USING ERRCODE = '22023';
  END IF;
  _input := CASE WHEN _table_name = 'crm_leads' AND _raw_column = 'phone'
    THEN 'COALESCE(NULLIF(btrim(phone), ''''), NULLIF(btrim(phone_normalized), ''''))'
    ELSE quote_ident(_raw_column) END;
  RETURN QUERY EXECUTE format($query$
    SELECT id, %1$I, %2$I, public.phone_to_e164(%5$s, COALESCE(%3$I, 'BR')),
      COALESCE(%3$I, public.phone_e164_default_country(public.phone_to_e164(%5$s, COALESCE(%3$I, 'BR')))),
      CASE WHEN regexp_replace(COALESCE(%5$s, ''), '\D', '', 'g') = '' THEN NULL
        WHEN regexp_replace(%5$s, '\D', '', 'g') !~ '^55' AND length(regexp_replace(%5$s, '\D', '', 'g')) <= 11
          THEN '55' || regexp_replace(%5$s, '\D', '', 'g')
        ELSE regexp_replace(%5$s, '\D', '', 'g') END,
      CASE WHEN %2$I IS NOT NULL THEN 'already_set'
        WHEN NULLIF(btrim(%5$s), '') IS NULL THEN 'empty'
        WHEN public.phone_to_e164(%5$s, COALESCE(%3$I, 'BR')) IS NULL THEN 'review_required'
        ELSE 'ready' END
    FROM public.%4$I WHERE ($1 IS NULL OR id > $1) ORDER BY id LIMIT $2
  $query$, _raw_column, _e164, _country, _table_name, _input) USING _after, _limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.preserve_phone_backfill_timestamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE _keys text[];
BEGIN
  IF current_setting('app.phone_backfill', true) = 'on' AND to_jsonb(NEW) ? 'updated_at' THEN
    SELECT array_agg(column_name) INTO _keys FROM (
      SELECT raw_column || '_e164' AS column_name FROM public._international_phone_targets() WHERE table_name = TG_TABLE_NAME
      UNION ALL SELECT raw_column || '_country' FROM public._international_phone_targets() WHERE table_name = TG_TABLE_NAME
      UNION ALL SELECT 'updated_at'
    ) columns_to_ignore;
    IF (to_jsonb(NEW) - _keys) = (to_jsonb(OLD) - _keys) THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('updated_at', to_jsonb(OLD)->'updated_at'));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $migration$
DECLARE _table text;
BEGIN
  FOR _table IN SELECT DISTINCT t.table_name FROM public._international_phone_targets() t
    JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS z_preserve_phone_backfill_timestamp ON public.%I', _table);
    EXECUTE format('CREATE TRIGGER z_preserve_phone_backfill_timestamp BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.preserve_phone_backfill_timestamp()', _table);
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.backfill_international_phone_batch(
  _table_name text, _raw_column text, _limit integer DEFAULT 1000, _after uuid DEFAULT NULL
)
RETURNS TABLE(updated_rows integer, last_scanned_id uuid, scanned_rows integer, review_required_rows integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _previous_flag text := current_setting('app.phone_backfill', true); _report jsonb; _input text;
BEGIN
  -- report enforces role, fixed target allowlist, and batch limits before any write.
  SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO _report
    FROM public.report_international_phone_migration(_table_name, _raw_column, _limit, _after) r;
  scanned_rows := jsonb_array_length(_report);
  SELECT max(value->>'row_id')::uuid, count(*) FILTER (WHERE value->>'migration_status' = 'review_required')::integer
    INTO last_scanned_id, review_required_rows FROM jsonb_array_elements(_report);
  PERFORM set_config('app.phone_backfill', 'on', true);
  _input := CASE WHEN _table_name = 'crm_leads' AND _raw_column = 'phone'
    THEN 'COALESCE(NULLIF(btrim(t.phone), ''''), NULLIF(btrim(t.phone_normalized), ''''))'
    ELSE format('t.%I', _raw_column) END;
  EXECUTE format($query$
    UPDATE public.%1$I t SET %2$I = r.proposed_e164, %3$I = r.proposed_country
    FROM jsonb_to_recordset($1) AS r(row_id uuid, proposed_e164 text, proposed_country text, migration_status text)
    WHERE t.id = r.row_id AND r.migration_status = 'ready' AND t.%2$I IS NULL
      AND public.phone_to_e164(%4$s, COALESCE(t.%3$I, 'BR')) = r.proposed_e164
  $query$, _table_name, _raw_column || '_e164', _raw_column || '_country', _input) USING _report;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  PERFORM set_config('app.phone_backfill', COALESCE(_previous_flag, ''), true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.phone_backfill', COALESCE(_previous_flag, ''), true);
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.report_international_phone_migration(text, text, integer, uuid),
  public.backfill_international_phone_batch(text, text, integer, uuid),
  public.preserve_phone_backfill_timestamp() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_international_phone_migration(text, text, integer, uuid),
  public.backfill_international_phone_batch(text, text, integer, uuid) TO service_role;

COMMENT ON FUNCTION public.backfill_international_phone_batch(text, text, integer, uuid) IS
  'Manual additive backfill only after dry-run and trigger/webhook review. Never changes raw, phone_normalized, customer keys, queue status, attempts, dispatch keys, or delivery history; preserves updated_at.';
