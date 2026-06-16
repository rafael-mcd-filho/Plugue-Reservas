CREATE TABLE IF NOT EXISTS public.whatsapp_dispatch_guards (
  delivery_key text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  automation_type text NOT NULL,
  reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  phone text,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'accepted', 'queued', 'failed')),
  locked_until timestamptz NOT NULL,
  finalized_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_dispatch_guards_company_updated_at
  ON public.whatsapp_dispatch_guards(company_id, updated_at DESC);

ALTER TABLE public.whatsapp_dispatch_guards ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_whatsapp_dispatch(
  _delivery_key text,
  _company_id uuid,
  _automation_type text,
  _reservation_id uuid DEFAULT NULL,
  _phone text DEFAULT NULL,
  _lock_seconds integer DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row_count integer := 0;
BEGIN
  IF NULLIF(btrim(COALESCE(_delivery_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'delivery_key is required';
  END IF;

  INSERT INTO public.whatsapp_dispatch_guards (
    delivery_key,
    company_id,
    automation_type,
    reservation_id,
    phone,
    status,
    locked_until,
    finalized_at,
    last_error,
    updated_at
  )
  VALUES (
    _delivery_key,
    _company_id,
    _automation_type,
    _reservation_id,
    NULLIF(btrim(COALESCE(_phone, '')), ''),
    'processing',
    now() + make_interval(secs => GREATEST(COALESCE(_lock_seconds, 900), 60)),
    NULL,
    NULL,
    now()
  )
  ON CONFLICT (delivery_key) DO UPDATE
  SET
    company_id = EXCLUDED.company_id,
    automation_type = EXCLUDED.automation_type,
    reservation_id = COALESCE(EXCLUDED.reservation_id, public.whatsapp_dispatch_guards.reservation_id),
    phone = COALESCE(EXCLUDED.phone, public.whatsapp_dispatch_guards.phone),
    status = 'processing',
    locked_until = now() + make_interval(secs => GREATEST(COALESCE(_lock_seconds, 900), 60)),
    finalized_at = NULL,
    last_error = NULL,
    updated_at = now()
  WHERE public.whatsapp_dispatch_guards.status = 'failed'
    OR (
      public.whatsapp_dispatch_guards.status = 'processing'
      AND public.whatsapp_dispatch_guards.locked_until <= now()
    );

  GET DIAGNOSTICS _row_count = ROW_COUNT;
  RETURN _row_count > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_whatsapp_dispatch(
  _delivery_key text,
  _status text,
  _error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _status NOT IN ('accepted', 'queued', 'failed') THEN
    RAISE EXCEPTION 'invalid whatsapp dispatch status: %', _status;
  END IF;

  UPDATE public.whatsapp_dispatch_guards
  SET
    status = _status,
    locked_until = now(),
    finalized_at = now(),
    last_error = _error,
    updated_at = now()
  WHERE delivery_key = _delivery_key;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_dispatch(text, uuid, text, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_whatsapp_dispatch(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_dispatch(text, uuid, text, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_whatsapp_dispatch(text, text, text) TO service_role;

ALTER TABLE public.whatsapp_message_queue
  DROP CONSTRAINT IF EXISTS whatsapp_message_queue_status_check;

ALTER TABLE public.whatsapp_message_queue
  ADD CONSTRAINT whatsapp_message_queue_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'expired'));

WITH ranked_reservation AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, type, reservation_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.whatsapp_message_queue
  WHERE reservation_id IS NOT NULL
    AND status IN ('pending', 'processing')
)
DELETE FROM public.whatsapp_message_queue q
USING ranked_reservation
WHERE q.id = ranked_reservation.id
  AND ranked_reservation.rn > 1;

WITH ranked_phone AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        company_id,
        type,
        right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 11),
        md5(message)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.whatsapp_message_queue
  WHERE reservation_id IS NULL
    AND status IN ('pending', 'processing')
)
DELETE FROM public.whatsapp_message_queue q
USING ranked_phone
WHERE q.id = ranked_phone.id
  AND ranked_phone.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_queue_active_reservation_unique
  ON public.whatsapp_message_queue(company_id, type, reservation_id)
  WHERE reservation_id IS NOT NULL
    AND status IN ('pending', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_queue_active_phone_message_unique
  ON public.whatsapp_message_queue(
    company_id,
    type,
    (right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 11)),
    (md5(message))
  )
  WHERE reservation_id IS NULL
    AND status IN ('pending', 'processing');
