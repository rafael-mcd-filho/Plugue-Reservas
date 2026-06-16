-- Separate commercial access to the NPS screen from the company's operational
-- activation of post-visit review generation.

CREATE OR REPLACE FUNCTION public.set_company_nps_enabled(
  _company_id uuid,
  _enabled boolean
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  feature_key text,
  enabled boolean,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  _override public.company_feature_overrides%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(), 'superadmin') THEN
    RAISE EXCEPTION 'Sem permissao para alterar a feature de NPS.';
  END IF;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa invalida.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = _company_id) THEN
    RAISE EXCEPTION 'Empresa nao encontrada.';
  END IF;

  INSERT INTO public.company_feature_overrides (
    company_id,
    feature_key,
    enabled,
    updated_at
  )
  VALUES (
    _company_id,
    'nps_surveys',
    COALESCE(_enabled, false),
    now()
  )
  ON CONFLICT (company_id, feature_key)
  DO UPDATE SET
    enabled = EXCLUDED.enabled,
    updated_at = now()
  RETURNING * INTO _override;

  IF COALESCE(_enabled, false) THEN
    INSERT INTO public.company_nps_configs (
      company_id,
      enabled,
      updated_at
    )
    VALUES (
      _company_id,
      false,
      now()
    )
    ON CONFLICT (company_id) DO NOTHING;
  END IF;

  RETURN QUERY
  SELECT
    _override.id,
    _override.company_id,
    _override.feature_key,
    _override.enabled,
    _override.created_at,
    _override.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_company_nps_enabled(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_company_nps_enabled(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.ensure_reservation_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _config public.company_nps_configs%ROWTYPE;
  _lead_id uuid;
BEGIN
  IF NEW.status NOT IN ('checked_in', 'completed') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('checked_in', 'completed') THEN
    RETURN NEW;
  END IF;

  IF NOT public.company_feature_enabled(NEW.company_id, 'nps_surveys') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _config
  FROM public.company_nps_configs
  WHERE company_id = NEW.company_id;

  IF NOT FOUND OR NOT _config.enabled THEN
    RETURN NEW;
  END IF;

  SELECT id INTO _lead_id
  FROM public.crm_leads
  WHERE company_id = NEW.company_id
    AND phone_normalized = regexp_replace(COALESCE(NEW.guest_phone, ''), '\D', '', 'g')
  LIMIT 1;

  INSERT INTO public.reservation_reviews (
    company_id,
    reservation_id,
    lead_id,
    expires_at
  )
  VALUES (
    NEW.company_id,
    NEW.id,
    _lead_id,
    now() + (_config.expiration_days || ' days')::interval
  )
  ON CONFLICT (reservation_id) DO NOTHING;

  RETURN NEW;
END;
$$;

