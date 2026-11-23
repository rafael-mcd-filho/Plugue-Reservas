-- Drain the Meta queue before deleting its tracking events. The FK from
-- meta_event_queue.tracking_event_id uses ON DELETE SET NULL; deleting raw
-- events first moves distinct queue rows into the reservation-only unique
-- index and can fail with 23505 for repeated events from one reservation.
-- Keep the existing event-retention and Meta deduplication rules unchanged.
DO $$
BEGIN
  -- Serialize with the scheduled runner. Lock active requests in the same
  -- order as the runner, before changing the phase map they will next read.
  PERFORM pg_advisory_xact_lock(hashtextextended('company-deletion-runner-global', 0));
  PERFORM request.id
  FROM public.company_deletion_requests request
  WHERE request.status IN ('grace_period', 'running', 'needs_attention')
  ORDER BY request.next_attempt_at, request.id
  FOR UPDATE;

  IF (SELECT count(*) FROM public.company_deletion_phase_order
      WHERE (phase_index, table_name) IN (
        (1, 'tracking_events'), (2, 'meta_event_attempts'), (3, 'meta_event_queue')
      )) <> 3 THEN
    RAISE EXCEPTION 'Unexpected company deletion phase order; refusing to remap active requests.';
  END IF;

  DELETE FROM public.company_deletion_phase_order WHERE phase_index BETWEEN 1 AND 3;
  INSERT INTO public.company_deletion_phase_order (phase_index, table_name) VALUES
    (1, 'meta_event_attempts'),
    (2, 'meta_event_queue'),
    (3, 'tracking_events');

  -- Existing requests may point at any of the three old phases. Revisit the
  -- whole group rather than interpreting their old index under the new map.
  -- Already deleted rows are harmless to revisit; keep their audit counters.
  UPDATE public.company_deletion_requests
  SET phase_index = 1, updated_at = clock_timestamp()
  WHERE phase_index BETWEEN 1 AND 3
    AND status IN ('grace_period', 'running', 'needs_attention');

  -- Resume only requests stopped by this exact bug, preserving the user's
  -- recorded external teardown decision and the original deletion request.
  UPDATE public.company_deletion_requests
  SET status = 'running', phase = 'meta_event_attempts',
      consecutive_errors = 0, last_error = NULL,
      next_attempt_at = '-infinity'::timestamptz, updated_at = clock_timestamp()
  WHERE status = 'needs_attention'
    AND phase = 'tracking_events' AND phase_index = 1
    AND last_error LIKE '23505:%"idx_meta_event_queue_reservation_event_unique"%';
END;
$$;

-- Retrying an internal database phase must not silently skip external cleanup.
CREATE OR REPLACE FUNCTION public.retry_company_deletion(_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _request_id uuid;
BEGIN
  IF _actor_id IS NULL OR NOT public.has_role(_actor_id, 'superadmin'::public.app_role) THEN
    RAISE EXCEPTION 'Somente superadministradores podem retomar exclusões de empresas.' USING ERRCODE = '42501';
  END IF;

  SELECT request.id INTO _request_id
  FROM public.company_deletion_requests request
  WHERE request.company_id = _company_id AND request.status = 'needs_attention'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há exclusão aguardando atenção para esta empresa.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.company_deletion_requests
  SET status = 'running', consecutive_errors = 0, last_error = NULL,
      next_attempt_at = '-infinity'::timestamptz, updated_at = clock_timestamp()
  WHERE id = _request_id;

  INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES (_actor_id, 'company_deletion_retried', 'company', _company_id,
    jsonb_build_object('request_id', _request_id));

  RETURN jsonb_build_object('request_id', _request_id, 'status', 'running');
END;
$$;

CREATE OR REPLACE FUNCTION public.force_skip_company_deletion_teardown(_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _request record;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _actor_id IS NULL OR NOT public.has_role(_actor_id, 'superadmin'::public.app_role) THEN
    RAISE EXCEPTION 'Somente superadministradores podem forçar essa etapa.' USING ERRCODE = '42501';
  END IF;

  SELECT request.id, request.external_teardown_result INTO _request
  FROM public.company_deletion_requests request
  WHERE request.company_id = _company_id AND request.status = 'needs_attention'
    AND request.phase = 'external_teardown'
    AND request.phase_index > (SELECT max(phase_index) FROM public.company_deletion_phase_order)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há exclusão travada na etapa externa. Retome a exclusão para tentar novamente a etapa atual.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.company_deletion_requests
  SET status = 'running',
      external_teardown_result = COALESCE(_request.external_teardown_result, '{}'::jsonb)
        || jsonb_build_object('status', 'ok', 'skipped_manually', true, 'skipped_by', _actor_id, 'skipped_at', _now),
      consecutive_errors = 0, last_error = NULL,
      next_attempt_at = '-infinity'::timestamptz, updated_at = _now
  WHERE id = _request.id;

  INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES (_actor_id, 'company_deletion_teardown_skipped', 'company', _company_id,
    jsonb_build_object('request_id', _request.id));

  RETURN jsonb_build_object('request_id', _request.id, 'status', 'running');
END;
$$;

REVOKE ALL ON FUNCTION public.retry_company_deletion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_company_deletion(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.force_skip_company_deletion_teardown(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.force_skip_company_deletion_teardown(uuid) TO authenticated;
