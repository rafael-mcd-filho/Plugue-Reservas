-- The tracking_journeys FK runs WHERE journey_id = $1 for ON DELETE SET NULL.
-- A company-scoped index cannot serve that lookup across the entire Meta queue.
-- Keep this concurrent index in its own migration, outside a transaction block.
CREATE INDEX CONCURRENTLY idx_meta_event_queue_journey
  ON public.meta_event_queue(journey_id);
