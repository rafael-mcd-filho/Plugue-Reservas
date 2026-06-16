-- Fundacao para criacao/edicao/atribuicao administrativa segura (Fases 4, 5 e 6).
--
-- 1. Colunas de estado de atribuicao de mesa (table_assignment_state/note).
-- 2. Helpers SQL que encapsulam o predicado de sobreposicao por duracao uma unica
--    vez, para serem reusados pelas RPCs de painel.
-- 3. get_reservation_table_options: lista as mesas do mapa ativo de um horario,
--    indicando disponibilidade, conflito e a mesa recomendada (best-fit).

-- ---------------------------------------------------------------------------
-- 1. Estado de atribuicao de mesa
-- ---------------------------------------------------------------------------

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS table_assignment_state text,
  ADD COLUMN IF NOT EXISTS table_assignment_note text;

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_table_assignment_state_check,
  ADD CONSTRAINT reservations_table_assignment_state_check
  CHECK (
    table_assignment_state IS NULL
    OR table_assignment_state IN ('assigned', 'pending', 'not_required')
  );

-- Backfill por inferencia. Statuses terminais nao precisam mais de mesa.
UPDATE public.reservations
SET table_assignment_state = CASE
  WHEN table_id IS NOT NULL THEN 'assigned'
  WHEN created_in_mode = 'capacity' THEN 'not_required'
  WHEN status IN ('cancelled', 'no-show', 'no_show', 'payment_expired', 'payment_cancelled') THEN 'not_required'
  ELSE 'pending'
END
WHERE table_assignment_state IS NULL;

-- Mantem table_assignment_state coerente com table_id/created_in_mode em qualquer
-- escrita. O motivo (table_assignment_note) continua sob controle das RPCs.
CREATE OR REPLACE FUNCTION public.sync_reservation_table_assignment_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.table_assignment_state := CASE
    WHEN NEW.table_id IS NOT NULL THEN 'assigned'
    WHEN NEW.created_in_mode = 'capacity' THEN 'not_required'
    ELSE 'pending'
  END;

  IF NEW.table_id IS NOT NULL THEN
    NEW.table_assignment_note := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_reservation_table_assignment_state ON public.reservations;
CREATE TRIGGER trg_sync_reservation_table_assignment_state
BEFORE INSERT OR UPDATE OF table_id, created_in_mode
ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.sync_reservation_table_assignment_state();

-- ---------------------------------------------------------------------------
-- 2. Helpers de sobreposicao (predicado de duracao centralizado)
-- ---------------------------------------------------------------------------

-- Total de pessoas ocupando capacidade que se sobrepoem a janela do horario.
CREATE OR REPLACE FUNCTION public.count_overlapping_reservation_guests(
  _company_id uuid,
  _date date,
  _time time,
  _duration_minutes integer,
  _exclude_reservation_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(r.party_size), 0)::integer
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND (_exclude_reservation_id IS NULL OR r.id <> _exclude_reservation_id)
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
    AND (_date + r.time) < (_date + _time + make_interval(mins => GREATEST(_duration_minutes, 1)))
    AND (
      _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
    ) > (_date + _time);
$$;

