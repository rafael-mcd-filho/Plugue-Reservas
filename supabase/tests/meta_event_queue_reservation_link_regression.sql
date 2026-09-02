BEGIN;

CREATE OR REPLACE FUNCTION public.test_assert(_condition boolean, _message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(_condition, false) THEN
    RAISE EXCEPTION 'meta event queue reservation link regression: %', _message;
  END IF;
END;
$$;

-- This reproduces the production failure: two PageView events from one journey
-- are linked in a single statement when the visitor completes the reservation.
INSERT INTO public.meta_event_queue (
  id,
  company_id,
  journey_id,
  tracking_event_id,
  event_name,
  meta_event_name
)
VALUES
  (
    '70000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'page_view',
    'PageView'
  ),
  (
    '70000000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002',
    'page_view',
    'PageView'
  );

UPDATE public.meta_event_queue
SET reservation_id = '50000000-0000-4000-8000-000000000001'
WHERE journey_id = '30000000-0000-4000-8000-000000000001'
  AND reservation_id IS NULL;

SELECT public.test_assert(
  (
    SELECT count(*)
    FROM public.meta_event_queue
    WHERE reservation_id = '50000000-0000-4000-8000-000000000001'
      AND event_name = 'page_view'
      AND tracking_event_id IS NOT NULL
  ) = 2,
  'repeated tracking events could not be linked to the reservation'
);

SELECT public.enqueue_meta_reservation_event(
  '50000000-0000-4000-8000-000000000001',
  'reservation_created',
  'Lead'
);

SELECT public.enqueue_meta_reservation_event(
  '50000000-0000-4000-8000-000000000001',
  'reservation_created',
  'Lead'
);

SELECT public.test_assert(
  (
    SELECT count(*)
    FROM public.meta_event_queue
    WHERE reservation_id = '50000000-0000-4000-8000-000000000001'
      AND event_name = 'reservation_created'
      AND tracking_event_id IS NULL
  ) = 1,
  'reservation-generated events are no longer idempotent'
);

SELECT public.test_assert(
  (
    SELECT pg_get_expr(indexes.indpred, indexes.indrelid)
    FROM pg_index AS indexes
    WHERE indexes.indexrelid = 'public.idx_meta_event_queue_reservation_event_unique'::regclass
  ) = '(tracking_event_id IS NULL)',
  'reservation event uniqueness is not scoped to reservation-generated events'
);

ROLLBACK;
