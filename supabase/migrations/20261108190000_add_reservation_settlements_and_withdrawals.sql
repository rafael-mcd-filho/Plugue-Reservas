-- Local implementation. Financial state is independent from booking approval.
-- Only newly created central production payments with explicit terms enter it.
CREATE TABLE public.reservation_settlement_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  release_policy text NOT NULL DEFAULT 'after_reservation' CHECK (release_policy IN ('after_reservation','on_settlement')),
  hold_days integer NOT NULL DEFAULT 0 CHECK (hold_days BETWEEN 0 AND 365),
  effective_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX reservation_settlement_terms_company_time ON public.reservation_settlement_terms(company_id,effective_at DESC,created_at DESC);

CREATE TABLE public.reservation_payment_settlements (
  payment_id uuid PRIMARY KEY REFERENCES public.reservation_payments(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  terms_id uuid NOT NULL REFERENCES public.reservation_settlement_terms(id) ON DELETE RESTRICT,
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  release_policy text NOT NULL CHECK (release_policy IN ('after_reservation','on_settlement')),
  hold_days integer NOT NULL CHECK (hold_days BETWEEN 0 AND 365),
  provider_account_id text NOT NULL,
  provider_environment text NOT NULL CHECK (provider_environment='production'),
  gross_cents bigint NOT NULL DEFAULT 0 CHECK (gross_cents>=0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents>=0),
  merchant_cents bigint NOT NULL DEFAULT 0 CHECK (merchant_cents>=0),
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents>=0),
  chargeback_cents bigint NOT NULL DEFAULT 0 CHECK (chargeback_cents>=0),
  provider_net_cents bigint,
  provider_status text,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz,
  eligible_at timestamptz,
  pending_balance_cents bigint NOT NULL DEFAULT 0,
  available_balance_cents bigint NOT NULL DEFAULT 0,
  blocked_balance_cents bigint NOT NULL DEFAULT 0,
  recognized_fee_cents bigint NOT NULL DEFAULT 0,
  recognized_provider_cost_cents bigint NOT NULL DEFAULT 0,
  recognized boolean NOT NULL DEFAULT false,
  observed_at timestamptz,
  reconciliation_error text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_payment_settlements_reconcile ON public.reservation_payment_settlements(last_checked_at NULLS FIRST,payment_id);

CREATE TABLE public.company_payout_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('pix','bank')),
  holder_name text NOT NULL CHECK (char_length(holder_name) BETWEEN 2 AND 160),
  holder_document text NOT NULL CHECK (holder_document ~ '^([0-9]{11}|[0-9]{14})$'),
  pix_key_type text CHECK (pix_key_type IN ('cpf','cnpj','email','phone','random')),
  pix_key text CHECK (char_length(pix_key)<=254),
  bank_code text,
  bank_name text,
  agency text,
  account_number text,
  account_type text CHECK (account_type IN ('checking','savings')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT company_payout_destination_fields CHECK (
    (kind='pix' AND pix_key_type IS NOT NULL AND NULLIF(btrim(pix_key),'') IS NOT NULL)
    OR (kind='bank' AND bank_code IS NOT NULL AND agency IS NOT NULL AND account_number IS NOT NULL
      AND bank_code ~ '^([0-9]{3}|[0-9]{8})$' AND char_length(agency) BETWEEN 1 AND 12
      AND char_length(account_number) BETWEEN 1 AND 25 AND account_type IS NOT NULL)
  )
);
CREATE UNIQUE INDEX company_payout_destinations_one_active ON public.company_payout_destinations(company_id) WHERE active;

