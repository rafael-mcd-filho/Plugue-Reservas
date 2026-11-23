-- PUB-01: optional customer changes. Local migration only; no company is opted in.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS public_reservation_changes_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_reservation_change_min_notice_minutes integer NOT NULL DEFAULT 120;
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_public_change_notice_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_public_change_notice_check
  CHECK (public_reservation_change_min_notice_minutes BETWEEN 0 AND 10080);

-- Opted-in companies serialize every normal capacity-changing entry point on
-- the same day lock. In table mode, different arrival slots can still overlap
-- and share a max_guests_per_slot limit. A slot/table lock alone is insufficient.
-- Keep deployed policies and the exact legacy lock behavior while the option is
-- off. Patch the active definitions (including intervening phone/full-slot fixes).
DO $capacity_locks$
DECLARE _signature regprocedure; _definition text; _before text; _anchor text;
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public.create_public_reservation(jsonb,text)'::regprocedure,
    'public.create_panel_reservation(uuid,date,time,integer,text,text,text,date,text,text,uuid,boolean,text,text)'::regprocedure,
    'public.update_panel_reservation(uuid,date,time,integer,text,text,text,text,text,uuid,boolean,boolean,text)'::regprocedure
  ] LOOP
    _definition := replace(pg_get_functiondef(_signature), E'\r\n', E'\n');
    IF position('public_reservation_changes_capacity_lock' IN _definition) = 0 THEN
      _before := _definition;
      _anchor := E'  IF _availability_mode = ''capacity'' THEN\n    PERFORM pg_advisory_xact_lock(\n      hashtextextended(format(''reservation-capacity|%s|%s'', ';
      _definition := replace(_definition, _anchor,
        E'  -- public_reservation_changes_capacity_lock: same slot -> day -> table order.\n  IF _availability_mode = ''capacity'' OR COALESCE(_company.public_reservation_changes_enabled, false) THEN\n    PERFORM pg_advisory_xact_lock(\n      hashtextextended(format(''reservation-capacity|%s|%s'', ');
      IF _definition = _before THEN RAISE EXCEPTION 'Missing reservation capacity lock anchor: %', _signature; END IF;
      EXECUTE _definition;
    END IF;
  END LOOP;

  _signature := 'public.seat_waitlist_entry(uuid,integer,jsonb,text,text,text,text)'::regprocedure;
  _definition := replace(pg_get_functiondef(_signature), E'\r\n', E'\n');
  IF position('public_reservation_changes_capacity_lock' IN _definition) = 0 THEN
    _before := _definition;
    _anchor := E'  IF _availability_mode = ''tables'' THEN\n    PERFORM pg_advisory_xact_lock(';
    _definition := replace(_definition, _anchor,
      E'  -- public_reservation_changes_capacity_lock: preserve walk-in override; serialize only.\n  IF EXISTS (SELECT 1 FROM public.companies c WHERE c.id = _updated.company_id AND c.public_reservation_changes_enabled) THEN\n    PERFORM pg_advisory_xact_lock(hashtextextended(format(''reservation-slot|%s|%s|%s'', _updated.company_id::text, _reservation_date_value::text, _reservation_time_value::text), 0));\n    PERFORM pg_advisory_xact_lock(hashtextextended(format(''reservation-capacity|%s|%s'', _updated.company_id::text, _reservation_date_value::text), 0));\n  END IF;\n\n' || _anchor);
    IF _definition = _before THEN RAISE EXCEPTION 'Missing waitlist seating capacity lock anchor.'; END IF;
    EXECUTE _definition;
  END IF;

  _signature := 'public.confirm_reservation_payment(uuid,uuid,text,timestamptz,jsonb,text)'::regprocedure;
  _definition := replace(pg_get_functiondef(_signature), E'\r\n', E'\n');
  IF position('public_reservation_changes_capacity_lock' IN _definition) = 0 THEN
    _before := _definition;
    _anchor := E'    IF COALESCE(_schedule.availability_mode, ''tables'') = ''capacity'' THEN\n      PERFORM pg_advisory_xact_lock(hashtextextended(';
    _definition := replace(_definition, _anchor,
      E'    -- public_reservation_changes_capacity_lock: late payment can reopen capacity.\n    IF COALESCE(_schedule.availability_mode, ''tables'') = ''capacity''\n      OR EXISTS (SELECT 1 FROM public.companies c WHERE c.id = _company_id AND c.public_reservation_changes_enabled) THEN\n      PERFORM pg_advisory_xact_lock(hashtextextended(');
    _definition := replace(_definition,
      '      IF COALESCE(_max_guests, 0) <= 0 THEN _conflict := true; END IF;',
      '      IF COALESCE(_schedule.availability_mode, ''tables'') = ''capacity'' AND COALESCE(_max_guests, 0) <= 0 THEN _conflict := true; END IF;');
    IF _definition = _before OR position('public_reservation_changes_capacity_lock' IN _definition) = 0 THEN
      RAISE EXCEPTION 'Missing payment confirmation capacity lock anchor.';
    END IF;
    EXECUTE _definition;
  END IF;
