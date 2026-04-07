INSERT INTO public.system_settings (key, value)
VALUES ('system_name', 'Plugue Reservas')
ON CONFLICT (key) DO UPDATE
SET
  value = EXCLUDED.value,
  updated_at = now()
WHERE public.system_settings.value IS NULL
   OR public.system_settings.value = ''
   OR public.system_settings.value IN ('ReservaFacil', 'ReservaFácil', 'PlugGuest', 'Plug Guest');

CREATE OR REPLACE FUNCTION public.get_public_system_branding()
RETURNS TABLE (
  system_name text,
  system_logo_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(MAX(value) FILTER (WHERE key = 'system_name'), 'Plugue Reservas') AS system_name,
    COALESCE(MAX(value) FILTER (WHERE key = 'system_logo_url'), '') AS system_logo_url
  FROM public.system_settings
  WHERE key IN ('system_name', 'system_logo_url');
$$;

GRANT EXECUTE ON FUNCTION public.get_public_system_branding() TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_system_branding() TO authenticated;
