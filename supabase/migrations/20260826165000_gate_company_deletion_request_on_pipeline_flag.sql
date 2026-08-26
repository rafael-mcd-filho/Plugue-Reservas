-- request_company_deletion did not check company_deletion_pipeline_enabled,
-- only the cron runner did. With the flag off, clicking "Excluir" still
-- quarantined the company (deletion_requested_at set, all writes blocked)
-- but the request could never be processed -- stranded in grace_period
-- forever with no automatic way out. Fail the request itself instead.
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
