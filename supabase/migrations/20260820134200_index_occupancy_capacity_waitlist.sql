-- If interrupted, inspect pg_index.indisvalid and drop only this exact invalid
-- index before retrying the migration.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_waitlist_company_created_report
  ON public.waitlist(company_id, created_at)
  INCLUDE (status, party_size, seated_at, expired_at, removed_at);
