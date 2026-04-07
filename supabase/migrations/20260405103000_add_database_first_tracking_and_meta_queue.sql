CREATE TABLE IF NOT EXISTS public.company_tracking_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,
  pixel_id text,
  access_token text,
  test_event_code text,
  capi_enabled boolean NOT NULL DEFAULT false,
  send_page_view boolean NOT NULL DEFAULT false,
  send_initiate_checkout boolean NOT NULL DEFAULT true,
  send_lead boolean NOT NULL DEFAULT false,
  send_schedule boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_tracking_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company admins can manage tracking settings" ON public.company_tracking_settings;
CREATE POLICY "Company admins can manage tracking settings"
ON public.company_tracking_settings
FOR ALL
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role(auth.uid(), 'superadmin')
)
WITH CHECK (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role(auth.uid(), 'superadmin')
);

CREATE TABLE IF NOT EXISTS public.tracking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  anonymous_id text NOT NULL,
  first_page_url text,
  last_page_url text,
  landing_path text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  fbp text,
  fbc text,
  ip_address text,
  user_agent text,
  accept_language text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_company_started
ON public.tracking_sessions(company_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_company_anonymous
ON public.tracking_sessions(company_id, anonymous_id, last_seen_at DESC);

ALTER TABLE public.tracking_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view tracking sessions" ON public.tracking_sessions;
CREATE POLICY "Company staff can view tracking sessions"
ON public.tracking_sessions
FOR SELECT
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
  OR has_role(auth.uid(), 'superadmin')
);

