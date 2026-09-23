-- Reduz round-trips no fluxo publico de reservas.
--
-- 1. A pagina pode buscar uma janela inteira de agendas em uma unica RPC.
-- 2. A escolha da data recebe agenda, disponibilidade e a melhor mesa em uma
--    unica resposta. A criacao continua revalidando tudo atomicamente.

CREATE OR REPLACE FUNCTION public.get_public_reservation_schedule_range(
  _company_id uuid,
  _start_date date,
  _end_date date
)
RETURNS TABLE (
  reservation_date date,
  source text,
  rule_id uuid,
  rule_name text,
  block_id uuid,
  block_name text,
  slots jsonb,
  max_party_size_per_reservation integer,
  availability_mode text,
  publish_at timestamptz,
  default_duration_minutes integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    requested.day::date,
    schedule.source,
    schedule.rule_id,
    schedule.rule_name,
    schedule.block_id,
    schedule.block_name,
    schedule.slots,
    schedule.max_party_size_per_reservation,
    schedule.availability_mode,
    schedule.publish_at,
    schedule.default_duration_minutes
  FROM generate_series(
    _start_date::timestamp,
    LEAST(_end_date, _start_date + 62)::timestamp,
    interval '1 day'
  ) requested(day)
  LEFT JOIN LATERAL public.get_public_reservation_schedule(
    _company_id,
    requested.day::date
  ) schedule ON true
  WHERE _company_id IS NOT NULL
    AND _start_date IS NOT NULL
    AND _end_date IS NOT NULL
    AND _end_date >= _start_date
    AND _end_date <= _start_date + 62
  ORDER BY requested.day;
$$;

COMMENT ON FUNCTION public.get_public_reservation_schedule_range(uuid, date, date)
IS 'Agendas publicas de uma janela de ate 63 dias em uma unica chamada.';

REVOKE ALL ON FUNCTION public.get_public_reservation_schedule_range(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_schedule_range(uuid, date, date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_schedule_range(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_schedule_range(uuid, date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.get_public_reservation_booking_context(
  _company_id uuid,
  _date date,
  _party_size integer
)
RETURNS TABLE (
  schedule_source text,
  schedule_rule_id uuid,
  schedule_rule_name text,
  schedule_block_id uuid,
  schedule_block_name text,
  schedule_slots jsonb,
  schedule_max_party_size_per_reservation integer,
  schedule_availability_mode text,
  schedule_default_duration_minutes integer,
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
  max_guests_per_slot integer,
  recommended_table_id uuid,
  recommended_table_number integer,
  recommended_table_capacity integer,
  recommended_table_section text,
  recommended_table_map_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH schedule AS (
    SELECT resolved.*
    FROM public.get_public_reservation_schedule(_company_id, _date) resolved
    LIMIT 1
  ),
  availability AS (
    SELECT resolved.*
    FROM public.get_public_reservation_availability(
      _company_id,
      _date,
      _party_size
    ) resolved
  )
  SELECT
    schedule.source,
    schedule.rule_id,
    schedule.rule_name,
    schedule.block_id,
    schedule.block_name,
    schedule.slots,
    schedule.max_party_size_per_reservation,
    schedule.availability_mode,
    schedule.default_duration_minutes,
    availability.time_slot,
    availability.available,
    availability.unavailable_reason,
    availability.total_tables,
    availability.occupied_tables,
    availability.available_tables,
    availability.total_guests,
    availability.reservation_count,
    availability.max_party_size_per_reservation,
    availability.max_reservations_per_slot,
    availability.availability_mode,
    availability.duration_minutes,
    availability.max_guests_per_slot,
    recommended.id,
    recommended.number,
    recommended.capacity,
    recommended.section,
    recommended.table_map_id
  FROM schedule
  LEFT JOIN availability ON true
  LEFT JOIN LATERAL public.get_active_table_map(
    _company_id,
    (_date + availability.time_slot)::timestamptz
  ) active_map ON availability.time_slot IS NOT NULL
    AND availability.availability_mode = 'tables'
  LEFT JOIN LATERAL (
    SELECT
      table_row.id,
      table_row.number,
      table_row.capacity,
      table_row.section,
      table_row.table_map_id
    FROM public.restaurant_tables table_row
    WHERE table_row.id = CASE
      WHEN availability.available = true
        AND availability.availability_mode = 'tables'
      THEN public.pick_best_fit_reservation_table(
        _company_id,
        _date,
        availability.time_slot,
        GREATEST(COALESCE(availability.duration_minutes, 30), 1),
        _party_size,
        active_map.id,
        NULL
      )
      ELSE NULL
    END
  ) recommended ON true
  WHERE _company_id IS NOT NULL
    AND _date IS NOT NULL
    AND _party_size BETWEEN 1 AND 20
  ORDER BY availability.time_slot NULLS FIRST;
$$;

COMMENT ON FUNCTION public.get_public_reservation_booking_context(uuid, date, integer)
IS 'Agenda, disponibilidade e melhor mesa para o fluxo publico em uma unica chamada; a criacao revalida tudo sob lock.';

REVOKE ALL ON FUNCTION public.get_public_reservation_booking_context(uuid, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_booking_context(uuid, date, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_booking_context(uuid, date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_booking_context(uuid, date, integer) TO service_role;
