-- Different platform fees by payment method. Existing rows are never repriced:
-- NULL method-rate pairs mark pre-migration terms/settlements and preserve fee_bps.
ALTER TABLE public.reservation_settlement_terms
  ADD COLUMN pix_fee_bps integer,
  ADD COLUMN credit_card_fee_bps integer,
  ADD CONSTRAINT reservation_settlement_terms_method_rates CHECK (
    (pix_fee_bps IS NULL AND credit_card_fee_bps IS NULL) OR
    (pix_fee_bps IS NOT NULL AND credit_card_fee_bps IS NOT NULL
      AND pix_fee_bps BETWEEN 0 AND 10000 AND credit_card_fee_bps BETWEEN 0 AND 10000)
  );
ALTER TABLE public.reservation_payment_settlements
  ADD COLUMN pix_fee_bps integer,
  ADD COLUMN credit_card_fee_bps integer,
  ADD COLUMN fee_billing_type text,
  ADD CONSTRAINT reservation_payment_settlements_method_rates CHECK (
    (pix_fee_bps IS NULL AND credit_card_fee_bps IS NULL) OR
    (pix_fee_bps IS NOT NULL AND credit_card_fee_bps IS NOT NULL
      AND pix_fee_bps BETWEEN 0 AND 10000 AND credit_card_fee_bps BETWEEN 0 AND 10000)
  ),
  ADD CONSTRAINT reservation_payment_settlements_fee_method CHECK (
    fee_billing_type IS NULL OR (fee_billing_type IN ('PIX','CREDIT_CARD') AND pix_fee_bps IS NOT NULL)
  );

