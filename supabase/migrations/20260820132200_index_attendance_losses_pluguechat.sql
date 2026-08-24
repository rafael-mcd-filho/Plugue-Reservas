-- Um statement, fora de transação. Se houver interrupção, verifique
-- pg_index.indisvalid/indisready e remova o índice inválido antes de repetir.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pluguechat_message_logs_company_reservation_sent
  ON public.pluguechat_message_logs(company_id, reservation_id, created_at)
  WHERE reservation_id IS NOT NULL AND status = 'sent';
