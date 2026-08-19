-- Expose the overdue-warning decision to every authenticated company-panel
-- member without exposing invoice amounts, counts, dates or provider metadata.

CREATE OR REPLACE FUNCTION public.get_company_billing_overdue_warning(
  _company_id uuid
)
RETURNS TABLE (
  billing_enabled boolean,
  show_overdue_warning boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _viewer_id uuid := auth.uid();
  _effective_billing_enabled boolean := false;
  _show_overdue_warning boolean := false;
  _today date;
BEGIN
  -- Authorize before reading any billing state so callers cannot use this RPC
  -- to probe whether another company is configured or has overdue invoices.
  IF _viewer_id IS NULL THEN
    RAISE EXCEPTION 'Not authorized to read company billing warning'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(_viewer_id, 'superadmin'::public.app_role)
    OR public.has_role_in_company(
      _viewer_id,
      'admin'::public.app_role,
      _company_id
    )
    OR public.has_role_in_company(
      _viewer_id,
      'operator'::public.app_role,
      _company_id
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to read company billing warning'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    public.platform_billing_is_enabled()
    AND COALESCE((
      SELECT link.billing_enabled
      FROM public.company_billing_links AS link
      WHERE link.company_id = _company_id
      LIMIT 1
    ), false)
  INTO _effective_billing_enabled;

  -- Disabled billing must not expose or scan cached invoice state.
  IF NOT COALESCE(_effective_billing_enabled, false) THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  _today := (now() AT TIME ZONE 'America/Fortaleza')::date;

  SELECT EXISTS (
    SELECT 1
    FROM public.company_billing_invoices AS invoice
    WHERE invoice.company_id = _company_id
      AND upper(invoice.status) IN (
        'PENDING',
        'OVERDUE',
        'DUNNING_REQUESTED',
        'AWAITING_RISK_ANALYSIS'
      )
      AND invoice.due_date <= _today - 6
  )
  INTO _show_overdue_warning;

  RETURN QUERY
  SELECT true, COALESCE(_show_overdue_warning, false);
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_billing_overdue_warning(uuid)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_billing_overdue_warning(uuid)
TO authenticated;

COMMENT ON FUNCTION public.get_company_billing_overdue_warning(uuid) IS
  'Returns only effective billing availability and the six-day overdue-warning decision for a same-company admin/operator or superadmin; no invoice details are exposed.';
