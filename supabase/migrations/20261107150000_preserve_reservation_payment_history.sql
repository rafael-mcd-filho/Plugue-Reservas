-- Cancelling a reservation must retain its financial history. Protect the row
-- itself so both a direct authenticated DELETE and the panel RPC are covered.
-- The company-deletion worker drains payment events/payments before
-- reservations. A final company cascade is also allowed once its parent row
-- is gone, matching the existing used-payment-rule deletion guard.
CREATE OR REPLACE FUNCTION public.prevent_reservation_payment_history_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.companies company WHERE company.id = OLD.company_id)
    AND EXISTS (SELECT 1 FROM public.reservation_payments payment WHERE payment.reservation_id = OLD.id) THEN
    RAISE EXCEPTION 'Reserva com historico de pagamento nao pode ser excluida. Cancele a reserva para preservar a conciliacao.'
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_reservation_payment_history ON public.reservations;
CREATE TRIGGER trg_preserve_reservation_payment_history
BEFORE DELETE ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.prevent_reservation_payment_history_delete();

REVOKE ALL ON FUNCTION public.prevent_reservation_payment_history_delete()
  FROM PUBLIC, anon, authenticated, service_role;
