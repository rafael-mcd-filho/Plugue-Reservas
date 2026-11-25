-- Plan a complete group allocation without changing reservation state. Every
-- combination stays in one environment and uses only free tables in the map
-- already resolved by the caller for the reservation date and time.
CREATE OR REPLACE FUNCTION public.pick_best_fit_reservation_tables(
  _company_id uuid,
  _date date,
  _time time,
  _duration_minutes integer,
  _party_size integer,
  _active_table_map_id uuid,
  _exclude_reservation_id uuid DEFAULT NULL,
  _section_id uuid DEFAULT NULL,
  _required_table_id uuid DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _section record;
  _required_section text;
  _required_capacity integer;
  _required_number integer;
  _table_ids uuid[];
  _table_capacities integer[];
  _table_numbers integer[];
  _total_capacity bigint;
  _duration integer := GREATEST(COALESCE(_duration_minutes, 30), 1);
  _states jsonb[];
  _state jsonb;
  _existing jsonb;
  _ids uuid[];
  _numbers integer[];
  _existing_numbers integer[];
  _best_ids uuid[] := '{}'::uuid[];
  _best_numbers integer[];
  _best_capacity bigint;
  _next_capacity bigint;
  _next_count integer;
  _index integer;
  _capacity integer;
BEGIN
  -- Do not turn a missing active map into an unrestricted scan of other maps.
  -- Bound the dynamic-programming state independently of table capacities.
  IF _company_id IS NULL OR _date IS NULL OR _time IS NULL
     OR _active_table_map_id IS NULL OR _party_size IS NULL
     OR _party_size < 1 OR _party_size > 10000 THEN
    RETURN '{}'::uuid[];
  END IF;

  IF _required_table_id IS NOT NULL THEN
    SELECT t.section, t.capacity, t.number
    INTO _required_section, _required_capacity, _required_number
    FROM public.restaurant_tables t
    WHERE t.id = _required_table_id
      AND t.company_id = _company_id
      AND t.table_map_id = _active_table_map_id
      AND t.status = 'available' AND t.capacity > 0
      AND (_section_id IS NULL OR EXISTS (
        SELECT 1 FROM public.table_sections s
        WHERE s.id = _section_id AND s.company_id = _company_id AND s.code = t.section
      ))
      AND public.reservation_table_conflict_id(
        _company_id, _date, _time, _duration, t.id, _exclude_reservation_id
      ) IS NULL;

    IF NOT FOUND THEN RETURN '{}'::uuid[]; END IF;
    -- Adding any other positive-capacity table cannot improve this allocation.
    IF _required_capacity >= _party_size THEN RETURN ARRAY[_required_table_id]; END IF;
  END IF;

  FOR _section IN
    SELECT DISTINCT t.section
    FROM public.restaurant_tables t
    WHERE t.company_id = _company_id
      AND t.table_map_id = _active_table_map_id
      AND t.status = 'available' AND t.capacity > 0
      AND (_required_table_id IS NULL OR t.section IS NOT DISTINCT FROM _required_section)
      AND (_section_id IS NULL OR EXISTS (
        SELECT 1 FROM public.table_sections s
        WHERE s.id = _section_id AND s.company_id = _company_id AND s.code = t.section
      ))
    ORDER BY t.section NULLS FIRST
  LOOP
    SELECT array_agg(t.id ORDER BY t.number, t.id),
           array_agg(t.capacity ORDER BY t.number, t.id),
           array_agg(t.number ORDER BY t.number, t.id),
           COALESCE(sum(t.capacity), 0)
    INTO _table_ids, _table_capacities, _table_numbers, _total_capacity
    FROM public.restaurant_tables t
    WHERE t.company_id = _company_id
      AND t.table_map_id = _active_table_map_id
      AND t.section IS NOT DISTINCT FROM _section.section
      AND t.status = 'available' AND t.capacity > 0
      AND public.reservation_table_conflict_id(
        _company_id, _date, _time, _duration, t.id, _exclude_reservation_id
      ) IS NULL;

    IF _total_capacity < _party_size THEN CONTINUE; END IF;

    -- Only sums below the requested capacity need another table. Keeping one
    -- best state per such sum avoids enumerating all subsets (O(tables * party)).
    _states := array_fill(NULL::jsonb, ARRAY[_party_size], ARRAY[0]);
    IF _required_table_id IS NULL THEN
      _states[0] := jsonb_build_object('ids', '[]'::jsonb, 'numbers', '[]'::jsonb);
    ELSE
      _states[_required_capacity] := jsonb_build_object(
        'ids', ARRAY[_required_table_id], 'numbers', ARRAY[_required_number]
      );
    END IF;

    FOR _index IN 1..cardinality(_table_ids) LOOP
      IF _table_ids[_index] = _required_table_id THEN CONTINUE; END IF;
      -- Descending sums ensure a table cannot be reused within this iteration.
      FOR _capacity IN REVERSE (_party_size - 1)..0 LOOP
        _state := _states[_capacity];
        IF _state IS NULL THEN CONTINUE; END IF;
        _ids := ARRAY(SELECT jsonb_array_elements_text(_state->'ids'))::uuid[]
          || _table_ids[_index];
        _numbers := ARRAY(SELECT jsonb_array_elements_text(_state->'numbers'))::integer[]
          || _table_numbers[_index];
        _next_capacity := _capacity::bigint + _table_capacities[_index];
        _next_count := cardinality(_ids);

        IF _next_capacity >= _party_size THEN
          IF _best_capacity IS NULL
             OR _next_capacity < _best_capacity
             OR (_next_capacity = _best_capacity AND _next_count < cardinality(_best_ids))
             OR (_next_capacity = _best_capacity AND _next_count = cardinality(_best_ids)
                 AND _numbers < _best_numbers) THEN
            _best_capacity := _next_capacity;
            _best_ids := _ids;
            _best_numbers := _numbers;
          END IF;
        ELSE
          _existing := _states[_next_capacity::integer];
          IF _existing IS NULL OR _next_count < jsonb_array_length(_existing->'ids') THEN
            _states[_next_capacity::integer] := jsonb_build_object('ids', _ids, 'numbers', _numbers);
          ELSIF _next_count = jsonb_array_length(_existing->'ids') THEN
            _existing_numbers := ARRAY(SELECT jsonb_array_elements_text(_existing->'numbers'))::integer[];
            IF _numbers < _existing_numbers THEN
              _states[_next_capacity::integer] := jsonb_build_object('ids', _ids, 'numbers', _numbers);
            END IF;
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN _best_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.pick_best_fit_reservation_tables(
  uuid, date, time, integer, integer, uuid, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pick_best_fit_reservation_tables(
  uuid, date, time, integer, integer, uuid, uuid, uuid, uuid
) TO service_role;

COMMENT ON FUNCTION public.pick_best_fit_reservation_tables(
  uuid, date, time, integer, integer, uuid, uuid, uuid, uuid
) IS 'Plans free tables in one environment: least excess capacity, fewest tables, then lowest table numbers. Does not lock or assign tables.';
