-- Session deletion checks tracking events across all tenants. The funnel's
-- (company_id, session_id, ...) index does not cover this FK lookup by session.
-- Keep this concurrent index in its own migration, outside a transaction block.
CREATE INDEX CONCURRENTLY idx_tracking_events_session
  ON public.tracking_events(session_id);
