-- Kept separate from the transactional report contract because reservations is
-- a hot write table. Production rollout must apply this migration without an
-- outer transaction so the index does not block reservation creation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reservations_company_created_at_id
  ON public.reservations(company_id, created_at DESC, id DESC);
