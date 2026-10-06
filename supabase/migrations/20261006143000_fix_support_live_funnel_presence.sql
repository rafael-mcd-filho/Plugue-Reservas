-- Authorize once before aggregating tracking events. The previous invoker RPC
-- evaluated delegated role/context checks for every event through RLS, causing
-- support sessions to remain in a loading state on busy companies.
-- SECURITY DEFINER is safe here only with both the selected-company scope and
-- the effective target's dashboard permission checked before any event reads.
CREATE OR REPLACE FUNCTION public.get_live_funnel_presence(
  _company_id uuid DEFAULT NULL,
  _window_minutes integer DEFAULT 5
)
RETURNS TABLE(stage text, stage_count integer, total_active integer, window_minutes integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
  END IF;

  IF _company_id IS NULL THEN
    IF NOT public.has_role(auth.uid(), 'superadmin'::public.app_role) THEN
      RAISE EXCEPTION 'Uma empresa autorizada deve ser selecionada.' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT public.support_company_scope_allows(_company_id)
    OR NOT public.has_company_panel_permission(auth.uid(), _company_id, 'dashboard_view') THEN
    RAISE EXCEPTION 'Sem permissao para visualizar o dashboard desta empresa.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH params AS (
    SELECT GREATEST(COALESCE(_window_minutes, 5), 1) AS minutes
  ),
  stages AS (
    SELECT *
    FROM (VALUES
      ('page_view'::text, 1),
      ('date_select'::text, 2),
      ('time_select'::text, 3),
      ('form_fill'::text, 4),
      ('completed'::text, 5)
    ) AS ordered_stages(stage, sort_order)
  ),
  latest_events AS (
    SELECT DISTINCT ON (
      CASE
        WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
        ELSE 'anonymous:' || te.anonymous_id
      END
    )
      CASE
        WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
        ELSE 'anonymous:' || te.anonymous_id
      END AS presence_key,
      CASE
        WHEN te.event_name = 'reservation_created' THEN 'completed'
        WHEN te.event_name IN ('form_fill', 'lead_captured') THEN 'form_fill'
        WHEN te.event_name = 'time_select' THEN 'time_select'
        WHEN te.event_name IN ('date_select', 'booking_started') THEN 'date_select'
        WHEN te.event_name = 'page_view' THEN 'page_view'
        ELSE NULL
      END AS stage
    FROM public.tracking_events te
    CROSS JOIN params
    WHERE te.tracking_source = 'public'
      AND (_company_id IS NULL OR te.company_id = _company_id)
      AND te.occurred_at >= now() - make_interval(mins => params.minutes)
      AND te.event_name IN (
        'page_view', 'booking_started', 'date_select', 'time_select',
        'form_fill', 'lead_captured', 'reservation_created'
      )
    ORDER BY
      CASE
        WHEN te.session_id IS NOT NULL THEN 'session:' || te.session_id::text
        ELSE 'anonymous:' || te.anonymous_id
      END,
      te.occurred_at DESC
  ),
  counted AS (
    SELECT latest_events.stage, count(*)::integer AS stage_count
    FROM latest_events
    WHERE latest_events.stage IS NOT NULL
    GROUP BY latest_events.stage
  ),
  total AS (
    SELECT count(*)::integer AS total_active
    FROM latest_events
    WHERE latest_events.stage IS NOT NULL
  )
  SELECT stages.stage, COALESCE(counted.stage_count, 0)::integer,
    total.total_active, params.minutes
  FROM stages
  CROSS JOIN params
  CROSS JOIN total
  LEFT JOIN counted ON counted.stage = stages.stage
  ORDER BY stages.sort_order;
END;
$$;

REVOKE ALL ON FUNCTION public.get_live_funnel_presence(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_live_funnel_presence(uuid, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
