-- Function to count people ahead in waitlist (for public tracking)
CREATE OR REPLACE FUNCTION public.get_waitlist_ahead_count(
  _company_id uuid,
  _position integer
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::integer
  FROM public.waitlist
  WHERE company_id = _company_id
    AND status = 'waiting'
    AND position < _position;
$$;

-- Function to get average wait time from today's seated entries
CREATE OR REPLACE FUNCTION public.get_waitlist_avg_wait(
  _company_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    AVG(
      EXTRACT(EPOCH FROM (seated_at - created_at)) / 60
    )::integer,
    10
  )
  FROM public.waitlist
  WHERE company_id = _company_id
    AND status = 'seated'
    AND seated_at IS NOT NULL
    AND created_at::date = CURRENT_DATE;
$$;

GRANT EXECUTE ON FUNCTION public.get_waitlist_ahead_count(uuid, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_waitlist_avg_wait(uuid) TO anon;