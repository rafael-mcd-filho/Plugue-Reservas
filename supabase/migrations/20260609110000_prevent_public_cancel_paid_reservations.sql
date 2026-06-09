-- Impede cancelamento publico direto de reservas com pre-pagamento recebido.
-- O estorno continua sendo uma acao administrativa pelo fluxo refund-reservation-payment.

CREATE OR REPLACE FUNCTION public.cancel_public_reservation(
  _tracking_code text,
  _visitor_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  public_tracking_code text,
  status text,
  cancelled boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  _entry public.reservations%ROWTYPE;
  _updated public.reservations%ROWTYPE;
  _normalized_tracking_code text := lower(btrim(COALESCE(_tracking_code, '')));
  _normalized_visitor_id text := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _recent_visitor_count integer := 0;
  _has_received_payment boolean := false;
BEGIN
  IF _normalized_tracking_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  IF _normalized_visitor_id IS NULL THEN
    RAISE EXCEPTION 'Identificacao do dispositivo obrigatoria.';
  END IF;

  SELECT count(*)
  INTO _recent_visitor_count
  FROM public.public_rate_limits prl
  WHERE prl.scope = 'public_reservation_cancel_visitor'
    AND prl.identifier = _normalized_visitor_id
    AND prl.created_at >= now() - interval '15 minutes';

  IF _recent_visitor_count >= 10 THEN
    RAISE EXCEPTION 'Muitas tentativas deste dispositivo. Aguarde alguns minutos e tente novamente.';
  END IF;

  SELECT *
  INTO _entry
  FROM public.reservations r
  WHERE r.public_tracking_code = _normalized_tracking_code
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reserva nao encontrada.';
  END IF;

  IF _entry.status <> 'confirmed' THEN
    RETURN QUERY
    SELECT
      _entry.id,
      _entry.public_tracking_code,
      _entry.status,
      false;
    RETURN;
  END IF;

  INSERT INTO public.public_rate_limits (scope, company_id, identifier)
  VALUES ('public_reservation_cancel_visitor', _entry.company_id, _normalized_visitor_id);

  SELECT EXISTS (
    SELECT 1
    FROM public.reservation_payments rp
    WHERE rp.reservation_id = _entry.id
      AND (
        rp.paid_at IS NOT NULL
        OR rp.status IN (
          'paid',
          'late_paid',
          'refund_pending',
          'refund_denied',
          'partial_refunded',
          'refunded',
          'chargeback'
        )
      )
  )
  INTO _has_received_payment;

  IF _has_received_payment THEN
    RETURN QUERY
    SELECT
      _entry.id,
      _entry.public_tracking_code,
      _entry.status,
      false;
    RETURN;
  END IF;

  UPDATE public.reservations r
  SET
    status = 'cancelled',
    updated_at = now()
  WHERE r.id = _entry.id
  RETURNING *
  INTO _updated;

  RETURN QUERY
  SELECT
    _updated.id,
    _updated.public_tracking_code,
    _updated.status,
    true;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_public_reservation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_public_reservation(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.cancel_public_reservation(text, text) TO authenticated;