END;
$capacity_locks$;

ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS last_public_change_at timestamptz;
ALTER TABLE public.whatsapp_message_queue ADD COLUMN IF NOT EXISTS reservation_change_revision timestamptz;
ALTER TABLE public.pluguechat_message_queue ADD COLUMN IF NOT EXISTS reservation_change_revision timestamptz;
ALTER TABLE public.whatsapp_message_logs ADD COLUMN IF NOT EXISTS reservation_change_revision timestamptz;
ALTER TABLE public.pluguechat_message_logs ADD COLUMN IF NOT EXISTS reservation_change_revision timestamptz;

-- Private request receipts make uncertain network retries safe. They do not grant
-- access to reservations or expose tracking codes to other company visitors.
CREATE TABLE IF NOT EXISTS public.reservation_public_change_requests (
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, request_id)
);
ALTER TABLE public.reservation_public_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reservation_public_change_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.reservation_public_change_requests TO service_role;

-- Annotate only this RPC's normal audit event as a customer update. Every other
-- insert/update/delete retains the deployed audit function's original behavior.
DO $audit$
DECLARE _definition text;
BEGIN
  SELECT pg_get_functiondef('public.audit_reservation_changes()'::regprocedure) INTO _definition;
  IF position('app.public_reservation_change' IN _definition) = 0 THEN
    IF position('  IF TG_OP = ''INSERT'' THEN' IN _definition) = 0 THEN
      RAISE EXCEPTION 'Contrato de auditoria de reservas inesperado.';
    END IF;
    _definition := replace(_definition,
      '  _actor_name := public.get_reservation_audit_actor_name(_actor_user_id, _guest_name, _looks_public);',
      '  _actor_name := public.get_reservation_audit_actor_name(_actor_user_id, _guest_name, _looks_public);
  IF TG_OP = ''UPDATE'' AND current_setting(''app.public_reservation_change'', true) = ''rpc'' THEN
    _actor_user_id := NULL;
    _actor_source := ''public'';
    _actor_role := ''user'';
    _actor_name := COALESCE(NULLIF(btrim(_guest_name), ''''), ''Cliente'');
  END IF;');
    IF position('app.public_reservation_change' IN _definition) = 0 THEN
      RAISE EXCEPTION 'Contrato de auditoria de reservas inesperado.';
    END IF;
    EXECUTE _definition;
  END IF;
END;
$audit$;

CREATE OR REPLACE FUNCTION public._public_reservation_change_snapshot(_entry public.reservations)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', _entry.id, 'date', _entry.date,
    'time', to_char(_entry.time, 'HH24:MI'), 'party_size', _entry.party_size,
    'updated_at', _entry.updated_at);
$$;
REVOKE ALL ON FUNCTION public._public_reservation_change_snapshot(public.reservations)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._public_reservation_change_reason(
  _entry public.reservations, _checked_at timestamptz DEFAULT clock_timestamp()
)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _company public.companies%ROWTYPE; _zone text;
BEGIN
  SELECT * INTO _company FROM public.companies WHERE id = _entry.company_id;
  IF NOT FOUND OR _company.status <> 'active' THEN RETURN 'unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM public.reservation_payments WHERE reservation_id = _entry.id) THEN
    RETURN 'payment';
  END IF;
  IF _entry.status <> 'confirmed' OR _entry.checked_in_at IS NOT NULL THEN RETURN 'status'; END IF;
  IF NOT _company.public_reservation_changes_enabled THEN RETURN 'disabled'; END IF;
  _zone := public._company_report_time_zone(_entry.company_id);
  IF (_entry.date + _entry.time) AT TIME ZONE _zone <= _checked_at
     OR (_entry.date + _entry.time) AT TIME ZONE _zone < _checked_at
       + make_interval(mins => _company.public_reservation_change_min_notice_minutes) THEN
    RETURN 'cutoff';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._public_reservation_change_reason(public.reservations,timestamptz)
  FROM PUBLIC, anon, authenticated;

-- The same resolver is used for the offered slots and the final write. Private
-- table/rule identifiers are removed by the public options RPC.
CREATE OR REPLACE FUNCTION public._public_reservation_change_slot(
  _reservation_id uuid, _date date, _time time, _party_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  _entry public.reservations%ROWTYPE; _company public.companies%ROWTYPE;
  _schedule record; _slot record; _zone text; _duration integer; _max_party integer;
  _max_guests integer; _map_id uuid; _table_id uuid; _reason text;
  _total_tables integer; _occupied_reservations integer; _checked_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO _entry FROM public.reservations WHERE id = _reservation_id;
  SELECT * INTO _company FROM public.companies WHERE id = _entry.company_id;
  _zone := public._company_report_time_zone(_entry.company_id);
  IF _date IS NULL OR _time IS NULL OR _date < (_checked_at AT TIME ZONE _zone)::date
     OR _date > (_checked_at AT TIME ZONE _zone)::date + 365 THEN
    RETURN jsonb_build_object('available',false,'reason','unavailable');
  END IF;
  SELECT * INTO _schedule FROM public.get_public_reservation_schedule(_entry.company_id, _date) LIMIT 1;
  IF NOT FOUND OR _schedule.source IS NULL OR _schedule.source = 'blocked'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(_schedule.slots,'[]'::jsonb)) s
      WHERE s::time = _time) THEN
    RETURN jsonb_build_object('available',false,'reason','blocked');
  END IF;
  SELECT rule_slot.* INTO _slot
  FROM public.reservation_schedule_rule_slots rule_slot
  WHERE rule_slot.time = _time AND (rule_slot.block_id = _schedule.block_id
    OR (rule_slot.block_id IS NULL AND rule_slot.rule_id = _schedule.rule_id))
  ORDER BY CASE WHEN rule_slot.block_id = _schedule.block_id THEN 0 ELSE 1 END,
    rule_slot.sort_order, rule_slot.created_at LIMIT 1;
  _duration := GREATEST(COALESCE(_slot.duration_minutes, _schedule.default_duration_minutes,
    _company.reservation_duration,30),1);
  _max_party := LEAST(COALESCE(_slot.max_party_size_per_reservation,
    _schedule.max_party_size_per_reservation,20),20);
  _max_guests := CASE WHEN _schedule.availability_mode = 'capacity' THEN _slot.max_guests_per_slot
    ELSE COALESCE(_slot.max_guests_per_slot,NULLIF(_company.max_guests_per_slot,0)) END;

  IF COALESCE(_slot.is_full,false) THEN _reason := 'full';
  ELSIF public.company_feature_enabled(_entry.company_id, 'reservation_prepayment') AND EXISTS (
    SELECT 1 FROM public.reservation_payment_rules r WHERE r.company_id = _entry.company_id
      AND r.enabled AND r.archived_at IS NULL AND _date BETWEEN r.date_start AND r.date_end
  ) THEN _reason := 'payment';
  ELSIF (_date + _time) AT TIME ZONE _zone <= _checked_at
    OR (_date + _time) AT TIME ZONE _zone < _checked_at
      + make_interval(mins => _company.public_reservation_change_min_notice_minutes) THEN _reason := 'cutoff';
  ELSIF _party_size IS NULL OR _party_size NOT BETWEEN 1 AND _max_party THEN _reason := 'party_size';
  ELSIF EXISTS(SELECT 1 FROM public.blocked_dates b WHERE b.company_id = _entry.company_id
    AND b.date = _date AND (b.all_day OR (_time >= COALESCE(b.start_time,'00:00'::time)
      AND _time < COALESCE(b.end_time,'23:59:59'::time)))) THEN _reason := 'blocked';
  ELSIF _slot.max_reservations_per_slot IS NOT NULL AND public.count_slot_arrival_reservations(
    _entry.company_id,_date,_time,_entry.id) >= _slot.max_reservations_per_slot THEN _reason := 'full';
  ELSIF _schedule.availability_mode = 'capacity' AND COALESCE(_max_guests,0) <= 0 THEN _reason := 'full';
  ELSIF COALESCE(_max_guests,0) > 0 AND public.count_overlapping_reservation_guests(
    _entry.company_id,_date,_time,_duration,_entry.id) + _party_size > _max_guests THEN _reason := 'full';
  END IF;

  IF _reason IS NULL AND COALESCE(_schedule.availability_mode,'tables') <> 'capacity' THEN
    SELECT active_map.id INTO _map_id FROM public.get_active_table_map(
      _entry.company_id,(_date + _time) AT TIME ZONE _zone) active_map LIMIT 1;
    SELECT count(*)::integer INTO _total_tables FROM public.restaurant_tables t
      WHERE t.company_id = _entry.company_id AND t.status = 'available'
      AND (_map_id IS NULL OR t.table_map_id = _map_id);
    SELECT count(*)::integer INTO _occupied_reservations FROM public.reservations r
      WHERE r.company_id = _entry.company_id AND r.id <> _entry.id AND r.date = _date
      AND public.is_reservation_occupying_capacity(r.id,r.status,r.created_at)
      AND (_date + r.time) < (_date + _time + make_interval(mins => _duration))
      AND (_date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes,30),1))) > (_date + _time);
    IF _total_tables <= _occupied_reservations THEN _reason := 'full';
    ELSE
      _table_id := public.pick_best_fit_reservation_table(_entry.company_id,_date,_time,
        _duration,_party_size,_map_id,_entry.id);
      IF _table_id IS NULL THEN _reason := 'full'; END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('available',_reason IS NULL,'reason',_reason,'duration_minutes',_duration,
    'table_id',_table_id,'rule_id',_schedule.rule_id,
    'availability_mode',COALESCE(_schedule.availability_mode,'tables'));
END;
$$;
REVOKE ALL ON FUNCTION public._public_reservation_change_slot(uuid,date,time,integer)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_public_reservation_change_options(
  _tracking_code text, _visitor_id text, _date date DEFAULT NULL, _party_size integer DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _entry public.reservations%ROWTYPE; _company public.companies%ROWTYPE;
  _visitor text := NULLIF(btrim(_visitor_id),''); _code text := lower(btrim(_tracking_code));
  _reason text; _zone text; _selected_date date; _selected_party integer;
  _schedule record; _time_text text; _slot jsonb; _slots jsonb := '[]'::jsonb;
BEGIN
  IF _visitor IS NULL OR length(_visitor) > 200 OR _code IS NULL OR length(_code) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'Identificacao de acompanhamento invalida.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('public-change-options|' || _visitor,0));
  IF (SELECT count(*) FROM public.public_rate_limits WHERE scope='public_reservation_change_options'
    AND identifier=_visitor AND created_at >= statement_timestamp()-interval '15 minutes') >= 120 THEN
    RAISE EXCEPTION 'Muitas consultas. Aguarde alguns minutos e tente novamente.' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO _entry FROM public.reservations WHERE public_tracking_code = _code LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva nao encontrada.' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.public_rate_limits(scope,company_id,identifier)
    VALUES('public_reservation_change_options',_entry.company_id,_visitor);
  SELECT * INTO _company FROM public.companies WHERE id=_entry.company_id;
  _zone := public._company_report_time_zone(_entry.company_id);
  _selected_date := COALESCE(_date,_entry.date); _selected_party := COALESCE(_party_size,_entry.party_size);
  IF _selected_party NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Quantidade de pessoas invalida.' USING ERRCODE='22023';
  END IF;
  _reason := public._public_reservation_change_reason(_entry);
  IF _reason IS NULL AND _selected_date BETWEEN (statement_timestamp() AT TIME ZONE _zone)::date
      AND (statement_timestamp() AT TIME ZONE _zone)::date + 365 THEN
    SELECT * INTO _schedule FROM public.get_public_reservation_schedule(_entry.company_id,_selected_date) LIMIT 1;
    IF FOUND THEN
      FOR _time_text IN SELECT DISTINCT value FROM jsonb_array_elements_text(COALESCE(_schedule.slots,'[]'::jsonb)) ORDER BY value LOOP
        _slot := public._public_reservation_change_slot(_entry.id,_selected_date,_time_text::time,_selected_party);
        _slots := _slots || jsonb_build_array(jsonb_build_object('time',to_char(_time_text::time,'HH24:MI'),
          'available',(_slot->>'available')::boolean,'reason',_slot->'reason',
          'duration_minutes',GREATEST(COALESCE((_slot->>'duration_minutes')::integer,_company.reservation_duration,30),1)));
      END LOOP;
    END IF;
  END IF;
  RETURN jsonb_build_object('allowed',_reason IS NULL,'reason',_reason,
    'min_notice_minutes',_company.public_reservation_change_min_notice_minutes,'time_zone',_zone,
    'server_now',statement_timestamp(),'revision',_entry.updated_at,
    'reservation',public._public_reservation_change_snapshot(_entry),
    'date',_selected_date,'party_size',_selected_party,'max_party_size',20,'slots',_slots);
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_reservation_change_options(text,text,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_change_options(text,text,date,integer)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.change_public_reservation(
  _tracking_code text, _visitor_id text, _date date, _time time, _party_size integer,
  _expected_revision timestamptz, _request_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _entry public.reservations%ROWTYPE; _updated public.reservations%ROWTYPE;
  _visitor text := NULLIF(btrim(_visitor_id),''); _code text := lower(btrim(_tracking_code));
  _reason text; _slot jsonb; _table_id uuid; _fingerprint jsonb; _receipt record; _result jsonb;
  _lock_date date; _old_audit_context text := current_setting('app.public_reservation_change',true);
BEGIN
  IF _visitor IS NULL OR length(_visitor)>200 OR _code IS NULL OR length(_code) NOT BETWEEN 8 AND 128
    OR _date IS NULL OR _time IS NULL OR _party_size IS NULL OR _party_size NOT BETWEEN 1 AND 20
    OR _expected_revision IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Dados da alteracao invalidos.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO _entry FROM public.reservations WHERE public_tracking_code = _code LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva nao encontrada.' USING ERRCODE='P0002'; END IF;
  _fingerprint := jsonb_build_object('date',_date,'time',_time,'party_size',_party_size,'revision',extract(epoch FROM _expected_revision));
  SELECT * INTO _receipt FROM public.reservation_public_change_requests
    WHERE reservation_id=_entry.id AND request_id=_request_id;
  IF FOUND THEN
    IF _receipt.fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'Identificador de alteracao ja utilizado.' USING ERRCODE='22023';
    END IF;
    RETURN _receipt.result || jsonb_build_object('replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('public-change-submit|' || _visitor,0));
  IF (SELECT count(*) FROM public.public_rate_limits WHERE scope='public_reservation_change_submit'
    AND identifier=_visitor AND created_at >= statement_timestamp()-interval '15 minutes') >= 10 THEN
    RAISE EXCEPTION 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.public_rate_limits(scope,company_id,identifier)
    VALUES('public_reservation_change_submit',_entry.company_id,_visitor);
  -- Lock both dates in a fixed order, using the exact namespaces of creation.
  FOR _lock_date IN SELECT DISTINCT value FROM unnest(ARRAY[_entry.date,_date]) AS value ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-date|%s|%s',_entry.company_id,_lock_date),0));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-slot|%s|%s|%s',_entry.company_id,_date,_time),0));
  PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-capacity|%s|%s',_entry.company_id,_date),0));
  PERFORM 1 FROM public.companies WHERE id=_entry.company_id FOR SHARE;
  _reason := public._public_reservation_change_reason(_entry);
  IF _reason IS NULL AND _entry.updated_at IS DISTINCT FROM _expected_revision THEN _reason := 'stale'; END IF;
  IF _reason IS NULL AND _entry.date=_date AND _entry.time=_time AND _entry.party_size=_party_size THEN _reason := 'no_changes'; END IF;
  IF _reason IS NULL THEN
    _slot := public._public_reservation_change_slot(_entry.id,_date,_time,_party_size);
    _reason := NULLIF(_slot->>'reason','');
    _table_id := NULLIF(_slot->>'table_id','')::uuid;
  END IF;
  IF _reason IS NULL THEN
    -- These row locks serialize queue claims. Never change the booking while a
    -- provider submission (including PlugueChat's provider_queued) is in flight.
    PERFORM 1 FROM public.whatsapp_message_queue WHERE reservation_id=_entry.id
      AND type IN ('confirmation','confirmation_message','reminder_1h','reminder_24h') ORDER BY id FOR UPDATE;
    PERFORM 1 FROM public.pluguechat_message_queue WHERE reservation_id=_entry.id
      AND type IN ('confirmation','confirmation_message','reminder_1h','reminder_24h') ORDER BY id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.whatsapp_message_queue WHERE reservation_id=_entry.id
      AND type IN ('confirmation','confirmation_message','reminder_1h','reminder_24h') AND status='processing')
      OR EXISTS(SELECT 1 FROM public.pluguechat_message_queue WHERE reservation_id=_entry.id
        AND type IN ('confirmation','confirmation_message','reminder_1h','reminder_24h')
        AND status IN ('processing','provider_queued')) THEN _reason := 'message_processing'; END IF;
  END IF;
  IF _reason IS NOT NULL THEN
    RETURN jsonb_build_object('changed',false,'replayed',false,'reason',_reason,
      'revision',_entry.updated_at,'reservation',public._public_reservation_change_snapshot(_entry));
  END IF;
  IF _table_id IS NOT NULL THEN
    PERFORM 1 FROM public.restaurant_tables WHERE id=_table_id FOR SHARE;
    PERFORM pg_advisory_xact_lock(hashtextextended(format('reservation-table|%s|%s',_table_id,_date),0));
  END IF;
  -- Recheck after every potentially waiting lock, against the wall clock and
  -- the latest schedule/payment/capacity snapshot, including capacity-only units.
  _reason := public._public_reservation_change_reason(_entry);
  IF _reason IS NULL THEN
    _slot := public._public_reservation_change_slot(_entry.id,_date,_time,_party_size);
    _reason := NULLIF(_slot->>'reason','');
    IF _reason IS NULL AND (_slot->>'table_id')::uuid IS DISTINCT FROM _table_id THEN _reason := 'full'; END IF;
  END IF;
  IF _reason IS NOT NULL THEN
    RETURN jsonb_build_object('changed',false,'replayed',false,'reason',_reason,
      'revision',_entry.updated_at,'reservation',public._public_reservation_change_snapshot(_entry));
  END IF;
  UPDATE public.whatsapp_message_queue SET status='expired',error_details='Reserva alterada pelo cliente.',expires_at=statement_timestamp()
    WHERE reservation_id=_entry.id AND type IN ('confirmation','confirmation_message','reminder_1h','reminder_24h')
      AND status IN ('pending','failed');
  UPDATE public.pluguechat_message_queue SET status='cancelled',cancel_reason='public_reservation_changed',cancelled_at=statement_timestamp()
    WHERE reservation_id=_entry.id AND type IN ('confirmation','confirmation_message','reminder_1h','reminder_24h')
      AND status IN ('pending','failed');
  PERFORM set_config('app.public_reservation_change','rpc',true);
  UPDATE public.reservations SET date=_date,time=_time,party_size=_party_size,table_id=_table_id,
    duration_minutes=(_slot->>'duration_minutes')::integer,
    applied_schedule_rule_id=NULLIF(_slot->>'rule_id','')::uuid,created_in_mode=_slot->>'availability_mode',
    last_public_change_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=_entry.id RETURNING * INTO _updated;
  PERFORM set_config('app.public_reservation_change',COALESCE(_old_audit_context,''),true);
  INSERT INTO public.notifications(company_id,title,message,type)
    VALUES(_entry.company_id,'Reserva alterada pelo cliente',format(
      '%s alterou a reserva de %s as %s, %s pessoa(s), para %s as %s, %s pessoa(s).',
      replace(replace(replace(replace(replace(_entry.guest_name,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),'''','&#39;'),
      to_char(_entry.date,'DD/MM/YYYY'),to_char(_entry.time,'HH24:MI'),_entry.party_size,
      to_char(_updated.date,'DD/MM/YYYY'),to_char(_updated.time,'HH24:MI'),_updated.party_size),'reservation_change');
  _result := jsonb_build_object('changed',true,'replayed',false,'reason',NULL,
    'revision',_updated.updated_at,'reservation',public._public_reservation_change_snapshot(_updated));
  INSERT INTO public.reservation_public_change_requests(reservation_id,company_id,request_id,fingerprint,result)
    VALUES(_entry.id,_entry.company_id,_request_id,_fingerprint,_result);
  RETURN _result;
END;
$$;
REVOKE ALL ON FUNCTION public.change_public_reservation(text,text,date,time,integer,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_public_reservation(text,text,date,time,integer,timestamptz,uuid)
  TO anon, authenticated, service_role;
