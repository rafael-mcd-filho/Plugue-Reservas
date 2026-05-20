-- Permite reservation_payments em status pending sem paymentLink,
-- desde que tenham asaas_payment_id (caso do Pix gerado direto via /payments).

ALTER TABLE public.reservation_payments
  DROP CONSTRAINT IF EXISTS reservation_payments_link_required_check;

ALTER TABLE public.reservation_payments
  ADD CONSTRAINT reservation_payments_link_required_check
  CHECK (
    status <> 'pending'
    OR asaas_payment_id IS NOT NULL
    OR (asaas_payment_link_id IS NOT NULL AND payment_link_url IS NOT NULL)
  );