CREATE TABLE public.reservation_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','under_review','processing','paid','rejected','cancelled')),
  destination_id uuid NOT NULL REFERENCES public.company_payout_destinations(id) ON DELETE RESTRICT,
  destination_snapshot jsonb NOT NULL,
  idempotency_key uuid NOT NULL,
  requested_by uuid NOT NULL,
  handled_by uuid,
  reason text CHECK (char_length(reason)<=2000),
  receipt_path text,
  bank_reference text CHECK (char_length(bank_reference)<=200),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id,idempotency_key),
  CONSTRAINT withdrawal_paid_evidence CHECK (status<>'paid' OR
    (NULLIF(btrim(receipt_path),'') IS NOT NULL AND NULLIF(btrim(bank_reference),'') IS NOT NULL AND paid_at IS NOT NULL))
);
CREATE INDEX reservation_withdrawals_company_time ON public.reservation_withdrawals(company_id,created_at DESC,id DESC);
CREATE INDEX reservation_withdrawals_queue ON public.reservation_withdrawals(status,created_at,id);
-- A transfer may discharge one request only. Use the bank's transaction ID or
-- Pix E2E ID, rather than a free-form description shared by several payments.
CREATE UNIQUE INDEX reservation_withdrawals_paid_reference
ON public.reservation_withdrawals(lower(btrim(bank_reference))) WHERE status='paid';

CREATE TABLE public.reservation_settlement_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  payment_id uuid REFERENCES public.reservation_payment_settlements(payment_id) ON DELETE RESTRICT,
  withdrawal_id uuid REFERENCES public.reservation_withdrawals(id) ON DELETE RESTRICT,
  entry_type text NOT NULL,
  source text NOT NULL,
  pending_delta_cents bigint NOT NULL DEFAULT 0,
  available_delta_cents bigint NOT NULL DEFAULT 0,
  blocked_delta_cents bigint NOT NULL DEFAULT 0,
  reserved_delta_cents bigint NOT NULL DEFAULT 0,
  paid_delta_cents bigint NOT NULL DEFAULT 0,
  fee_delta_cents bigint NOT NULL DEFAULT 0,
  provider_cost_delta_cents bigint NOT NULL DEFAULT 0,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_settlement_ledger_company_time ON public.reservation_settlement_ledger(company_id,created_at DESC,id DESC);

CREATE TABLE public.reservation_withdrawal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  withdrawal_id uuid NOT NULL REFERENCES public.reservation_withdrawals(id) ON DELETE RESTRICT,
  previous_status text,
  status text NOT NULL,
  actor_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.reject_reservation_financial_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'O histórico financeiro é permanente; registre uma nova movimentação para corrigir'; END;
$$;
CREATE TRIGGER immutable_reservation_settlement_ledger BEFORE UPDATE OR DELETE ON public.reservation_settlement_ledger
FOR EACH ROW EXECUTE FUNCTION public.reject_reservation_financial_history_mutation();
CREATE TRIGGER immutable_reservation_settlement_terms BEFORE UPDATE OR DELETE ON public.reservation_settlement_terms
FOR EACH ROW EXECUTE FUNCTION public.reject_reservation_financial_history_mutation();
CREATE TRIGGER immutable_reservation_withdrawal_events BEFORE UPDATE OR DELETE ON public.reservation_withdrawal_events
FOR EACH ROW EXECUTE FUNCTION public.reject_reservation_financial_history_mutation();

-- Every balance-changing operation, including a refund claimed by the existing
-- payment endpoint, shares this company lock. No operation locks payment rows
-- after acquiring this lock, avoiding payment->company lock-order cycles.
CREATE FUNCTION public.lock_reservation_settlement_company(_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF _company_id IS NULL THEN RAISE EXCEPTION 'Empresa obrigatória'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reservation-settlement:'||_company_id::text,0));
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id=_company_id AND deletion_requested_at IS NULL) THEN
    RAISE EXCEPTION 'Empresa indisponível ou com exclusão em andamento';
  END IF;
END;
$$;

