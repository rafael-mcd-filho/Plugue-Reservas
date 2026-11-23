-- FILA-01: keep the call notification attached to its original call and retry
-- only that existing queue row. No call status/deadline is changed here.
ALTER TABLE public.whatsapp_message_queue
  ADD COLUMN IF NOT EXISTS waitlist_id uuid REFERENCES public.waitlist(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS waitlist_called_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_manual_retry_at timestamptz;

ALTER TABLE public.pluguechat_message_queue
  ADD COLUMN IF NOT EXISTS waitlist_called_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_manual_retry_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_queue_waitlist_call_once
  ON public.whatsapp_message_queue(company_id, waitlist_id, type, waitlist_called_at)
  WHERE waitlist_id IS NOT NULL AND waitlist_called_at IS NOT NULL AND type = 'waitlist_called';

CREATE INDEX IF NOT EXISTS idx_pluguechat_queue_waitlist_call
  ON public.pluguechat_message_queue(company_id, waitlist_id, waitlist_called_at, created_at DESC)
  WHERE waitlist_id IS NOT NULL AND type = 'waitlist_called';

-- A timeout, malformed provider response, or an accepted request with no message
-- ID is inconclusive. Never authorize a duplicate send on that evidence alone.
CREATE OR REPLACE FUNCTION public.is_retryable_waitlist_call_failure(
  _channel text,
  _error_details text,
  _provider_status text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  _details jsonb;
  _http_status text;
BEGIN
  IF _channel = 'evolution' THEN
    BEGIN
      _details := _error_details::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN false;
    END;
    IF _details ->> 'code' IN ('evolution_not_configured', 'instance_not_configured', 'instance_disconnected', 'invalid_payload') THEN
      RETURN true;
    END IF;
    RETURN COALESCE(_details ->> 'code' = 'provider_request_failed'
      AND _details ->> 'provider_status' IN ('400', '401', '403', '404', '405', '410', '413', '415', '422', '429'), false);
  ELSIF _channel = 'pluguechat_official' THEN
    IF upper(COALESCE(_provider_status, '')) IN ('MISSING_MESSAGE_ID', 'EXPIRED') THEN RETURN false; END IF;
    IF upper(COALESCE(_provider_status, '')) IN ('FAILED', 'ERROR', 'REJECTED', 'CANCELED', 'CANCELLED', 'UNDELIVERED') THEN RETURN true; END IF;
    IF _error_details IN (
      'Configuração PlugueChat não encontrada ou incompleta.',
      'Template da chamada não configurado.',
      'Telefone internacional invalido para envio.'
    ) THEN RETURN true; END IF;
    _http_status := substring(_error_details FROM '^HTTP ([0-9]{3}):');
    RETURN COALESCE(_http_status IN ('400', '401', '403', '404', '405', '410', '413', '415', '422', '429'), false);
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.waitlist_call_automation_enabled(_company_id uuid, _channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.company_feature_enabled(_company_id, 'whatsapp_integration'), false)
    AND CASE _channel
      WHEN 'pluguechat_official' THEN EXISTS (
        SELECT 1 FROM public.pluguechat_automation_templates t
        WHERE t.company_id = _company_id AND t.type = 'waitlist_called' AND t.enabled = true
      )
      WHEN 'evolution' THEN EXISTS (
        SELECT 1 FROM public.automation_settings a
        WHERE a.company_id = _company_id AND a.type = 'waitlist_called' AND a.enabled = true
      )
      ELSE false
    END;
$$;

CREATE OR REPLACE FUNCTION public.get_waitlist_call_notification_state(_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _channel text;
  _enabled boolean;
  _failures jsonb := '[]'::jsonb;
BEGIN
  SELECT c.whatsapp_automation_channel INTO _channel FROM public.companies c WHERE c.id = _company_id;
  _channel := COALESCE(_channel, 'evolution');
  _enabled := public.waitlist_call_automation_enabled(_company_id, _channel);
  IF _enabled AND _channel = 'evolution' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'waitlist_id', w.id, 'called_at', w.called_at,
      'can_retry', q.expires_at > now()
        AND (q.last_manual_retry_at IS NULL OR q.last_manual_retry_at <= now() - interval '30 seconds')
    ) ORDER BY w.position, w.id), '[]'::jsonb)
    INTO _failures
    FROM public.waitlist w
    CROSS JOIN LATERAL (
      SELECT mq.status, mq.error_details, mq.last_manual_retry_at, mq.expires_at
      FROM public.whatsapp_message_queue mq
      WHERE mq.company_id = _company_id AND mq.waitlist_id = w.id
        AND mq.type = 'waitlist_called' AND mq.waitlist_called_at = w.called_at
      ORDER BY mq.created_at DESC, mq.id DESC LIMIT 1
    ) q
    WHERE w.company_id = _company_id AND w.status = 'called' AND w.called_at IS NOT NULL
      AND w.called_at + interval '5 minutes' > now()
      AND q.status IN ('pending', 'failed')
      AND public.is_retryable_waitlist_call_failure(_channel, q.error_details);
  ELSIF _enabled AND _channel = 'pluguechat_official' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'waitlist_id', w.id, 'called_at', w.called_at,
      'can_retry', q.expires_at > now()
        AND (q.last_manual_retry_at IS NULL OR q.last_manual_retry_at <= now() - interval '30 seconds')
        AND EXISTS (SELECT 1 FROM public.pluguechat_automation_templates t
          WHERE t.company_id = _company_id AND t.type = 'waitlist_called' AND t.enabled
            AND NULLIF(btrim(t.template_id), '') IS NOT NULL)
    ) ORDER BY w.position, w.id), '[]'::jsonb)
    INTO _failures
    FROM public.waitlist w
    CROSS JOIN LATERAL (
      SELECT mq.status, mq.error_details, mq.provider_status, mq.last_manual_retry_at, mq.expires_at
      FROM public.pluguechat_message_queue mq
      WHERE mq.company_id = _company_id AND mq.waitlist_id = w.id
        AND mq.type = 'waitlist_called' AND mq.waitlist_called_at = w.called_at
      ORDER BY mq.created_at DESC, mq.id DESC LIMIT 1
    ) q
    WHERE w.company_id = _company_id AND w.status = 'called' AND w.called_at IS NOT NULL
      AND w.called_at + interval '5 minutes' > now()
      AND q.status IN ('pending', 'failed')
      AND public.is_retryable_waitlist_call_failure(_channel, q.error_details, q.provider_status);
  END IF;
  RETURN jsonb_build_object('company_id', _company_id, 'channel', _channel,
    'automation_enabled', _enabled, 'failures', _failures);
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_waitlist_call_notification(
  _company_id uuid,
  _waitlist_id uuid,
  _called_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _channel text;
  _call public.waitlist%ROWTYPE;
  _queue record;
  _template public.pluguechat_automation_templates%ROWTYPE;
  _now timestamptz := clock_timestamp();
BEGIN
  -- These RPCs are service-role-only; the Edge handler checks waitlist_view for
  -- this exact company before calling them. No client can execute a raw retry.
  SELECT c.whatsapp_automation_channel INTO _channel
  FROM public.companies c WHERE c.id = _company_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found', 'channel', 'evolution', 'queue_id', NULL); END IF;
  _channel := COALESCE(_channel, 'evolution');

  -- Serialize the active automation configuration with its writers until this
  -- requeue is committed. Workers must check it again just before sending.
  IF _channel = 'pluguechat_official' THEN
    SELECT t.* INTO _template FROM public.pluguechat_automation_templates t
      WHERE t.company_id = _company_id AND t.type = 'waitlist_called' FOR SHARE;
  ELSE
    PERFORM 1 FROM public.automation_settings a
      WHERE a.company_id = _company_id AND a.type = 'waitlist_called' FOR SHARE;
  END IF;
  IF NOT public.waitlist_call_automation_enabled(_company_id, _channel) THEN
    RETURN jsonb_build_object('result', 'disabled', 'channel', _channel, 'queue_id', NULL);
  END IF;
  IF _channel = 'pluguechat_official' AND NULLIF(btrim(_template.template_id), '') IS NULL THEN
    RETURN jsonb_build_object('result', 'not_retryable', 'channel', _channel, 'queue_id', NULL);
  END IF;

  SELECT w.* INTO _call FROM public.waitlist w
    WHERE w.id = _waitlist_id AND w.company_id = _company_id FOR UPDATE;
  _now := clock_timestamp();
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found', 'channel', _channel, 'queue_id', NULL); END IF;
  IF _call.status <> 'called' OR _call.called_at IS NULL THEN
    RETURN jsonb_build_object('result', 'not_called', 'channel', _channel, 'queue_id', NULL);
  END IF;
  IF _called_at IS NULL OR _called_at <> _call.called_at THEN
    RETURN jsonb_build_object('result', 'not_retryable', 'channel', _channel, 'queue_id', NULL);
  END IF;
  IF _call.called_at + interval '5 minutes' <= _now THEN
    RETURN jsonb_build_object('result', 'expired', 'channel', _channel, 'queue_id', NULL);
  END IF;

  IF _channel = 'evolution' THEN
    SELECT q.id, q.status, q.error_details, q.last_manual_retry_at, q.expires_at INTO _queue
    FROM public.whatsapp_message_queue q
    WHERE q.company_id = _company_id AND q.waitlist_id = _waitlist_id
      AND q.type = 'waitlist_called' AND q.waitlist_called_at = _call.called_at
    ORDER BY q.created_at DESC, q.id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR _queue.status NOT IN ('pending', 'failed')
      OR NOT public.is_retryable_waitlist_call_failure(_channel, _queue.error_details) THEN
      RETURN jsonb_build_object('result', 'not_retryable', 'channel', _channel, 'queue_id', NULL);
    END IF;
    _now := clock_timestamp();
    IF _call.called_at + interval '5 minutes' <= _now THEN
      RETURN jsonb_build_object('result', 'expired', 'channel', _channel, 'queue_id', NULL);
    END IF;
    IF _queue.last_manual_retry_at > _now - interval '30 seconds' THEN
      RETURN jsonb_build_object('result', 'cooldown', 'channel', _channel, 'queue_id', NULL);
    END IF;
    IF _queue.expires_at <= _now THEN
      RETURN jsonb_build_object('result', 'expired', 'channel', _channel, 'queue_id', NULL);
    END IF;
    UPDATE public.whatsapp_message_queue SET status = 'pending', scheduled_for = _now,
      max_attempts = greatest(max_attempts, attempts + 1),
      expires_at = least(expires_at, _call.called_at + interval '5 minutes'),
      last_manual_retry_at = _now, manual_retry_count = manual_retry_count + 1
    WHERE id = _queue.id AND status IN ('pending', 'failed');
  ELSE
    SELECT q.id, q.status, q.error_details, q.provider_status, q.last_manual_retry_at, q.expires_at INTO _queue
    FROM public.pluguechat_message_queue q
    WHERE q.company_id = _company_id AND q.waitlist_id = _waitlist_id
      AND q.type = 'waitlist_called' AND q.waitlist_called_at = _call.called_at
    ORDER BY q.created_at DESC, q.id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR _queue.status NOT IN ('pending', 'failed')
      OR NOT public.is_retryable_waitlist_call_failure(_channel, _queue.error_details, _queue.provider_status) THEN
      RETURN jsonb_build_object('result', 'not_retryable', 'channel', _channel, 'queue_id', NULL);
    END IF;
    _now := clock_timestamp();
    IF _call.called_at + interval '5 minutes' <= _now THEN
      RETURN jsonb_build_object('result', 'expired', 'channel', _channel, 'queue_id', NULL);
    END IF;
    IF _queue.last_manual_retry_at > _now - interval '30 seconds' THEN
      RETURN jsonb_build_object('result', 'cooldown', 'channel', _channel, 'queue_id', NULL);
    END IF;
    IF _queue.expires_at <= _now THEN
      RETURN jsonb_build_object('result', 'expired', 'channel', _channel, 'queue_id', NULL);
    END IF;
    UPDATE public.pluguechat_message_queue SET status = 'pending', scheduled_for = _now,
      template_id = _template.template_id, template_name = _template.template_name,
      max_attempts = greatest(max_attempts, attempts + 1),
      expires_at = least(expires_at, _call.called_at + interval '5 minutes'),
      last_manual_retry_at = _now,
      manual_retry_count = manual_retry_count + 1
    WHERE id = _queue.id AND status IN ('pending', 'failed');
  END IF;
  RETURN jsonb_build_object('result', 'queued', 'channel', _channel, 'queue_id', _queue.id);
EXCEPTION WHEN unique_violation THEN
  -- Existing broader dispatch indexes can also cover another pending message
  -- with the same destination/content. Keep their protection and do not queue
  -- a competing attempt just to satisfy a manual retry.
  RETURN jsonb_build_object('result', 'not_retryable', 'channel', _channel, 'queue_id', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.is_retryable_waitlist_call_failure(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.waitlist_call_automation_enabled(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_waitlist_call_notification_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retry_waitlist_call_notification(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_retryable_waitlist_call_failure(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.waitlist_call_automation_enabled(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_waitlist_call_notification_state(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_waitlist_call_notification(uuid, uuid, timestamptz) TO service_role;

-- The terminal queue update and the log write happen in separate HTTP calls.
-- Lock and validate the current attempt again so an older worker cannot replace
-- a newer successful log after a manual retry has already reused this queue row.
CREATE OR REPLACE FUNCTION public.write_waitlist_call_notification_log(
  _queue_id uuid,
  _called_at timestamptz,
  _last_attempt_at timestamptz,
  _status text,
  _provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _queue public.pluguechat_message_queue%ROWTYPE;
BEGIN
  IF _called_at IS NULL OR _last_attempt_at IS NULL
    OR _status IS NULL OR _status NOT IN ('sent', 'failed') THEN RETURN false; END IF;

  SELECT q.* INTO _queue FROM public.pluguechat_message_queue q
    WHERE q.id = _queue_id FOR UPDATE;
  IF NOT FOUND OR _queue.type <> 'waitlist_called' OR _queue.waitlist_id IS NULL
    OR _queue.status IS DISTINCT FROM _status
    OR _queue.waitlist_called_at IS DISTINCT FROM _called_at
    OR _queue.last_attempt_at IS DISTINCT FROM _last_attempt_at
    OR _queue.provider_message_id IS DISTINCT FROM _provider_message_id THEN
    RETURN false;
  END IF;

  INSERT INTO public.pluguechat_message_logs (
    queue_id, company_id, reservation_id, waitlist_id, phone, type,
    template_id, template_name, parameters, status,
    provider_message_id, provider_status, error_details
  ) VALUES (
    _queue.id, _queue.company_id, _queue.reservation_id, _queue.waitlist_id,
    COALESCE(NULLIF(btrim(_queue.phone_e164), ''), _queue.phone), _queue.type,
    _queue.template_id, _queue.template_name, COALESCE(_queue.parameters, '{}'::jsonb), _queue.status,
    _queue.provider_message_id, _queue.provider_status, _queue.error_details
  ) ON CONFLICT (queue_id) DO UPDATE SET
    company_id = EXCLUDED.company_id, reservation_id = EXCLUDED.reservation_id,
    waitlist_id = EXCLUDED.waitlist_id, phone = EXCLUDED.phone, type = EXCLUDED.type,
    template_id = EXCLUDED.template_id, template_name = EXCLUDED.template_name,
    parameters = EXCLUDED.parameters, status = EXCLUDED.status,
    provider_message_id = EXCLUDED.provider_message_id,
    provider_status = EXCLUDED.provider_status, error_details = EXCLUDED.error_details;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.write_waitlist_call_notification_log(uuid, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_waitlist_call_notification_log(uuid, timestamptz, timestamptz, text, text) TO service_role;
