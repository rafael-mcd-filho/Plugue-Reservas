-- If interrupted, inspect pg_index.indisvalid and drop only this exact invalid
-- index before retrying the migration.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reservations_company_service_slot_report
  ON public.reservations(company_id, date, time, id DESC)
  INCLUDE (
    status,
    party_size,
    checked_in_party_size,
    table_id,
    created_in_mode
  );
