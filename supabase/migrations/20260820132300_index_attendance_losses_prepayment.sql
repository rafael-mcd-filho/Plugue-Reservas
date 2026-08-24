-- Um statement, fora de transação. Se houver interrupção, verifique
-- pg_index.indisvalid/indisready e remova o índice inválido antes de repetir.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reservation_payments_company_reservation_paid
  ON public.reservation_payments(company_id, reservation_id, paid_at)
  WHERE paid_at IS NOT NULL
    AND status IN ('paid', 'late_paid');