CREATE FUNCTION public.save_reservation_settlement_method_terms(
  _company_id uuid,_pix_fee_bps integer,_credit_card_fee_bps integer,_release_policy text,_hold_days integer,
  _effective_at timestamptz,_enabled boolean,_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _row public.reservation_settlement_terms;
BEGIN
  PERFORM public.lock_reservation_settlement_company(_company_id);
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Responsável obrigatório'; END IF;
  IF _pix_fee_bps IS NULL OR _credit_card_fee_bps IS NULL THEN RAISE EXCEPTION 'Informe os percentuais de Pix e cartão'; END IF;
  IF _effective_at IS NOT NULL AND _effective_at < now()-interval '1 minute' THEN
    RAISE EXCEPTION 'A condição comercial não pode ser aplicada retroativamente';
  END IF;
  -- fee_bps remains a compatibility field. New charges use their frozen pair.
  INSERT INTO public.reservation_settlement_terms(company_id,fee_bps,pix_fee_bps,credit_card_fee_bps,release_policy,hold_days,effective_at,enabled,created_by)
  VALUES(_company_id,_pix_fee_bps,_pix_fee_bps,_credit_card_fee_bps,_release_policy,_hold_days,COALESCE(_effective_at,now()),_enabled,_actor_id)
  RETURNING * INTO _row;
  RETURN to_jsonb(_row);
END;
$$;

-- Older tabs may still submit one rate. They cannot silently replace a pair
-- that the administrator has explicitly configured with different percentages.
CREATE OR REPLACE FUNCTION public.save_reservation_settlement_terms(
  _company_id uuid,_fee_bps integer,_release_policy text,_hold_days integer,
  _effective_at timestamptz,_enabled boolean,_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.lock_reservation_settlement_company(_company_id);
  IF EXISTS(SELECT 1 FROM public.reservation_settlement_terms WHERE company_id=_company_id
    AND COALESCE(pix_fee_bps,fee_bps)<>COALESCE(credit_card_fee_bps,fee_bps)) THEN
    RAISE EXCEPTION 'Atualize a página para configurar os percentuais de Pix e cartão separadamente';
  END IF;
  RETURN public.save_reservation_settlement_method_terms(_company_id,_fee_bps,_fee_bps,_release_policy,_hold_days,_effective_at,_enabled,_actor_id);
END;
$$;

CREATE FUNCTION public.guard_reservation_payment_fee_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.company_id,NEW.terms_id,NEW.pix_fee_bps,NEW.credit_card_fee_bps,NEW.release_policy,NEW.hold_days,NEW.provider_account_id,NEW.provider_environment)
    IS DISTINCT FROM (OLD.company_id,OLD.terms_id,OLD.pix_fee_bps,OLD.credit_card_fee_bps,OLD.release_policy,OLD.hold_days,OLD.provider_account_id,OLD.provider_environment) THEN
    RAISE EXCEPTION 'As condições comerciais da cobrança são permanentes';
  END IF;
  IF OLD.fee_billing_type IS NOT NULL AND NEW.fee_billing_type IS DISTINCT FROM OLD.fee_billing_type THEN
    RAISE EXCEPTION 'O método financeiro da cobrança já foi definido';
  END IF;
  IF NEW.fee_bps IS DISTINCT FROM OLD.fee_bps OR NEW.fee_billing_type IS DISTINCT FROM OLD.fee_billing_type THEN
    IF OLD.pix_fee_bps IS NULL OR OLD.recognized OR OLD.fee_billing_type IS NOT NULL
      OR NEW.fee_billing_type IS NULL OR NEW.fee_bps IS DISTINCT FROM
        (CASE NEW.fee_billing_type WHEN 'PIX' THEN OLD.pix_fee_bps WHEN 'CREDIT_CARD' THEN OLD.credit_card_fee_bps END) THEN
      RAISE EXCEPTION 'A taxa financeira da cobrança já foi preservada';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_reservation_payment_fee_snapshot BEFORE UPDATE ON public.reservation_payment_settlements
FOR EACH ROW EXECUTE FUNCTION public.guard_reservation_payment_fee_snapshot();

CREATE OR REPLACE FUNCTION public.initialize_reservation_payment_settlement(_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _p public.reservation_payments; _t public.reservation_settlement_terms; _s public.reservation_payment_settlements;
BEGIN
  SELECT * INTO _p FROM public.reservation_payments WHERE id=_payment_id;
  IF NOT FOUND OR _p.metadata->>'asaas_account_scope' IS DISTINCT FROM 'platform'
    OR _p.metadata->>'asaas_environment' IS DISTINCT FROM 'production'
    OR NULLIF(_p.metadata->>'asaas_account_id','') IS NULL THEN RETURN NULL; END IF;
  PERFORM public.lock_reservation_settlement_company(_p.company_id);
  SELECT * INTO _s FROM public.reservation_payment_settlements WHERE payment_id=_payment_id;
  IF FOUND THEN RETURN to_jsonb(_s); END IF;
  SELECT * INTO _t FROM public.reservation_settlement_terms WHERE company_id=_p.company_id
    AND effective_at<=_p.created_at AND created_at<=_p.created_at
    ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Condições comerciais dos pagamentos antecipados não configuradas para esta empresa'; END IF;
  IF NOT _t.enabled THEN RAISE EXCEPTION 'Condições comerciais dos pagamentos antecipados desabilitadas para esta empresa'; END IF;
  INSERT INTO public.reservation_payment_settlements(payment_id,company_id,terms_id,fee_bps,pix_fee_bps,credit_card_fee_bps,release_policy,hold_days,provider_account_id,provider_environment)
  VALUES(_p.id,_p.company_id,_t.id,_t.fee_bps,COALESCE(_t.pix_fee_bps,_t.fee_bps),COALESCE(_t.credit_card_fee_bps,_t.fee_bps),_t.release_policy,_t.hold_days,_p.metadata->>'asaas_account_id','production') RETURNING * INTO _s;
  RETURN to_jsonb(_s);
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_reservation_payment_settlement(_payment_id uuid,_source text DEFAULT 'projection')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  _s public.reservation_payment_settlements; _p public.reservation_payments; _snapshot jsonb;
  _company uuid; _status text; _gross bigint; _refund bigint:=0; _fee bigint; _merchant bigint;
  _pending bigint:=0; _available bigint:=0; _blocked bigint:=0; _cost bigint:=0;
  _recognized boolean; _manual boolean; _net bigint; _reservation_date date; _eligible timestamptz; _chargeback bigint:=0; _refund_uncertain boolean;
BEGIN
  SELECT company_id INTO _company FROM public.reservation_payment_settlements WHERE payment_id=_payment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM public.lock_reservation_settlement_company(_company);
  SELECT * INTO _s FROM public.reservation_payment_settlements WHERE payment_id=_payment_id FOR UPDATE;
  SELECT * INTO _p FROM public.reservation_payments WHERE id=_payment_id;
  IF _p.company_id IS DISTINCT FROM _s.company_id THEN RAISE EXCEPTION 'Empresa do pagamento divergente'; END IF;
  _snapshot:=_s.provider_snapshot;
  _status:=upper(COALESCE(_snapshot->>'status',''));
  _gross:=_s.gross_cents;
  _net:=_s.provider_net_cents;
  _recognized:=_s.recognized OR _status IN ('CONFIRMED','RECEIVED','REFUNDED','REFUND_REQUESTED','REFUND_IN_PROGRESS','CHARGEBACK_REQUESTED','CHARGEBACK_DISPUTE','AWAITING_CHARGEBACK_REVERSAL');
  IF NOT _recognized OR _gross<=0 THEN RETURN to_jsonb(_s); END IF;
  SELECT COALESCE(sum(round((r->>'value')::numeric*100)::bigint),0) INTO _refund
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_snapshot->'refunds')='array' THEN _snapshot->'refunds' ELSE '[]'::jsonb END) r
    WHERE upper(COALESCE(r->>'status',''))='DONE' AND (r->>'value') ~ '^[0-9]+([.][0-9]{1,2})?$';
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_snapshot->'refunds')='array' THEN _snapshot->'refunds' ELSE '[]'::jsonb END) r
    WHERE upper(COALESCE(r->>'status','')) NOT IN ('DONE','CANCELLED')
      OR (upper(COALESCE(r->>'status',''))='DONE' AND
        (r->>'value' IS NULL OR (r->>'value') !~ '^[0-9]+([.][0-9]{1,2})?$'))) INTO _refund_uncertain;
  IF _status='REFUNDED' THEN _refund:=_gross; END IF;
  _refund:=greatest(_s.refunded_cents,least(_gross,_refund));
  _fee:=round((_gross-_refund)::numeric*_s.fee_bps/10000)::bigint;
  _merchant:=_gross-_refund-_fee;
  IF _status IN ('CHARGEBACK_REQUESTED','CHARGEBACK_DISPUTE','AWAITING_CHARGEBACK_REVERSAL') OR _p.status='chargeback'
    OR upper(COALESCE(_snapshot#>>'{chargeback,status}','')) IN ('REQUESTED','DISPUTE','AWAITING_REVERSAL') THEN
    _fee:=0; _merchant:=0; _chargeback:=_gross-_refund;
  END IF;
  _manual:=NULLIF(_snapshot->>'installment','') IS NOT NULL OR _p.metadata ? 'asaas_installment_id'
    OR _p.metadata->>'asaas_account_scope' IS DISTINCT FROM 'platform'
    OR _p.metadata->>'asaas_environment' IS DISTINCT FROM _s.provider_environment
    OR _p.metadata->>'asaas_account_id' IS DISTINCT FROM _s.provider_account_id
    OR COALESCE((_p.metadata->>'needs_manual_installment_reconciliation')::boolean,false)
    OR _p.status NOT IN ('paid','partial_refunded','refund_denied') OR _refund_uncertain
    OR _status NOT IN ('CONFIRMED','RECEIVED','REFUNDED')
    OR _snapshot->>'billingType' NOT IN ('PIX','CREDIT_CARD')
    OR _snapshot->>'billingType' IS NULL OR _net IS NULL
    OR (_p.status='partial_refunded' AND _refund=0) OR _s.reconciliation_error IS NOT NULL
    OR (_s.pix_fee_bps IS NOT NULL AND
      (_s.fee_billing_type IS NULL OR _p.billing_type IS DISTINCT FROM _s.fee_billing_type
        OR _snapshot->>'billingType' IS DISTINCT FROM _s.fee_billing_type))
    OR _s.observed_at IS NULL OR _s.observed_at<now()-interval '24 hours';
  IF _net IS NOT NULL THEN _cost:=greatest(0,_gross-_net); END IF;
  SELECT date INTO _reservation_date FROM public.reservations WHERE id=_p.reservation_id;
  _eligible:=_s.received_at;
  IF _s.release_policy='after_reservation' THEN
    IF _reservation_date IS NULL THEN _manual:=true;
    ELSE _eligible:=greatest(_eligible,((_reservation_date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')); END IF;
  END IF;
  _eligible:=_eligible+make_interval(days=>_s.hold_days);
  IF _merchant>0 THEN
    IF _manual OR _p.status='refund_pending' THEN _blocked:=_merchant;
    ELSIF _s.received_at IS NOT NULL AND _status='RECEIVED' AND _eligible<=now() THEN _available:=_merchant;
    ELSE _pending:=_merchant;
    END IF;
  END IF;
  IF (_pending,_available,_blocked,_fee,_cost) IS DISTINCT FROM
    (_s.pending_balance_cents,_s.available_balance_cents,_s.blocked_balance_cents,_s.recognized_fee_cents,_s.recognized_provider_cost_cents) THEN
    INSERT INTO public.reservation_settlement_ledger(company_id,payment_id,entry_type,source,pending_delta_cents,available_delta_cents,blocked_delta_cents,fee_delta_cents,provider_cost_delta_cents)
    VALUES(_s.company_id,_payment_id,'payment_position',COALESCE(NULLIF(_source,''),'projection'),_pending-_s.pending_balance_cents,
      _available-_s.available_balance_cents,_blocked-_s.blocked_balance_cents,_fee-_s.recognized_fee_cents,_cost-_s.recognized_provider_cost_cents);
  END IF;
  UPDATE public.reservation_payment_settlements SET recognized=true,refunded_cents=_refund,chargeback_cents=_chargeback,
    fee_cents=round(_gross::numeric*fee_bps/10000)::bigint,merchant_cents=_gross-round(_gross::numeric*fee_bps/10000)::bigint,
    pending_balance_cents=_pending,available_balance_cents=_available,blocked_balance_cents=_blocked,
    recognized_fee_cents=_fee,recognized_provider_cost_cents=_cost,eligible_at=_eligible,updated_at=now()
    WHERE payment_id=_payment_id RETURNING * INTO _s;
  RETURN to_jsonb(_s);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_reservation_payment_settlement(_payment_id uuid,_provider_snapshot jsonb,_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _s public.reservation_payment_settlements; _p public.reservation_payments; _gross bigint; _net bigint; _company uuid; _observed timestamptz; _method text; _method_fee integer;
BEGIN
  SELECT company_id INTO _company FROM public.reservation_payment_settlements WHERE payment_id=_payment_id;
  -- Never lazily initialize old payments from reconciliation or a late webhook.
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM public.lock_reservation_settlement_company(_company);
  SELECT * INTO _s FROM public.reservation_payment_settlements WHERE payment_id=_payment_id FOR UPDATE;
  SELECT * INTO _p FROM public.reservation_payments WHERE id=_payment_id;
  _observed:=COALESCE(NULLIF(_provider_snapshot->>'observed_at','')::timestamptz,now());
  IF _observed>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Data de observação futura inválida'; END IF;
  IF _s.observed_at IS NOT NULL AND _observed<_s.observed_at THEN RETURN to_jsonb(_s); END IF;
  IF _p.company_id IS DISTINCT FROM _s.company_id OR _p.metadata->>'asaas_account_scope' IS DISTINCT FROM 'platform'
    OR _p.metadata->>'asaas_account_id' IS DISTINCT FROM _s.provider_account_id
    OR _p.metadata->>'asaas_environment' IS DISTINCT FROM 'production' THEN RAISE EXCEPTION 'Conta financeira divergente'; END IF;
  IF NULLIF(_provider_snapshot->>'id','') IS NULL OR _provider_snapshot->>'id' IS DISTINCT FROM _p.asaas_payment_id THEN
    RAISE EXCEPTION 'Snapshot não corresponde à cobrança vinculada';
  END IF;
  IF (_provider_snapshot->>'value') !~ '^[0-9]+([.][0-9]{1,2})?$' THEN RAISE EXCEPTION 'Valor bruto inválido no provedor'; END IF;
  _gross:=round((_provider_snapshot->>'value')::numeric*100)::bigint;
  IF _gross<=0 OR _gross>1000000000000 THEN RAISE EXCEPTION 'Valor bruto fora do limite'; END IF;
  IF _s.recognized AND _s.gross_cents<>_gross THEN RAISE EXCEPTION 'Valor de cobrança já reconhecida mudou; conciliação manual necessária'; END IF;
  IF (_provider_snapshot->>'netValue') ~ '^[0-9]+([.][0-9]{1,2})?$' THEN
    _net:=round((_provider_snapshot->>'netValue')::numeric*100)::bigint;
    IF _net>_gross THEN RAISE EXCEPTION 'Valor líquido do provedor inválido'; END IF;
  END IF;
  -- Bind only an authoritative, in-order observation of the locally chosen
  -- method. Both rates were frozen before the customer chose how to pay.
  IF _s.pix_fee_bps IS NOT NULL THEN
    _method:=_provider_snapshot->>'billingType';
    IF _method IS NULL OR _method NOT IN ('PIX','CREDIT_CARD') OR _p.billing_type IS DISTINCT FROM _method
      OR (_s.fee_billing_type IS NOT NULL AND _s.fee_billing_type IS DISTINCT FROM _method)
      OR (_s.fee_billing_type IS NULL AND _s.recognized) THEN
      UPDATE public.reservation_payment_settlements SET reconciliation_error='Método do pagamento divergente; conferência necessária',observed_at=_observed,last_checked_at=now(),updated_at=now()
        WHERE payment_id=_payment_id;
      RETURN public.refresh_reservation_payment_settlement(_payment_id,_source);
    END IF;
    IF _s.fee_billing_type IS NULL THEN
      _method_fee:=CASE _method WHEN 'PIX' THEN _s.pix_fee_bps WHEN 'CREDIT_CARD' THEN _s.credit_card_fee_bps END;
      UPDATE public.reservation_payment_settlements SET fee_bps=_method_fee,fee_billing_type=_method WHERE payment_id=_payment_id;
    END IF;
  END IF;
  UPDATE public.reservation_payment_settlements SET gross_cents=_gross,provider_net_cents=_net,
    provider_status=upper(_provider_snapshot->>'status'),provider_snapshot=_provider_snapshot,
    received_at=CASE WHEN upper(_provider_snapshot->>'status')='RECEIVED'
      AND _provider_snapshot->>'billingType' IN ('PIX','CREDIT_CARD') AND NULLIF(_provider_snapshot->>'installment','') IS NULL
      THEN COALESCE(received_at,now()) ELSE received_at END,
    observed_at=_observed,reconciliation_error=NULL,last_checked_at=now(),updated_at=now() WHERE payment_id=_payment_id;
  RETURN public.refresh_reservation_payment_settlement(_payment_id,_source);
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_changed_reservation_payment_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.billing_type IS DISTINCT FROM OLD.billing_type THEN
    PERFORM public.refresh_reservation_payment_settlement(NEW.id,'payment_status');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER refresh_changed_reservation_payment_settlement ON public.reservation_payments;
CREATE TRIGGER refresh_changed_reservation_payment_settlement AFTER UPDATE OF status,metadata,billing_type ON public.reservation_payments
FOR EACH ROW EXECUTE FUNCTION public.refresh_changed_reservation_payment_settlement();

REVOKE ALL ON FUNCTION public.save_reservation_settlement_method_terms(uuid,integer,integer,text,integer,timestamptz,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_reservation_settlement_method_terms(uuid,integer,integer,text,integer,timestamptz,boolean,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.guard_reservation_payment_fee_snapshot() FROM PUBLIC,anon,authenticated;
COMMENT ON COLUMN public.reservation_settlement_terms.fee_bps IS 'Legacy single-rate fallback; method-aware clients use pix_fee_bps and credit_card_fee_bps.';
COMMENT ON COLUMN public.reservation_payment_settlements.fee_bps IS 'Effective charge rate: legacy frozen rate, or one-time selection from frozen method rates after authoritative verification.';
COMMENT ON COLUMN public.reservation_payment_settlements.fee_billing_type IS 'Method verified against the canonical provider charge and local selection; NULL on historical settlements.';