CREATE FUNCTION public.save_reservation_settlement_terms(
  _company_id uuid,_fee_bps integer,_release_policy text,_hold_days integer,
  _effective_at timestamptz,_enabled boolean,_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _row public.reservation_settlement_terms;
BEGIN
  PERFORM public.lock_reservation_settlement_company(_company_id);
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Responsável obrigatório'; END IF;
  IF _effective_at IS NOT NULL AND _effective_at < now()-interval '1 minute' THEN
    RAISE EXCEPTION 'A condição comercial não pode ser aplicada retroativamente';
  END IF;
  INSERT INTO public.reservation_settlement_terms(company_id,fee_bps,release_policy,hold_days,effective_at,enabled,created_by)
  VALUES(_company_id,_fee_bps,_release_policy,_hold_days,COALESCE(_effective_at,now()),_enabled,_actor_id) RETURNING * INTO _row;
  RETURN to_jsonb(_row);
END;
$$;

CREATE FUNCTION public.initialize_reservation_payment_settlement(_payment_id uuid)
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
  INSERT INTO public.reservation_payment_settlements(payment_id,company_id,terms_id,fee_bps,release_policy,hold_days,provider_account_id,provider_environment)
  VALUES(_p.id,_p.company_id,_t.id,_t.fee_bps,_t.release_policy,_t.hold_days,_p.metadata->>'asaas_account_id','production') RETURNING * INTO _s;
  RETURN to_jsonb(_s);
END;
$$;

CREATE FUNCTION public.refresh_reservation_payment_settlement(_payment_id uuid,_source text DEFAULT 'projection')
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

CREATE FUNCTION public.sync_reservation_payment_settlement(_payment_id uuid,_provider_snapshot jsonb,_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _s public.reservation_payment_settlements; _p public.reservation_payments; _gross bigint; _net bigint; _company uuid; _observed timestamptz;
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
  UPDATE public.reservation_payment_settlements SET gross_cents=_gross,provider_net_cents=_net,
    provider_status=upper(_provider_snapshot->>'status'),provider_snapshot=_provider_snapshot,
    received_at=CASE WHEN upper(_provider_snapshot->>'status')='RECEIVED'
      AND _provider_snapshot->>'billingType' IN ('PIX','CREDIT_CARD') AND NULLIF(_provider_snapshot->>'installment','') IS NULL
      THEN COALESCE(received_at,now()) ELSE received_at END,
    observed_at=_observed,reconciliation_error=NULL,last_checked_at=now(),updated_at=now() WHERE payment_id=_payment_id;
  RETURN public.refresh_reservation_payment_settlement(_payment_id,_source);
END;
$$;

CREATE FUNCTION public.release_due_reservation_settlements(_company_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _id uuid; _count integer:=0;
BEGIN
  FOR _id IN SELECT payment_id FROM public.reservation_payment_settlements
    WHERE (_company_id IS NULL OR company_id=_company_id) AND recognized
      AND (pending_balance_cents>0 OR blocked_balance_cents>0 OR available_balance_cents>0) ORDER BY company_id,payment_id
  LOOP PERFORM public.refresh_reservation_payment_settlement(_id,'release_due'); _count:=_count+1; END LOOP;
  RETURN _count;
END;
$$;

CREATE FUNCTION public.get_reservation_settlement_summary(_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _balances jsonb; _terms jsonb; _terms_history jsonb; _destination jsonb; _withdrawals jsonb; _ledger jsonb;
  _gross bigint; _refund bigint; _chargeback bigint; _attention integer;
BEGIN
  SELECT jsonb_build_object('pending_cents',COALESCE(sum(pending_delta_cents),0),'available_cents',COALESCE(sum(available_delta_cents),0),
    'blocked_cents',COALESCE(sum(blocked_delta_cents),0),'reserved_cents',COALESCE(sum(reserved_delta_cents),0),
    'paid_cents',COALESCE(sum(paid_delta_cents),0),'fee_cents',COALESCE(sum(fee_delta_cents),0),
    'provider_cost_cents',COALESCE(sum(provider_cost_delta_cents),0)) INTO _balances
    FROM public.reservation_settlement_ledger WHERE company_id=_company_id;
  SELECT to_jsonb(t) INTO _terms FROM public.reservation_settlement_terms t WHERE company_id=_company_id
    AND effective_at<=now() ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.effective_at DESC,t.created_at DESC,t.id DESC),'[]'::jsonb) INTO _terms_history
    FROM (SELECT * FROM public.reservation_settlement_terms WHERE company_id=_company_id ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 10) t;
  SELECT to_jsonb(d) INTO _destination FROM public.company_payout_destinations d WHERE company_id=_company_id AND active;
  SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC,w.id DESC),'[]'::jsonb) INTO _withdrawals
    FROM (SELECT * FROM public.reservation_withdrawals WHERE company_id=_company_id ORDER BY created_at DESC,id DESC LIMIT 25) w;
  SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC,l.id DESC),'[]'::jsonb) INTO _ledger
    FROM (SELECT * FROM public.reservation_settlement_ledger WHERE company_id=_company_id ORDER BY created_at DESC,id DESC LIMIT 50) l;
  SELECT COALESCE(sum(gross_cents),0),COALESCE(sum(refunded_cents),0),COALESCE(sum(chargeback_cents),0),
    count(*) FILTER(WHERE blocked_balance_cents>0 OR reconciliation_error IS NOT NULL)::integer INTO _gross,_refund,_chargeback,_attention
    FROM public.reservation_payment_settlements WHERE company_id=_company_id AND recognized;
  RETURN _balances||jsonb_build_object('company_id',_company_id,'terms',_terms,'destination',_destination,
    'withdrawals',_withdrawals,'ledger',_ledger,'gross_cents',_gross,'refunded_cents',_refund,'chargeback_cents',_chargeback,
    'merchant_net_cents',_gross-_refund-_chargeback-COALESCE((_balances->>'fee_cents')::bigint,0),'terms_history',_terms_history,'attention_count',_attention);
