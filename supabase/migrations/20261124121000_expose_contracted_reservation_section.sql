-- Keep the existing tracking scope, review and rate-limit behavior while
-- exposing the environment agreed at booking, independently of table changes.
DROP FUNCTION IF EXISTS public.get_public_reservation_by_tracking_code(text, text);

CREATE OR REPLACE FUNCTION public.get_public_reservation_by_tracking_code(
  _tracking_code text,
  _visitor_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid, company_id uuid, guest_name text, date date, "time" text,
  party_size integer, status text, occasion text, notes text,
  created_at timestamptz, updated_at timestamptz, public_tracking_code text,
  review_token text, review_status text,
  selected_section_id uuid, selected_section_name text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry public.reservations%ROWTYPE;
  _normalized_code text := lower(btrim(COALESCE(_tracking_code, '')));
  _normalized_visitor text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _recent_count integer := 0;
  _review_token text;
  _review_status text;
BEGIN
  IF _normalized_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  IF _normalized_visitor IS NOT NULL THEN
    SELECT count(*) INTO _recent_count
    FROM public.public_rate_limits prl
    WHERE prl.scope = 'public_reservation_lookup_visitor'
      AND prl.identifier = _normalized_visitor
      AND prl.created_at >= now() - interval '15 minutes';
    IF _recent_count >= 60 THEN
      RAISE EXCEPTION 'Muitas consultas deste dispositivo. Aguarde alguns minutos e tente novamente.';
    END IF;
  END IF;

  SELECT * INTO _entry FROM public.reservations r
  WHERE r.public_tracking_code = _normalized_code LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  IF _normalized_visitor IS NOT NULL THEN
    INSERT INTO public.public_rate_limits(scope, company_id, identifier)
    VALUES ('public_reservation_lookup_visitor', _entry.company_id, _normalized_visitor);
  END IF;

  SELECT rr.review_token,
    CASE WHEN rr.expires_at < now() THEN 'expired' ELSE rr.status END
  INTO _review_token, _review_status
  FROM public.reservation_reviews rr WHERE rr.reservation_id = _entry.id LIMIT 1;

  RETURN QUERY SELECT
    _entry.id, _entry.company_id, _entry.guest_name, _entry.date,
    _entry.time::text, _entry.party_size, _entry.status, _entry.occasion,
    _entry.notes, _entry.created_at, _entry.updated_at, _entry.public_tracking_code,
    _review_token, _review_status, _entry.selected_section_id, _entry.selected_section_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_reservation_by_tracking_code(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_by_tracking_code(text,text) TO anon, authenticated;
