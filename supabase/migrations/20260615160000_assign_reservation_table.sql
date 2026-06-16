-- Fase 6 do plano: atribuicao explicita de mesa.
--
-- Acao rapida para atribuir ou trocar a mesa de uma reserva, validando
-- capacidade da mesa, mapa ativo e conflito por sobreposicao de duracao.
-- Passar _table_id = NULL com _allow_unassigned marca a reserva como
-- "alocar depois" (pendente de mesa) com um motivo.

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
  _reservation public.reservations%ROWTYPE;
  _updated public.reservations%ROWTYPE;
  _duration_minutes integer;
  _party_size integer;
  _active_table_map_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  SELECT *
  INTO _reservation
  FROM public.reservations
  WHERE id = _reservation_id
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

  _party_size := GREATEST(COALESCE(_reservation.party_size, 1), 1);
  _duration_minutes := GREATEST(
    COALESCE(
      _reservation.duration_minutes,
      public.resolve_reservation_slot_duration(_reservation.company_id, _reservation.date, _reservation.time),
      30
    ),
    1
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('reservation-slot|%s|%s|%s', _reservation.company_id::text, _reservation.date::text, _reservation.time::text), 0)
  );

  IF _table_id IS NULL THEN
    IF NOT COALESCE(_allow_unassigned, false) THEN
      RAISE EXCEPTION 'Informe uma mesa ou use "alocar depois".';
    END IF;

    UPDATE public.reservations
    SET
      table_id = NULL,
      table_assignment_note = COALESCE(NULLIF(btrim(_assignment_note), ''), 'Alocar mesa depois'),
      updated_at = now()
    WHERE id = _reservation_id
    RETURNING *
    INTO _updated;

    RETURN _updated;
  END IF;

  SELECT active_map.id
  INTO _active_table_map_id
  FROM public.get_active_table_map(_reservation.company_id, (_reservation.date + _reservation.time)::timestamptz) active_map
  LIMIT 1;

  IF NOT EXISTS (
    SELECT 1
    FROM public.restaurant_tables rt
    WHERE rt.id = _table_id
      AND rt.company_id = _reservation.company_id
      AND rt.status = 'available'
      AND rt.capacity >= _party_size
      AND (_active_table_map_id IS NULL OR rt.table_map_id = _active_table_map_id)
  ) THEN
    RAISE EXCEPTION 'Mesa indisponivel para este numero de pessoas.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('reservation-table|%s|%s', _table_id::text, _reservation.date::text), 0)
  );

  IF public.reservation_table_conflict_id(
    _reservation.company_id, _reservation.date, _reservation.time, _duration_minutes, _table_id, _reservation_id
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Mesa ja ocupada neste horario.';
  END IF;

  UPDATE public.reservations
  SET
    table_id = _table_id,
    table_assignment_note = NULL,
    updated_at = now()
  WHERE id = _reservation_id
  RETURNING *
  INTO _updated;

  RETURN _updated;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_reservation_table(uuid, uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_reservation_table(uuid, uuid, boolean, text) TO authenticated;
