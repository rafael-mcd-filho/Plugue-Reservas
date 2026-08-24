-- One concurrent statement per migration. If deployment is interrupted, check
-- pg_index.indisvalid before retrying and drop only the exact invalid index.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_occupancy_capacity_snapshots_latest
  ON public.occupancy_capacity_slot_snapshots(
    company_id,
    service_date,
    time_slot,
    version DESC
  );
