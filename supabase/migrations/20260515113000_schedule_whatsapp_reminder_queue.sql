ALTER TABLE public.whatsapp_message_queue
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;

ALTER TABLE public.whatsapp_message_queue
  DROP CONSTRAINT IF EXISTS whatsapp_message_queue_status_check;

ALTER TABLE public.whatsapp_message_queue
  ADD CONSTRAINT whatsapp_message_queue_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'expired'));

CREATE INDEX IF NOT EXISTS idx_whatsapp_queue_pending_schedule
  ON public.whatsapp_message_queue(company_id, status, priority, scheduled_for, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.whatsapp_delivery_cadence_state (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  instance_name text NOT NULL,
  last_sent_at timestamptz,
  next_available_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, instance_name)
);

ALTER TABLE public.whatsapp_delivery_cadence_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view whatsapp cadence state"
ON public.whatsapp_delivery_cadence_state;

CREATE POLICY "Company staff can view whatsapp cadence state"
ON public.whatsapp_delivery_cadence_state
FOR SELECT
TO authenticated
USING (
  has_role_in_company(auth.uid(), 'admin'::app_role, company_id)
  OR has_role_in_company(auth.uid(), 'operator'::app_role, company_id)
  OR has_role(auth.uid(), 'superadmin'::app_role)
);

CREATE OR REPLACE FUNCTION public.reserve_whatsapp_delivery_slot(
  _company_id uuid,
  _instance_name text,
  _min_delay_seconds integer DEFAULT 40,
  _max_delay_seconds integer DEFAULT 80
)
RETURNS TABLE(can_send boolean, wait_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now timestamptz := now();
  _state record;
  _delay_seconds integer;
  _next_available_at timestamptz;
  _min_seconds integer := GREATEST(COALESCE(_min_delay_seconds, 40), 0);
  _max_seconds integer := GREATEST(COALESCE(_max_delay_seconds, 80), GREATEST(COALESCE(_min_delay_seconds, 40), 0));
BEGIN
  IF _company_id IS NULL OR NULLIF(btrim(COALESCE(_instance_name, '')), '') IS NULL THEN
    RETURN QUERY SELECT false, _now;
    RETURN;
  END IF;

  INSERT INTO public.whatsapp_delivery_cadence_state (
    company_id,
    instance_name,
    next_available_at,
    updated_at
  )
  VALUES (
    _company_id,
    _instance_name,
    _now,
    _now
  )
  ON CONFLICT (company_id, instance_name) DO NOTHING;

  SELECT *
  INTO _state
  FROM public.whatsapp_delivery_cadence_state
  WHERE company_id = _company_id
    AND instance_name = _instance_name
  FOR UPDATE;

  IF _state.next_available_at > _now THEN
    RETURN QUERY SELECT false, _state.next_available_at;
    RETURN;
  END IF;

  _delay_seconds := floor(random() * (_max_seconds - _min_seconds + 1) + _min_seconds)::integer;

  UPDATE public.whatsapp_delivery_cadence_state
  SET
    last_sent_at = _now,
    next_available_at = _now + make_interval(secs => _delay_seconds),
    updated_at = _now
  WHERE company_id = _company_id
    AND instance_name = _instance_name
  RETURNING public.whatsapp_delivery_cadence_state.next_available_at
  INTO _next_available_at;

  RETURN QUERY SELECT true, _next_available_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.note_whatsapp_delivery_sent(
  _company_id uuid,
  _instance_name text,
  _min_delay_seconds integer DEFAULT 40,
  _max_delay_seconds integer DEFAULT 80
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now timestamptz := now();
  _state record;
  _delay_seconds integer;
  _base_at timestamptz;
  _next_available_at timestamptz;
  _min_seconds integer := GREATEST(COALESCE(_min_delay_seconds, 40), 0);
  _max_seconds integer := GREATEST(COALESCE(_max_delay_seconds, 80), GREATEST(COALESCE(_min_delay_seconds, 40), 0));
BEGIN
  IF _company_id IS NULL OR NULLIF(btrim(COALESCE(_instance_name, '')), '') IS NULL THEN
    RETURN _now;
  END IF;

  INSERT INTO public.whatsapp_delivery_cadence_state (
    company_id,
    instance_name,
    next_available_at,
    updated_at
  )
  VALUES (
    _company_id,
    _instance_name,
    _now,
    _now
  )
  ON CONFLICT (company_id, instance_name) DO NOTHING;

  SELECT *
  INTO _state
  FROM public.whatsapp_delivery_cadence_state
  WHERE company_id = _company_id
    AND instance_name = _instance_name
  FOR UPDATE;

  _delay_seconds := floor(random() * (_max_seconds - _min_seconds + 1) + _min_seconds)::integer;
  _base_at := GREATEST(COALESCE(_state.next_available_at, _now), _now);
  _next_available_at := _base_at + make_interval(secs => _delay_seconds);

  UPDATE public.whatsapp_delivery_cadence_state
  SET
    last_sent_at = _now,
    next_available_at = _next_available_at,
    updated_at = _now
  WHERE company_id = _company_id
    AND instance_name = _instance_name;

  RETURN _next_available_at;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_whatsapp_delivery_slot(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.note_whatsapp_delivery_sent(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_whatsapp_delivery_slot(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.note_whatsapp_delivery_sent(uuid, text, integer, integer) TO service_role;

UPDATE public.automation_settings
SET message_template = 'Ola, {nome}! Passando para lembrar que voce tem uma reserva amanha, dia {data}, as {hora}, para {pessoas} pessoa(s). Vai ser um prazer te receber!'
WHERE type = 'reminder_24h'
  AND message_template IN (
    'Olá {nome}! Lembrete: sua reserva é amanhã, dia {data} às {hora}, para {pessoas} pessoa(s). Esperamos você!',
    'Olá {nome}! ⏰ Passando para lembrar da sua reserva amanhã, dia {data} às {hora}, para {pessoas} pessoa(s). Vai ser um prazer te receber! 🍽️'
  );

UPDATE public.automation_settings
SET message_template = 'Ola, {nome}! Passando para lembrar que hoje voce tem uma reserva as {hora}, para {pessoas} pessoa(s). Esperamos voce!'
WHERE type = 'reminder_1h'
  AND message_template IN (
    'Olá {nome}! Lembrete: sua reserva é hoje às {hora} para {pessoas} pessoa(s). Estamos esperando você!',
    'Olá {nome}! ⏳ Falta pouco: sua reserva é hoje às {hora} para {pessoas} pessoa(s). Estamos te esperando! 🍽️'
  );
