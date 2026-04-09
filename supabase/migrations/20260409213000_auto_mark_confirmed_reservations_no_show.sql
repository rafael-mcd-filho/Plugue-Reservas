CREATE OR REPLACE FUNCTION public.mark_confirmed_reservations_as_no_show(
  _reference_date date DEFAULT ((now() AT TIME ZONE 'America/Fortaleza')::date)
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _updated_count integer := 0;
BEGIN
  UPDATE public.reservations
  SET
    status = 'no-show',
    checked_in_at = NULL,
    checked_in_party_size = NULL,
    updated_at = now()
  WHERE status = 'confirmed'
    AND date < _reference_date;

  GET DIAGNOSTICS _updated_count = ROW_COUNT;
  RETURN _updated_count;
END;
$$;

COMMENT ON FUNCTION public.mark_confirmed_reservations_as_no_show(date)
IS 'Marca automaticamente como no-show as reservas confirmadas de dias anteriores ao dia local.';

UPDATE public.reservations
SET
  status = 'checked_in',
  checked_in_at = COALESCE(checked_in_at, updated_at, now()),
  checked_in_party_size = COALESCE(checked_in_party_size, party_size),
  updated_at = now()
WHERE status = 'completed';

UPDATE public.reservations
SET
  status = 'confirmed',
  updated_at = now()
WHERE status = 'pending';

UPDATE public.reservations
SET
  status = 'no-show',
  updated_at = now()
WHERE status = 'no_show';

DO $$
DECLARE
  _existing_job_id bigint;
BEGIN
  SELECT jobid
  INTO _existing_job_id
  FROM cron.job
  WHERE jobname = 'mark-confirmed-reservations-no-show'
  LIMIT 1;

  IF _existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(_existing_job_id);
  END IF;
END;
$$;

SELECT cron.schedule(
  'mark-confirmed-reservations-no-show',
  '5 1 * * *',
  $$SELECT public.mark_confirmed_reservations_as_no_show(((now() AT TIME ZONE 'America/Fortaleza')::date));$$
);
