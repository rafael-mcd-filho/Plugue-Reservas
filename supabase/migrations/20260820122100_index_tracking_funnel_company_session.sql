-- Separate non-transactional migration for the cohort-to-milestone join.  On
-- interrupted build, verify pg_index and DROP INDEX CONCURRENTLY before retry.
CREATE INDEX CONCURRENTLY idx_tracking_events_funnel_company_session
  ON public.tracking_events(company_id, session_id, created_at, id)
  INCLUDE (event_name, occurred_at, reservation_id)
  WHERE tracking_source = 'public'
    AND session_id IS NOT NULL
    AND event_name IN (
      'page_view', 'date_select', 'time_select',
      'form_fill', 'lead_captured', 'reservation_created'
    );
