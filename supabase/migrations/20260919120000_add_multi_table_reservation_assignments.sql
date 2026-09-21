-- Suporte interno a multiplas mesas por reserva.
--
-- Compatibilidade:
--   * public.reservations.table_id continua sendo a mesa primaria/legada;
--   * public.reservation_table_assignments e a fonte de verdade para ocupacao;
--   * escritas legadas que alteram table_id sincronizam uma atribuicao singular;
--   * a pagina publica continua escolhendo uma unica mesa, que e sincronizada
--     automaticamente para a tabela associativa.

-- ---------------------------------------------------------------------------
-- 1. Modelo, indices, backfill e RLS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.reservation_table_assignments (
  reservation_id uuid NOT NULL
    REFERENCES public.reservations(id) ON DELETE CASCADE,
  table_id uuid NOT NULL
    REFERENCES public.restaurant_tables(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  capacity_at_assignment integer NOT NULL,
  assigned_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, table_id),
  CONSTRAINT reservation_table_assignments_sort_order_check
    CHECK (sort_order >= 0),
  CONSTRAINT reservation_table_assignments_capacity_check
    CHECK (capacity_at_assignment > 0),
  CONSTRAINT reservation_table_assignments_reservation_sort_key
    UNIQUE (reservation_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_reservation_table_assignments_table
  ON public.reservation_table_assignments(table_id, reservation_id);

CREATE INDEX IF NOT EXISTS idx_reservation_table_assignments_reservation_order
  ON public.reservation_table_assignments(reservation_id, sort_order, table_id);

INSERT INTO public.reservation_table_assignments (
  reservation_id,
  table_id,
  sort_order,
  capacity_at_assignment,
  assigned_by
)
SELECT
  r.id,
  r.table_id,
  0,
  GREATEST(rt.capacity, 1),
  NULL
FROM public.reservations r
JOIN public.restaurant_tables rt
  ON rt.id = r.table_id
 AND rt.company_id = r.company_id
WHERE r.table_id IS NOT NULL
ON CONFLICT (reservation_id, table_id) DO NOTHING;

ALTER TABLE public.reservation_table_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.reservation_table_assignments FROM PUBLIC;
REVOKE ALL ON TABLE public.reservation_table_assignments FROM anon;
REVOKE ALL ON TABLE public.reservation_table_assignments FROM authenticated;

GRANT SELECT ON TABLE public.reservation_table_assignments TO authenticated;
GRANT ALL ON TABLE public.reservation_table_assignments TO service_role;

DROP POLICY IF EXISTS "Company staff can view reservation table assignments"
  ON public.reservation_table_assignments;
CREATE POLICY "Company staff can view reservation table assignments"
ON public.reservation_table_assignments
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.reservations r
    WHERE r.id = reservation_table_assignments.reservation_id
      AND (
        public.has_company_panel_permission(auth.uid(), r.company_id, 'reservations_view')
        OR public.has_company_panel_permission(auth.uid(), r.company_id, 'calendar_view')
      )
  )
);

-- Escritas antigas continuam representando uma selecao singular. A RPC
-- multi-mesa usa um GUC local e faz a sincronizacao completa por conta propria.
CREATE OR REPLACE FUNCTION public.sync_legacy_reservation_table_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('app.multi_table_sync', true), '') = 'rpc' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
     AND NEW.date IS NOT DISTINCT FROM OLD.date
     AND NEW.time IS NOT DISTINCT FROM OLD.time
     AND NEW.duration_minutes IS NOT DISTINCT FROM OLD.duration_minutes
     AND NEW.party_size IS NOT DISTINCT FROM OLD.party_size
     AND NEW.created_in_mode IS NOT DISTINCT FROM OLD.created_in_mode THEN
    RETURN NEW;
  END IF;

  DELETE FROM public.reservation_table_assignments a
  WHERE a.reservation_id = NEW.id;

  IF NEW.table_id IS NOT NULL THEN
    INSERT INTO public.reservation_table_assignments (
      reservation_id,
      table_id,
      sort_order,
      capacity_at_assignment,
      assigned_by
    )
    SELECT
      NEW.id,
      rt.id,
      0,
      GREATEST(rt.capacity, 1),
      auth.uid()
    FROM public.restaurant_tables rt
    WHERE rt.id = NEW.table_id
      AND rt.company_id = NEW.company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mesa invalida para a empresa da reserva.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_legacy_reservation_table_assignment
  ON public.reservations;
