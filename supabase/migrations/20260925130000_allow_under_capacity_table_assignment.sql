-- Permite que admin/operador salve mesas cuja capacidade somada fica abaixo
-- do numero de pessoas (ex.: grupo de 12 em mesa de 10 com cadeiras extras),
-- desde que o painel envie _allow_under_capacity = true apos confirmacao.
-- O fluxo publico nao usa esta RPC e segue exigindo capacidade suficiente.

DROP FUNCTION IF EXISTS public.assign_reservation_tables(uuid, uuid[], boolean, text);

CREATE OR REPLACE FUNCTION public.assign_reservation_tables(
  _reservation_id uuid,
  _table_ids uuid[],
  _allow_unassigned boolean DEFAULT false,
  _assignment_note text DEFAULT NULL,
  _allow_under_capacity boolean DEFAULT false
)
RETURNS TABLE (
  reservation_id uuid,
  primary_table_id uuid,
  table_ids uuid[],
  assigned_capacity integer,
  party_size integer,
  assignment_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _reservation public.reservations%ROWTYPE;
  _normalized_table_ids uuid[] := '{}'::uuid[];
  _previous_table_ids uuid[] := '{}'::uuid[];
  _active_table_map_id uuid;
  _duration_minutes integer;
  _valid_table_count integer := 0;
  _assigned_capacity integer := 0;
  _table_id_to_lock uuid;
  _conflict_id uuid;
  _state text;
  _party_size integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  SELECT *
  INTO _reservation
  FROM public.reservations r
  WHERE r.id = _reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reserva nao encontrada.';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _reservation.company_id)
    OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, _reservation.company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF _reservation.created_in_mode = 'capacity' THEN
    RAISE EXCEPTION 'Reserva por capacidade nao utiliza mesa.';
  END IF;

  SELECT COALESCE(array_agg(a.table_id ORDER BY a.sort_order, a.table_id), '{}'::uuid[])
  INTO _previous_table_ids
  FROM public.reservation_table_assignments a
  WHERE a.reservation_id = _reservation.id;

  SELECT COALESCE(array_agg(d.table_id ORDER BY d.first_position), '{}'::uuid[])
  INTO _normalized_table_ids
  FROM (
    SELECT u.table_id, min(u.position) AS first_position
    FROM unnest(COALESCE(_table_ids, '{}'::uuid[]))
      WITH ORDINALITY AS u(table_id, position)
    WHERE u.table_id IS NOT NULL
    GROUP BY u.table_id
  ) d;

  _duration_minutes := GREATEST(
    COALESCE(
      _reservation.duration_minutes,
      public.resolve_reservation_slot_duration(
        _reservation.company_id, _reservation.date, _reservation.time
      ),
      30
    ),
    1
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      format(
        'reservation-slot|%s|%s|%s',
        _reservation.company_id::text,
        _reservation.date::text,
        _reservation.time::text
      ),
      0
    )
  );

  IF cardinality(_normalized_table_ids) = 0 THEN
    IF NOT COALESCE(_allow_unassigned, false) THEN
      RAISE EXCEPTION 'Selecione ao menos uma mesa ou use "alocar depois".';
    END IF;

    PERFORM set_config('app.multi_table_sync', 'rpc', true);

    DELETE FROM public.reservation_table_assignments a
    WHERE a.reservation_id = _reservation.id;

    UPDATE public.reservations r
    SET
      table_id = NULL,
      table_assignment_note = COALESCE(
        NULLIF(btrim(_assignment_note), ''),
        'Alocar mesa depois'
      ),
      updated_at = now()
    WHERE r.id = _reservation.id;

    IF _previous_table_ids IS DISTINCT FROM '{}'::uuid[] THEN
      INSERT INTO public.reservation_audit_logs (
        reservation_id,
        company_id,
        actor_user_id,
        actor_name,
        actor_role,
        actor_source,
        action,
        summary,
        details
      ) VALUES (
        _reservation.id,
        _reservation.company_id,
        auth.uid(),
        public.get_reservation_audit_actor_name(auth.uid(), _reservation.guest_name, false),
        public.get_reservation_audit_actor_role(auth.uid(), _reservation.company_id, false),
        'panel',
        'updated',
        'Mesas da reserva removidas',
        jsonb_build_object(
          'changes', jsonb_build_object(
            'table_ids', jsonb_build_object(
              'old', to_jsonb(_previous_table_ids),
              'new', '[]'::jsonb
            )
          ),
          'assignment_note', COALESCE(
            NULLIF(btrim(_assignment_note), ''),
            'Alocar mesa depois'
          )
        )
      );
    END IF;

    PERFORM set_config('app.multi_table_sync', '', true);

    _state := CASE
      WHEN _reservation.created_in_mode = 'capacity' THEN 'not_required'
      ELSE 'pending'
    END;

    RETURN QUERY SELECT
      _reservation.id,
      NULL::uuid,
      '{}'::uuid[],
      0,
      GREATEST(COALESCE(_reservation.party_size, 1), 1),
      _state;
    RETURN;
  END IF;

  -- Trava primeiro as linhas reais das mesas. Assim capacidade, status e mapa
  -- nao podem mudar entre a validacao e a gravacao da atribuicao.
  PERFORM 1
  FROM public.restaurant_tables rt
  WHERE rt.id = ANY(_normalized_table_ids)
  ORDER BY rt.id
  FOR UPDATE;

  SELECT active_map.id
  INTO _active_table_map_id
  FROM public.get_active_table_map(
    _reservation.company_id,
    (_reservation.date + _reservation.time)::timestamptz
  ) active_map
  LIMIT 1;

  SELECT count(*)::integer, COALESCE(sum(rt.capacity), 0)::integer
  INTO _valid_table_count, _assigned_capacity
  FROM public.restaurant_tables rt
  WHERE rt.id = ANY(_normalized_table_ids)
    AND rt.company_id = _reservation.company_id
    AND rt.status = 'available'
    AND (
      _active_table_map_id IS NULL
      OR rt.table_map_id = _active_table_map_id
    );

  IF _valid_table_count <> cardinality(_normalized_table_ids) THEN
    RAISE EXCEPTION 'Uma ou mais mesas estao inativas, fora do mapa ativo ou pertencem a outra empresa.';
  END IF;

  _party_size := GREATEST(COALESCE(_reservation.party_size, 1), 1);

  -- A equipe pode confirmar mesas abaixo do grupo (ex.: cadeiras extras na
  -- mesa). Sem a confirmacao explicita, a capacidade combinada continua
  -- obrigatoria.
  IF _assigned_capacity < _party_size AND NOT COALESCE(_allow_under_capacity, false) THEN
    RAISE EXCEPTION 'As mesas selecionadas somam % lugares, mas a reserva possui % pessoas.',
      _assigned_capacity,
      GREATEST(COALESCE(_reservation.party_size, 1), 1);
  END IF;

  -- Ordem deterministica de advisory locks evita deadlock entre duas selecoes
  -- concorrentes e coordena com criacao/edicao singular de reservas.
  FOR _table_id_to_lock IN
    SELECT value
    FROM unnest(_normalized_table_ids) AS value
    ORDER BY value::text
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        format(
          'reservation-table|%s|%s',
          _table_id_to_lock::text,
          _reservation.date::text
        ),
        0
      )
    );
  END LOOP;

  -- Revalida todas as mesas depois de obter os locks.
  FOREACH _table_id_to_lock IN ARRAY _normalized_table_ids
  LOOP
    _conflict_id := public.reservation_table_conflict_id(
      _reservation.company_id,
      _reservation.date,
      _reservation.time,
      _duration_minutes,
      _table_id_to_lock,
      _reservation.id
    );

    IF _conflict_id IS NOT NULL THEN
      RAISE EXCEPTION 'Uma das mesas selecionadas ja esta ocupada neste horario.';
    END IF;
  END LOOP;

  PERFORM set_config('app.multi_table_sync', 'rpc', true);

  DELETE FROM public.reservation_table_assignments a
  WHERE a.reservation_id = _reservation.id;

  INSERT INTO public.reservation_table_assignments (
    reservation_id,
    table_id,
    sort_order,
    capacity_at_assignment,
    assigned_by
  )
  SELECT
    _reservation.id,
    selected.table_id,
    (selected.position - 1)::integer,
    GREATEST(rt.capacity, 1),
    auth.uid()
  FROM unnest(_normalized_table_ids)
    WITH ORDINALITY AS selected(table_id, position)
  JOIN public.restaurant_tables rt ON rt.id = selected.table_id
  ORDER BY selected.position;

  UPDATE public.reservations r
  SET
    table_id = _normalized_table_ids[1],
    table_assignment_note = NULL,
    updated_at = now()
  WHERE r.id = _reservation.id;

  IF _previous_table_ids IS DISTINCT FROM _normalized_table_ids THEN
    INSERT INTO public.reservation_audit_logs (
      reservation_id,
      company_id,
      actor_user_id,
      actor_name,
      actor_role,
      actor_source,
      action,
      summary,
      details
    ) VALUES (
      _reservation.id,
      _reservation.company_id,
      auth.uid(),
      public.get_reservation_audit_actor_name(auth.uid(), _reservation.guest_name, false),
      public.get_reservation_audit_actor_role(auth.uid(), _reservation.company_id, false),
      'panel',
      'updated',
      'Mesas da reserva atualizadas',
      jsonb_build_object(
        'changes', jsonb_build_object(
          'table_ids', jsonb_build_object(
            'old', to_jsonb(_previous_table_ids),
            'new', to_jsonb(_normalized_table_ids)
          )
        ),
        'assigned_capacity', _assigned_capacity,
        'party_size', _party_size,
        'under_capacity', _assigned_capacity < _party_size
      )
    );
  END IF;

  PERFORM set_config('app.multi_table_sync', '', true);

  RETURN QUERY SELECT
    _reservation.id,
    _normalized_table_ids[1],
    _normalized_table_ids,
    _assigned_capacity,
    GREATEST(COALESCE(_reservation.party_size, 1), 1),
    'assigned'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_reservation_tables(
  uuid, uuid[], boolean, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_reservation_tables(
  uuid, uuid[], boolean, text, boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_reservation_tables(
  uuid, uuid[], boolean, text, boolean
) TO service_role;
