UPDATE public.companies
SET cnpj = NULL
WHERE cnpj IS NOT NULL
  AND btrim(cnpj) = '';

CREATE OR REPLACE FUNCTION public.normalize_company_cnpj()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.cnpj := NULLIF(regexp_replace(COALESCE(NEW.cnpj, ''), '[^0-9]', '', 'g'), '');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_company_cnpj() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_normalize_company_cnpj ON public.companies;
CREATE TRIGGER trg_normalize_company_cnpj
BEFORE INSERT OR UPDATE OF cnpj
ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.normalize_company_cnpj();
