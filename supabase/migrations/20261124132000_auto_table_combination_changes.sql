-- Keep automatically combined tables coherent when the reservation changes.
-- Existing contact-only edits, customer-change restrictions, payment protection,
-- queue handling, receipts and contracted environments remain in their RPCs.
DO $patch_combination_changes$
DECLARE
  _signature regprocedure;
  _definition text;
  _anchor text;
  _start integer;
  _finish integer;
BEGIN
  _signature := to_regprocedure('public.update_panel_reservation(uuid,date,time,integer,text,text,text,text,text,uuid,boolean,boolean,text)');
  IF _signature IS NOT NULL THEN
    _definition := replace(pg_get_functiondef(_signature), E'\r\n', E'\n');
    IF position('auto_table_combination_panel_changes' IN _definition) = 0 THEN
      _anchor := '  _candidate_table_id uuid;';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing panel combination declaration anchor.'; END IF;
      _definition := replace(_definition, _anchor, _anchor || E'\n  -- auto_table_combination_panel_changes\n  _combination_table_ids uuid[] := ARRAY[]::uuid[];\n  _old_multi_table_sync text := current_setting(''app.multi_table_sync'',true);');
      _start := position('    -- Mesa candidata: escolha explicita, senao mesa atual (se _keep_table).' IN _definition);
      _finish := position(E'\n  END IF;\n\n  UPDATE public.reservations\n  SET\n    guest_name = _normalized_name,' IN _definition);
      IF _start = 0 OR _finish <= _start THEN RAISE EXCEPTION 'Missing panel combination selection anchors.'; END IF;
      _definition := substr(_definition, 1, _start - 1) || $panel_selection$
    -- Preserve an explicitly requested primary table. Otherwise try keeping
    -- the current primary, then choose another fitting set in the same section.
    _candidate_table_id := COALESCE(_table_id,
      CASE WHEN COALESCE(_keep_table,true) THEN _reservation.table_id ELSE NULL END);
    IF _candidate_table_id IS NOT NULL THEN
      _combination_table_ids := public.lock_reservation_table_combination(
        _reservation.company_id,_date,_time,_duration_minutes,_party_size,
        _active_table_map_id,_reservation_id,_reservation.selected_section_id,_candidate_table_id);
    END IF;
    IF cardinality(_combination_table_ids) = 0 AND _table_id IS NOT NULL THEN
      RAISE EXCEPTION 'Mesa indisponivel para este horario.';
    END IF;
    IF cardinality(_combination_table_ids) = 0 THEN
      _combination_table_ids := public.lock_reservation_table_combination(
        _reservation.company_id,_date,_time,_duration_minutes,_party_size,
        _active_table_map_id,_reservation_id,_reservation.selected_section_id,NULL);
    END IF;
    _resolved_table_id := _combination_table_ids[1];
    IF _resolved_table_id IS NULL THEN
      IF COALESCE(_allow_unassigned,false) THEN
        _assignment_note_value := COALESCE(NULLIF(btrim(_assignment_note),''),
          _reservation.table_assignment_note,'Alocar mesa depois');
      ELSE
        RAISE EXCEPTION 'Nenhuma combinacao de mesas disponivel para este horario. Use "alocar depois" para registrar mesmo assim.';
      END IF;
    END IF;
