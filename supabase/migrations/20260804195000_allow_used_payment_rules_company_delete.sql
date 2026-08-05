-- A used payment rule must not be deleted on its own, but it must not block
-- the explicit permanent deletion of its owning company. During the company
-- cascade the parent row is no longer visible, which safely distinguishes the
-- two operations without weakening the normal archive-only rule.

CREATE OR REPLACE FUNCTION public.prevent_used_reservation_payment_rule_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.companies company
    WHERE company.id = OLD.company_id
  ) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reservation_payments payment
    WHERE payment.rule_id = OLD.id
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Regra ja usada deve ser arquivada, nao excluida';
  END IF;

  RETURN OLD;
END;
$$;
