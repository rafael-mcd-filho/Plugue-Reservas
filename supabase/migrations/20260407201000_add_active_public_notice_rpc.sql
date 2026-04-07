DROP FUNCTION IF EXISTS public.get_active_company_public_notice(uuid);

CREATE OR REPLACE FUNCTION public.get_active_company_public_notice(_company_id uuid)
RETURNS TABLE (
  id uuid,
  text text,
  image_url text,
  active_until timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    cpn.id,
    cpn.text,
    cpn.image_url,
    cpn.active_until
  FROM public.company_public_notices cpn
  JOIN public.companies c ON c.id = cpn.company_id
  WHERE cpn.company_id = _company_id
    AND cpn.is_active = true
    AND cpn.active_until > now()
    AND c.status = 'active'
    AND (
      NULLIF(BTRIM(COALESCE(cpn.text, '')), '') IS NOT NULL
      OR NULLIF(BTRIM(COALESCE(cpn.image_url, '')), '') IS NOT NULL
    )
  ORDER BY cpn.updated_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_company_public_notice(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_active_company_public_notice(uuid) TO authenticated;
