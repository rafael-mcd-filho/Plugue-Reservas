-- Async company deletion pipeline -- user-facing RPCs.
--
-- Thin, superadmin-gated entry points. All real work happens in the
-- service_role-only engine (20260826162000_add_company_deletion_engine.sql).
-- Same grant convention as clear_company_event_data: REVOKE ALL FROM PUBLIC,
-- anon; GRANT EXECUTE TO authenticated (the internal has_role check is the
-- actual gate).

CREATE OR REPLACE FUNCTION public.request_company_deletion(
  _company_id uuid,
  _confirmation_text text,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _company record;
  _grace_period interval := interval '24 hours';
  _request_id uuid := gen_random_uuid();
  _impact jsonb;
  _now timestamptz := clock_timestamp();
BEGIN
  IF _actor_id IS NULL OR NOT public.has_role(_actor_id, 'superadmin'::public.app_role) THEN
    RAISE EXCEPTION 'Somente superadministradores podem solicitar exclusão de empresas.' USING ERRCODE = '42501';
  END IF;

  -- Fail fast, before quarantining anything: with the pipeline disabled the
  -- cron worker never picks up a request, so letting one through here would
  -- just strand the company in grace_period forever with no way forward
  -- except a manual cancel or flipping the flag back on.
  IF COALESCE((SELECT value FROM public.system_settings WHERE key = 'company_deletion_pipeline_enabled'), 'false') <> 'true' THEN
    RAISE EXCEPTION 'A exclusão assíncrona de empresas está temporariamente desativada.' USING ERRCODE = '55000';
  END IF;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa obrigatória.' USING ERRCODE = '22004';
  END IF;

  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Informe o motivo da exclusão.' USING ERRCODE = '22004';
  END IF;

  SELECT company.id, company.name, company.slug, company.deletion_requested_at
  INTO _company
  FROM public.companies company
  WHERE company.id = _company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa não encontrada.' USING ERRCODE = '22023';
  END IF;

  IF _company.deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Já existe uma solicitação de exclusão ativa para esta empresa.' USING ERRCODE = '55006';
  END IF;

  IF _confirmation_text IS NULL OR btrim(_confirmation_text) NOT IN (_company.name, _company.slug) THEN
    RAISE EXCEPTION 'Digite exatamente o nome ou o identificador (slug) da empresa para confirmar.' USING ERRCODE = '22023';
  END IF;

  -- Estimates only (pg_stat_user_tables.n_live_tup), never an exact COUNT(*)
  -- across ~60 tables here -- that would reintroduce the same 8s timeout
  -- this pipeline exists to fix.
  SELECT jsonb_object_agg(order_row.table_name, COALESCE(stat.n_live_tup, 0))
  INTO _impact
  FROM public.company_deletion_phase_order order_row
  LEFT JOIN pg_stat_user_tables stat
    ON stat.relname = order_row.table_name AND stat.schemaname = 'public';

  INSERT INTO public.company_deletion_requests (
    id, company_id, company_name_snapshot, company_slug_snapshot,
    requested_by, requested_reason, confirmation_text, grace_period_ends_at,
    impact_preview
  ) VALUES (
    _request_id, _company_id, _company.name, _company.slug,
    _actor_id, _reason, _confirmation_text, _now + _grace_period,
    COALESCE(_impact, '{}'::jsonb)
  );

  UPDATE public.companies SET deletion_requested_at = _now WHERE id = _company_id;

  INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES (
    _actor_id, 'company_deletion_requested', 'company', _company_id,
    jsonb_build_object(
      'reason', _reason, 'confirmation_text', _confirmation_text,
      'request_id', _request_id, 'grace_period_ends_at', _now + _grace_period
    )
  );

  RETURN jsonb_build_object(
    'request_id', _request_id,
    'grace_period_ends_at', _now + _grace_period,
    'impact_preview', COALESCE(_impact, '{}'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_company_deletion(_company_id uuid)
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
    RAISE EXCEPTION 'Somente superadministradores podem cancelar exclusão de empresas.' USING ERRCODE = '42501';
  END IF;

  -- Only cancelable during the grace period: once the worker has started
  -- deleting rows, "canceling" cannot undo the rows already removed, so
  -- offering it would be misleading rather than safe.
  SELECT request.id INTO _request
  FROM public.company_deletion_requests request
  WHERE request.company_id = _company_id AND request.status = 'grace_period'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há solicitação em período de carência para esta empresa (pode já ter começado a ser processada).' USING ERRCODE = '22023';
  END IF;

  UPDATE public.company_deletion_requests
  SET status = 'canceled', canceled_by = _actor_id, canceled_at = _now, updated_at = _now
  WHERE id = _request.id;

  UPDATE public.companies SET deletion_requested_at = NULL WHERE id = _company_id;

  INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES (_actor_id, 'company_deletion_canceled', 'company', _company_id, jsonb_build_object('request_id', _request.id));

  RETURN jsonb_build_object('request_id', _request.id, 'status', 'canceled');
END;
$$;

-- Manual escape hatch for a request stuck in 'needs_attention' (external
-- teardown kept failing after repeated automatic retries). Skips teardown
-- and lets the engine proceed straight to the final company delete on its
-- next tick -- does not touch Asaas either way, since teardown never did.
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
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há solicitação travada em desprovisionamento externo para esta empresa.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.company_deletion_requests
  SET
    status = 'running',
    external_teardown_result = COALESCE(_request.external_teardown_result, '{}'::jsonb)
      || jsonb_build_object('status', 'ok', 'skipped_manually', true, 'skipped_by', _actor_id, 'skipped_at', _now),
    consecutive_errors = 0,
    last_error = NULL,
    next_attempt_at = '-infinity'::timestamptz,
    updated_at = _now
  WHERE id = _request.id;

  INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES (_actor_id, 'company_deletion_teardown_skipped', 'company', _company_id, jsonb_build_object('request_id', _request.id));

  RETURN jsonb_build_object('request_id', _request.id, 'status', 'running');
END;
$$;

CREATE OR REPLACE FUNCTION public.list_company_deletion_requests()
RETURNS SETOF public.company_deletion_requests
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT request.*
  FROM public.company_deletion_requests request
  WHERE public.has_role(auth.uid(), 'superadmin'::public.app_role)
  ORDER BY request.requested_at DESC;
$$;

REVOKE ALL ON FUNCTION public.request_company_deletion(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_company_deletion(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.force_skip_company_deletion_teardown(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_company_deletion_requests() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.request_company_deletion(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_company_deletion(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.force_skip_company_deletion_teardown(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_company_deletion_requests() TO authenticated;
