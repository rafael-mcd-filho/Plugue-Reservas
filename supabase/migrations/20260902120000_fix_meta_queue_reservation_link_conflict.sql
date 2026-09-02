-- Tracking events may legitimately repeat inside the same journey (for example,
-- when a visitor reloads the page or changes the selected time). When the
-- reservation trigger linked every queued tracking event to the new reservation,
-- the original broad unique index rejected those repeated events and rolled back
-- the reservation itself.
--
-- Keep reservation-generated Meta events idempotent while allowing independent
-- tracking events to be associated with the same reservation.
DROP INDEX IF EXISTS public.idx_meta_event_queue_reservation_event_unique;

CREATE UNIQUE INDEX idx_meta_event_queue_reservation_event_unique
ON public.meta_event_queue(reservation_id, event_name)
WHERE tracking_event_id IS NULL;

COMMENT ON INDEX public.idx_meta_event_queue_reservation_event_unique IS
  'Deduplicates reservation-generated Meta events without collapsing distinct tracking events linked to the same reservation.';

CREATE OR REPLACE FUNCTION public.enqueue_meta_reservation_event(
  _reservation_id uuid,
  _event_name text,
  _meta_event_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _reservation record;
  _settings record;
  _session record;
  _source text;
  _payload jsonb;
BEGIN
  SELECT r.*
  INTO _reservation
  FROM public.reservations r
  WHERE r.id = _reservation_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  _source := CASE
    WHEN _reservation.origin_tracking_session_id IS NOT NULL OR COALESCE(_reservation.origin_anonymous_id, '') <> '' THEN 'public'
    ELSE 'manual'
  END;

  IF _source <> 'public' THEN
    RETURN;
  END IF;

  SELECT *
  INTO _settings
  FROM public.company_tracking_settings
  WHERE company_id = _reservation.company_id;

  IF NOT FOUND OR NOT COALESCE(_settings.capi_enabled, false) THEN
    RETURN;
  END IF;

  IF COALESCE(NULLIF(btrim(_settings.pixel_id), ''), '') = '' OR COALESCE(NULLIF(btrim(_settings.access_token), ''), '') = '' THEN
    RETURN;
  END IF;

  IF (
    (_meta_event_name = 'PageView' AND NOT COALESCE(_settings.send_page_view, false))
    OR (_meta_event_name = 'InitiateCheckout' AND NOT COALESCE(_settings.send_initiate_checkout, true))
    OR (_meta_event_name = 'Lead' AND NOT COALESCE(_settings.send_lead, false))
    OR (_meta_event_name = 'Schedule' AND NOT COALESCE(_settings.send_schedule, true))
  ) THEN
    RETURN;
  END IF;

  SELECT *
  INTO _session
  FROM public.tracking_sessions
  WHERE id = _reservation.origin_tracking_session_id;

  _payload := jsonb_strip_nulls(
    jsonb_build_object(
      'event_name', _event_name,
      'meta_event_name', _meta_event_name,
      'event_source_url', COALESCE(
        _reservation.attribution_snapshot ->> 'event_source_url',
        _reservation.attribution_snapshot ->> 'page_url',
        _session.last_page_url,
        _session.first_page_url
      ),
      'referrer', COALESCE(_reservation.attribution_snapshot ->> 'referrer', _session.referrer),
      'fbp', COALESCE(_reservation.origin_fbp, _reservation.attribution_snapshot ->> 'fbp', _session.fbp),
      'fbc', COALESCE(_reservation.origin_fbc, _reservation.attribution_snapshot ->> 'fbc', _session.fbc),
      'fbclid', COALESCE(_reservation.attribution_snapshot ->> 'fbclid', _session.fbclid),
      'anonymous_id', COALESCE(_reservation.origin_anonymous_id, _session.anonymous_id, _reservation.visitor_id),
      'session_id', _reservation.origin_tracking_session_id,
      'journey_id', _reservation.origin_tracking_journey_id,
      'custom_data', jsonb_build_object(
        'reservation_id', _reservation.id,
        'party_size', _reservation.party_size,
        'reservation_date', _reservation.date,
        'reservation_time', _reservation.time,
        'status', _reservation.status
      )
    )
  );

  INSERT INTO public.meta_event_queue (
    company_id,
    reservation_id,
    journey_id,
    event_name,
    meta_event_name,
    payload
  )
  VALUES (
    _reservation.company_id,
    _reservation.id,
    _reservation.origin_tracking_journey_id,
    _event_name,
    _meta_event_name,
    _payload
  )
  ON CONFLICT (reservation_id, event_name)
    WHERE tracking_event_id IS NULL
  DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_meta_reservation_event(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_meta_reservation_event(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_meta_reservation_event(uuid, text, text) FROM authenticated;