$panel_selection$ || substr(_definition, _finish);

      _anchor := E'  UPDATE public.reservations\n  SET\n    guest_name = _normalized_name,';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing panel combination update anchor.'; END IF;
      _definition := replace(_definition, _anchor,
        E'  PERFORM set_config(''app.multi_table_sync'',''rpc'',true);\n' || _anchor);
      _anchor := E'  RETURN _updated;\nEND;';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing panel combination persistence anchor.'; END IF;
      _definition := replace(_definition, _anchor,
        E'  PERFORM public.persist_reservation_table_combination(_updated.id,_combination_table_ids);\n  PERFORM set_config(''app.multi_table_sync'',COALESCE(_old_multi_table_sync,''''),true);\n\n' || _anchor);
      EXECUTE _definition;
    END IF;
    -- Acquire the day-capacity lock before reading either guest or arrival
    -- quotas. Locking only later, while choosing tables, would let edits at
    -- overlapping slots both pass a stale global guest-limit check.
    IF position('auto_table_combination_panel_capacity_lock' IN _definition) = 0 THEN
      _anchor := '  _effective_max_guests_per_slot := COALESCE(';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing panel change combination capacity-lock anchor.'; END IF;
      _definition := replace(_definition, _anchor, $panel_capacity_lock$
  -- auto_table_combination_panel_capacity_lock
  IF _availability_mode='tables' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('reservation-capacity|%s|%s',_reservation.company_id::text,_date::text),0));
  END IF;
$panel_capacity_lock$ || _anchor);
      EXECUTE _definition;
    END IF;
  END IF;

  _signature := to_regprocedure('public._public_reservation_change_slot(uuid,date,time,integer)');
  IF _signature IS NOT NULL THEN
    _definition := replace(pg_get_functiondef(_signature), E'\r\n', E'\n');
    IF position('auto_table_combination_public_change_slot' IN _definition) = 0 THEN
      _anchor := '  _max_guests integer; _map_id uuid; _table_id uuid; _reason text;';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public change combination declaration anchor.'; END IF;
      _definition := replace(_definition, _anchor, _anchor || E'\n  -- auto_table_combination_public_change_slot\n  _combination_table_ids uuid[] := ARRAY[]::uuid[];');
      _start := position('      -- reservation_section_public_change:' IN _definition);
      IF _start = 0 THEN
        _start := position('      _table_id := public.pick_best_fit_reservation_table(_entry.company_id,_date,_time,' IN _definition);
      END IF;
      _anchor := E'      IF _table_id IS NULL THEN _reason := ''full''; END IF;';
      _finish := position(_anchor IN _definition);
      IF _start = 0 OR _finish <= _start THEN RAISE EXCEPTION 'Missing public change combination selection anchors.'; END IF;
      _definition := substr(_definition, 1, _start - 1) || $change_selection$
      _combination_table_ids := public.pick_best_fit_reservation_tables(
        _entry.company_id,_date,_time,_duration,_party_size,_map_id,
        _entry.id,_entry.selected_section_id,NULL);
      _table_id := _combination_table_ids[1];
$change_selection$ || substr(_definition, _finish);
      _anchor := E'    ''table_id'',_table_id,''rule_id'',_schedule.rule_id,';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public change combination result anchor.'; END IF;
      _definition := replace(_definition, _anchor,
        E'    ''table_id'',_table_id,''table_ids'',to_jsonb(_combination_table_ids),\n    ''table_map_id'',_map_id,''rule_id'',_schedule.rule_id,');
      EXECUTE _definition;
    END IF;
  END IF;

  _signature := to_regprocedure('public.change_public_reservation(text,text,date,time,integer,timestamptz,uuid)');
  IF _signature IS NOT NULL THEN
    _definition := replace(pg_get_functiondef(_signature), E'\r\n', E'\n');
    IF position('auto_table_combination_public_changes' IN _definition) = 0 THEN
      _anchor := E'  _lock_date date; _old_audit_context text := current_setting(''app.public_reservation_change'',true);';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public combination change declaration anchor.'; END IF;
      _definition := replace(_definition, _anchor, _anchor || E'\n  -- auto_table_combination_public_changes\n  _combination_table_ids uuid[] := ARRAY[]::uuid[];\n  _rechecked_table_ids uuid[] := ARRAY[]::uuid[];\n  _old_multi_table_sync text := current_setting(''app.multi_table_sync'',true);');
      _anchor := E'  IF _table_id IS NOT NULL THEN\n    PERFORM 1 FROM public.restaurant_tables WHERE id=_table_id FOR SHARE;\n    PERFORM pg_advisory_xact_lock(hashtextextended(format(''reservation-table|%s|%s'',_table_id,_date),0));\n  END IF;';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public combination change locking anchor.'; END IF;
      _definition := replace(_definition, _anchor, $change_locks$
  IF COALESCE(_slot->>'availability_mode','tables') <> 'capacity' THEN
    _combination_table_ids := public.lock_reservation_table_combination(
      _entry.company_id,_date,_time,(_slot->>'duration_minutes')::integer,_party_size,
      NULLIF(_slot->>'table_map_id','')::uuid,_entry.id,_entry.selected_section_id,NULL);
    _table_id := _combination_table_ids[1];
  END IF;
$change_locks$);
      _anchor := E'    IF _reason IS NULL AND (_slot->>''table_id'')::uuid IS DISTINCT FROM _table_id THEN _reason := ''full''; END IF;';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public combination change recheck anchor.'; END IF;
      _definition := replace(_definition, _anchor, $change_recheck$
    SELECT COALESCE(array_agg(value::uuid ORDER BY ordinality),ARRAY[]::uuid[])
    INTO _rechecked_table_ids
    FROM jsonb_array_elements_text(COALESCE(_slot->'table_ids','[]'::jsonb)) WITH ORDINALITY ids(value,ordinality);
    IF _reason IS NULL AND (_rechecked_table_ids IS DISTINCT FROM _combination_table_ids
      OR NULLIF(_slot->>'table_id','')::uuid IS DISTINCT FROM _table_id) THEN _reason := 'full'; END IF;
$change_recheck$);
      _anchor := E'  UPDATE public.reservations SET date=_date,time=_time,party_size=_party_size,table_id=_table_id,';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public combination change update anchor.'; END IF;
      _definition := replace(_definition, _anchor,
        E'  PERFORM set_config(''app.multi_table_sync'',''rpc'',true);\n' || _anchor);
      _anchor := E'  PERFORM set_config(''app.public_reservation_change'',COALESCE(_old_audit_context,''''),true);';
      IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Missing public combination change persistence anchor.'; END IF;
      _definition := replace(_definition, _anchor,
        E'  PERFORM public.persist_reservation_table_combination(_updated.id,_combination_table_ids);\n  PERFORM set_config(''app.multi_table_sync'',COALESCE(_old_multi_table_sync,''''),true);\n' || _anchor);
      EXECUTE _definition;
    END IF;
  END IF;
END;
$patch_combination_changes$;
