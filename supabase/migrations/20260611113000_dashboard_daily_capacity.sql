-- Daily reservation capacity for dashboard occupancy charts.
--
-- Capacity is calculated per reservation date by summing the capacity of each
-- public reservation slot resolved for that day. Table-based schedules use the
-- active table map seat total unless a global/slot guest limit caps the slot.
-- Capacity-based schedules use each slot's configured max_guests_per_slot.

DROP FUNCTION IF EXISTS public.get_dashboard_daily_capacity(uuid, date, date);

CREATE OR REPLACE FUNCTION public.get_dashboard_daily_capacity(
  _company_id uuid,
  _start_date date,
  _end_date date
)
RETURNS TABLE (
  capacity_date date,
  total_capacity integer,
  slot_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_range AS (
    SELECT _start_date AS start_date, _end_date AS end_date
    WHERE _start_date IS NOT NULL
      AND _end_date IS NOT NULL
      AND _end_date >= _start_date
  ),
  days AS (
    SELECT generated.day::date AS capacity_date
    FROM requested_range requested
    CROSS JOIN generate_series(requested.start_date, requested.end_date, interval '1 day') generated(day)
  ),
  accessible_companies AS (
    SELECT
      c.id,
      COALESCE(c.max_guests_per_slot, 0) AS max_guests_per_slot
    FROM public.companies c
    WHERE c.status = 'active'
      AND (_company_id IS NULL OR c.id = _company_id)
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR (
          _company_id IS NOT NULL
          AND (
            public.has_role_in_company(auth.uid(), 'admin'::public.app_role, c.id)
            OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, c.id)
          )
        )
      )
  ),
  resolved_schedule AS (
    SELECT
      company.id AS company_id,
      company.max_guests_per_slot AS company_max_guests_per_slot,
      days.capacity_date,
      schedule.source,
      NULLIF(to_jsonb(schedule) ->> 'block_id', '')::uuid AS block_id,
      schedule.rule_id,
      schedule.slots,
      COALESCE(NULLIF(to_jsonb(schedule) ->> 'availability_mode', ''), 'tables') AS availability_mode
    FROM accessible_companies company
    CROSS JOIN days
    LEFT JOIN LATERAL public.get_public_reservation_schedule(company.id, days.capacity_date) schedule ON true
    WHERE COALESCE(schedule.source, '') <> 'blocked'
  ),
  resolved_slots AS (
    SELECT
      schedule.company_id,
      schedule.company_max_guests_per_slot,
      schedule.capacity_date,
      schedule.block_id,
      schedule.rule_id,
      schedule.availability_mode,
      slot_value::time AS time_slot
    FROM resolved_schedule schedule
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(schedule.slots, '[]'::jsonb)) slot_value
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.blocked_dates bd
      WHERE bd.company_id = schedule.company_id
        AND bd.date = schedule.capacity_date
        AND (
          bd.all_day = true
          OR (
            bd.all_day = false
            AND slot_value::time >= COALESCE(bd.start_time, '00:00'::time)
            AND slot_value::time < COALESCE(bd.end_time, '23:59:59'::time)
          )
        )
    )
  ),
  slot_capacity AS (
    SELECT
      slot.capacity_date,
      CASE
        WHEN slot.availability_mode = 'capacity' THEN COALESCE(NULLIF(to_jsonb(rule_slot) ->> 'max_guests_per_slot', '')::integer, 0)
        WHEN COALESCE(table_capacity.total_seats, 0) <= 0 THEN 0
        WHEN COALESCE(NULLIF(to_jsonb(rule_slot) ->> 'max_guests_per_slot', '')::integer, NULLIF(slot.company_max_guests_per_slot, 0)) IS NULL
          THEN table_capacity.total_seats
        ELSE LEAST(
          table_capacity.total_seats,
          COALESCE(NULLIF(to_jsonb(rule_slot) ->> 'max_guests_per_slot', '')::integer, NULLIF(slot.company_max_guests_per_slot, 0))
        )
      END AS slot_capacity
    FROM resolved_slots slot
    LEFT JOIN public.reservation_schedule_rule_slots rule_slot
      ON rule_slot.rule_id = slot.rule_id
     AND rule_slot.time = slot.time_slot
     AND (
       slot.block_id IS NULL
       OR NULLIF(to_jsonb(rule_slot) ->> 'block_id', '')::uuid = slot.block_id
     )
    LEFT JOIN LATERAL public.get_active_table_map(
      slot.company_id,
      (slot.capacity_date + slot.time_slot)::timestamptz
    ) active_map ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(rt.capacity), 0)::integer AS total_seats
      FROM public.restaurant_tables rt
      WHERE rt.company_id = slot.company_id
        AND rt.status = 'available'
        AND (active_map.id IS NULL OR rt.table_map_id = active_map.id)
    ) table_capacity ON true
  )
  SELECT
    days.capacity_date,
    COALESCE(sum(slot_capacity.slot_capacity), 0)::integer AS total_capacity,
    COALESCE(count(*) FILTER (WHERE slot_capacity.slot_capacity > 0), 0)::integer AS slot_count
  FROM days
  LEFT JOIN slot_capacity
    ON slot_capacity.capacity_date = days.capacity_date
  GROUP BY days.capacity_date
  ORDER BY days.capacity_date;
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_daily_capacity(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_daily_capacity(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dashboard_daily_capacity(uuid, date, date) TO service_role;
