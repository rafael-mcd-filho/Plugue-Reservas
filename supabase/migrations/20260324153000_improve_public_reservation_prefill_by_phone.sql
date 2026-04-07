-- Improve public reservation prefill:
-- 1. Do not require the same visitor_id/device.
-- 2. Match guest_phone using only digits, so masks do not break lookup.
-- 3. Prefer the most recent non-empty value for each field.

CREATE OR REPLACE FUNCTION public.get_public_reservation_prefill(
  _company_id uuid,
  _visitor_id text,
  _guest_phone text
)
RETURNS TABLE (
  guest_name text,
  guest_email text,
  guest_birthdate date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH matches AS (
    SELECT
      NULLIF(btrim(r.guest_name), '') AS guest_name,
      NULLIF(btrim(r.guest_email), '') AS guest_email,
      r.guest_birthdate,
      r.created_at
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND regexp_replace(COALESCE(r.guest_phone, ''), '\D', '', 'g')
        = regexp_replace(COALESCE(_guest_phone, ''), '\D', '', 'g')
  )
  SELECT
    (SELECT m.guest_name FROM matches m WHERE m.guest_name IS NOT NULL ORDER BY m.created_at DESC LIMIT 1) AS guest_name,
    (SELECT m.guest_email FROM matches m WHERE m.guest_email IS NOT NULL ORDER BY m.created_at DESC LIMIT 1) AS guest_email,
    (SELECT m.guest_birthdate FROM matches m WHERE m.guest_birthdate IS NOT NULL ORDER BY m.created_at DESC LIMIT 1) AS guest_birthdate
  WHERE EXISTS (SELECT 1 FROM matches);
$$;

GRANT EXECUTE ON FUNCTION public.get_public_reservation_prefill(uuid, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_prefill(uuid, text, text) TO authenticated;
