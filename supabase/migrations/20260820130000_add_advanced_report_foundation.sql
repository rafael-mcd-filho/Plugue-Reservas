-- Shared, fail-closed foundation for the advanced company reports.
--
-- This migration does not change the existing Dashboard read path. New report
-- RPCs use an explicit company calendar timezone and a common authorization /
-- date-range contract. America/Fortaleza preserves the historical behavior for
-- companies that have not selected another IANA timezone yet.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'America/Fortaleza';

CREATE OR REPLACE FUNCTION public._is_valid_iana_time_zone(_time_zone text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_timezone_names names
    WHERE names.name = NULLIF(btrim(_time_zone), '')
  );
$$;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_time_zone_valid;

ALTER TABLE public.companies
  ADD CONSTRAINT companies_time_zone_valid
  CHECK (public._is_valid_iana_time_zone(time_zone));

CREATE OR REPLACE FUNCTION public._assert_company_advanced_report_access(
  _company_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id é obrigatório.' USING ERRCODE = '22023';
  END IF;

  IF auth.role() IS NOT DISTINCT FROM 'service_role' THEN
    RETURN;
  END IF;

  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autorizado.' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_role(auth.uid(), 'superadmin'::public.app_role)
    AND NOT public.has_role_in_company(
      auth.uid(),
      'admin'::public.app_role,
      _company_id
    ) THEN
    RAISE EXCEPTION 'Apenas administradores podem visualizar este relatório.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.company_feature_enabled(_company_id, 'advanced_reports') THEN
    RAISE EXCEPTION 'Relatórios avançados não estão habilitados para esta empresa.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._company_report_time_zone(_company_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
BEGIN
  SELECT companies.time_zone
  INTO _time_zone
  FROM public.companies
  WHERE companies.id = _company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa não encontrada.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public._is_valid_iana_time_zone(_time_zone) THEN
    RAISE EXCEPTION 'Fuso horário inválido para a empresa.' USING ERRCODE = '22023';
  END IF;

  RETURN _time_zone;
END;
$$;

CREATE OR REPLACE FUNCTION public._validate_advanced_report_range(
  _start_date date,
  _end_date date,
  _maximum_days integer DEFAULT 366
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  _days integer;
BEGIN
  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date THEN
    RAISE EXCEPTION 'Intervalo de datas inválido.' USING ERRCODE = '22023';
  END IF;

  IF _maximum_days IS NULL OR _maximum_days < 1 THEN
    RAISE EXCEPTION 'Limite de dias inválido.' USING ERRCODE = '22023';
  END IF;

  _days := (_end_date - _start_date) + 1;
  IF _days > _maximum_days THEN
    RAISE EXCEPTION 'O período pode ter no máximo % dias. O intervalo atual possui % dias.',
      _maximum_days,
      _days
      USING ERRCODE = '22023';
  END IF;
END;
$$;

COMMENT ON COLUMN public.companies.time_zone IS
  'Fuso IANA usado por relatórios e agrupamentos de calendário da empresa.';
COMMENT ON FUNCTION public._assert_company_advanced_report_access(uuid) IS
  'Autorização interna comum aos relatórios avançados por empresa.';
COMMENT ON FUNCTION public._company_report_time_zone(uuid) IS
  'Retorna o fuso IANA validado da empresa para contratos de relatório.';
COMMENT ON FUNCTION public._validate_advanced_report_range(date, date, integer) IS
  'Valida intervalo inclusivo e seu limite máximo antes de consultar dados.';

REVOKE ALL ON FUNCTION public._is_valid_iana_time_zone(text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._assert_company_advanced_report_access(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._company_report_time_zone(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._validate_advanced_report_range(date, date, integer)
  FROM PUBLIC, anon, authenticated;

-- The CHECK constraint is evaluated under the caller privileges when an admin
-- updates a company through PostgREST, so authenticated needs this harmless
-- boolean validator even though the remaining helpers stay private.
GRANT EXECUTE ON FUNCTION public._is_valid_iana_time_zone(text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._assert_company_advanced_report_access(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._company_report_time_zone(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._validate_advanced_report_range(date, date, integer) TO service_role;
