DROP FUNCTION IF EXISTS public.get_active_table_map(uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.get_active_table_map(
  _company_id uuid,
  _reservation_at timestamptz
)
RETURNS TABLE (
  id uuid,
  name text,
  is_default boolean,
  is_enabled boolean,
  active_from timestamptz,
  active_to timestamptz,
  priority integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH special_map AS (
    SELECT
      tm.id,
      tm.name,
      tm.is_default,
      tm.is_enabled,
      tm.active_from,
      tm.active_to,
      tm.priority
    FROM public.table_maps tm
    WHERE tm.company_id = _company_id
      AND tm.is_default = false
      AND tm.is_enabled = true
      AND tm.active_from IS NOT NULL
      AND tm.active_from <= _reservation_at
      AND (tm.active_to IS NULL OR tm.active_to > _reservation_at)
    ORDER BY tm.priority ASC, tm.active_from DESC, tm.created_at DESC
    LIMIT 1
  ),
  default_map AS (
    SELECT
      tm.id,
      tm.name,
      tm.is_default,
      tm.is_enabled,
      tm.active_from,
      tm.active_to,
      tm.priority
    FROM public.table_maps tm
    WHERE tm.company_id = _company_id
      AND tm.is_default = true
    ORDER BY tm.updated_at DESC
    LIMIT 1
  )
  SELECT * FROM special_map
  UNION ALL
  SELECT * FROM default_map
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_table_map(uuid, timestamptz) TO anon;
GRANT EXECUTE ON FUNCTION public.get_active_table_map(uuid, timestamptz) TO authenticated;