END;
$$;

CREATE FUNCTION public.save_company_payout_destination(_company_id uuid,_destination jsonb,_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _row public.company_payout_destinations;
BEGIN
  PERFORM public.lock_reservation_settlement_company(_company_id);
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Responsável obrigatório'; END IF;
  UPDATE public.company_payout_destinations SET active=false WHERE company_id=_company_id AND active;
  INSERT INTO public.company_payout_destinations(company_id,kind,holder_name,holder_document,pix_key_type,pix_key,bank_code,bank_name,agency,account_number,account_type,created_by)
  VALUES(_company_id,_destination->>'kind',btrim(_destination->>'holder_name'),regexp_replace(_destination->>'holder_document','[^0-9]','','g'),
    NULLIF(_destination->>'pix_key_type',''),NULLIF(btrim(_destination->>'pix_key'),''),NULLIF(_destination->>'bank_code',''),
    NULLIF(_destination->>'bank_name',''),NULLIF(_destination->>'agency',''),NULLIF(_destination->>'account_number',''),
    NULLIF(_destination->>'account_type',''),_actor_id) RETURNING * INTO _row;
  RETURN to_jsonb(_row);
END;
$$;

CREATE FUNCTION public.request_reservation_withdrawal(_company_id uuid,_amount_cents bigint,_idempotency_key uuid,_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _available bigint; _row public.reservation_withdrawals; _destination public.company_payout_destinations;
BEGIN
  PERFORM public.lock_reservation_settlement_company(_company_id);
  IF _actor_id IS NULL OR _idempotency_key IS NULL OR _amount_cents IS NULL OR _amount_cents<=0 THEN RAISE EXCEPTION 'Pedido de saque inválido'; END IF;
  SELECT * INTO _row FROM public.reservation_withdrawals WHERE company_id=_company_id AND idempotency_key=_idempotency_key;
  IF FOUND THEN
    IF _row.amount_cents<>_amount_cents OR _row.requested_by<>_actor_id THEN RAISE EXCEPTION 'Identificador de pedido já utilizado com outros dados'; END IF;
    RETURN to_jsonb(_row);
  END IF;
  PERFORM public.release_due_reservation_settlements(_company_id);
  SELECT COALESCE(sum(available_delta_cents),0) INTO _available FROM public.reservation_settlement_ledger WHERE company_id=_company_id;
  IF _amount_cents>_available THEN RAISE EXCEPTION 'Saldo disponível insuficiente'; END IF;
  SELECT * INTO _destination FROM public.company_payout_destinations WHERE company_id=_company_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cadastre uma conta para receber o saque'; END IF;
  INSERT INTO public.reservation_withdrawals(company_id,amount_cents,destination_id,destination_snapshot,idempotency_key,requested_by)
  VALUES(_company_id,_amount_cents,_destination.id,to_jsonb(_destination)-'active',_idempotency_key,_actor_id) RETURNING * INTO _row;
  INSERT INTO public.reservation_settlement_ledger(company_id,withdrawal_id,entry_type,source,available_delta_cents,reserved_delta_cents,actor_id)
  VALUES(_company_id,_row.id,'withdrawal_requested','company',-_amount_cents,_amount_cents,_actor_id);
  INSERT INTO public.reservation_withdrawal_events(company_id,withdrawal_id,status,actor_id) VALUES(_company_id,_row.id,'requested',_actor_id);
  RETURN to_jsonb(_row);
END;
$$;

CREATE FUNCTION public.transition_reservation_withdrawal(
  _withdrawal_id uuid,_status text,_actor_id uuid,_reason text DEFAULT NULL,
  _receipt_path text DEFAULT NULL,_bank_reference text DEFAULT NULL,_paid_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _row public.reservation_withdrawals; _previous text; _available bigint;
BEGIN
  SELECT * INTO _row FROM public.reservation_withdrawals WHERE id=_withdrawal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido de saque não encontrado'; END IF;
  PERFORM public.lock_reservation_settlement_company(_row.company_id);
  SELECT * INTO _row FROM public.reservation_withdrawals WHERE id=_withdrawal_id FOR UPDATE;
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Responsável obrigatório'; END IF;
  IF _row.status=_status THEN
    IF _status IN ('processing','paid') AND _row.handled_by IS DISTINCT FROM _actor_id THEN
      RAISE EXCEPTION 'Pedido já assumido por outro administrador';
    END IF;
    IF _status='paid' AND (_row.receipt_path IS DISTINCT FROM _receipt_path OR _row.bank_reference IS DISTINCT FROM btrim(_bank_reference)
      OR _row.paid_at IS DISTINCT FROM _paid_at) THEN RAISE EXCEPTION 'Pedido pago é imutável'; END IF;
    RETURN to_jsonb(_row);
  END IF;
  _previous:=_row.status;
  IF NOT ((_previous='requested' AND _status IN ('under_review','processing','rejected','cancelled'))
    OR (_previous='under_review' AND _status IN ('processing','rejected','cancelled'))
    OR (_previous='processing' AND _status='paid')) THEN
    RAISE EXCEPTION 'Transição de saque não permitida; pagamentos em andamento exigem conferência antes de qualquer liberação';
  END IF;
  IF _status IN ('rejected','cancelled') AND NULLIF(btrim(_reason),'') IS NULL THEN RAISE EXCEPTION 'Informe o motivo'; END IF;
  IF _status='processing' THEN
    PERFORM public.release_due_reservation_settlements(_row.company_id);
    SELECT COALESCE(sum(available_delta_cents),0) INTO _available FROM public.reservation_settlement_ledger WHERE company_id=_row.company_id;
    IF _available<0 THEN RAISE EXCEPTION 'Saldo comprometido por devoluções; regularize antes de efetuar o repasse'; END IF;
  END IF;
  IF _status='paid' THEN
    IF _row.handled_by IS DISTINCT FROM _actor_id THEN RAISE EXCEPTION 'Pagamento deve ser concluído pelo administrador responsável'; END IF;
    IF NULLIF(btrim(_receipt_path),'') IS NULL OR NULLIF(btrim(_bank_reference),'') IS NULL OR _paid_at IS NULL
      OR _paid_at>now()+interval '5 minutes' OR _paid_at<_row.created_at-interval '1 day'
      OR _receipt_path NOT LIKE _row.company_id::text||'/'||_row.id::text||'/%' THEN
      RAISE EXCEPTION 'Comprovante privado, referência e data de pagamento válidos são obrigatórios';
    END IF;
    -- Checking existence prevents claiming a paid transfer with a fabricated URL.
    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='reservation-payout-receipts' AND name=_receipt_path) THEN
      RAISE EXCEPTION 'Comprovante não encontrado no armazenamento privado';
    END IF;
    INSERT INTO public.reservation_settlement_ledger(company_id,withdrawal_id,entry_type,source,reserved_delta_cents,paid_delta_cents,actor_id)
    VALUES(_row.company_id,_row.id,'withdrawal_paid','superadmin',-_row.amount_cents,_row.amount_cents,_actor_id);
  ELSIF _status IN ('rejected','cancelled') THEN
    INSERT INTO public.reservation_settlement_ledger(company_id,withdrawal_id,entry_type,source,available_delta_cents,reserved_delta_cents,actor_id)
    VALUES(_row.company_id,_row.id,'withdrawal_released',CASE WHEN _status='cancelled' THEN 'company' ELSE 'superadmin' END,_row.amount_cents,-_row.amount_cents,_actor_id);
  END IF;
  UPDATE public.reservation_withdrawals SET status=_status,handled_by=_actor_id,reason=NULLIF(btrim(_reason),''),
    receipt_path=CASE WHEN _status='paid' THEN _receipt_path ELSE receipt_path END,
    bank_reference=CASE WHEN _status='paid' THEN btrim(_bank_reference) ELSE bank_reference END,
    paid_at=CASE WHEN _status='paid' THEN _paid_at ELSE paid_at END,updated_at=now()
    WHERE id=_row.id RETURNING * INTO _row;
  INSERT INTO public.reservation_withdrawal_events(company_id,withdrawal_id,previous_status,status,actor_id,details)
  VALUES(_row.company_id,_row.id,_previous,_status,_actor_id,jsonb_build_object('reason',_reason,'bank_reference',_bank_reference,'receipt_path',_receipt_path,'paid_at',_paid_at));
  RETURN to_jsonb(_row);
END;
$$;

CREATE FUNCTION public.cancel_reservation_withdrawal(_withdrawal_id uuid,_company_id uuid,_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.reservation_withdrawals WHERE id=_withdrawal_id AND company_id=_company_id) THEN
    RAISE EXCEPTION 'Pedido de saque não encontrado'; END IF;
  RETURN public.transition_reservation_withdrawal(_withdrawal_id,'cancelled',_actor_id,'Cancelado pela empresa');
END;
$$;

CREATE FUNCTION public.initialize_new_reservation_payment_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN PERFORM public.initialize_reservation_payment_settlement(NEW.id); RETURN NEW; END;
$$;
CREATE TRIGGER initialize_new_reservation_payment_settlement AFTER INSERT ON public.reservation_payments
FOR EACH ROW EXECUTE FUNCTION public.initialize_new_reservation_payment_settlement();

CREATE FUNCTION public.refresh_changed_reservation_payment_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    PERFORM public.refresh_reservation_payment_settlement(NEW.id,'payment_status');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refresh_changed_reservation_payment_settlement AFTER UPDATE OF status,metadata ON public.reservation_payments
FOR EACH ROW EXECUTE FUNCTION public.refresh_changed_reservation_payment_settlement();

-- No authenticated direct table/storage access: Edge performs real-actor tenant
-- authorization and issues short-lived receipt download URLs after that check.
DO $$ DECLARE _table text; _function record;
BEGIN
  FOREACH _table IN ARRAY ARRAY['reservation_settlement_terms','reservation_payment_settlements','reservation_settlement_ledger',
    'company_payout_destinations','reservation_withdrawals','reservation_withdrawal_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon,authenticated',_table);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.%I TO service_role',_table);
  END LOOP;
  FOR _function IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('reject_reservation_financial_history_mutation','lock_reservation_settlement_company',
      'save_reservation_settlement_terms','initialize_reservation_payment_settlement','refresh_reservation_payment_settlement',
      'sync_reservation_payment_settlement','release_due_reservation_settlements','get_reservation_settlement_summary',
      'save_company_payout_destination','request_reservation_withdrawal','transition_reservation_withdrawal','cancel_reservation_withdrawal',
      'initialize_new_reservation_payment_settlement','refresh_changed_reservation_payment_settlement') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',_function.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',_function.signature);
  END LOOP;
END; $$;
REVOKE UPDATE ON public.reservation_settlement_terms,public.reservation_settlement_ledger,public.reservation_withdrawal_events FROM service_role;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('reservation-payout-receipts','reservation-payout-receipts',false,5242880,ARRAY['application/pdf','image/jpeg','image/png'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=5242880,allowed_mime_types=EXCLUDED.allowed_mime_types;

COMMENT ON TABLE public.reservation_settlement_ledger IS 'Permanent merchant payable movements in integer BRL cents. Provider fees are a platform cost. Not a bank balance.';
COMMENT ON TABLE public.reservation_payment_settlements IS 'New central production charges only; frozen terms, no automatic historical opening balance.';
