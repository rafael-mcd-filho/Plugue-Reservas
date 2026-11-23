-- Keep operational changes in the bell without displacing announcements from
-- the blocking banner's bounded result. The existing generic RPC is unchanged.
CREATE OR REPLACE FUNCTION public.get_company_announcement_notifications(
  _company_id uuid,
  _limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  title text,
  message text,
  image_url text,
  type text,
  is_read boolean,
  read_at timestamptz,
  created_by uuid,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
    OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, _company_id)
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND COALESCE(p.is_active, true)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  RETURN QUERY
  SELECT
    n.id,
    n.company_id,
    n.title,
    n.message,
    n.image_url,
    n.type,
    nr.read_at IS NOT NULL,
    nr.read_at,
    n.created_by,
    n.created_at
  FROM public.notification_recipients nr
  JOIN public.notifications n ON n.id = nr.notification_id
  WHERE nr.company_id = _company_id
    AND nr.user_id = auth.uid()
    AND n.type <> 'reservation_change'
  ORDER BY n.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 20), 1), 100);
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_announcement_notifications(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_announcement_notifications(uuid, integer) TO authenticated;
