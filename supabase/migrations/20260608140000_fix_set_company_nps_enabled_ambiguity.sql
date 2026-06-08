-- Corrige "column reference 'company_id' is ambiguous" em set_company_nps_enabled.
-- A função declarava RETURNS TABLE com colunas company_id/enabled/etc., que viravam
-- parâmetros OUT no PL/pgSQL e conflitavam com as colunas de mesmo nome nos INSERTs.
-- A diretiva #variable_conflict use_column diz ao PL/pgSQL para sempre preferir
-- a coluna da tabela quando houver conflito de nome.

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

  INSERT INTO public.company_nps_configs (
    company_id,
    enabled,
    updated_at
  )
  VALUES (
    _company_id,
    COALESCE(_enabled, false),
    now()
  )
  ON CONFLICT (company_id)
  DO UPDATE SET
    enabled = EXCLUDED.enabled,
    updated_at = now();

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
