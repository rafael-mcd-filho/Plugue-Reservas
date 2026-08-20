-- Separate non-transactional migration for superadmin/global ranges.  On
-- interrupted build, verify pg_index and DROP INDEX CONCURRENTLY before retry.
CREATE INDEX CONCURRENTLY idx_tracking_events_funnel_global_cursor
  ON public.tracking_events(created_at, id, company_id)
  INCLUDE (event_name, session_id, occurred_at, reservation_id)
  WHERE tracking_source = 'public'
    AND event_name IN (
      'page_view', 'date_select', 'time_select',
      'form_fill', 'lead_captured', 'reservation_created'
    );
