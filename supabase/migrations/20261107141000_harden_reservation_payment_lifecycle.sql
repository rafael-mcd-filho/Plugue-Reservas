-- A retry must be able to recover a failed webhook instead of acknowledging
-- the event forever. The timestamp also lets a retry reclaim an abandoned run.
ALTER TABLE public.asaas_webhook_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

CREATE OR REPLACE FUNCTION public.record_reservation_installment_snapshot(
  _payment_id uuid, _company_id uuid, _installment_id text, _provider_payment_id text, _snapshot jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  _payment public.reservation_payments%ROWTYPE;
  _observations jsonb;
  _previous jsonb;
BEGIN
  SELECT * INTO _payment FROM public.reservation_payments
  WHERE id=_payment_id AND company_id=_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pagamento nao encontrado'; END IF;
  IF NULLIF(_installment_id,'') IS NULL OR NULLIF(_provider_payment_id,'') IS NULL THEN
    RAISE EXCEPTION 'Identificadores do parcelamento obrigatorios';
  END IF;
  _observations := COALESCE(_payment.metadata->'asaas_installment_payments','{}'::jsonb);
  _previous := _observations->_provider_payment_id;
  _observations := _observations || jsonb_build_object(_provider_payment_id,
    _snapshot||jsonb_build_object('installment_id',_installment_id));
  UPDATE public.reservation_payments SET last_checked_at=now(),
    metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object(
      'asaas_installment_id',COALESCE(metadata->>'asaas_installment_id',_installment_id),
      'needs_manual_installment_reconciliation',true,
      'asaas_installment_payments',_observations)
  WHERE id=_payment_id;
  IF _previous IS NULL OR _previous->'status' IS DISTINCT FROM _snapshot->'status' THEN
    INSERT INTO public.reservation_payment_events(company_id,reservation_payment_id,reservation_id,event_type,payload)
    VALUES(_company_id,_payment_id,_payment.reservation_id,'payment_installment_observed',
      _snapshot||jsonb_build_object('asaas_payment_id',_provider_payment_id,'asaas_installment_id',_installment_id));
  END IF;
  RETURN (SELECT to_jsonb(rp) FROM public.reservation_payments rp WHERE rp.id=_payment_id);
END;
$$;
REVOKE ALL ON FUNCTION public.record_reservation_installment_snapshot(uuid,uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_reservation_installment_snapshot(uuid,uuid,text,text,jsonb) TO service_role;

-- A late receipt awaiting manual review does not reserve a table or consume
-- service capacity. This also lets the conflict trigger persist that state.
CREATE OR REPLACE FUNCTION public.is_reservation_occupying_capacity(
  _reservation_id uuid, _status text, _created_at timestamptz
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT _status NOT IN ('cancelled','no-show','no_show','payment_expired','payment_cancelled','paid_after_expiration')
    AND (_status <> 'pending_payment'
      OR EXISTS (SELECT 1 FROM public.reservation_payments rp WHERE rp.reservation_id = _reservation_id
        AND rp.status IN ('awaiting_method','pending') AND rp.expires_at > now())
      OR (_created_at > now() - interval '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM public.reservation_payments rp WHERE rp.reservation_id = _reservation_id)));
$$;

CREATE OR REPLACE FUNCTION public.apply_reservation_payment_outcome(
  _payment_id uuid, _company_id uuid, _outcome text, _asaas_status text,
  _provider_check jsonb, _error_details text, _event_type text, _event_payload jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  _payment public.reservation_payments%ROWTYPE;
  _reservation public.reservations%ROWTYPE;
  _checked_at timestamptz := now();
  _result_status text;
BEGIN
  IF _outcome NOT IN ('refunded','partial_refunded','refund_pending','refund_denied','chargeback','cancelled') THEN
    RAISE EXCEPTION 'Status de pagamento invalido';
  END IF;
  SELECT * INTO _payment FROM public.reservation_payments
  WHERE id=_payment_id AND company_id=_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pagamento nao encontrado'; END IF;
  SELECT * INTO _reservation FROM public.reservations
  WHERE id=_payment.reservation_id AND company_id=_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva nao encontrada'; END IF;
  IF NULLIF(_payment.metadata->>'asaas_installment_id','') IS NOT NULL THEN
    RETURN to_jsonb(_payment);
  END IF;
  -- Delayed refund-progress events cannot undo a completed full refund.
  IF _payment.status='refunded' AND _outcome<>'refunded' THEN RETURN to_jsonb(_payment); END IF;
  _result_status := CASE WHEN _payment.status='expired' AND _outcome='cancelled' THEN 'expired' ELSE _outcome END;
  UPDATE public.reservation_payments SET status=_result_status,asaas_status=_asaas_status,
    cancelled_at=CASE WHEN _outcome IN ('refunded','partial_refunded','chargeback','cancelled')
      THEN COALESCE(cancelled_at,_checked_at) ELSE cancelled_at END,
    last_checked_at=_checked_at,error_details=_error_details,
    metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('provider_status_check',_provider_check)
  WHERE id=_payment_id;
  IF _outcome IN ('refunded','partial_refunded','chargeback','cancelled') AND _result_status<>'expired' THEN
    UPDATE public.reservations SET status='payment_cancelled',updated_at=_checked_at
    WHERE id=_reservation.id AND company_id=_company_id AND status IN ('pending_payment','confirmed');
  END IF;
  IF _payment.status IS DISTINCT FROM _result_status THEN
    INSERT INTO public.reservation_payment_events(company_id,reservation_payment_id,reservation_id,event_type,payload)
    VALUES(_company_id,_payment_id,_reservation.id,_event_type,_event_payload);
  END IF;
  RETURN (SELECT to_jsonb(rp) FROM public.reservation_payments rp WHERE rp.id=_payment_id);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_reservation_payment_outcome(uuid,uuid,text,text,jsonb,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_reservation_payment_outcome(uuid,uuid,text,text,jsonb,text,text,jsonb) TO service_role;

-- Only trusted payment endpoints may confirm receipt. All financial and
-- reservation changes are committed together and serialized on the payment.
CREATE OR REPLACE FUNCTION public.confirm_reservation_payment(
  _payment_id uuid,
  _company_id uuid,
  _asaas_status text,
  _paid_at timestamptz,
  _confirmation_metadata jsonb,
  _source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _payment public.reservation_payments%ROWTYPE;
  _reservation public.reservations%ROWTYPE;
  _schedule record;
  _table_id uuid;
  _duration integer;
  _max_guests integer;
  _max_reservations integer;
  _conflict boolean := false;
  _late boolean := false;
  _checked_at timestamptz := now();
  _result_status text;
  _error_details text;
BEGIN
  SELECT * INTO _payment FROM public.reservation_payments
  WHERE id = _payment_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pagamento nao encontrado'; END IF;

  SELECT * INTO _reservation FROM public.reservations
  WHERE id = _payment.reservation_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva nao encontrada'; END IF;

  IF _payment.status NOT IN ('awaiting_method', 'pending', 'expired', 'failed') THEN
    RETURN jsonb_build_object('status', _payment.status, 'changed', false);
  END IF;

  -- Keep a financial record of a real receipt without reopening an explicitly
  -- cancelled reservation, a completed visit or another terminal state.
  IF _reservation.status NOT IN ('pending_payment', 'payment_expired', 'confirmed') THEN
    _late := true;
    _error_details := 'Pagamento recebido para reserva que requer revisao da empresa';
  ELSIF _reservation.status <> 'confirmed' AND (
    _payment.status = 'expired' OR _payment.expires_at <= _checked_at
    OR _reservation.status = 'payment_expired'
  ) THEN
    _duration := GREATEST(COALESCE(_reservation.duration_minutes, 30), 1);
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('reservation-slot|%s|%s|%s', _company_id, _reservation.date, _reservation.time), 0));

    SELECT * INTO _schedule FROM public.get_public_reservation_schedule(_company_id, _reservation.date) LIMIT 1;
    SELECT COALESCE(slot.max_guests_per_slot, NULLIF(company.max_guests_per_slot, 0)),
           slot.max_reservations_per_slot
    INTO _max_guests, _max_reservations
    FROM public.companies company
    LEFT JOIN public.reservation_schedule_rule_slots slot
      ON slot.block_id = _schedule.block_id AND slot.time = _reservation.time
    WHERE company.id = _company_id;

    IF COALESCE(_schedule.availability_mode, 'tables') = 'capacity' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        format('reservation-capacity|%s|%s', _company_id, _reservation.date), 0));
      IF COALESCE(_max_guests, 0) <= 0 THEN _conflict := true; END IF;
    END IF;

    IF _max_guests > 0 AND public.count_overlapping_reservation_guests(
      _company_id, _reservation.date, _reservation.time, _duration, _reservation.id
    ) + _reservation.party_size > _max_guests THEN _conflict := true; END IF;
    IF _max_reservations IS NOT NULL AND public.count_slot_arrival_reservations(
      _company_id, _reservation.date, _reservation.time, _reservation.id
    ) >= _max_reservations THEN _conflict := true; END IF;

    -- Include secondary tables and overlapping service windows, using the same
    -- locks and conflict helper as public and panel reservation creation.
    FOR _table_id IN
      SELECT table_id FROM public.reservation_table_assignments WHERE reservation_id = _reservation.id
      UNION SELECT _reservation.table_id WHERE _reservation.table_id IS NOT NULL
      ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(
        format('reservation-table|%s|%s', _table_id, _reservation.date), 0));
      IF public.reservation_table_conflict_id(_company_id, _reservation.date,
        _reservation.time, _duration, _table_id, _reservation.id) IS NOT NULL THEN
        _conflict := true;
      END IF;
    END LOOP;
    IF _conflict THEN
      _late := true;
      _error_details := 'Pagamento detectado apos expiracao e capacidade indisponivel';
    END IF;
  END IF;

  _result_status := CASE WHEN _late THEN 'late_paid' ELSE 'paid' END;
  UPDATE public.reservation_payments SET
    status = _result_status, asaas_status = _asaas_status,
    paid_at = COALESCE(_paid_at, _checked_at), last_checked_at = _checked_at,
    error_details = _error_details,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('payment_confirmation', _confirmation_metadata)
  WHERE id = _payment.id;

  IF NOT _late THEN
    UPDATE public.reservations SET status = 'confirmed', updated_at = _checked_at
    WHERE id = _reservation.id AND company_id = _company_id;
  ELSIF _conflict THEN
    UPDATE public.reservations SET status = 'paid_after_expiration', updated_at = _checked_at
    WHERE id = _reservation.id AND company_id = _company_id;
  END IF;

  INSERT INTO public.reservation_payment_events(company_id, reservation_payment_id, reservation_id, event_type, payload)
  VALUES (_company_id, _payment.id, _reservation.id,
    CASE WHEN _late THEN 'payment_late_paid' ELSE 'payment_paid' END,
    jsonb_build_object('source', _source, 'asaas_status', _asaas_status,
      'provider_paid_at', _confirmation_metadata->'provider_paid_at'));
  RETURN jsonb_build_object('status', _result_status, 'changed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_reservation_payment(uuid,uuid,text,timestamptz,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_reservation_payment(uuid,uuid,text,timestamptz,jsonb,text) TO service_role;

-- Existing charges still need reconciliation after their original rule has
-- been disabled or archived. The Edge Function filters by charge age/status.
DO $$
DECLARE _job record;
BEGIN
  FOR _job IN SELECT jobid FROM cron.job WHERE jobname IN ('reconcile-reservation-payments','expire-reservation-payments') LOOP
    PERFORM cron.unschedule(_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule('reconcile-reservation-payments', '*/10 * * * *', $job$
  SELECT CASE WHEN COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '') <> ''
    AND NULLIF(btrim(config.project_url),'') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.reservation_payments
      WHERE asaas_payment_id IS NOT NULL OR payment_link_external_reference IS NOT NULL OR asaas_payment_link_id IS NOT NULL)
  THEN net.http_post(
    url := rtrim(config.project_url,'/') || '/functions/v1/reconcile-reservation-payments',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-job-secret',
      COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '')),
    body := jsonb_build_object('limit',25,'batch_size',5,'delay_ms',500,'stale_minutes',30,'lookback_days',120)
  ) ELSE NULL END AS request_id
  FROM public.platform_reservation_asaas_config config WHERE config.id = true;
$job$);

-- Replace the legacy expiration job's fixed host too. A newly replayed
-- database remains inert until its own endpoint saves the current project URL.
SELECT cron.schedule('expire-reservation-payments', '*/1 * * * *', $job$
  SELECT CASE WHEN COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1), '') <> ''
    AND NULLIF(btrim(config.project_url),'') IS NOT NULL
  THEN net.http_post(
    url := rtrim(config.project_url,'/') || '/functions/v1/expire-reservation-payments',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret',
      COALESCE((SELECT value FROM public.system_settings WHERE key = 'internal_job_secret' LIMIT 1),'')),
    body := '{}'::jsonb
  ) ELSE NULL END AS request_id
  FROM public.platform_reservation_asaas_config config WHERE config.id = true;
$job$);
