-- company_deletion_requests.phase_index defaulted to 0, but
-- company_deletion_phase_order is 1-based (starts at phase_index=1). Every
-- request's first batch tick looked up phase 0, found no row, and tried to
-- format() a NULL table name -- caught live during canary testing before
-- any real company was processed. 20260826161000 already reflects the fix
-- for anyone replaying migrations from scratch; this brings an
-- already-applied production database in line the same way.
ALTER TABLE public.company_deletion_requests ALTER COLUMN phase_index SET DEFAULT 1;
