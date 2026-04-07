WITH target_events AS (
  SELECT id
  FROM public.tracking_events
  WHERE anonymous_id LIKE 'smoke-anon-%'
     OR page_url LIKE 'https://smoke-test.local/%'
     OR event_source_url LIKE 'https://smoke-test.local/%'
),
target_queue AS (
  SELECT id
  FROM public.meta_event_queue
  WHERE tracking_event_id IN (SELECT id FROM target_events)
)
DELETE FROM public.meta_event_attempts
WHERE queue_id IN (SELECT id FROM target_queue);

WITH target_events AS (
  SELECT id
  FROM public.tracking_events
  WHERE anonymous_id LIKE 'smoke-anon-%'
     OR page_url LIKE 'https://smoke-test.local/%'
     OR event_source_url LIKE 'https://smoke-test.local/%'
)
DELETE FROM public.meta_event_queue
WHERE tracking_event_id IN (SELECT id FROM target_events);

DELETE FROM public.tracking_events
WHERE anonymous_id LIKE 'smoke-anon-%'
   OR page_url LIKE 'https://smoke-test.local/%'
   OR event_source_url LIKE 'https://smoke-test.local/%';

DELETE FROM public.tracking_journeys
WHERE anonymous_id LIKE 'smoke-anon-%';

DELETE FROM public.tracking_sessions
WHERE anonymous_id LIKE 'smoke-anon-%'
   OR first_page_url LIKE 'https://smoke-test.local/%'
   OR last_page_url LIKE 'https://smoke-test.local/%';
