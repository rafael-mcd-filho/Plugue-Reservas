-- Expand Ads journey V2 shadow collection to every company.
-- Customer-facing dashboards continue using the legacy attribution method.

ALTER TABLE public.company_tracking_settings
  ALTER COLUMN ads_attribution_mode SET DEFAULT 'shadow';

CREATE OR REPLACE FUNCTION public.guard_ads_attribution_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.ads_attribution_mode IS NOT DISTINCT FROM OLD.ads_attribution_mode
  THEN
    RETURN NEW;
  END IF;

  -- Shadow collection is the platform-wide default. Company admins can keep
  -- creating their normal tracking settings without controlling this mode.
  IF TG_OP = 'INSERT' AND NEW.ads_attribution_mode = 'shadow' THEN
    RETURN NEW;
  END IF;

  IF current_user IN ('postgres', 'service_role', 'supabase_admin')
    OR COALESCE(
      public.has_role(auth.uid(), 'superadmin'::public.app_role),
      false
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only superadmins can change Ads attribution mode'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_ads_attribution_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_ads_attribution_mode() FROM anon;
REVOKE ALL ON FUNCTION public.guard_ads_attribution_mode() FROM authenticated;

-- Every existing company receives a settings row and is moved to shadow.
INSERT INTO public.company_tracking_settings (
  company_id,
  ads_attribution_mode
)
SELECT
  company.id,
  'shadow'
FROM public.companies AS company
ON CONFLICT (company_id) DO UPDATE
SET
  ads_attribution_mode = EXCLUDED.ads_attribution_mode,
  updated_at = now();

-- Keep the rollout global for companies created after this migration, even
-- before an administrator first opens or saves the tracking settings screen.
CREATE OR REPLACE FUNCTION public.ensure_global_ads_shadow_for_new_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.company_tracking_settings (
    company_id,
    ads_attribution_mode
  )
  VALUES (
    NEW.id,
    'shadow'
  )
  ON CONFLICT (company_id) DO UPDATE
  SET
    ads_attribution_mode = EXCLUDED.ads_attribution_mode,
    updated_at = now();

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_global_ads_shadow_for_new_company()
FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_global_ads_shadow_for_new_company()
FROM anon;
REVOKE ALL ON FUNCTION public.ensure_global_ads_shadow_for_new_company()
FROM authenticated;

DROP TRIGGER IF EXISTS ensure_global_ads_shadow_for_new_company
ON public.companies;

CREATE TRIGGER ensure_global_ads_shadow_for_new_company
AFTER INSERT ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.ensure_global_ads_shadow_for_new_company();

CREATE OR REPLACE FUNCTION public.guard_global_ads_shadow_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin')
    OR COALESCE(
      public.has_role(auth.uid(), 'superadmin'::public.app_role),
      false
    )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Company administrators cannot disable global Ads shadow collection'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_global_ads_shadow_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_global_ads_shadow_row() FROM anon;
REVOKE ALL ON FUNCTION public.guard_global_ads_shadow_row()
FROM authenticated;

DROP TRIGGER IF EXISTS guard_global_ads_shadow_row_on_delete
ON public.company_tracking_settings;

CREATE TRIGGER guard_global_ads_shadow_row_on_delete
BEFORE DELETE ON public.company_tracking_settings
FOR EACH ROW
EXECUTE FUNCTION public.guard_global_ads_shadow_row();

COMMENT ON COLUMN public.company_tracking_settings.ads_attribution_mode IS
  'Platform-wide Ads journey V2 shadow collection. Existing and new companies default to shadow without changing customer-visible V1 metrics.';
