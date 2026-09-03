-- Notify company-panel users after three complete overdue days. Both billing
-- read paths are updated: the restricted banner decision and the summary popup.
DO $$
DECLARE
  _function_definition text;
  _updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.get_company_billing_overdue_warning(uuid)'::regprocedure
  ) INTO _function_definition;

  _updated_definition := replace(
    _function_definition,
    'invoice.due_date <= _today - 6',
    'invoice.due_date <= _today - 3'
  );

  IF _updated_definition = _function_definition THEN
    RAISE EXCEPTION 'Could not locate the overdue-warning threshold';
  END IF;

  EXECUTE _updated_definition;

  SELECT pg_get_functiondef(
    'public.get_company_billing_summary(uuid)'::regprocedure
  ) INTO _function_definition;

  _updated_definition := replace(
    _function_definition,
    'local_clock.today - rollup.oldest_overdue_due_date >= 6',
    'local_clock.today - rollup.oldest_overdue_due_date >= 3'
  );

  IF _updated_definition = _function_definition THEN
    RAISE EXCEPTION 'Could not locate the overdue-popup threshold';
  END IF;

  EXECUTE _updated_definition;
END;
$$;

COMMENT ON FUNCTION public.get_company_billing_overdue_warning(uuid) IS
  'Returns only effective billing availability and the three-day overdue-warning decision for a same-company admin/operator or superadmin; no invoice details are exposed.';
