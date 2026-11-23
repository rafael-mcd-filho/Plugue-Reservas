-- Reservation card charges are single-payment only. Existing payment rows,
-- provider links and their frozen rule snapshots are deliberately preserved.
-- The rule describes future charges, while reservation_payments is history.

-- Used rules normally reject changes to their commercial fields. This one-time
-- normalization only changes future card eligibility; no payment is rewritten.
ALTER TABLE public.reservation_payment_rules DISABLE TRIGGER trg_validate_reservation_payment_rule;
UPDATE public.reservation_payment_rules
SET max_credit_card_installments = CASE WHEN credit_card_enabled THEN 1 ELSE NULL END
WHERE max_credit_card_installments IS DISTINCT FROM CASE WHEN credit_card_enabled THEN 1 ELSE NULL END;
ALTER TABLE public.reservation_payment_rules ENABLE TRIGGER trg_validate_reservation_payment_rule;

ALTER TABLE public.reservation_payment_rules
  ADD CONSTRAINT reservation_payment_rules_single_card_payment_check
  CHECK ((credit_card_enabled AND max_credit_card_installments=1)
    OR (NOT credit_card_enabled AND max_credit_card_installments IS NULL));

CREATE FUNCTION public.normalize_reservation_rule_single_card_payment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  NEW.max_credit_card_installments := CASE WHEN NEW.credit_card_enabled THEN 1 ELSE NULL END;
  RETURN NEW;
END;
$$;
-- PostgreSQL orders same-event triggers by name. Normalize before the existing
-- used-rule validator so stale clients sending 2..21 cannot re-enable parcels.
CREATE TRIGGER aaa_reservation_rule_single_card_payment
BEFORE INSERT OR UPDATE ON public.reservation_payment_rules
FOR EACH ROW EXECUTE FUNCTION public.normalize_reservation_rule_single_card_payment();

CREATE FUNCTION public.enforce_new_reservation_single_card_payment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.rule_snapshot := COALESCE(NEW.rule_snapshot,'{}'::jsonb)
      || jsonb_build_object('max_credit_card_installments',
        CASE WHEN NEW.rule_snapshot->>'credit_card_enabled'='true' THEN 1 ELSE NULL END);
    IF NEW.max_installments IS NOT NULL OR NEW.billing_type='CREDIT_CARD' THEN
      NEW.max_installments := 1;
    END IF;
  ELSIF OLD.status='awaiting_method' THEN
    -- Selection may finish an old, unselected payment whose frozen rule allowed
    -- parcels. Its new provider charge is still detached; keep the old snapshot.
    IF NEW.max_installments IS NOT NULL OR NEW.billing_type='CREDIT_CARD' THEN
      NEW.max_installments := 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER aaa_reservation_payment_single_card_payment
BEFORE INSERT OR UPDATE OF billing_type,max_installments ON public.reservation_payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_new_reservation_single_card_payment();

REVOKE ALL ON FUNCTION public.normalize_reservation_rule_single_card_payment() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.enforce_new_reservation_single_card_payment() FROM PUBLIC,anon,authenticated,service_role;
