UPDATE public.company_tracking_settings
SET
  send_lead = true,
  send_schedule = false,
  updated_at = now()
WHERE send_schedule = true;

ALTER TABLE public.company_tracking_settings
  ALTER COLUMN send_lead SET DEFAULT true;

ALTER TABLE public.company_tracking_settings
  ALTER COLUMN send_schedule SET DEFAULT false;

DELETE FROM public.meta_event_queue
WHERE meta_event_name = 'Lead'
  AND event_name = 'lead_captured';

UPDATE public.meta_event_queue
SET
  meta_event_name = 'Lead',
  payload = jsonb_set(
    jsonb_set(payload, '{meta_event_name}', to_jsonb('Lead'::text), true),
    '{event_name}',
    to_jsonb(event_name),
    true
  )
WHERE meta_event_name = 'Schedule';

CREATE OR REPLACE FUNCTION public.capture_tracking_event_for_meta_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.event_name = 'page_view' THEN
    PERFORM public.enqueue_meta_tracking_event(NEW.id, 'PageView');
  ELSIF NEW.event_name = 'booking_started' THEN
    PERFORM public.enqueue_meta_tracking_event(NEW.id, 'InitiateCheckout');
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_reservation_tracking_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tracking_source text;
  _anonymous_id text;
  _user_data_snapshot jsonb;
BEGIN
  _tracking_source := CASE
    WHEN NEW.origin_tracking_session_id IS NOT NULL OR COALESCE(NEW.origin_anonymous_id, '') <> '' THEN 'public'
    ELSE 'manual'
  END;

  _anonymous_id := COALESCE(
    NEW.origin_anonymous_id,
    NEW.visitor_id,
    format('reservation:%s', NEW.id::text)
  );

  _user_data_snapshot := jsonb_strip_nulls(
    jsonb_build_object(
      'email', lower(NULLIF(btrim(COALESCE(NEW.guest_email, '')), '')),
      'phone', NULLIF(regexp_replace(COALESCE(NEW.guest_phone, ''), '\D', '', 'g'), ''),
      'first_name', NULLIF(split_part(btrim(COALESCE(NEW.guest_name, '')), ' ', 1), ''),
      'last_name', NULLIF(regexp_replace(btrim(COALESCE(NEW.guest_name, '')), '^\S+\s*', ''), ''),
      'zip', NULLIF(btrim(COALESCE(NEW.attribution_snapshot -> 'user_data' ->> 'zip', '')), ''),
      'city', NULLIF(btrim(COALESCE(NEW.attribution_snapshot -> 'user_data' ->> 'city', '')), ''),
      'state', NULLIF(btrim(COALESCE(NEW.attribution_snapshot -> 'user_data' ->> 'state', '')), ''),
      'country', NULLIF(btrim(COALESCE(NEW.attribution_snapshot -> 'user_data' ->> 'country', '')), ''),
      'external_id', COALESCE(NEW.origin_anonymous_id, NEW.visitor_id, NEW.id::text)
    )
  );

  IF TG_OP = 'INSERT' THEN
    IF NEW.origin_tracking_journey_id IS NOT NULL THEN
      UPDATE public.tracking_journeys
      SET
        reservation_id = NEW.id,
        status = 'converted',
        converted_at = now(),
        last_event_at = now()
      WHERE id = NEW.origin_tracking_journey_id;

      UPDATE public.meta_event_queue
      SET reservation_id = NEW.id
      WHERE journey_id = NEW.origin_tracking_journey_id
        AND reservation_id IS NULL;
    END IF;

    INSERT INTO public.tracking_events (
      company_id,
      session_id,
      journey_id,
      reservation_id,
      anonymous_id,
      event_id,
      event_name,
      tracking_source,
      step,
      page_url,
      path,
      referrer,
      event_source_url,
      occurred_at,
      metadata,
      user_data_snapshot
    )
    VALUES (
      NEW.company_id,
      NEW.origin_tracking_session_id,
      NEW.origin_tracking_journey_id,
      NEW.id,
      _anonymous_id,
      format('reservation:%s:created', NEW.id::text),
      'reservation_created',
      _tracking_source,
      'completed',
      COALESCE(NEW.attribution_snapshot ->> 'page_url', NEW.attribution_snapshot ->> 'landing_url'),
      NEW.attribution_snapshot ->> 'path',
      NEW.attribution_snapshot ->> 'referrer',
      COALESCE(NEW.attribution_snapshot ->> 'event_source_url', NEW.attribution_snapshot ->> 'page_url', NEW.attribution_snapshot ->> 'landing_url'),
      COALESCE(NEW.created_at, now()),
      jsonb_strip_nulls(
        jsonb_build_object(
          'status', NEW.status,
          'party_size', NEW.party_size,
          'reservation_date', NEW.date,
          'reservation_time', NEW.time,
          'tracking_source', _tracking_source,
          'origin_tracking_session_id', NEW.origin_tracking_session_id,
          'origin_tracking_journey_id', NEW.origin_tracking_journey_id
        )
      ),
      _user_data_snapshot
    )
    ON CONFLICT (event_id) DO NOTHING;

    PERFORM public.enqueue_meta_reservation_event(NEW.id, 'reservation_created', 'Lead');
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.tracking_events (
      company_id,
      session_id,
      journey_id,
      reservation_id,
      anonymous_id,
      event_id,
      event_name,
      tracking_source,
      page_url,
      path,
      referrer,
      event_source_url,
      occurred_at,
      metadata,
      user_data_snapshot
    )
    VALUES (
      NEW.company_id,
      NEW.origin_tracking_session_id,
      NEW.origin_tracking_journey_id,
      NEW.id,
      _anonymous_id,
      format('reservation:%s:status:%s', NEW.id::text, NEW.status),
      CASE
        WHEN NEW.status = 'cancelled' THEN 'reservation_cancelled'
        WHEN NEW.status IN ('checked_in', 'completed') THEN 'reservation_checked_in'
        WHEN NEW.status = 'no-show' THEN 'reservation_no_show'
        ELSE 'reservation_status_changed'
      END,
      _tracking_source,
      COALESCE(NEW.attribution_snapshot ->> 'page_url', NEW.attribution_snapshot ->> 'landing_url'),
      NEW.attribution_snapshot ->> 'path',
      NEW.attribution_snapshot ->> 'referrer',
      COALESCE(NEW.attribution_snapshot ->> 'event_source_url', NEW.attribution_snapshot ->> 'page_url', NEW.attribution_snapshot ->> 'landing_url'),
      COALESCE(NEW.updated_at, now()),
      jsonb_strip_nulls(
        jsonb_build_object(
          'previous_status', OLD.status,
          'status', NEW.status,
          'tracking_source', _tracking_source
        )
      ),
      _user_data_snapshot
    )
    ON CONFLICT (event_id) DO NOTHING;

    IF NEW.origin_tracking_journey_id IS NOT NULL THEN
      UPDATE public.tracking_journeys
      SET
        status = CASE
          WHEN NEW.status = 'cancelled' THEN 'cancelled'
          WHEN NEW.status IN ('checked_in', 'completed') THEN 'converted'
          ELSE status
        END,
        last_event_at = now(),
        ended_at = CASE
          WHEN NEW.status IN ('cancelled', 'checked_in', 'completed', 'no-show') THEN now()
          ELSE ended_at
        END
      WHERE id = NEW.origin_tracking_journey_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
