UPDATE public.company_tracking_settings
SET
  capi_enabled = false,
  updated_at = now()
WHERE capi_enabled = true
  AND (
    COALESCE(NULLIF(btrim(pixel_id), ''), '') = ''
    OR COALESCE(NULLIF(btrim(access_token), ''), '') = ''
  );

ALTER TABLE public.company_tracking_settings
  DROP CONSTRAINT IF EXISTS company_tracking_settings_capi_credentials_check;

ALTER TABLE public.company_tracking_settings
  ADD CONSTRAINT company_tracking_settings_capi_credentials_check
  CHECK (
    NOT capi_enabled
    OR (
      COALESCE(NULLIF(btrim(pixel_id), ''), '') <> ''
      AND COALESCE(NULLIF(btrim(access_token), ''), '') <> ''
    )
  );

WITH invalid_queue AS (
  SELECT q.id
  FROM public.meta_event_queue q
  LEFT JOIN public.company_tracking_settings s
    ON s.company_id = q.company_id
  WHERE NOT COALESCE(s.capi_enabled, false)
    OR COALESCE(NULLIF(btrim(s.pixel_id), ''), '') = ''
    OR COALESCE(NULLIF(btrim(s.access_token), ''), '') = ''
)
DELETE FROM public.meta_event_attempts
WHERE queue_id IN (SELECT id FROM invalid_queue);

WITH invalid_queue AS (
  SELECT q.id
  FROM public.meta_event_queue q
  LEFT JOIN public.company_tracking_settings s
    ON s.company_id = q.company_id
  WHERE NOT COALESCE(s.capi_enabled, false)
    OR COALESCE(NULLIF(btrim(s.pixel_id), ''), '') = ''
    OR COALESCE(NULLIF(btrim(s.access_token), ''), '') = ''
)
DELETE FROM public.meta_event_queue
WHERE id IN (SELECT id FROM invalid_queue);

CREATE OR REPLACE FUNCTION public.clear_company_event_data(
  _company_id uuid,
  _scope text DEFAULT 'meta_queue'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _deleted_meta_attempts integer := 0;
  _deleted_meta_queue integer := 0;
  _deleted_tracking_events integer := 0;
  _deleted_tracking_journeys integer := 0;
  _deleted_tracking_sessions integer := 0;
  _deleted integer := 0;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa obrigatoria.';
  END IF;

  IF _scope NOT IN ('meta_queue', 'event_log', 'all') THEN
    RAISE EXCEPTION 'Escopo de limpeza invalido.';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'superadmin')
    OR public.has_role_in_company(auth.uid(), 'admin', _company_id)
  ) THEN
    RAISE EXCEPTION 'Sem permissao para limpar eventos desta empresa.';
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
  END IF;

  RETURN jsonb_build_object(
    'meta_attempts', _deleted_meta_attempts,
    'meta_queue', _deleted_meta_queue,
    'tracking_events', _deleted_tracking_events,
    'tracking_journeys', _deleted_tracking_journeys,
    'tracking_sessions', _deleted_tracking_sessions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.clear_company_event_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_company_event_data(uuid, text) TO authenticated;
