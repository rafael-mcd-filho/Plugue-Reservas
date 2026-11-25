-- Automatic reservations use the same N:N table inventory as the panel.
-- A combination always belongs to one environment. The legacy single-table
-- selector keeps its original contract for callers that explicitly need it.

CREATE OR REPLACE FUNCTION public.pick_automatic_reservation_section(
  _company_id uuid, _date date, _time time, _party_size integer,
  _duration_minutes integer, _availability_mode text
) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _slot public.reservation_schedule_rule_slots; _section_id uuid; _map_id uuid;
BEGIN
  _slot:=public.resolve_public_reservation_section_slot(_company_id,_date,_time);
  IF NOT COALESCE(_slot.allow_section_selection,false) THEN RETURN NULL; END IF;
  IF _availability_mode='capacity' THEN
    SELECT ss.section_id INTO _section_id FROM public.reservation_schedule_rule_slot_sections ss
    WHERE ss.slot_id=_slot.id AND ss.company_id=_company_id AND ss.enabled
      AND COALESCE(ss.capacity_guests,0)>=_party_size+public.count_overlapping_reservation_section_guests(
        _company_id,_date,_time,_duration_minutes,ss.section_id,NULL)
      AND public.reservation_section_capacity_available(_company_id,_date,_time,_duration_minutes,_party_size,ss.section_id,NULL)
    ORDER BY ss.sort_order,ss.id LIMIT 1;
  ELSE
    SELECT id INTO _map_id FROM public.get_active_table_map(_company_id,(_date+_time)::timestamptz) LIMIT 1;
    SELECT ss.section_id INTO _section_id
    FROM public.reservation_schedule_rule_slot_sections ss
    CROSS JOIN LATERAL (
      SELECT public.pick_best_fit_reservation_tables(_company_id,_date,_time,_duration_minutes,
        _party_size,_map_id,NULL,ss.section_id,NULL) AS ids
    ) combination
    WHERE ss.slot_id=_slot.id AND ss.company_id=_company_id AND ss.enabled
      AND cardinality(combination.ids)>0
      AND public.reservation_section_capacity_available(_company_id,_date,_time,_duration_minutes,_party_size,ss.section_id,NULL)
    ORDER BY (SELECT sum(t.capacity) FROM public.restaurant_tables t WHERE t.id=ANY(combination.ids)),
      cardinality(combination.ids),ss.sort_order,ss.id LIMIT 1;
  END IF;
  RETURN _section_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pick_automatic_reservation_section(uuid,date,time,integer,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- Public availability and automatic panel allocation must only use offered
-- environments when the slot enables their selection. An explicit panel table
-- retains the existing exception flow, with inventory and capacity validation.
CREATE OR REPLACE FUNCTION public.pick_reservation_slot_table_combination(
  _company_id uuid, _date date, _time time, _duration_minutes integer,
  _party_size integer, _active_table_map_id uuid,
  _exclude_reservation_id uuid DEFAULT NULL, _section_id uuid DEFAULT NULL,
  _required_table_id uuid DEFAULT NULL
) RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _slot public.reservation_schedule_rule_slots; _section uuid:=_section_id; _ids uuid[];
BEGIN
  _slot:=public.resolve_public_reservation_section_slot(_company_id,_date,_time);
  IF _section IS NULL AND _required_table_id IS NULL AND COALESCE(_slot.allow_section_selection,false) THEN
    SELECT ss.section_id INTO _section
    FROM public.reservation_schedule_rule_slot_sections ss
    CROSS JOIN LATERAL (
      SELECT public.pick_best_fit_reservation_tables(_company_id,_date,_time,_duration_minutes,
        _party_size,_active_table_map_id,_exclude_reservation_id,ss.section_id,NULL) AS ids
    ) combination
    WHERE ss.slot_id=_slot.id AND ss.company_id=_company_id AND ss.enabled
      AND cardinality(combination.ids)>0
      AND public.reservation_section_capacity_available(_company_id,_date,_time,_duration_minutes,
        _party_size,ss.section_id,_exclude_reservation_id)
    ORDER BY (SELECT sum(t.capacity) FROM public.restaurant_tables t WHERE t.id=ANY(combination.ids)),
      cardinality(combination.ids),ss.sort_order,ss.id LIMIT 1;
    IF _section IS NULL THEN RETURN '{}'::uuid[]; END IF;
  END IF;
  _ids:=public.pick_best_fit_reservation_tables(_company_id,_date,_time,_duration_minutes,
    _party_size,_active_table_map_id,_exclude_reservation_id,_section,_required_table_id);
  IF cardinality(_ids)>0 THEN
    IF _section IS NULL THEN
      SELECT s.id INTO _section FROM public.restaurant_tables t
      JOIN public.table_sections s ON s.company_id=t.company_id AND s.code=t.section WHERE t.id=_ids[1];
    END IF;
    IF NOT public.reservation_section_capacity_available(_company_id,_date,_time,_duration_minutes,
      _party_size,_section,_exclude_reservation_id) THEN RETURN '{}'::uuid[]; END IF;
  END IF;
  RETURN COALESCE(_ids,'{}'::uuid[]);
END;
$$;
REVOKE ALL ON FUNCTION public.pick_reservation_slot_table_combination(uuid,date,time,integer,integer,uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.lock_reservation_table_combination(
  _company_id uuid, _date date, _time time, _duration_minutes integer,
  _party_size integer, _active_table_map_id uuid,
  _exclude_reservation_id uuid DEFAULT NULL, _section_id uuid DEFAULT NULL,
  _required_table_id uuid DEFAULT NULL
) RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _ids uuid[]; _table_id uuid; _lock_date date; _count integer; _capacity integer; _sections integer;
BEGIN
  -- The day lock precedes table locks, as in the existing capacity entry points.
  PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0));
  _ids:=public.pick_reservation_slot_table_combination(_company_id,_date,_time,_duration_minutes,
    _party_size,_active_table_map_id,_exclude_reservation_id,_section_id,_required_table_id);
  IF COALESCE(cardinality(_ids),0)=0 THEN RETURN '{}'::uuid[]; END IF;

  -- Inventory row locks coordinate across midnight and protect capacity/status.
  -- NO KEY UPDATE permits FK KEY SHARE locks from legacy writers that already
  -- hold the table advisory lock; FOR UPDATE here would create a lock cycle.
  PERFORM 1 FROM public.restaurant_tables t WHERE t.id=ANY(_ids) ORDER BY t.id FOR NO KEY UPDATE;
  FOR _table_id IN SELECT value FROM unnest(_ids) value ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-table-set|%s',_table_id::text),0));
    -- Keep the established advisory contract, including adjacent dates, for
    -- payment/legacy writers that lock by the reservation's starting date.
    FOR _lock_date IN SELECT day::date FROM generate_series((_date-1)::timestamp,
      ((_date+_time+make_interval(mins=>GREATEST(_duration_minutes,1)))::date)::timestamp,interval '1 day') day LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-table|%s|%s',_table_id::text,_lock_date::text),0));
    END LOOP;
  END LOOP;
  SELECT count(*)::integer,COALESCE(sum(t.capacity),0)::integer,count(DISTINCT COALESCE(t.section,''))::integer
  INTO _count,_capacity,_sections FROM public.restaurant_tables t
  WHERE t.id=ANY(_ids) AND t.company_id=_company_id AND t.status='available'
    AND t.table_map_id=_active_table_map_id;
  IF _count<>cardinality(_ids) OR _capacity<_party_size OR _sections<>1 THEN RETURN '{}'::uuid[]; END IF;
  IF _section_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.restaurant_tables t
    JOIN public.table_sections s ON s.company_id=t.company_id AND s.code=t.section
    WHERE t.id=ANY(_ids) AND s.id<>_section_id) THEN RETURN '{}'::uuid[]; END IF;
  IF _required_table_id IS NOT NULL AND _ids[1] IS DISTINCT FROM _required_table_id THEN RETURN '{}'::uuid[]; END IF;
  IF EXISTS(SELECT 1 FROM unnest(_ids) value WHERE public.reservation_table_conflict_id(
    _company_id,_date,_time,_duration_minutes,value,_exclude_reservation_id) IS NOT NULL) THEN
    RETURN '{}'::uuid[];
  END IF;
  RETURN _ids;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_reservation_table_combination(uuid,date,time,integer,integer,uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.persist_reservation_table_combination(_reservation_id uuid,_table_ids uuid[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _reservation public.reservations; _ids uuid[]:=COALESCE(_table_ids,'{}'::uuid[]); _count integer; _capacity integer; _sections integer;
BEGIN
  SELECT * INTO _reservation FROM public.reservations WHERE id=_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva nao encontrada para atribuir mesas.'; END IF;
  IF cardinality(_ids)=0 THEN
    IF _reservation.table_id IS NOT NULL THEN RAISE EXCEPTION 'A mesa principal deve acompanhar a atribuicao.'; END IF;
    DELETE FROM public.reservation_table_assignments WHERE reservation_id=_reservation_id;
    RETURN;
  END IF;
  IF _reservation.created_in_mode='capacity' OR _reservation.table_id IS DISTINCT FROM _ids[1]
    OR cardinality(_ids)<>(SELECT count(DISTINCT value) FROM unnest(_ids) value) THEN
    RAISE EXCEPTION 'Combinacao de mesas invalida para esta reserva.';
  END IF;
  SELECT count(*)::integer,COALESCE(sum(capacity),0)::integer,count(DISTINCT COALESCE(section,''))::integer
  INTO _count,_capacity,_sections FROM public.restaurant_tables
  WHERE id=ANY(_ids) AND company_id=_reservation.company_id AND status='available';
  IF _count<>cardinality(_ids) OR _capacity<_reservation.party_size OR _sections<>1 THEN
    RAISE EXCEPTION 'As mesas selecionadas nao comportam a reserva no mesmo ambiente.';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(_ids) value WHERE public.reservation_table_conflict_id(
    _reservation.company_id,_reservation.date,_reservation.time,
    COALESCE(_reservation.duration_minutes,30),value,_reservation.id) IS NOT NULL) THEN
    RAISE EXCEPTION 'Uma das mesas selecionadas ja esta ocupada neste horario.';
  END IF;
  DELETE FROM public.reservation_table_assignments WHERE reservation_id=_reservation_id;
  INSERT INTO public.reservation_table_assignments(reservation_id,table_id,sort_order,capacity_at_assignment,assigned_by)
  SELECT _reservation_id,selected.table_id,(selected.position-1)::integer,t.capacity,public.effective_auth_uid()
  FROM unnest(_ids) WITH ORDINALITY selected(table_id,position)
  JOIN public.restaurant_tables t ON t.id=selected.table_id ORDER BY selected.position;
END;
$$;
REVOKE ALL ON FUNCTION public.persist_reservation_table_combination(uuid,uuid[])
  FROM PUBLIC,anon,authenticated,service_role;

-- Replace only the singular-selection anchors in the deployed routines. This
-- retains their OIDs, grants, phone/birthdate, payments and attribution checks.
DO $automatic_table_combinations$
DECLARE _definition text; _anchor text; _replacement text; _start integer; _finish integer; _signature regprocedure; _count integer;
BEGIN
  _signature:='public.get_public_reservation_availability(uuid,date,integer)'::regprocedure;
  _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
  IF position('automatic_table_combination_availability' IN _definition)=0 THEN
    SELECT count(*) INTO _count FROM regexp_matches(_definition,'AND rt[.]capacity >= _party_size','g');
    IF _count<>3 THEN RAISE EXCEPTION 'Unexpected physical table-count anchors in availability: %',_count; END IF;
    _definition:=regexp_replace(_definition,E'(?m)^ *AND rt[.]capacity >= _party_size\n','','g');
    _anchor:='AND metrics.effective_available_units <= 0';
    SELECT count(*) INTO _count FROM regexp_matches(_definition,'AND metrics[.]effective_available_units <= 0','g');
    IF _count<>2 THEN RAISE EXCEPTION 'Unexpected combination availability anchors: %',_count; END IF;
    _replacement:=$patch$AND (metrics.effective_available_units <= 0
          OR cardinality(public.pick_reservation_slot_table_combination(_company_id,_date,metrics.time_slot,
            metrics.duration_minutes,_party_size,metrics.active_table_map_id,NULL,NULL,NULL))=0)$patch$;
    _definition:=replace(_definition,_anchor,_replacement);
    _definition:=replace(_definition,'WITH company AS (','WITH company AS ( -- automatic_table_combination_availability');
    EXECUTE _definition;
  END IF;

  _signature:='public.get_public_reservation_section_options(uuid,date,time,integer)'::regprocedure;
  _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
  IF position('automatic_table_combination_options' IN _definition)=0 THEN
    _anchor:=$patch$public.pick_best_fit_reservation_section_table(_company_id, _date, _time,
        COALESCE(_availability.duration_minutes, 30), _party_size, _map_id, ts.id, NULL) IS NOT NULL$patch$;
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing public section combination option anchor.'; END IF;
    _definition:=replace(_definition,_anchor,$patch$cardinality(public.pick_best_fit_reservation_tables(_company_id,_date,_time,
        COALESCE(_availability.duration_minutes,30),_party_size,_map_id,NULL,ts.id,NULL))>0 /* automatic_table_combination_options */$patch$);
    EXECUTE _definition;
  END IF;

  _signature:='public.resolve_public_reservation_section(jsonb,uuid,date,time,integer,integer,text)'::regprocedure;
  _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
  IF position('automatic_table_combination_section' IN _definition)=0 THEN
    _anchor:=$patch$_table_id := public.pick_best_fit_reservation_section_table(
      _company_id, _date, _time, _duration_minutes, _party_size, _map_id, _section_id, NULL);$patch$;
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing public section combination resolution anchor.'; END IF;
    _definition:=replace(_definition,_anchor,$patch$-- automatic_table_combination_section: primary ID remains compatible with the public payload.
    _table_id := (public.pick_best_fit_reservation_tables(
      _company_id,_date,_time,_duration_minutes,_party_size,_map_id,NULL,_section_id,NULL))[1];$patch$);
    EXECUTE _definition;
  END IF;

  _signature:='public.get_public_reservation_booking_context(uuid,date,integer)'::regprocedure;
  _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
  IF position('automatic_table_combination_context' IN _definition)=0 THEN
    _anchor:=$patch$    recommended.capacity,$patch$;
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing booking-context capacity anchor.'; END IF;
    _definition:=replace(_definition,_anchor,$patch$    recommended.capacity, -- automatic_table_combination_context$patch$);
    _start:=position('  LEFT JOIN LATERAL (' IN _definition);
    _finish:=position('  ) recommended ON true' IN _definition);
    IF _start=0 OR _finish<=_start THEN RAISE EXCEPTION 'Missing booking-context recommendation bounds.'; END IF;
    _replacement:=$patch$  LEFT JOIN LATERAL (
    SELECT primary_table.id,primary_table.number,
      (SELECT sum(t.capacity)::integer FROM public.restaurant_tables t WHERE t.id=ANY(combination.ids)) AS capacity,
      primary_table.section,primary_table.table_map_id
    FROM (SELECT public.pick_reservation_slot_table_combination(_company_id,_date,availability.time_slot,
      GREATEST(COALESCE(availability.duration_minutes,30),1),_party_size,active_map.id,NULL,NULL,NULL) AS ids) combination
    JOIN public.restaurant_tables primary_table ON primary_table.id=combination.ids[1]
    WHERE availability.available AND availability.availability_mode='tables'
$patch$;
    _definition:=substring(_definition FROM 1 FOR _start-1)||_replacement||substring(_definition FROM _finish);
    EXECUTE _definition;
  END IF;

  _signature:='public.create_public_reservation(jsonb,text)'::regprocedure;
  _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
  IF position('automatic_table_combination_public' IN _definition)=0 THEN
    _anchor:='  _active_table_map_id uuid;';
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing public combination declaration anchor.'; END IF;
    _definition:=replace(_definition,_anchor,_anchor||E'\n  _automatic_table_ids uuid[] := ''{}''::uuid[];');
    _anchor:='  _effective_max_guests_per_slot := COALESCE(';
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing public combination capacity-lock anchor.'; END IF;
    _definition:=replace(_definition,_anchor,$patch$  -- automatic_table_combination_public: share the capacity lock before checking guest limits.
  IF _availability_mode='tables' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0));
  END IF;
$patch$||_anchor);
    _start:=position('    IF _table_id IS NULL OR NOT EXISTS (' IN _definition);
    _finish:=position(E'  END IF;\n\n  INSERT INTO public.reservations (' IN _definition);
    IF _start=0 OR _finish<=_start THEN RAISE EXCEPTION 'Missing public singular table validation bounds.'; END IF;
    _replacement:=$patch$    _automatic_table_ids:=public.lock_reservation_table_combination(
      _company_id,_date,_time,_duration_minutes,_party_size,_active_table_map_id,NULL,
      NULLIF(_reservation->>'selected_section_id','')::uuid,NULL);
    _table_id:=_automatic_table_ids[1];
    IF COALESCE(cardinality(_automatic_table_ids),0)=0 THEN
      RAISE EXCEPTION 'Nao ha mesas livres no mesmo ambiente para este numero de pessoas.';
    END IF;
$patch$;
    _definition:=substring(_definition FROM 1 FOR _start-1)||_replacement||substring(_definition FROM _finish);
    _anchor:='  RETURN _created;';
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing public combination persistence anchor.'; END IF;
    _definition:=replace(_definition,_anchor,$patch$  IF _availability_mode='tables' THEN
    PERFORM public.persist_reservation_table_combination(_created.id,_automatic_table_ids);
  END IF;
$patch$||_anchor);
    EXECUTE _definition;
  END IF;

  _signature:='public.create_panel_reservation(uuid,date,time,integer,text,text,text,date,text,text,uuid,boolean,text,text)'::regprocedure;
  _definition:=replace(pg_get_functiondef(_signature),E'\r\n',E'\n');
  IF position('automatic_table_combination_panel' IN _definition)=0 THEN
    _anchor:='  _active_table_map_id uuid;';
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing panel combination declaration anchor.'; END IF;
    _definition:=replace(_definition,_anchor,_anchor||E'\n  _automatic_table_ids uuid[] := ''{}''::uuid[];');
    _anchor:='  _effective_max_guests_per_slot := COALESCE(';
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing panel combination capacity-lock anchor.'; END IF;
    _definition:=replace(_definition,_anchor,$patch$  -- automatic_table_combination_panel: serialize capacity checks before locking tables.
  IF _availability_mode='tables' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-capacity|%s|%s',_company_id::text,_date::text),0));
  END IF;
$patch$||_anchor);
    _start:=position('    IF _table_id IS NOT NULL THEN' IN _definition);
    _finish:=position(E'  END IF;\n\n  INSERT INTO public.reservations (' IN _definition);
    IF _start=0 OR _finish<=_start THEN RAISE EXCEPTION 'Missing panel singular table allocation bounds.'; END IF;
    _replacement:=$patch$    _automatic_table_ids:=public.lock_reservation_table_combination(
      _company_id,_date,_time,_duration_minutes,_party_size,_active_table_map_id,NULL,NULL,_table_id);
    _resolved_table_id:=_automatic_table_ids[1];
    IF COALESCE(cardinality(_automatic_table_ids),0)=0 THEN
      IF _table_id IS NOT NULL THEN
        RAISE EXCEPTION 'A mesa escolhida e as mesas livres do mesmo ambiente nao comportam este grupo.';
      ELSIF COALESCE(_allow_unassigned,false) THEN
        _assignment_note_value:=COALESCE(NULLIF(btrim(_assignment_note),''),'Alocar mesa depois');
      ELSE
        RAISE EXCEPTION 'Nao ha mesas livres no mesmo ambiente para este grupo. Use "alocar depois" para registrar mesmo assim.';
      END IF;
    END IF;
$patch$;
    _definition:=substring(_definition FROM 1 FOR _start-1)||_replacement||substring(_definition FROM _finish);
    _anchor:='  RETURN _created;';
    IF position(_anchor IN _definition)=0 THEN RAISE EXCEPTION 'Missing panel combination persistence anchor.'; END IF;
    _definition:=replace(_definition,_anchor,$patch$  IF _availability_mode='tables' THEN
    PERFORM public.persist_reservation_table_combination(_created.id,_automatic_table_ids);
  END IF;
$patch$||_anchor);
    EXECUTE _definition;
  END IF;
END;
$automatic_table_combinations$;
