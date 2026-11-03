-- A published slot may remain visible while the team stops new bookings.
-- Keep real occupancy/capacity metrics and the original RPC signatures/ACLs.
ALTER TABLE public.reservation_schedule_rule_slots
  ADD COLUMN IF NOT EXISTS is_full boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.reservation_schedule_rule_slots.is_full IS
  'Manually sold out: show the published time but reject new reservations.';

-- Patch the deployed definitions so support impersonation and other later
-- authorization changes are retained. Each edit checks its expected anchor;
-- unexpected database drift aborts the migration instead of silently skipping.
DO $migration$
DECLARE
  _definition text;
  _before text;
BEGIN
  _definition := pg_get_functiondef(
    'public.upsert_reservation_schedule_rule(uuid,text,text,uuid,date,date,boolean,integer,timestamptz,jsonb)'::regprocedure
  );
  _definition := replace(_definition, E'\r\n', E'\n');
  IF position('Estado de lotacao do horario invalido.' IN _definition) = 0 THEN
    _before := _definition;
    _definition := replace(_definition,
      '      IF NULLIF(_slot_item ->> ''duration_minutes'', '''') IS NOT NULL',
      E'      IF _slot_item ? ''is_full''\n         AND jsonb_typeof(_slot_item -> ''is_full'') NOT IN (''boolean'', ''null'') THEN\n        RAISE EXCEPTION ''Estado de lotacao do horario invalido.'';\n      END IF;\n\n      IF NULLIF(_slot_item ->> ''duration_minutes'', '''') IS NOT NULL');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing slot validation anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      '      IF _mode = ''capacity'' AND NULLIF(_slot_item ->> ''max_guests_per_slot'', '''') IS NULL THEN',
      E'      IF _mode = ''capacity''\n         AND NOT COALESCE((_slot_item ->> ''is_full'')::boolean, false)\n         AND NULLIF(_slot_item ->> ''max_guests_per_slot'', '''') IS NULL THEN');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing capacity validation anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      E'        max_guests_per_slot\n      )',
      E'        max_guests_per_slot,\n        is_full\n      )');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing slot insert columns anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      E'        NULLIF(_slot_item ->> ''max_guests_per_slot'', '''')::integer\n      );',
      E'        NULLIF(_slot_item ->> ''max_guests_per_slot'', '''')::integer,\n        COALESCE((_slot_item ->> ''is_full'')::boolean, false)\n      );');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing slot insert values anchor.'; END IF;
    EXECUTE _definition;
  END IF;
END;
$migration$;

DO $migration$
DECLARE
  _definition text;
  _before text;
BEGIN
  _definition := pg_get_functiondef(
    'public.get_public_reservation_availability(uuid,date,integer)'::regprocedure
  );
  _definition := replace(_definition, E'\r\n', E'\n');
  IF position('manually_full' IN _definition) = 0 THEN
    _before := _definition;
    _definition := replace(_definition,
      '      slot.max_guests_per_slot,',
      E'      slot.max_guests_per_slot,\n      COALESCE(slot.is_full, false) AS is_full,');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing public slot config anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      '      WHEN metrics.is_blocked THEN false',
      E'      WHEN metrics.is_full THEN false\n      WHEN metrics.is_blocked THEN false');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing public available anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      '      WHEN metrics.is_blocked THEN ''blocked''',
      E'      WHEN metrics.is_full THEN ''manually_full''\n      WHEN metrics.is_blocked THEN ''blocked''');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing public reason anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      E'    metrics.effective_available_units,\n    metrics.overlapping_guest_count,',
      E'    CASE WHEN metrics.is_full THEN 0 ELSE metrics.effective_available_units END,\n    metrics.overlapping_guest_count,');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing public available units anchor.'; END IF;
    EXECUTE _definition;
  END IF;
END;
$migration$;

DO $migration$
DECLARE
  _definition text;
  _before text;
BEGIN
  _definition := pg_get_functiondef(
    'public.get_admin_reservation_day_capacity(uuid,date)'::regprocedure
  );
  _definition := replace(_definition, E'\r\n', E'\n');
  IF position('manually_full' IN _definition) = 0 THEN
    _before := _definition;
    _definition := replace(_definition,
      '      slot.max_guests_per_slot,',
      E'      slot.max_guests_per_slot,\n      COALESCE(slot.is_full, false) AS is_full,');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing admin slot config anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      E'    f.is_blocked AS blocked,\n    CASE',
      E'    f.is_blocked AS blocked,\n    CASE\n      WHEN f.is_full THEN ''manually_full''');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing admin reason anchor.'; END IF;

    _before := _definition;
    _definition := replace(_definition,
      '      WHEN f.is_blocked THEN ''blocked''',
      E'      WHEN f.is_full THEN ''full''\n      WHEN f.is_blocked THEN ''blocked''');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing admin status anchor.'; END IF;
    EXECUTE _definition;
  END IF;
