-- Keep this file to one statement: CREATE INDEX CONCURRENTLY must run outside
-- an explicit transaction.  A bare CREATE is intentional: after an interrupted
-- build, a duplicate-name error forces inspection of pg_index.indisvalid and
-- pg_index.indisready instead of silently accepting an invalid index.  Drop
-- only this exact invalid index with DROP INDEX CONCURRENTLY before retrying.
CREATE INDEX CONCURRENTLY idx_waitlist_company_removed_event
  ON public.waitlist(company_id, removed_at)
  INCLUDE (status, party_size, expired_at)
  WHERE status IN ('expired', 'removed')
    AND removed_at IS NOT NULL;
