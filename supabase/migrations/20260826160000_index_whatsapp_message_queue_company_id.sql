-- whatsapp_message_queue only had partial indexes on company_id (WHERE
-- status='pending'/etc). Any operation that must find every row for a
-- company regardless of status -- including the batched company-deletion
-- worker added next -- falls back to a sequential scan on this large, shared,
-- actively-written table. A plain leading index fixes that without touching
-- the existing partial indexes used by the queue processor.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_message_queue_company_id
  ON public.whatsapp_message_queue(company_id);
