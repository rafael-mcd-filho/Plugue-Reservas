-- Avoid scanning the entire Meta delivery history for every deleted reservation.
-- Keep this concurrent index in its own migration, outside a transaction block.
CREATE INDEX CONCURRENTLY idx_meta_event_attempts_reservation
  ON public.meta_event_attempts(reservation_id);