END;
$migration$;

-- Resolve only the effective rule/block, including legacy slots. An inactive,
-- future, archived or lower-priority rule must not close another rule's slot.
CREATE OR REPLACE FUNCTION public.assert_reservation_slot_not_full(
  _company_id uuid,
  _date date,
  _time time
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  _is_full boolean;
BEGIN
  SELECT COALESCE(slot.is_full, false)
  INTO _is_full
  FROM public.get_public_reservation_schedule(_company_id, _date) schedule
  JOIN LATERAL (
    SELECT rule_slot.is_full
    FROM public.reservation_schedule_rule_slots rule_slot
    -- Published schedule times use HH24:MI. Apply the identical precision so
    -- a caller cannot bypass a full slot by supplying seconds.
    WHERE to_char(rule_slot.time, 'HH24:MI') = to_char(_time, 'HH24:MI')
      AND (
        rule_slot.block_id = schedule.block_id
        OR (rule_slot.block_id IS NULL AND rule_slot.rule_id = schedule.rule_id)
      )
    ORDER BY
      CASE WHEN rule_slot.block_id = schedule.block_id THEN 0 ELSE 1 END,
      rule_slot.sort_order,
      rule_slot.created_at
    LIMIT 1
  ) slot ON true;

  IF COALESCE(_is_full, false) THEN
    RAISE EXCEPTION 'Este horario esta lotado. Escolha outro horario.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_reservation_slot_not_full(uuid, date, time) FROM PUBLIC;

-- Check early in create RPCs for the useful sold-out message, before table or
-- capacity validation. Retain all deployed phone and authorization behavior.
DO $migration$
DECLARE
  _signature regprocedure;
  _definition text;
  _before text;
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public.create_public_reservation(jsonb,text)'::regprocedure,
    'public.create_panel_reservation(uuid,date,time,integer,text,text,text,date,text,text,uuid,boolean,text,text)'::regprocedure
  ] LOOP
    _definition := pg_get_functiondef(_signature);
    _definition := replace(_definition, E'\r\n', E'\n');
    IF position('PERFORM public.assert_reservation_slot_not_full' IN _definition) = 0 THEN
      _before := _definition;
      _definition := replace(_definition,
        '  _availability_mode := COALESCE(_schedule.availability_mode, ''tables'');',
        E'  PERFORM public.assert_reservation_slot_not_full(_company_id, _date, _time);\n\n  _availability_mode := COALESCE(_schedule.availability_mode, ''tables'');');
      IF _definition = _before THEN RAISE EXCEPTION 'Missing create schedule anchor: %', _signature; END IF;
      EXECUTE _definition;
    END IF;
  END LOOP;
END;
$migration$;

DO $migration$
DECLARE
  _definition text;
  _before text;
BEGIN
  _definition := pg_get_functiondef(
    'public.update_panel_reservation(uuid,date,time,integer,text,text,text,text,text,uuid,boolean,boolean,text)'::regprocedure
  );
  _definition := replace(_definition, E'\r\n', E'\n');
  IF position('PERFORM public.assert_reservation_slot_not_full' IN _definition) = 0 THEN
    _before := _definition;
    _definition := replace(_definition,
      '  _availability_mode := COALESCE(_schedule.availability_mode, ''tables'');',
      E'  IF _reservation.date IS DISTINCT FROM _date OR _reservation.time IS DISTINCT FROM _time THEN\n    PERFORM public.assert_reservation_slot_not_full(_reservation.company_id, _date, _time);\n  END IF;\n\n  _availability_mode := COALESCE(_schedule.availability_mode, ''tables'');');
    IF _definition = _before THEN RAISE EXCEPTION 'Missing update schedule anchor.'; END IF;
    EXECUTE _definition;
  END IF;
END;
$migration$;

-- Enforce the same rule for direct writes and moves from panel RPCs. Existing
-- bookings can still be checked in, cancelled, assigned tables or have their
-- contact details corrected after a time has been marked full.
CREATE OR REPLACE FUNCTION public.enforce_reservation_slot_not_full()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS NOT DISTINCT FROM OLD.company_id
       AND NEW.date IS NOT DISTINCT FROM OLD.date
       AND NEW.time IS NOT DISTINCT FROM OLD.time
       AND NOT (
         OLD.status IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
         AND NEW.status NOT IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled')
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM public.assert_reservation_slot_not_full(NEW.company_id, NEW.date, NEW.time);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_reservation_slot_not_full() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_enforce_reservation_slot_not_full ON public.reservations;
CREATE TRIGGER trg_enforce_reservation_slot_not_full
  BEFORE INSERT OR UPDATE OF company_id, date, time, status ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reservation_slot_not_full();
