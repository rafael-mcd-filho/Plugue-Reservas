-- Financial records cannot be erased by the general company-deletion worker.
-- Fail before quarantine/teardown, rather than discovering a RESTRICT FK after
-- the worker has already removed unrelated company data.
CREATE FUNCTION public.company_has_reservation_settlement_records(_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.reservation_settlement_terms WHERE company_id=_company_id)
    OR EXISTS (SELECT 1 FROM public.company_payout_destinations WHERE company_id=_company_id)
    OR EXISTS (SELECT 1 FROM public.reservation_payment_settlements WHERE company_id=_company_id)
    OR EXISTS (SELECT 1 FROM public.reservation_withdrawals WHERE company_id=_company_id);
$$;

CREATE FUNCTION public.guard_company_settlement_deletion_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _company_id uuid;
BEGIN
  IF TG_TABLE_NAME='companies' THEN
    IF NEW.deletion_requested_at IS NULL THEN RETURN NEW; END IF;
    _company_id:=NEW.id;
  ELSE
    IF NEW.status NOT IN ('grace_period','running') THEN RETURN NEW; END IF;
    _company_id:=NEW.company_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reservation-settlement:'||_company_id::text,0));
  IF public.company_has_reservation_settlement_records(_company_id) THEN
    RAISE EXCEPTION 'Esta empresa possui configuração ou histórico de repasses. Desative a empresa para preservar os registros financeiros.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_financial_company_deletion_request
BEFORE INSERT OR UPDATE OF status,company_id ON public.company_deletion_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_company_settlement_deletion_request();
CREATE TRIGGER guard_financial_company_quarantine
BEFORE UPDATE OF deletion_requested_at ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.guard_company_settlement_deletion_request();

ALTER FUNCTION public._process_company_deletion_batch(uuid,integer)
RENAME TO _process_company_deletion_batch_without_settlements;
REVOKE ALL ON FUNCTION public._process_company_deletion_batch_without_settlements(uuid,integer)
FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public._process_company_deletion_batch(_request_id uuid,_batch_size integer DEFAULT 3000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET lock_timeout='5s' SET statement_timeout='55s' AS $$
DECLARE _company_id uuid;
BEGIN
  SELECT company_id INTO _company_id FROM public.company_deletion_requests WHERE id=_request_id;
  IF _company_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('reservation-settlement:'||_company_id::text,0));
  END IF;
  IF _company_id IS NOT NULL AND public.company_has_reservation_settlement_records(_company_id) THEN
    UPDATE public.company_deletion_requests SET status='needs_attention',updated_at=clock_timestamp(),
      last_error='Exclusão bloqueada: a empresa possui registros financeiros de repasses; nenhum lote foi removido.'
    WHERE id=_request_id AND status IN ('grace_period','running','failed');
    RETURN jsonb_build_object('status','needs_attention','request_id',_request_id,'reason','financial_history_preserved');
  END IF;
  RETURN public._process_company_deletion_batch_without_settlements(_request_id,_batch_size);
END;
$$;
REVOKE ALL ON FUNCTION public._process_company_deletion_batch(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._process_company_deletion_batch(uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.company_has_reservation_settlement_records(uuid),public.guard_company_settlement_deletion_request()
FROM PUBLIC,anon,authenticated;