CREATE TRIGGER trg_sync_legacy_reservation_table_assignment
AFTER INSERT OR UPDATE OF
  table_id,
  company_id,
  date,
  time,
  duration_minutes,
  party_size,
  created_in_mode
ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.sync_legacy_reservation_table_assignment();

REVOKE ALL ON FUNCTION public.sync_legacy_reservation_table_assignment()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Conflito e escolha de mesa considerando todas as associacoes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reservation_table_conflict_id(
  _company_id uuid,
  _date date,
  _time time,
  _duration_minutes integer,
  _table_id uuid,
  _exclude_reservation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id
  FROM public.reservation_table_assignments a
  JOIN public.reservations r ON r.id = a.reservation_id
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND a.table_id = _table_id
    AND _table_id IS NOT NULL
    AND (_exclude_reservation_id IS NULL OR r.id <> _exclude_reservation_id)
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
    AND (_date + r.time) < (
      _date + _time + make_interval(mins => GREATEST(_duration_minutes, 1))
    )
    AND (
      _date + r.time
      + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
    ) > (_date + _time)
  ORDER BY r.time ASC, r.created_at ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.reservation_table_conflict_id(
  uuid, date, time, integer, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reservation_table_conflict_id(
  uuid, date, time, integer, uuid, uuid
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reservation_table_conflict_id(
  uuid, date, time, integer, uuid, uuid
) TO service_role;

-- Protege tambem escritas singulares antigas/diretas. As RPCs publicas e de
-- painel usam o mesmo advisory lock; a revalidacao abaixo impede que uma mesa
-- secundaria, invisivel em reservations.table_id, seja reservada em paralelo.
CREATE OR REPLACE FUNCTION public.validate_reservation_primary_table_conflict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _conflict_id uuid;
  _duration_minutes integer;
BEGIN
  IF COALESCE(current_setting('app.multi_table_sync', true), '') = 'rpc'
     OR NEW.table_id IS NULL
     OR NOT public.is_reservation_occupying_capacity(
       NEW.id,
       NEW.status,
       COALESCE(NEW.created_at, now())
     ) THEN
    RETURN NEW;
  END IF;

  _duration_minutes := GREATEST(
    COALESCE(
      NEW.duration_minutes,
      public.resolve_reservation_slot_duration(NEW.company_id, NEW.date, NEW.time),
      30
    ),
    1
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      format('reservation-table|%s|%s', NEW.table_id::text, NEW.date::text),
      0
    )
  );

  _conflict_id := public.reservation_table_conflict_id(
    NEW.company_id,
    NEW.date,
    NEW.time,
    _duration_minutes,
    NEW.table_id,
    NEW.id
  );

  IF _conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'Mesa indisponivel para este horario.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_reservation_primary_table_conflict
  ON public.reservations;
CREATE TRIGGER trg_validate_reservation_primary_table_conflict
AFTER INSERT OR UPDATE OF
  table_id,
  company_id,
  date,
  time,
  duration_minutes,
  status
ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.validate_reservation_primary_table_conflict();

REVOKE ALL ON FUNCTION public.validate_reservation_primary_table_conflict()
  FROM PUBLIC, anon, authenticated;

-- pick_best_fit_reservation_table ja delega o conflito ao helper acima. A
-- assinatura e o criterio singular permanecem compativeis com pagina publica,
-- criacao antiga no painel e conversao de fila.

CREATE OR REPLACE FUNCTION public.get_occupied_table_ids(
  _company_id uuid,
  _date date,
  _time time
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_slot AS (
    SELECT public.resolve_reservation_slot_duration(
      _company_id, _date, _time
    ) AS duration_minutes
  )
  SELECT COALESCE(array_agg(DISTINCT a.table_id), '{}'::uuid[])
  FROM public.reservation_table_assignments a
  JOIN public.reservations r ON r.id = a.reservation_id
  CROSS JOIN requested_slot requested
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
    AND (_date + r.time) < (
      _date + _time + make_interval(mins => requested.duration_minutes)
    )
    AND (
      _date + r.time
      + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
    ) > (_date + _time);
$$;

REVOKE ALL ON FUNCTION public.get_occupied_table_ids(uuid, date, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO anon;
GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Leitura e atribuicao atomica de varias mesas
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_reservation_table_assignments(
  _reservation_id uuid
)
RETURNS TABLE (
  table_id uuid,
  table_number integer,
  section_code text,
  section_name text,
  capacity integer,
  table_map_id uuid,
  table_map_name text,
  sort_order integer,
  is_primary boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company_id uuid;
BEGIN
  SELECT r.company_id
  INTO _company_id
  FROM public.reservations r
  WHERE r.id = _reservation_id;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Reserva nao encontrada.';
  END IF;

  IF auth.uid() IS NULL
     OR NOT (
       public.has_company_panel_permission(auth.uid(), _company_id, 'reservations_view')
       OR public.has_company_panel_permission(auth.uid(), _company_id, 'calendar_view')
     ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  RETURN QUERY
  SELECT
    rt.id,
    rt.number,
    rt.section,
    COALESCE(ts.name, rt.section),
    rt.capacity,
    rt.table_map_id,
    tm.name,
    a.sort_order,
    (a.sort_order = 0)
  FROM public.reservation_table_assignments a
  JOIN public.restaurant_tables rt ON rt.id = a.table_id
  LEFT JOIN public.table_sections ts
    ON ts.company_id = rt.company_id
   AND ts.code = rt.section
  LEFT JOIN public.table_maps tm ON tm.id = rt.table_map_id
  WHERE a.reservation_id = _reservation_id
  ORDER BY a.sort_order, rt.number, rt.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_reservation_table_assignments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reservation_table_assignments(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_reservation_table_assignments(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.assign_reservation_tables(
  _reservation_id uuid,
  _table_ids uuid[],
  _allow_unassigned boolean DEFAULT false,
  _assignment_note text DEFAULT NULL
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

  IF _assigned_capacity < GREATEST(COALESCE(_reservation.party_size, 1), 1) THEN
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
        )
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
  uuid, uuid[], boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_reservation_tables(
  uuid, uuid[], boolean, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_reservation_tables(
  uuid, uuid[], boolean, text
) TO service_role;

-- Wrapper retrocompativel para clientes que ainda enviam uma unica mesa.
CREATE OR REPLACE FUNCTION public.assign_reservation_table(
  _reservation_id uuid,
  _table_id uuid DEFAULT NULL,
  _allow_unassigned boolean DEFAULT false,
  _assignment_note text DEFAULT NULL
)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _updated public.reservations%ROWTYPE;
BEGIN
  PERFORM 1
  FROM public.assign_reservation_tables(
    _reservation_id,
    CASE
      WHEN _table_id IS NULL THEN '{}'::uuid[]
      ELSE ARRAY[_table_id]::uuid[]
    END,
    _allow_unassigned,
    _assignment_note
  )
  LIMIT 1;

  SELECT *
  INTO _updated
  FROM public.reservations r
  WHERE r.id = _reservation_id;

  RETURN _updated;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_reservation_table(
  uuid, uuid, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_reservation_table(
  uuid, uuid, boolean, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_reservation_table(
  uuid, uuid, boolean, text
) TO service_role;

-- A lista administrativa deixa de exigir que cada mesa comporte o grupo
-- inteiro. A capacidade combinada e validada somente no salvamento atomico.
DROP FUNCTION IF EXISTS public.get_reservation_table_options(
  uuid, date, time, integer, integer, uuid
);

CREATE OR REPLACE FUNCTION public.get_reservation_table_options(
  _company_id uuid,
  _date date,
  _time time,
  _party_size integer,
  _duration_minutes integer DEFAULT NULL,
  _reservation_id uuid DEFAULT NULL
)
RETURNS TABLE (
  table_id uuid,
  table_number integer,
  section_code text,
  section_name text,
  capacity integer,
  table_map_id uuid,
  table_map_name text,
  available boolean,
  conflict_reservation_id uuid,
  conflict_guest_name text,
  recommended boolean,
  selected boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _duration integer;
  _active_map_id uuid;
  _active_map_name text;
  _best_fit_table_id uuid;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (
       public.has_company_panel_permission(auth.uid(), _company_id, 'reservations_view')
       OR public.has_company_panel_permission(auth.uid(), _company_id, 'calendar_view')
     ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF _date IS NULL OR _time IS NULL THEN
    RETURN;
  END IF;

  _duration := GREATEST(
    COALESCE(
      _duration_minutes,
      public.resolve_reservation_slot_duration(_company_id, _date, _time),
      30
    ),
    1
  );

  SELECT active_map.id, active_map.name
  INTO _active_map_id, _active_map_name
  FROM public.get_active_table_map(
    _company_id,
    (_date + _time)::timestamptz
  ) active_map
  LIMIT 1;

  _best_fit_table_id := public.pick_best_fit_reservation_table(
    _company_id,
    _date,
    _time,
    _duration,
    GREATEST(COALESCE(_party_size, 1), 1),
    _active_map_id,
    _reservation_id
  );

  RETURN QUERY
  SELECT
    rt.id,
    rt.number,
    rt.section,
    COALESCE(ts.name, rt.section),
    rt.capacity,
    rt.table_map_id,
    _active_map_name,
    (conflict.conflict_id IS NULL),
    conflict.conflict_id,
    conflict.guest_name,
    (rt.id = _best_fit_table_id),
    (selected_assignment.reservation_id IS NOT NULL)
  FROM public.restaurant_tables rt
  LEFT JOIN public.table_sections ts
    ON ts.company_id = rt.company_id
   AND ts.code = rt.section
  LEFT JOIN public.reservation_table_assignments selected_assignment
    ON selected_assignment.reservation_id = _reservation_id
   AND selected_assignment.table_id = rt.id
  LEFT JOIN LATERAL (
    SELECT
      c.id AS conflict_id,
      cr.guest_name
    FROM public.reservation_table_conflict_id(
      _company_id,
      _date,
      _time,
      _duration,
      rt.id,
      _reservation_id
    ) AS c(id)
    LEFT JOIN public.reservations cr ON cr.id = c.id
    WHERE c.id IS NOT NULL
  ) conflict ON true
  WHERE rt.company_id = _company_id
    AND rt.status = 'available'
    AND (_active_map_id IS NULL OR rt.table_map_id = _active_map_id)
  ORDER BY
    (selected_assignment.reservation_id IS NOT NULL) DESC,
    rt.capacity ASC,
    rt.number ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_reservation_table_options(
  uuid, date, time, integer, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reservation_table_options(
  uuid, date, time, integer, integer, uuid
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_reservation_table_options(
  uuid, date, time, integer, integer, uuid
) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Disponibilidade publica: pessoas uma vez, todas as mesas ocupadas
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_public_reservation_availability(
  _company_id uuid,
  _date date,
  _party_size integer
)
RETURNS TABLE (
  time_slot time,
  available boolean,
  unavailable_reason text,
  total_tables integer,
  occupied_tables integer,
  available_tables integer,
  total_guests integer,
  reservation_count integer,
  max_party_size_per_reservation integer,
  max_reservations_per_slot integer,
  availability_mode text,
  duration_minutes integer,
  max_guests_per_slot integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company AS (
    SELECT
      c.id,
      GREATEST(COALESCE(c.reservation_duration, 30), 1) AS duration_minutes,
      COALESCE(c.max_guests_per_slot, 0) AS max_guests_per_slot
    FROM public.companies c
    WHERE c.id = _company_id
      AND c.status = 'active'
    LIMIT 1
  ),
  schedule AS (
    SELECT resolved.*
    FROM public.get_public_reservation_schedule(_company_id, _date) resolved
    WHERE resolved.source <> 'blocked'
  ),
  allowed_slots AS (
    SELECT
      slot_value::time AS time_slot,
      schedule.rule_id,
      schedule.block_id,
      schedule.availability_mode,
      schedule.default_duration_minutes,
      schedule.max_party_size_per_reservation AS rule_max_party_size
    FROM schedule
    CROSS JOIN LATERAL jsonb_array_elements_text(
      COALESCE(schedule.slots, '[]'::jsonb)
    ) slot_value
  ),
  resolved_slots AS (
    SELECT
      allowed.time_slot,
      COALESCE(allowed.availability_mode, 'tables') AS availability_mode,
      GREATEST(
        COALESCE(
          slot.duration_minutes,
          allowed.default_duration_minutes,
          company.duration_minutes,
          30
        ),
        1
      ) AS duration_minutes,
      COALESCE(
        slot.max_party_size_per_reservation,
        allowed.rule_max_party_size
      ) AS max_party_size_per_reservation,
      slot.max_reservations_per_slot,
      slot.max_guests_per_slot,
      company.max_guests_per_slot AS company_max_guests_per_slot,
      EXISTS (
        SELECT 1
        FROM public.blocked_dates bd
        WHERE bd.company_id = _company_id
          AND bd.date = _date
          AND (
            bd.all_day = true
            OR (
              bd.all_day = false
              AND allowed.time_slot >= COALESCE(bd.start_time, '00:00'::time)
              AND allowed.time_slot < COALESCE(bd.end_time, '23:59:59'::time)
            )
          )
      ) AS is_blocked
    FROM allowed_slots allowed
    CROSS JOIN company
    LEFT JOIN LATERAL (
      SELECT rule_slot.*
      FROM public.reservation_schedule_rule_slots rule_slot
      WHERE rule_slot.time = allowed.time_slot
        AND (
          rule_slot.block_id = allowed.block_id
          OR (
            rule_slot.block_id IS NULL
            AND rule_slot.rule_id = allowed.rule_id
          )
        )
      ORDER BY
        CASE WHEN rule_slot.block_id = allowed.block_id THEN 0 ELSE 1 END,
        rule_slot.sort_order,
        rule_slot.created_at
      LIMIT 1
    ) slot ON true
  ),
  slot_context AS (
    SELECT
      resolved.*,
      active_map.id AS active_table_map_id
    FROM resolved_slots resolved
    LEFT JOIN LATERAL public.get_active_table_map(
      _company_id,
      (_date + resolved.time_slot)::timestamptz
    ) active_map ON true
  ),
  slot_metrics AS (
    SELECT
      context.*,
      (
        SELECT COALESCE(sum(r.party_size), 0)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
          AND (_date + r.time) < (
            _date + context.time_slot
            + make_interval(mins => context.duration_minutes)
          )
          AND (
            _date + r.time
            + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
          ) > (_date + context.time_slot)
      ) AS overlapping_guest_count,
      (
        SELECT count(*)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND r.time = context.time_slot
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      ) AS same_time_reservation_count,
      CASE
        WHEN context.availability_mode = 'capacity'
          THEN COALESCE(context.max_guests_per_slot, 0)
        ELSE (
          SELECT count(*)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (
              context.active_table_map_id IS NULL
              OR rt.table_map_id = context.active_table_map_id
            )
        )
      END AS total_units,
      CASE
        WHEN context.availability_mode = 'capacity' THEN (
          SELECT COALESCE(sum(r.party_size), 0)::integer
          FROM public.reservations r
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (
              _date + context.time_slot
              + make_interval(mins => context.duration_minutes)
            )
            AND (
              _date + r.time
              + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
        ELSE (
          SELECT count(DISTINCT a.table_id)::integer
          FROM public.reservation_table_assignments a
          JOIN public.reservations r ON r.id = a.reservation_id
          JOIN public.restaurant_tables rt ON rt.id = a.table_id
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (
              context.active_table_map_id IS NULL
              OR rt.table_map_id = context.active_table_map_id
            )
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (
              _date + context.time_slot
              + make_interval(mins => context.duration_minutes)
            )
            AND (
              _date + r.time
              + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
      END AS occupied_units,
      CASE
        WHEN context.availability_mode = 'capacity' THEN GREATEST(
          COALESCE(context.max_guests_per_slot, 0) - (
            SELECT COALESCE(sum(r.party_size), 0)::integer
            FROM public.reservations r
            WHERE r.company_id = _company_id
              AND r.date = _date
              AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
              AND (_date + r.time) < (
                _date + context.time_slot
                + make_interval(mins => context.duration_minutes)
              )
              AND (
                _date + r.time
                + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
              ) > (_date + context.time_slot)
          ),
          0
        )
        ELSE (
          SELECT count(*)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (
              context.active_table_map_id IS NULL
              OR rt.table_map_id = context.active_table_map_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.reservation_table_assignments a
              JOIN public.reservations r ON r.id = a.reservation_id
              WHERE a.table_id = rt.id
                AND r.company_id = _company_id
                AND r.date = _date
                AND public.is_reservation_occupying_capacity(
                  r.id, r.status, r.created_at
                )
                AND (_date + r.time) < (
                  _date + context.time_slot
                  + make_interval(mins => context.duration_minutes)
                )
                AND (
                  _date + r.time
                  + make_interval(
                    mins => GREATEST(COALESCE(r.duration_minutes, 30), 1)
                  )
                ) > (_date + context.time_slot)
            )
        )
      END AS available_units,
      (
        SELECT count(*)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND COALESCE(r.created_in_mode, 'tables') = 'tables'
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
          AND (_date + r.time) < (
            _date + context.time_slot
            + make_interval(mins => context.duration_minutes)
          )
          AND (
            _date + r.time
            + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
          ) > (_date + context.time_slot)
          AND NOT EXISTS (
            SELECT 1
            FROM public.reservation_table_assignments a
            WHERE a.reservation_id = r.id
          )
      ) AS unassigned_table_reservation_count
    FROM slot_context context
  ),
  normalized_metrics AS (
    SELECT
      metrics.*,
      CASE
        WHEN metrics.availability_mode = 'tables' THEN GREATEST(
          metrics.available_units - metrics.unassigned_table_reservation_count,
          0
        )
        ELSE metrics.available_units
      END AS effective_available_units,
      CASE
        WHEN metrics.availability_mode = 'capacity'
          THEN metrics.max_guests_per_slot
        ELSE COALESCE(
          metrics.max_guests_per_slot,
          NULLIF(metrics.company_max_guests_per_slot, 0)
        )
      END AS effective_max_guests_per_slot
    FROM slot_metrics metrics
  )
  SELECT
    metrics.time_slot,
    CASE
      WHEN metrics.is_blocked THEN false
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN false
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.same_time_reservation_count >= metrics.max_reservations_per_slot THEN false
      WHEN metrics.availability_mode = 'capacity'
        AND COALESCE(metrics.max_guests_per_slot, 0) <= 0 THEN false
      WHEN metrics.availability_mode = 'capacity'
        AND metrics.overlapping_guest_count + _party_size
          > COALESCE(metrics.max_guests_per_slot, 0) THEN false
      WHEN metrics.availability_mode = 'tables'
        AND COALESCE(metrics.effective_max_guests_per_slot, 0) > 0
        AND metrics.overlapping_guest_count + _party_size
          > metrics.effective_max_guests_per_slot THEN false
      WHEN metrics.availability_mode = 'tables'
        AND metrics.effective_available_units <= 0 THEN false
      ELSE true
    END,
    CASE
      WHEN metrics.is_blocked THEN 'blocked'
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN 'party_size_limit'
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.same_time_reservation_count >= metrics.max_reservations_per_slot
        THEN 'reservation_limit'
      WHEN metrics.availability_mode = 'capacity'
        AND COALESCE(metrics.max_guests_per_slot, 0) <= 0
        THEN 'capacity_limit_missing'
      WHEN metrics.availability_mode = 'capacity'
        AND metrics.overlapping_guest_count + _party_size
          > COALESCE(metrics.max_guests_per_slot, 0) THEN 'guest_limit'
      WHEN metrics.availability_mode = 'tables'
        AND COALESCE(metrics.effective_max_guests_per_slot, 0) > 0
        AND metrics.overlapping_guest_count + _party_size
          > metrics.effective_max_guests_per_slot THEN 'guest_limit'
      WHEN metrics.availability_mode = 'tables'
        AND metrics.effective_available_units <= 0 THEN 'no_table'
      ELSE NULL
    END,
    metrics.total_units,
    CASE
      WHEN metrics.availability_mode = 'tables'
        THEN GREATEST(metrics.total_units - metrics.effective_available_units, 0)
      ELSE metrics.occupied_units
    END,
    metrics.effective_available_units,
    metrics.overlapping_guest_count,
    metrics.same_time_reservation_count,
    metrics.max_party_size_per_reservation,
    metrics.max_reservations_per_slot,
    metrics.availability_mode,
    metrics.duration_minutes,
    metrics.effective_max_guests_per_slot
  FROM normalized_metrics metrics
  WHERE _party_size BETWEEN 1 AND 20
  ORDER BY metrics.time_slot;
$$;

REVOKE ALL ON FUNCTION public.get_public_reservation_availability(
  uuid, date, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(
  uuid, date, integer
) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(
  uuid, date, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(
  uuid, date, integer
) TO service_role;

-- create_public_reservation permanece com o mesmo OID e contrato. O trigger
-- trg_validate_reservation_primary_table_conflict faz a revalidacao final
-- contra todas as associacoes sem renomear ou encapsular a RPC publica.

-- ---------------------------------------------------------------------------
-- 5. Capacidade administrativa sem multiplicar reservas/pessoas
-- ---------------------------------------------------------------------------

-- A RPC existente continua calculando pessoas, chegadas, pagamentos e faixas
-- mantendo uma linha por reserva. Esta variante preserva o OID/contrato antigo
-- e substitui apenas as metricas/JSON de mesa pelas associacoes N:N.
CREATE OR REPLACE FUNCTION public.get_admin_reservation_day_capacity_with_tables(
  _company_id uuid,
  _date date
)
RETURNS TABLE (
  time_slot time,
  slot_start timestamptz,
  slot_end timestamptz,
  slot_label text,
  source text,
  rule_id uuid,
  rule_name text,
  block_id uuid,
  block_name text,
  availability_mode text,
  active_table_map_id uuid,
  active_table_map_name text,
  duration_minutes integer,
  capacity_limit integer,
  occupying_guest_count integer,
  arrival_guest_count integer,
  checked_in_guest_count integer,
  remaining_capacity integer,
  fill_rate numeric,
  arrival_reservation_count integer,
  occupying_reservation_count integer,
  total_tables integer,
  occupied_tables integer,
  available_tables integer,
  unassigned_reservation_count integer,
  reservation_limit integer,
  blocked boolean,
  configuration_issue text,
  status text,
  reservations jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    legacy.time_slot,
    legacy.slot_start,
    legacy.slot_end,
    legacy.slot_label,
    legacy.source,
    legacy.rule_id,
    legacy.rule_name,
    legacy.block_id,
    legacy.block_name,
    legacy.availability_mode,
    legacy.active_table_map_id,
    legacy.active_table_map_name,
    legacy.duration_minutes,
    legacy.capacity_limit,
    legacy.occupying_guest_count,
    legacy.arrival_guest_count,
    legacy.checked_in_guest_count,
    legacy.remaining_capacity,
    legacy.fill_rate,
    legacy.arrival_reservation_count,
    legacy.occupying_reservation_count,
    legacy.total_tables,
    CASE
      WHEN legacy.time_slot IS NULL THEN legacy.occupied_tables
      ELSE COALESCE(occupied.value, 0)
    END AS occupied_tables,
    CASE
      WHEN legacy.time_slot IS NULL THEN legacy.available_tables
      ELSE GREATEST(legacy.total_tables - COALESCE(occupied.value, 0), 0)
    END AS available_tables,
    CASE
      WHEN legacy.time_slot IS NULL THEN legacy.unassigned_reservation_count
      WHEN legacy.availability_mode <> 'tables' THEN 0
      ELSE COALESCE(unassigned.value, 0)
    END AS unassigned_reservation_count,
    legacy.reservation_limit,
    legacy.blocked,
    legacy.configuration_issue,
    legacy.status,
    COALESCE(enriched.value, '[]'::jsonb) AS reservations
  FROM public.get_admin_reservation_day_capacity(
    _company_id,
    _date
  ) legacy
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT a.table_id)::integer AS value
    FROM public.reservation_table_assignments a
    JOIN public.reservations r ON r.id = a.reservation_id
    JOIN public.restaurant_tables rt ON rt.id = a.table_id
    WHERE legacy.time_slot IS NOT NULL
      AND r.company_id = _company_id
      AND r.date = _date
      AND rt.status = 'available'
      AND (
        legacy.active_table_map_id IS NULL
        OR rt.table_map_id = legacy.active_table_map_id
      )
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      AND (_date + r.time) < (
        _date + legacy.time_slot
        + make_interval(mins => GREATEST(legacy.duration_minutes, 1))
      )
      AND (
        _date + r.time
        + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
      ) > (_date + legacy.time_slot)
  ) occupied ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS value
    FROM public.reservations r
    WHERE legacy.time_slot IS NOT NULL
      AND r.company_id = _company_id
      AND r.date = _date
      AND COALESCE(r.created_in_mode, 'tables') = 'tables'
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      AND (_date + r.time) < (
        _date + legacy.time_slot
        + make_interval(mins => GREATEST(legacy.duration_minutes, 1))
      )
      AND (
        _date + r.time
        + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
      ) > (_date + legacy.time_slot)
      AND NOT EXISTS (
        SELECT 1
        FROM public.reservation_table_assignments a
        WHERE a.reservation_id = r.id
      )
  ) unassigned ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      jsonb_agg(
        item.value
        || jsonb_build_object(
          'table_assignments', COALESCE(assignments.value, '[]'::jsonb),
          'tables', COALESCE(assignments.value, '[]'::jsonb),
          'assigned_table_count', COALESCE(assignments.table_count, 0),
          'assigned_capacity', COALESCE(assignments.total_capacity, 0)
        )
        ORDER BY item.position
      ),
      '[]'::jsonb
    ) AS value
    FROM jsonb_array_elements(COALESCE(legacy.reservations, '[]'::jsonb))
      WITH ORDINALITY AS item(value, position)
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'table_id', rt.id,
              'table_number', rt.number,
              'section_code', rt.section,
              'section_name', COALESCE(ts.name, rt.section),
              'capacity', rt.capacity,
              'table_map_id', rt.table_map_id,
              'table_map_name', tm.name,
              'sort_order', a.sort_order,
              'is_primary', (a.sort_order = 0)
            )
            ORDER BY a.sort_order, rt.number, rt.id
          ),
          '[]'::jsonb
        ) AS value,
        count(*)::integer AS table_count,
        COALESCE(sum(rt.capacity), 0)::integer AS total_capacity
      FROM public.reservation_table_assignments a
      JOIN public.restaurant_tables rt ON rt.id = a.table_id
      LEFT JOIN public.table_sections ts
        ON ts.company_id = rt.company_id
       AND ts.code = rt.section
      LEFT JOIN public.table_maps tm ON tm.id = rt.table_map_id
      WHERE a.reservation_id = (item.value ->> 'id')::uuid
    ) assignments ON true
  ) enriched ON true;
$$;

COMMENT ON FUNCTION public.get_admin_reservation_day_capacity_with_tables(uuid, date)
IS 'Capacidade operacional diaria com atribuicoes multi-mesa, sem multiplicar pessoas.';

REVOKE ALL ON FUNCTION public.get_admin_reservation_day_capacity_with_tables(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_reservation_day_capacity_with_tables(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_reservation_day_capacity_with_tables(uuid, date) TO service_role;