CREATE TABLE IF NOT EXISTS public.tracking_journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.tracking_sessions(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  anonymous_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'cancelled', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz,
  ended_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracking_journeys_company_started
ON public.tracking_journeys(company_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_journeys_session
ON public.tracking_journeys(session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_journeys_reservation
ON public.tracking_journeys(reservation_id);

ALTER TABLE public.tracking_journeys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view tracking journeys" ON public.tracking_journeys;
CREATE POLICY "Company staff can view tracking journeys"
ON public.tracking_journeys
FOR SELECT
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
  OR has_role(auth.uid(), 'superadmin')
);

CREATE TABLE IF NOT EXISTS public.tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.tracking_sessions(id) ON DELETE SET NULL,
  journey_id uuid REFERENCES public.tracking_journeys(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  anonymous_id text NOT NULL,
  event_id text NOT NULL UNIQUE,
  event_name text NOT NULL,
  tracking_source text NOT NULL DEFAULT 'public',
  step text,
  page_url text,
  path text,
  referrer text,
  event_source_url text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_data_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracking_events_company_occurred
ON public.tracking_events(company_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_events_company_name
ON public.tracking_events(company_id, event_name, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_events_reservation
ON public.tracking_events(reservation_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_events_journey
ON public.tracking_events(journey_id, occurred_at DESC);

ALTER TABLE public.tracking_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view tracking events" ON public.tracking_events;
CREATE POLICY "Company staff can view tracking events"
ON public.tracking_events
FOR SELECT
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
  OR has_role(auth.uid(), 'superadmin')
);

CREATE TABLE IF NOT EXISTS public.meta_event_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  journey_id uuid REFERENCES public.tracking_journeys(id) ON DELETE SET NULL,
  tracking_event_id uuid REFERENCES public.tracking_events(id) ON DELETE SET NULL,
  event_name text NOT NULL,
  meta_event_name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_response_status integer,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_event_queue_reservation_event_unique
ON public.meta_event_queue(reservation_id, event_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_event_queue_tracking_event_unique
ON public.meta_event_queue(tracking_event_id, event_name);

CREATE INDEX IF NOT EXISTS idx_meta_event_queue_company_status
ON public.meta_event_queue(company_id, status, next_retry_at);

ALTER TABLE public.meta_event_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view meta queue" ON public.meta_event_queue;
CREATE POLICY "Company staff can view meta queue"
ON public.meta_event_queue
FOR SELECT
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
  OR has_role(auth.uid(), 'superadmin')
);

CREATE TABLE IF NOT EXISTS public.meta_event_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES public.meta_event_queue(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  status text NOT NULL,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_status integer,
  response_body text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_event_attempts_queue
ON public.meta_event_attempts(queue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_meta_event_attempts_company
ON public.meta_event_attempts(company_id, created_at DESC);

ALTER TABLE public.meta_event_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view meta attempts" ON public.meta_event_attempts;
CREATE POLICY "Company staff can view meta attempts"
ON public.meta_event_attempts
FOR SELECT
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin', company_id)
  OR has_role_in_company(auth.uid(), 'operator', company_id)
  OR has_role(auth.uid(), 'superadmin')
);

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS origin_tracking_session_id uuid,
  ADD COLUMN IF NOT EXISTS origin_tracking_journey_id uuid,
  ADD COLUMN IF NOT EXISTS origin_anonymous_id text,
  ADD COLUMN IF NOT EXISTS origin_fbp text,
  ADD COLUMN IF NOT EXISTS origin_fbc text,
  ADD COLUMN IF NOT EXISTS attribution_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_origin_tracking_session_id_fkey'
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_origin_tracking_session_id_fkey
      FOREIGN KEY (origin_tracking_session_id)
      REFERENCES public.tracking_sessions(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_origin_tracking_journey_id_fkey'
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_origin_tracking_journey_id_fkey
      FOREIGN KEY (origin_tracking_journey_id)
      REFERENCES public.tracking_journeys(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reservations_origin_tracking_session
ON public.reservations(origin_tracking_session_id);

CREATE INDEX IF NOT EXISTS idx_reservations_origin_tracking_journey
ON public.reservations(origin_tracking_journey_id);

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
  ON CONFLICT (reservation_id, event_name) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_meta_reservation_event(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_meta_reservation_event(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_meta_reservation_event(uuid, text, text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_meta_tracking_event(
  _tracking_event_id uuid,
  _meta_event_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _event record;
  _settings record;
  _session record;
  _payload jsonb;
BEGIN
  SELECT te.*
  INTO _event
  FROM public.tracking_events te
  WHERE te.id = _tracking_event_id;

  IF NOT FOUND OR COALESCE(_event.tracking_source, '') <> 'public' THEN
    RETURN;
  END IF;

  SELECT *
  INTO _settings
  FROM public.company_tracking_settings
  WHERE company_id = _event.company_id;

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
  WHERE id = _event.session_id;

  _payload := jsonb_strip_nulls(
    jsonb_build_object(
      'event_name', _event.event_name,
      'meta_event_name', _meta_event_name,
      'event_source_url', COALESCE(_event.event_source_url, _event.page_url, _session.last_page_url, _session.first_page_url),
      'referrer', COALESCE(_event.referrer, _session.referrer),
      'fbp', COALESCE(_event.metadata ->> 'fbp', _session.fbp),
      'fbc', COALESCE(_event.metadata ->> 'fbc', _session.fbc),
      'fbclid', COALESCE(_event.metadata ->> 'fbclid', _session.fbclid),
      'anonymous_id', COALESCE(_event.anonymous_id, _session.anonymous_id),
      'session_id', _event.session_id,
      'journey_id', _event.journey_id,
      'custom_data', jsonb_build_object(
        'tracking_event_id', _event.id,
        'step', _event.step,
        'path', _event.path,
        'reservation_id', _event.reservation_id
      ),
      'user_data', _event.user_data_snapshot
    )
  );

  INSERT INTO public.meta_event_queue (
    company_id,
    reservation_id,
    journey_id,
    tracking_event_id,
    event_name,
    meta_event_name,
    payload
  )
  VALUES (
    _event.company_id,
    _event.reservation_id,
    _event.journey_id,
    _event.id,
    _event.event_name,
    _meta_event_name,
    _payload
  )
  ON CONFLICT (tracking_event_id, event_name) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_meta_tracking_event(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_meta_tracking_event(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_meta_tracking_event(uuid, text) FROM authenticated;

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
  ELSIF NEW.event_name = 'lead_captured' THEN
    PERFORM public.enqueue_meta_tracking_event(NEW.id, 'Lead');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_tracking_event_for_meta_queue ON public.tracking_events;
CREATE TRIGGER trg_capture_tracking_event_for_meta_queue
AFTER INSERT ON public.tracking_events
FOR EACH ROW
EXECUTE FUNCTION public.capture_tracking_event_for_meta_queue();

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

    PERFORM public.enqueue_meta_reservation_event(NEW.id, 'reservation_created', 'Schedule');
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

DROP TRIGGER IF EXISTS trg_capture_reservation_tracking_events ON public.reservations;
CREATE TRIGGER trg_capture_reservation_tracking_events
AFTER INSERT OR UPDATE OF status ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.capture_reservation_tracking_events();

CREATE OR REPLACE FUNCTION public.get_reservation_event_history(_reservation_id uuid)
RETURNS TABLE (
  id uuid,
  occurred_at timestamptz,
  source text,
  event_name text,
  tracking_source text,
  title text,
  description text,
  status text,
  payload jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH reservation_context AS (
    SELECT
      r.id,
      r.company_id,
      r.origin_tracking_journey_id
    FROM public.reservations r
    WHERE r.id = _reservation_id
  ),
  journey_events AS (
    SELECT
      te.id,
      te.occurred_at,
      'tracking'::text AS source,
      te.event_name,
      te.tracking_source,
      CASE te.event_name
        WHEN 'page_view' THEN 'Visualizou a pagina'
        WHEN 'booking_started' THEN 'Iniciou a reserva'
        WHEN 'date_select' THEN 'Selecionou a data'
        WHEN 'time_select' THEN 'Selecionou o horario'
        WHEN 'form_fill' THEN 'Avancou para os dados pessoais'
        WHEN 'lead_captured' THEN 'Enviou os dados do formulario'
        WHEN 'reservation_created' THEN 'Reserva criada'
        WHEN 'reservation_cancelled' THEN 'Reserva cancelada'
        WHEN 'reservation_checked_in' THEN 'Check-in realizado'
        WHEN 'reservation_no_show' THEN 'Marcada como no-show'
        ELSE replace(te.event_name, '_', ' ')
      END AS title,
      COALESCE(
        te.metadata ->> 'description',
        te.path,
        te.page_url,
        te.referrer
      ) AS description,
      COALESCE(te.metadata ->> 'status', null) AS status,
      jsonb_strip_nulls(
        te.metadata
        || jsonb_build_object(
          'page_url', te.page_url,
          'path', te.path,
          'referrer', te.referrer,
          'event_source_url', te.event_source_url,
          'user_data_snapshot', te.user_data_snapshot
        )
      ) AS payload
    FROM public.tracking_events te
    JOIN reservation_context rc
      ON te.company_id = rc.company_id
    WHERE te.reservation_id = rc.id
      OR (
        rc.origin_tracking_journey_id IS NOT NULL
        AND te.journey_id = rc.origin_tracking_journey_id
      )
  ),
  meta_logs AS (
    SELECT
      mea.id,
      mea.created_at AS occurred_at,
      'meta'::text AS source,
      meq.meta_event_name AS event_name,
      'meta'::text AS tracking_source,
      CASE
        WHEN mea.status = 'sent' THEN 'Evento enviado para a Meta'
        ELSE 'Tentativa de envio para a Meta'
      END AS title,
      COALESCE(mea.error_message, mea.response_body, 'Sem detalhes adicionais') AS description,
      mea.status,
      jsonb_strip_nulls(
        jsonb_build_object(
          'response_status', mea.response_status,
          'response_body', mea.response_body,
          'error_message', mea.error_message,
          'request_payload', mea.request_payload
        )
      ) AS payload
    FROM public.meta_event_attempts mea
    JOIN public.meta_event_queue meq
      ON meq.id = mea.queue_id
    WHERE meq.reservation_id = _reservation_id
  )
  SELECT *
  FROM (
    SELECT * FROM journey_events
    UNION ALL
    SELECT * FROM meta_logs
  ) timeline
  ORDER BY occurred_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_reservation_event_history(uuid) TO authenticated;
