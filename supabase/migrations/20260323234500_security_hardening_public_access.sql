-- Remove unsafe anonymous read access on reservations.
DROP POLICY IF EXISTS "Anon can view own reservations" ON public.reservations;

-- Remove unsafe anonymous read access on waitlist. Public tracking must use RPC.
DROP POLICY IF EXISTS "Public can view by tracking code" ON public.waitlist;

-- Safe public prefill limited to the same visitor_id and company.
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
  SELECT
    r.guest_name,
    r.guest_email,
    r.guest_birthdate
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.visitor_id = _visitor_id
    AND r.guest_phone = _guest_phone
  ORDER BY r.created_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_reservation_prefill(uuid, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_prefill(uuid, text, text) TO authenticated;

-- Safe waitlist tracking lookup with only the fields required by the public page.
DROP FUNCTION IF EXISTS public.get_waitlist_by_tracking_code(text);

CREATE OR REPLACE FUNCTION public.get_waitlist_by_tracking_code(_tracking_code text)
RETURNS TABLE (
  id uuid,
  guest_name text,
  party_size integer,
  tracking_code text,
  status text,
  "position" integer,
  created_at timestamptz,
  called_at timestamptz,
  company_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    w.id,
    w.guest_name,
    w.party_size,
    w.tracking_code,
    w.status,
    w.position AS "position",
    w.created_at,
    w.called_at,
    w.company_id
  FROM public.waitlist w
  WHERE w.tracking_code = _tracking_code
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_waitlist_by_tracking_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_waitlist_by_tracking_code(text) TO authenticated;

-- Generic public rate-limit registry for anonymous flows handled by edge functions.
CREATE TABLE IF NOT EXISTS public.public_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  identifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.public_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_public_rate_limits_scope_identifier_created_at
ON public.public_rate_limits(scope, identifier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_rate_limits_company_created_at
ON public.public_rate_limits(company_id, created_at DESC);

-- Basic public booking throttling to reduce spam and brute-force inserts.
CREATE OR REPLACE FUNCTION public.enforce_public_reservation_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _recent_phone_count integer := 0;
  _recent_visitor_count integer := 0;
BEGIN
  IF COALESCE(NEW.visitor_id, '') = '' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
  INTO _recent_phone_count
  FROM public.reservations r
  WHERE r.company_id = NEW.company_id
    AND r.guest_phone = NEW.guest_phone
    AND r.created_at >= now() - interval '15 minutes';

  IF _recent_phone_count >= 3 THEN
    RAISE EXCEPTION 'Muitas tentativas de reserva para este telefone. Aguarde alguns minutos e tente novamente.';
  END IF;

  SELECT count(*)
  INTO _recent_visitor_count
  FROM public.reservations r
  WHERE r.company_id = NEW.company_id
    AND r.visitor_id = NEW.visitor_id
    AND r.created_at >= now() - interval '15 minutes';

  IF _recent_visitor_count >= 3 THEN
    RAISE EXCEPTION 'Muitas tentativas de reserva deste dispositivo. Aguarde alguns minutos e tente novamente.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_public_reservation_rate_limit ON public.reservations;
CREATE TRIGGER trg_enforce_public_reservation_rate_limit
BEFORE INSERT ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_public_reservation_rate_limit();

-- Anonymous funnel inserts should happen through the edge function with rate limiting.
DROP POLICY IF EXISTS "Anyone can insert funnel logs" ON public.reservation_funnel_logs;
