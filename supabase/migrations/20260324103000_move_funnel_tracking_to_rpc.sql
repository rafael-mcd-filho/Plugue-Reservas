-- Move public funnel tracking from edge function to database RPC + reservation trigger.

CREATE OR REPLACE FUNCTION public._record_public_funnel_step(
  _company_id uuid,
  _visitor_id text,
  _step text,
  _date date DEFAULT CURRENT_DATE
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _company_id IS NULL THEN
    RETURN;
  END IF;

  IF COALESCE(btrim(_visitor_id), '') = '' THEN
    RETURN;
  END IF;

  IF _step NOT IN ('page_view', 'date_select', 'time_select', 'form_fill', 'completed') THEN
    RAISE EXCEPTION 'Etapa de funil invalida: %', _step;
  END IF;

  INSERT INTO public.reservation_funnel_logs (company_id, visitor_id, step, date)
  VALUES (_company_id, btrim(_visitor_id), _step, COALESCE(_date, CURRENT_DATE))
  ON CONFLICT (company_id, visitor_id, step, date) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public._record_public_funnel_step(uuid, text, text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._record_public_funnel_step(uuid, text, text, date) FROM anon;
REVOKE ALL ON FUNCTION public._record_public_funnel_step(uuid, text, text, date) FROM authenticated;

DROP FUNCTION IF EXISTS public.track_public_funnel_step(uuid, text, text, date);

CREATE OR REPLACE FUNCTION public.track_public_funnel_step(
  _company_id uuid,
  _visitor_id text,
  _step text,
  _date date DEFAULT CURRENT_DATE
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._record_public_funnel_step(_company_id, _visitor_id, _step, _date);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.track_public_funnel_step(uuid, text, text, date) TO anon;
GRANT EXECUTE ON FUNCTION public.track_public_funnel_step(uuid, text, text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.track_completed_reservation_funnel_step()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(btrim(NEW.visitor_id), '') = '' THEN
    RETURN NEW;
  END IF;

  PERFORM public._record_public_funnel_step(NEW.company_id, NEW.visitor_id, 'completed', NEW.date);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_completed_reservation_funnel_step ON public.reservations;

CREATE TRIGGER trg_track_completed_reservation_funnel_step
AFTER INSERT ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.track_completed_reservation_funnel_step();
