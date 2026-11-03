-- Manual sold-out markings close online booking only. Staff keep the normal
-- panel reservation workflow and its existing table/capacity checks.
-- The first migration is already deployed; correct its scope additively.
DO $migration$
DECLARE
  _definition text;
  _before text;
BEGIN
  _definition := pg_get_functiondef(
    'public.create_panel_reservation(uuid,date,time,integer,text,text,text,date,text,text,uuid,boolean,text,text)'::regprocedure
  );
  _definition := replace(_definition, E'\r\n', E'\n');
  IF position('PERFORM public.assert_reservation_slot_not_full' IN _definition) > 0 THEN
    _before := _definition;
    _definition := replace(_definition,
      E'  PERFORM public.assert_reservation_slot_not_full(_company_id, _date, _time);\n\n',
      '');
    IF _definition = _before
       OR position('PERFORM public.assert_reservation_slot_not_full' IN _definition) > 0 THEN
      RAISE EXCEPTION 'Unexpected panel create sold-out guard definition.';
    END IF;
    EXECUTE _definition;
  END IF;

  _definition := pg_get_functiondef(
    'public.update_panel_reservation(uuid,date,time,integer,text,text,text,text,text,uuid,boolean,boolean,text)'::regprocedure
  );
  _definition := replace(_definition, E'\r\n', E'\n');
  IF position('PERFORM public.assert_reservation_slot_not_full' IN _definition) > 0 THEN
    _before := _definition;
    _definition := replace(_definition,
      E'  IF _reservation.date IS DISTINCT FROM _date OR _reservation.time IS DISTINCT FROM _time THEN\n    PERFORM public.assert_reservation_slot_not_full(_reservation.company_id, _date, _time);\n  END IF;\n\n',
      '');
    IF _definition = _before
       OR position('PERFORM public.assert_reservation_slot_not_full' IN _definition) > 0 THEN
      RAISE EXCEPTION 'Unexpected panel update sold-out guard definition.';
    END IF;
    EXECUTE _definition;
  END IF;

  -- Capacity mode continues requiring a real configured capacity on every
  -- slot, including slots whose online booking is manually closed.
  _definition := pg_get_functiondef(
    'public.upsert_reservation_schedule_rule(uuid,text,text,uuid,date,date,boolean,integer,timestamptz,jsonb)'::regprocedure
  );
  _definition := replace(_definition, E'\r\n', E'\n');
  IF position('AND NOT COALESCE((_slot_item ->> ''is_full'')::boolean, false)' IN _definition) > 0 THEN
    _before := _definition;
    _definition := replace(_definition,
      E'      IF _mode = ''capacity''\n         AND NOT COALESCE((_slot_item ->> ''is_full'')::boolean, false)\n         AND NULLIF(_slot_item ->> ''max_guests_per_slot'', '''') IS NULL THEN',
      '      IF _mode = ''capacity'' AND NULLIF(_slot_item ->> ''max_guests_per_slot'', '''') IS NULL THEN');
    IF _definition = _before THEN
      RAISE EXCEPTION 'Unexpected full-slot capacity validation definition.';
    END IF;
    EXECUTE _definition;
  END IF;
END;
$migration$;

-- Global row guards cannot distinguish online requests from authorized panel
-- operations. The public create RPC retains its own sold-out guard, and the
-- public availability and booking-context RPCs remain unavailable for the slot.
DROP TRIGGER IF EXISTS trg_enforce_reservation_slot_not_full ON public.reservations;
DROP FUNCTION IF EXISTS public.enforce_reservation_slot_not_full();
