DELETE FROM public.meta_event_queue
WHERE meta_event_name = 'InitiateCheckout'
  AND event_name = 'booking_started';

CREATE OR REPLACE FUNCTION public.capture_tracking_event_for_meta_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.event_name = 'page_view' THEN
    PERFORM public.enqueue_meta_tracking_event(NEW.id, 'PageView');
  ELSIF NEW.event_name = 'time_select' THEN
    PERFORM public.enqueue_meta_tracking_event(NEW.id, 'InitiateCheckout');
  END IF;

  RETURN NEW;
END;
$$;
