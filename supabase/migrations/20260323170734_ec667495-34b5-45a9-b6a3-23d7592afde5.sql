-- Function to get occupied table IDs for a specific company/date/time slot
-- This avoids exposing reservation row data to anon users
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
  SELECT COALESCE(array_agg(table_id), '{}')
  FROM public.reservations
  WHERE company_id = _company_id
    AND date = _date
    AND time = _time
    AND status NOT IN ('cancelled', 'no_show')
    AND table_id IS NOT NULL;
$$;

-- Function to get guest counts per time slot for a date (for availability display)
CREATE OR REPLACE FUNCTION public.get_slot_occupancy(
  _company_id uuid,
  _date date
)
RETURNS TABLE(time_slot time, occupied_tables bigint, total_guests bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT time, COUNT(*), COALESCE(SUM(party_size), 0)
  FROM public.reservations
  WHERE company_id = _company_id
    AND date = _date
    AND status NOT IN ('cancelled', 'no_show')
  GROUP BY time;
$$;

GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO anon;
GRANT EXECUTE ON FUNCTION public.get_slot_occupancy(uuid, date) TO anon;