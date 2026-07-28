CREATE OR REPLACE FUNCTION public.can_view_reservation_event_history(_reservation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.reservations r
      WHERE r.id = _reservation_id
        AND (
          public.has_role(auth.uid(), 'superadmin'::public.app_role)
          OR public.has_role_in_company(
            auth.uid(),
            'admin'::public.app_role,
            r.company_id
          )
        )
    );
$$;

REVOKE ALL ON FUNCTION public.can_view_reservation_event_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_reservation_event_history(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_view_reservation_event_history(uuid) TO authenticated;

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
      AND public.can_view_reservation_event_history(r.id)
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
    JOIN reservation_context rc
      ON meq.reservation_id = rc.id
      AND meq.company_id = rc.company_id
      AND mea.company_id = rc.company_id
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
    JOIN reservation_context rc
      ON ral.reservation_id = rc.id
      AND ral.company_id = rc.company_id
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

REVOKE ALL ON FUNCTION public.get_reservation_event_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_reservation_event_history(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_reservation_event_history(uuid) TO authenticated;
