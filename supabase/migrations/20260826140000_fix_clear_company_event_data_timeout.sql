-- The "Limpar" button on the Meta queue / event log (CompanyEvents.tsx) calls
-- clear_company_event_data directly from the browser through PostgREST. The
-- authenticated role's statement_timeout in production is 8s, and companies
-- with a large tracking/meta history blow past that even though every DELETE
-- here is backed by a leading company_id index — the row volume alone is
-- enough. delete_company_permanently already solved the exact same class of
-- problem (see docs/problema-exclusao-empresas.md) by overriding the timeout
-- at the function level; this applies the same fix here. Scope is much
-- narrower than company deletion (2-5 operational tables, no external
-- providers, no cascade into companies), so no async/job architecture is
-- needed for this one.
CREATE OR REPLACE FUNCTION public.clear_company_event_data(
  _company_id uuid,
  _scope text DEFAULT 'meta_queue'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '55s'
AS $$
DECLARE
  _deleted_meta_attempts integer := 0;
  _deleted_meta_queue integer := 0;
  _deleted_tracking_events integer := 0;
  _deleted_tracking_journeys integer := 0;
  _deleted_tracking_sessions integer := 0;
  _deleted_funnel_sessions integer := 0;
  _deleted_funnel_states integer := 0;
  _deleted integer := 0;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa obrigatória.';
  END IF;

  IF _scope NOT IN ('meta_queue', 'event_log', 'all') THEN
    RAISE EXCEPTION 'Escopo de limpeza inválido.';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'superadmin')
    OR public.has_role_in_company(auth.uid(), 'admin', _company_id)
  ) THEN
    RAISE EXCEPTION 'Sem permissão para limpar eventos desta empresa.';
  END IF;

  IF _scope = 'meta_queue' THEN
    DELETE FROM public.meta_event_attempts
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_attempts := _deleted_meta_attempts + _deleted;

    DELETE FROM public.meta_event_queue
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_queue := _deleted_meta_queue + _deleted;
  END IF;

  IF _scope = 'event_log' THEN
    DELETE FROM public.meta_event_attempts
    WHERE queue_id IN (
      SELECT id
      FROM public.meta_event_queue
      WHERE company_id = _company_id
        AND tracking_event_id IS NOT NULL
    );
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_attempts := _deleted_meta_attempts + _deleted;

    DELETE FROM public.meta_event_queue
    WHERE company_id = _company_id
      AND tracking_event_id IS NOT NULL;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_queue := _deleted_meta_queue + _deleted;

    DELETE FROM public.tracking_events
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_events := _deleted_tracking_events + _deleted;

    DELETE FROM public.tracking_funnel_sessions
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_sessions := _deleted_funnel_sessions + _deleted;

    DELETE FROM public.tracking_funnel_projection_state
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_states := _deleted_funnel_states + _deleted;
  END IF;

  IF _scope = 'all' THEN
    DELETE FROM public.meta_event_attempts
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_attempts := _deleted_meta_attempts + _deleted;

    DELETE FROM public.meta_event_queue
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_meta_queue := _deleted_meta_queue + _deleted;

    DELETE FROM public.tracking_events
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_events := _deleted_tracking_events + _deleted;

    DELETE FROM public.tracking_journeys
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_journeys := _deleted_tracking_journeys + _deleted;

    DELETE FROM public.tracking_sessions
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_tracking_sessions := _deleted_tracking_sessions + _deleted;

    DELETE FROM public.tracking_funnel_sessions
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_sessions := _deleted_funnel_sessions + _deleted;

    DELETE FROM public.tracking_funnel_projection_state
    WHERE company_id = _company_id;
    GET DIAGNOSTICS _deleted = ROW_COUNT;
    _deleted_funnel_states := _deleted_funnel_states + _deleted;
  END IF;

  RETURN jsonb_build_object(
    'meta_attempts', _deleted_meta_attempts,
    'meta_queue', _deleted_meta_queue,
    'tracking_events', _deleted_tracking_events,
    'tracking_journeys', _deleted_tracking_journeys,
    'tracking_sessions', _deleted_tracking_sessions,
    'tracking_funnel_sessions', _deleted_funnel_sessions,
    'tracking_funnel_projection_states', _deleted_funnel_states
  );
END;
$$;

REVOKE ALL ON FUNCTION public.clear_company_event_data(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_company_event_data(uuid, text)
  TO authenticated;
