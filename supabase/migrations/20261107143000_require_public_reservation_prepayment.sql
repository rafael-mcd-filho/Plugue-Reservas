-- Public callers must use the payment Edge Function whenever the company has
-- an active prepayment rule for the requested date. Enforce this on the table:
-- create_public_reservation is SECURITY DEFINER and accepts an initial status,
-- so an RPC-only check in the browser would let clients confirm without paying
-- or create pending reservations with no reservation_payments record.
CREATE OR REPLACE FUNCTION public.enforce_public_reservation_prepayment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Read the verified request role, never current_user: a SECURITY DEFINER RPC
  -- runs as its owner even when its caller is anonymous.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Preserve manual panel bookings with the same role checks used by
  -- create_panel_reservation. These helpers also enforce delegated support's
  -- company scope and require a valid impersonation session for support.
  IF auth.uid() IS NOT NULL AND (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, NEW.company_id)
    OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, NEW.company_id)
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'pending_payment' THEN
    RAISE EXCEPTION 'Reservas pendentes de pagamento devem ser criadas pelo fluxo de pagamento.'
      USING ERRCODE = '42501';
  END IF;

  IF public.company_feature_enabled(NEW.company_id, 'reservation_prepayment')
    AND EXISTS (
      SELECT 1
      FROM public.reservation_payment_rules rule
      WHERE rule.company_id = NEW.company_id
        AND rule.enabled
        AND rule.archived_at IS NULL
        AND NEW.date BETWEEN rule.date_start AND rule.date_end
    ) THEN
    RAISE EXCEPTION 'Esta reserva exige pagamento antecipado. Conclua a reserva pelo fluxo de pagamento.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_public_reservation_prepayment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_public_reservation_prepayment ON public.reservations;
CREATE TRIGGER trg_enforce_public_reservation_prepayment
BEFORE INSERT ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_public_reservation_prepayment();
