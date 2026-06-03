ALTER TABLE public.reservation_payments
  DROP CONSTRAINT IF EXISTS reservation_payments_status_check;

ALTER TABLE public.reservation_payments
  ADD CONSTRAINT reservation_payments_status_check
  CHECK (status IN (
    'awaiting_method',
    'pending',
    'paid',
    'expired',
    'cancelled',
    'failed',
    'late_paid',
    'refunded',
    'partial_refunded',
    'refund_pending',
    'refund_denied',
    'chargeback'
  ));