REVOKE ALL ON FUNCTION public.count_overlapping_reservation_guests(uuid, date, time, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_overlapping_reservation_guests(uuid, date, time, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_overlapping_reservation_guests(uuid, date, time, integer, uuid) TO service_role;

-- Quantidade de reservas que chegam exatamente no horario (para max_reservations_per_slot).
CREATE OR REPLACE FUNCTION public.count_slot_arrival_reservations(
  _company_id uuid,
  _date date,
  _time time,
  _exclude_reservation_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.time = _time
    AND (_exclude_reservation_id IS NULL OR r.id <> _exclude_reservation_id)
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at);
$$;

REVOKE ALL ON FUNCTION public.count_slot_arrival_reservations(uuid, date, time, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_slot_arrival_reservations(uuid, date, time, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_slot_arrival_reservations(uuid, date, time, uuid) TO service_role;

-- A mesa esta em conflito (ocupada por reserva sobreposta) na janela do horario?
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
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.table_id = _table_id
    AND _table_id IS NOT NULL
    AND (_exclude_reservation_id IS NULL OR r.id <> _exclude_reservation_id)
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
    AND (_date + r.time) < (_date + _time + make_interval(mins => GREATEST(_duration_minutes, 1)))
    AND (
      _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
    ) > (_date + _time)
  ORDER BY r.time ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.reservation_table_conflict_id(uuid, date, time, integer, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reservation_table_conflict_id(uuid, date, time, integer, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reservation_table_conflict_id(uuid, date, time, integer, uuid, uuid) TO service_role;

-- Menor mesa disponivel que comporta o grupo, sem conflito, no mapa ativo.
CREATE OR REPLACE FUNCTION public.pick_best_fit_reservation_table(
  _company_id uuid,
  _date date,
  _time time,
  _duration_minutes integer,
  _party_size integer,
  _active_table_map_id uuid,
  _exclude_reservation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rt.id
  FROM public.restaurant_tables rt
  WHERE rt.company_id = _company_id
    AND rt.status = 'available'
    AND rt.capacity >= _party_size
    AND (_active_table_map_id IS NULL OR rt.table_map_id = _active_table_map_id)
    AND public.reservation_table_conflict_id(
      _company_id, _date, _time, _duration_minutes, rt.id, _exclude_reservation_id
    ) IS NULL
  ORDER BY rt.capacity ASC, rt.number ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.pick_best_fit_reservation_table(uuid, date, time, integer, integer, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_best_fit_reservation_table(uuid, date, time, integer, integer, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pick_best_fit_reservation_table(uuid, date, time, integer, integer, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. get_reservation_table_options
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_reservation_table_options(uuid, date, time, integer, integer, uuid);

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
  recommended boolean
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
    COALESCE(_duration_minutes, public.resolve_reservation_slot_duration(_company_id, _date, _time), 30),
    1
  );

  SELECT active_map.id, active_map.name
  INTO _active_map_id, _active_map_name
  FROM public.get_active_table_map(_company_id, (_date + _time)::timestamptz) active_map
  LIMIT 1;

  _best_fit_table_id := public.pick_best_fit_reservation_table(
    _company_id, _date, _time, _duration, GREATEST(COALESCE(_party_size, 1), 1), _active_map_id, _reservation_id
  );

  RETURN QUERY
  SELECT
    rt.id AS table_id,
    rt.number AS table_number,
    rt.section AS section_code,
    rt.section AS section_name,
    rt.capacity,
    rt.table_map_id,
    _active_map_name AS table_map_name,
    (
      rt.capacity >= GREATEST(COALESCE(_party_size, 1), 1)
      AND conflict.conflict_id IS NULL
    ) AS available,
    conflict.conflict_id AS conflict_reservation_id,
    conflict.guest_name AS conflict_guest_name,
    (rt.id = _best_fit_table_id) AS recommended
  FROM public.restaurant_tables rt
  LEFT JOIN LATERAL (
    SELECT
      c.id AS conflict_id,
      cr.guest_name
    FROM public.reservation_table_conflict_id(
      _company_id, _date, _time, _duration, rt.id, _reservation_id
    ) AS c(id)
    LEFT JOIN public.reservations cr ON cr.id = c.id
    WHERE c.id IS NOT NULL
  ) conflict ON true
  WHERE rt.company_id = _company_id
    AND rt.status = 'available'
    AND (_active_map_id IS NULL OR rt.table_map_id = _active_map_id)
  ORDER BY rt.capacity ASC, rt.number ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_reservation_table_options(uuid, date, time, integer, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reservation_table_options(uuid, date, time, integer, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_reservation_table_options(uuid, date, time, integer, integer, uuid) TO service_role;
