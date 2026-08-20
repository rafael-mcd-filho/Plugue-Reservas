-- Keep this file to one statement: CREATE INDEX CONCURRENTLY must run outside
-- an explicit transaction and avoids blocking public tracking inserts.  If the
-- build is interrupted, inspect pg_index.indisvalid/indisready and run
-- `DROP INDEX CONCURRENTLY idx_tracking_events_funnel_company_cursor` before
-- retrying; a stale invalid index must never be silently accepted.
CREATE INDEX CONCURRENTLY idx_tracking_events_funnel_company_cursor
  ON public.tracking_events(company_id, created_at, id)
  INCLUDE (event_name, session_id, occurred_at, reservation_id)
  WHERE tracking_source = 'public'
    AND event_name IN (
      'page_view', 'date_select', 'time_select',
      'form_fill', 'lead_captured', 'reservation_created'
    );
