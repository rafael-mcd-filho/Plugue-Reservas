-- Restore reservation_prepayment in the company feature flag contract after later
-- feature migrations rewrote these functions without the payment feature.

CREATE OR REPLACE FUNCTION public.company_feature_enabled(
  _company_id uuid,
  _feature_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company_plan AS (
    SELECT COALESCE(c.plan_tier, 'enterprise') AS plan_tier
    FROM public.companies c
    WHERE c.id = _company_id
  ),
  override_value AS (
    SELECT cfo.enabled
    FROM public.company_feature_overrides cfo
    WHERE cfo.company_id = _company_id
      AND cfo.feature_key = _feature_key
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT enabled FROM override_value),
    CASE
      WHEN _feature_key = 'reservation_prepayment' THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'starter' THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'pro' THEN
        _feature_key IN ('whatsapp_integration', 'custom_public_page', 'active_communication', 'flow_protection')
      WHEN (SELECT plan_tier FROM company_plan) = 'enterprise' THEN
        _feature_key IN ('whatsapp_integration', 'custom_public_page', 'advanced_reports', 'active_communication', 'flow_protection')
      ELSE false
    END
  );
$$;

CREATE OR REPLACE FUNCTION public.get_company_feature_flags(_company_id uuid)
RETURNS TABLE (
  feature_key text,
  enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE public.has_role(auth.uid(), 'superadmin')
      OR EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.company_id = _company_id
      )
  )
  SELECT feature_key, public.company_feature_enabled(_company_id, feature_key) AS enabled
  FROM unnest(ARRAY[
    'whatsapp_integration',
    'custom_public_page',
    'advanced_reports',
    'active_communication',
    'flow_protection',
    'reservation_prepayment'
  ]) AS feature_key
  WHERE EXISTS (SELECT 1 FROM has_access);
$$;

GRANT EXECUTE ON FUNCTION public.get_company_feature_flags(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_feature_enabled(uuid, text) TO authenticated;
