-- The reservation-event unique index is partial; FK maintenance must also
-- find tracking-generated queue rows associated with a deleted reservation.
-- Keep this concurrent index in its own migration, outside a transaction block.
CREATE INDEX CONCURRENTLY idx_meta_event_queue_reservation
  ON public.meta_event_queue(reservation_id);
