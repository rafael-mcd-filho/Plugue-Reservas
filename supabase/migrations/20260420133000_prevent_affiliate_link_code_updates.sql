CREATE OR REPLACE FUNCTION public.prevent_affiliate_link_code_updates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'O código do link não pode ser alterado após a criação. Crie um novo link para usar outro código.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_affiliate_link_code_updates ON public.affiliate_links;
CREATE TRIGGER trg_prevent_affiliate_link_code_updates
BEFORE UPDATE ON public.affiliate_links
FOR EACH ROW
EXECUTE FUNCTION public.prevent_affiliate_link_code_updates();
