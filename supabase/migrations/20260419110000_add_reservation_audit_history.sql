CREATE TABLE IF NOT EXISTS public.reservation_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL,
  actor_source text NOT NULL,
  action text NOT NULL,
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_audit_logs_actor_role_check
    CHECK (actor_role IN ('superadmin', 'admin', 'operator', 'user', 'system')),
  CONSTRAINT reservation_audit_logs_actor_source_check
    CHECK (actor_source IN ('panel', 'public', 'system')),
  CONSTRAINT reservation_audit_logs_action_check
    CHECK (action IN ('created', 'updated', 'status_changed', 'check_in', 'auto_no_show', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_reservation_audit_logs_reservation_created_at
ON public.reservation_audit_logs(reservation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_audit_logs_company_created_at
ON public.reservation_audit_logs(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_audit_logs_actor_user_created_at
ON public.reservation_audit_logs(actor_user_id, created_at DESC);

ALTER TABLE public.reservation_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view reservation audit logs" ON public.reservation_audit_logs;
CREATE POLICY "Company staff can view reservation audit logs"
ON public.reservation_audit_logs
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin')
  OR public.has_role_in_company(auth.uid(), 'admin', company_id)
  OR public.has_role_in_company(auth.uid(), 'operator', company_id)
);

CREATE OR REPLACE FUNCTION public.format_reservation_status_label(_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(btrim(COALESCE(_status, '')))
    WHEN 'confirmed' THEN 'Confirmada'
    WHEN 'checked_in' THEN 'Check-in realizado'
    WHEN 'cancelled' THEN 'Cancelada'
    WHEN 'no-show' THEN 'No Show'
    WHEN 'no_show' THEN 'No Show'
    ELSE COALESCE(NULLIF(_status, ''), 'Sem status')
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_reservation_audit_actor_role(
  _user_id uuid,
  _company_id uuid,
  _looks_public boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _user_id IS NOT NULL THEN
    IF public.has_role(_user_id, 'superadmin') THEN
      RETURN 'superadmin';
    END IF;

    IF public.has_role_in_company(_user_id, 'admin', _company_id) THEN
      RETURN 'admin';
    END IF;

    IF public.has_role_in_company(_user_id, 'operator', _company_id) THEN
      RETURN 'operator';
    END IF;

    RETURN 'user';
  END IF;

  IF _looks_public THEN
    RETURN 'user';
  END IF;

  RETURN 'system';
END;
$$;

CREATE OR REPLACE FUNCTION public.get_reservation_audit_actor_name(
  _user_id uuid,
  _fallback_name text DEFAULT NULL,
  _looks_public boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor_full_name text;
BEGIN
  IF _user_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), _user_id::text)
    INTO _actor_full_name
    FROM public.profiles p
    WHERE p.id = _user_id
    LIMIT 1;

    RETURN COALESCE(_actor_full_name, _user_id::text);
  END IF;

  IF _looks_public THEN
    RETURN COALESCE(NULLIF(btrim(COALESCE(_fallback_name, '')), ''), 'Cliente');
  END IF;

  RETURN 'Sistema';
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_reservation_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor_user_id uuid := auth.uid();
  _company_id uuid := COALESCE(NEW.company_id, OLD.company_id);
  _reservation_id uuid := COALESCE(NEW.id, OLD.id);
  _guest_name text := COALESCE(NEW.guest_name, OLD.guest_name);
  _looks_public boolean := false;
  _actor_role text;
  _actor_source text;
  _actor_name text;
  _action text;
  _summary text;
  _changes jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    _looks_public := _actor_user_id IS NULL
      AND (
        NEW.origin_tracking_session_id IS NOT NULL
        OR COALESCE(NEW.origin_anonymous_id, '') <> ''
        OR COALESCE(NEW.visitor_id, '') <> ''
      );
  END IF;

  _actor_role := public.get_reservation_audit_actor_role(_actor_user_id, _company_id, _looks_public);
  _actor_source := CASE
    WHEN _actor_user_id IS NOT NULL THEN 'panel'
    WHEN _looks_public THEN 'public'
    ELSE 'system'
  END;
  _actor_name := public.get_reservation_audit_actor_name(_actor_user_id, _guest_name, _looks_public);

  IF TG_OP = 'INSERT' THEN
    _action := 'created';
    _summary := CASE
      WHEN _actor_source = 'public' THEN 'Reserva criada pelo cliente'
      ELSE 'Reserva criada'
    END;

    _changes := jsonb_build_object(
      'guest_name', jsonb_build_object('old', to_jsonb(NULL::text), 'new', to_jsonb(NEW.guest_name)),
      'guest_phone', jsonb_build_object('old', to_jsonb(NULL::text), 'new', to_jsonb(NEW.guest_phone)),
      'guest_email', jsonb_build_object('old', to_jsonb(NULL::text), 'new', to_jsonb(NEW.guest_email)),
      'guest_birthdate', jsonb_build_object('old', to_jsonb(NULL::date), 'new', to_jsonb(NEW.guest_birthdate)),
      'date', jsonb_build_object('old', to_jsonb(NULL::date), 'new', to_jsonb(NEW.date)),
      'time', jsonb_build_object('old', to_jsonb(NULL::time), 'new', to_jsonb(NEW.time)),
      'party_size', jsonb_build_object('old', to_jsonb(NULL::integer), 'new', to_jsonb(NEW.party_size)),
      'occasion', jsonb_build_object('old', to_jsonb(NULL::text), 'new', to_jsonb(NEW.occasion)),
      'notes', jsonb_build_object('old', to_jsonb(NULL::text), 'new', to_jsonb(NEW.notes)),
      'status', jsonb_build_object('old', to_jsonb(NULL::text), 'new', to_jsonb(NEW.status))
    );

    INSERT INTO public.reservation_audit_logs (
      reservation_id,
      company_id,
      actor_user_id,
      actor_name,
      actor_role,
      actor_source,
      action,
      summary,
      details
    )
    VALUES (
      _reservation_id,
      _company_id,
      _actor_user_id,
      _actor_name,
      _actor_role,
      _actor_source,
      _action,
      _summary,
      jsonb_build_object('changes', _changes)
    );

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    _action := 'deleted';
    _summary := 'Reserva excluida';
    _changes := jsonb_build_object(
      'guest_name', jsonb_build_object('old', to_jsonb(OLD.guest_name), 'new', to_jsonb(NULL::text)),
      'date', jsonb_build_object('old', to_jsonb(OLD.date), 'new', to_jsonb(NULL::date)),
      'time', jsonb_build_object('old', to_jsonb(OLD.time), 'new', to_jsonb(NULL::time)),
      'party_size', jsonb_build_object('old', to_jsonb(OLD.party_size), 'new', to_jsonb(NULL::integer)),
      'status', jsonb_build_object('old', to_jsonb(OLD.status), 'new', to_jsonb(NULL::text))
    );

    INSERT INTO public.reservation_audit_logs (
      reservation_id,
      company_id,
      actor_user_id,
      actor_name,
      actor_role,
      actor_source,
      action,
      summary,
      details
    )
    VALUES (
      _reservation_id,
      _company_id,
      _actor_user_id,
      _actor_name,
      _actor_role,
      _actor_source,
      _action,
      _summary,
      jsonb_build_object('changes', _changes)
    );

    RETURN OLD;
  END IF;

  _changes := jsonb_strip_nulls(
    jsonb_build_object(
      'guest_name', CASE
        WHEN NEW.guest_name IS DISTINCT FROM OLD.guest_name
          THEN jsonb_build_object('old', to_jsonb(OLD.guest_name), 'new', to_jsonb(NEW.guest_name))
      END,
      'guest_phone', CASE
        WHEN NEW.guest_phone IS DISTINCT FROM OLD.guest_phone
          THEN jsonb_build_object('old', to_jsonb(OLD.guest_phone), 'new', to_jsonb(NEW.guest_phone))
      END,
      'guest_email', CASE
        WHEN NEW.guest_email IS DISTINCT FROM OLD.guest_email
          THEN jsonb_build_object('old', to_jsonb(OLD.guest_email), 'new', to_jsonb(NEW.guest_email))
      END,
      'guest_birthdate', CASE
        WHEN NEW.guest_birthdate IS DISTINCT FROM OLD.guest_birthdate
          THEN jsonb_build_object('old', to_jsonb(OLD.guest_birthdate), 'new', to_jsonb(NEW.guest_birthdate))
      END,
      'date', CASE
        WHEN NEW.date IS DISTINCT FROM OLD.date
          THEN jsonb_build_object('old', to_jsonb(OLD.date), 'new', to_jsonb(NEW.date))
      END,
      'time', CASE
        WHEN NEW.time IS DISTINCT FROM OLD.time
          THEN jsonb_build_object('old', to_jsonb(OLD.time), 'new', to_jsonb(NEW.time))
      END,
      'party_size', CASE
        WHEN NEW.party_size IS DISTINCT FROM OLD.party_size
          THEN jsonb_build_object('old', to_jsonb(OLD.party_size), 'new', to_jsonb(NEW.party_size))
      END,
      'occasion', CASE
        WHEN NEW.occasion IS DISTINCT FROM OLD.occasion
          THEN jsonb_build_object('old', to_jsonb(OLD.occasion), 'new', to_jsonb(NEW.occasion))
      END,
      'notes', CASE
        WHEN NEW.notes IS DISTINCT FROM OLD.notes
          THEN jsonb_build_object('old', to_jsonb(OLD.notes), 'new', to_jsonb(NEW.notes))
      END,
      'status', CASE
        WHEN NEW.status IS DISTINCT FROM OLD.status
          THEN jsonb_build_object('old', to_jsonb(OLD.status), 'new', to_jsonb(NEW.status))
      END,
      'checked_in_at', CASE
        WHEN NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at
          THEN jsonb_build_object('old', to_jsonb(OLD.checked_in_at), 'new', to_jsonb(NEW.checked_in_at))
      END,
      'checked_in_party_size', CASE
        WHEN NEW.checked_in_party_size IS DISTINCT FROM OLD.checked_in_party_size
          THEN jsonb_build_object('old', to_jsonb(OLD.checked_in_party_size), 'new', to_jsonb(NEW.checked_in_party_size))
      END
    )
  );

  IF _changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'checked_in' THEN
      _action := 'check_in';
      _summary := 'Check-in registrado';
    ELSIF NEW.status = 'no-show' AND OLD.status = 'confirmed' AND _actor_source = 'system' THEN
      _action := 'auto_no_show';
      _summary := 'No-show aplicado automaticamente';
    ELSE
      _action := 'status_changed';
      _summary := format(
        'Status alterado de %s para %s',
        public.format_reservation_status_label(OLD.status),
        public.format_reservation_status_label(NEW.status)
      );
    END IF;
  ELSE
    _action := 'updated';
    _summary := 'Reserva editada';
  END IF;

  INSERT INTO public.reservation_audit_logs (
    reservation_id,
    company_id,
    actor_user_id,
    actor_name,
    actor_role,
    actor_source,
    action,
    summary,
    details
  )
  VALUES (
    _reservation_id,
    _company_id,
    _actor_user_id,
    _actor_name,
    _actor_role,
    _actor_source,
    _action,
    _summary,
    jsonb_build_object('changes', _changes)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_reservation_changes ON public.reservations;
CREATE TRIGGER trg_audit_reservation_changes
AFTER INSERT OR UPDATE OR DELETE ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.audit_reservation_changes();

DROP FUNCTION IF EXISTS public.get_reservation_event_history(uuid);

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
  payload jsonb,
  actor_name text,
  actor_role text,
  actor_source text
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
      ) AS payload,
      NULL::text AS actor_name,
      NULL::text AS actor_role,
      NULL::text AS actor_source
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
      ) AS payload,
      NULL::text AS actor_name,
      NULL::text AS actor_role,
      NULL::text AS actor_source
    FROM public.meta_event_attempts mea
    JOIN public.meta_event_queue meq
      ON meq.id = mea.queue_id
    WHERE meq.reservation_id = _reservation_id
  ),
  audit_logs AS (
    SELECT
      ral.id,
      ral.created_at AS occurred_at,
      'audit'::text AS source,
      ral.action AS event_name,
      CASE
        WHEN ral.actor_source = 'system' THEN 'system'
        WHEN ral.actor_source = 'public' THEN 'public'
        ELSE 'manual'
      END AS tracking_source,
      CASE ral.action
        WHEN 'created' THEN 'Reserva criada'
        WHEN 'updated' THEN 'Reserva editada'
        WHEN 'status_changed' THEN 'Status alterado'
        WHEN 'check_in' THEN 'Check-in registrado'
        WHEN 'auto_no_show' THEN 'No-show automatico'
        WHEN 'deleted' THEN 'Reserva excluida'
        ELSE 'Auditoria da reserva'
      END AS title,
      ral.summary AS description,
      NULL::text AS status,
      ral.details AS payload,
      ral.actor_name,
      ral.actor_role,
      ral.actor_source
    FROM public.reservation_audit_logs ral
    WHERE ral.reservation_id = _reservation_id
  )
  SELECT *
  FROM (
    SELECT * FROM journey_events
    UNION ALL
    SELECT * FROM meta_logs
    UNION ALL
    SELECT * FROM audit_logs
  ) timeline
  ORDER BY occurred_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_reservation_event_history(uuid) TO authenticated;
