-- Separate from tenant/panel notifications and their read receipts. Only an
-- explicitly submitted global-superadmin request can create these messages.
CREATE TABLE IF NOT EXISTS public.platform_whatsapp_notice_batches (
  id uuid PRIMARY KEY,
  company_ids uuid[] NOT NULL CHECK (cardinality(company_ids) BETWEEN 1 AND 1000),
  image_path text NOT NULL CHECK (image_path ~* '^notification-images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg)$'),
  caption text NOT NULL CHECK (char_length(btrim(caption)) BETWEEN 1 AND 1000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_whatsapp_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.platform_whatsapp_notice_batches(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  company_name text NOT NULL,
  recipient_phone text CHECK (recipient_phone IS NULL OR recipient_phone ~ '^\+[1-9][0-9]{6,14}$'),
  image_path text NOT NULL CHECK (image_path ~* '^notification-images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg)$'),
  caption text NOT NULL CHECK (char_length(btrim(caption)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','accepted','failed','unknown','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  provider_message_id text CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 255),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(batch_id,company_id),
  CHECK (status <> 'queued' OR recipient_phone IS NOT NULL),
  CHECK (status <> 'accepted' OR provider_message_id IS NOT NULL),
  CHECK ((status='processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_whatsapp_notices_batch_phone
  ON public.platform_whatsapp_notices(batch_id,recipient_phone)
  WHERE recipient_phone IS NOT NULL AND status <> 'skipped';
CREATE INDEX IF NOT EXISTS idx_platform_whatsapp_notices_queue
  ON public.platform_whatsapp_notices(status,created_at,id) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS idx_platform_whatsapp_notices_history
  ON public.platform_whatsapp_notices(created_at DESC,id DESC);

ALTER TABLE public.platform_whatsapp_notice_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_whatsapp_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Global superadmin can read platform WhatsApp batches" ON public.platform_whatsapp_notice_batches;
CREATE POLICY "Global superadmin can read platform WhatsApp batches" ON public.platform_whatsapp_notice_batches
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL AND public.has_role(auth.uid(),'superadmin'::public.app_role));
DROP POLICY IF EXISTS "Global superadmin can read platform WhatsApp notices" ON public.platform_whatsapp_notices;
CREATE POLICY "Global superadmin can read platform WhatsApp notices" ON public.platform_whatsapp_notices
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL AND public.has_role(auth.uid(),'superadmin'::public.app_role));
REVOKE ALL ON public.platform_whatsapp_notice_batches,public.platform_whatsapp_notices FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.platform_whatsapp_notice_batches TO authenticated;
GRANT SELECT(id,batch_id,company_id,company_name,recipient_phone,image_path,caption,status,attempts,error_message,created_at,processed_at)
  ON public.platform_whatsapp_notices TO authenticated;
GRANT ALL ON public.platform_whatsapp_notice_batches,public.platform_whatsapp_notices TO service_role;

CREATE OR REPLACE FUNCTION public.create_platform_whatsapp_notice_batch(
  _request_id uuid,_company_ids uuid[],_image_path text,_caption text,_actor_id uuid,_recipients jsonb
) RETURNS SETOF public.platform_whatsapp_notices
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  _ids uuid[];
  _batch public.platform_whatsapp_notice_batches%ROWTYPE;
  _row record;
  _company public.companies%ROWTYPE;
  _expected_phone text;
  _seen_phones text[] := ARRAY[]::text[];
  _status text;
  _reason text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Não autorizado' USING ERRCODE='42501'; END IF;
  IF _actor_id IS NULL OR public.has_role(_actor_id,'superadmin'::public.app_role) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Apenas superadmin pode enviar avisos' USING ERRCODE='42501'; END IF;
  IF _request_id IS NULL OR _company_ids IS NULL OR array_position(_company_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Pedido e empresas obrigatórios' USING ERRCODE='22023'; END IF;
  SELECT array_agg(id ORDER BY id) INTO _ids FROM (SELECT DISTINCT unnest(_company_ids) id) ids;
  IF COALESCE(cardinality(_ids),0) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Selecione de 1 a 1000 empresas' USING ERRCODE='22023'; END IF;
  IF _image_path IS NULL OR _image_path !~* '^notification-images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg)$'
    OR _caption IS NULL OR char_length(btrim(_caption)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Imagem ou legenda inválida' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-whatsapp-batch|'||_request_id::text,0));
  SELECT * INTO _batch FROM public.platform_whatsapp_notice_batches WHERE id=_request_id;
  IF FOUND THEN
    IF _batch.company_ids IS DISTINCT FROM _ids OR _batch.image_path IS DISTINCT FROM _image_path
      OR _batch.caption IS DISTINCT FROM _caption OR _batch.created_by IS DISTINCT FROM _actor_id THEN
      RAISE EXCEPTION 'Este pedido já foi usado com outro conteúdo' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT n.* FROM public.platform_whatsapp_notices n WHERE n.batch_id=_request_id ORDER BY n.created_at,n.id;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.companies WHERE id=ANY(_ids))<>cardinality(_ids) THEN RAISE EXCEPTION 'Empresa não encontrada' USING ERRCODE='22023'; END IF;
  IF _recipients IS NULL OR jsonb_typeof(_recipients)<>'array' OR jsonb_array_length(_recipients)<>cardinality(_ids) THEN RAISE EXCEPTION 'Destinatários inválidos' USING ERRCODE='22023'; END IF;
  IF (SELECT array_agg(id ORDER BY id) FROM(SELECT DISTINCT (r->>'company_id')::uuid id FROM jsonb_array_elements(_recipients) r) ids) IS DISTINCT FROM _ids
    OR (SELECT count(DISTINCT r->>'company_id') FROM jsonb_array_elements(_recipients) r)<>cardinality(_ids) THEN
    RAISE EXCEPTION 'Destinatários não correspondem às empresas' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.platform_whatsapp_notice_batches(id,company_ids,image_path,caption,created_by)
    VALUES(_request_id,_ids,_image_path,_caption,_actor_id);
  FOR _row IN SELECT * FROM jsonb_to_recordset(_recipients) AS r(company_id uuid,company_name text,recipient_phone text,status text,error_message text) ORDER BY company_id LOOP
    SELECT * INTO _company FROM public.companies WHERE id=_row.company_id;
    _expected_phone := CASE WHEN NULLIF(btrim(to_jsonb(_company)->>'responsible_phone_e164'),'') IS NOT NULL
      THEN '+'||public.phone_stored_identity_digits(to_jsonb(_company)->>'responsible_phone_e164',NULL,COALESCE(NULLIF(to_jsonb(_company)->>'responsible_phone_country',''),'BR'))
      ELSE '+'||public.phone_stored_identity_digits(NULL,to_jsonb(_company)->>'responsible_phone',COALESCE(NULLIF(to_jsonb(_company)->>'responsible_phone_country',''),'BR')) END;
    IF _row.company_name IS DISTINCT FROM _company.name OR _row.status NOT IN ('queued','skipped') OR _row.status IS NULL
      OR (_row.recipient_phone IS NOT NULL AND (_row.recipient_phone !~ '^\+[1-9][0-9]{6,14}$' OR _row.recipient_phone IS DISTINCT FROM _expected_phone))
      OR (_row.status='queued' AND _row.recipient_phone IS NULL) THEN RAISE EXCEPTION 'Contato do responsável inválido' USING ERRCODE='22023'; END IF;
    _status := _row.status;
    _reason := left(NULLIF(btrim(_row.error_message),''),500);
    IF _status='queued' AND _row.recipient_phone=ANY(_seen_phones) THEN
      _status := 'skipped'; _reason := 'Contato repetido neste envio; o aviso será enviado uma única vez.';
    END IF;
    IF _status='skipped' THEN _reason := COALESCE(_reason,'Empresa sem telefone válido do responsável.');
    ELSE _seen_phones:=array_append(_seen_phones,_row.recipient_phone); _reason:=NULL; END IF;
    INSERT INTO public.platform_whatsapp_notices(batch_id,company_id,company_name,recipient_phone,image_path,caption,status,error_message,processed_at)
      VALUES(_request_id,_row.company_id,_company.name,_row.recipient_phone,_image_path,_caption,_status,_reason,CASE WHEN _status='skipped' THEN now() ELSE NULL END);
  END LOOP;
  INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,details)
    VALUES(_actor_id,'send_whatsapp_notification','platform_whatsapp_notice_batch',_request_id,
      jsonb_build_object('company_ids',_ids,'company_count',cardinality(_ids),'channel','whatsapp','instance','RWSL','image_path',_image_path));
  RETURN QUERY SELECT n.* FROM public.platform_whatsapp_notices n WHERE n.batch_id=_request_id ORDER BY n.created_at,n.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_platform_whatsapp_notices(_limit integer DEFAULT 3,_batch_id uuid DEFAULT NULL)
RETURNS SETOF public.platform_whatsapp_notices LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Não autorizado' USING ERRCODE='42501'; END IF;
  IF _limit IS NULL OR _limit NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Lote inválido' USING ERRCODE='22023'; END IF;
  -- A crashed/late worker might have reached the provider. Never silently retry.
  UPDATE public.platform_whatsapp_notices SET status='unknown',error_message='O envio ficou sem confirmação. Confira a instância RWSL antes de reenviar.',processed_at=now(),lease_token=NULL,lease_expires_at=NULL
    WHERE status='processing' AND lease_expires_at<=now() AND (_batch_id IS NULL OR batch_id=_batch_id);
  UPDATE public.platform_whatsapp_notices n SET status='skipped',error_message='A empresa deste aviso não está disponível.',processed_at=now()
    WHERE n.status='queued' AND (n.company_id IS NULL OR EXISTS(
      SELECT 1 FROM public.companies c WHERE c.id=n.company_id
        AND NULLIF(btrim(to_jsonb(c)->>'deletion_requested_at'),'') IS NOT NULL
    )) AND (_batch_id IS NULL OR n.batch_id=_batch_id);
  RETURN QUERY WITH selected AS (
    SELECT id FROM public.platform_whatsapp_notices WHERE status='queued' AND (_batch_id IS NULL OR batch_id=_batch_id)
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT _limit
  ) UPDATE public.platform_whatsapp_notices n SET status='processing',attempts=n.attempts+1,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes'
    FROM selected s WHERE n.id=s.id RETURNING n.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_platform_whatsapp_notice(
  _notice_id uuid,_lease_token uuid,_status text,_provider_message_id text DEFAULT NULL,_error_message text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _changed integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Não autorizado' USING ERRCODE='42501'; END IF;
  IF _status NOT IN ('accepted','failed','unknown') OR _status IS NULL OR (_status='accepted' AND NULLIF(btrim(_provider_message_id),'') IS NULL)
    OR char_length(COALESCE(_provider_message_id,''))>255 THEN RAISE EXCEPTION 'Resultado inválido' USING ERRCODE='22023'; END IF;
  UPDATE public.platform_whatsapp_notices SET status=_status,provider_message_id=NULLIF(btrim(_provider_message_id),''),
    error_message=CASE WHEN _status='accepted' THEN NULL ELSE left(COALESCE(NULLIF(btrim(_error_message),''),'Não foi possível confirmar o envio.'),500) END,
    processed_at=now(),lease_token=NULL,lease_expires_at=NULL
    WHERE id=_notice_id AND status='processing' AND lease_token=_lease_token AND lease_expires_at>now();
  GET DIAGNOSTICS _changed=ROW_COUNT;
  RETURN _changed=1;
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_platform_whatsapp_notice(
  _notice_id uuid,_recipient_phone text,_error_message text,_actor_id uuid,_expected_attempts integer
) RETURNS public.platform_whatsapp_notices LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE _notice public.platform_whatsapp_notices%ROWTYPE; _company public.companies%ROWTYPE; _expected_phone text; _status text; _reason text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR _actor_id IS NULL OR public.has_role(_actor_id,'superadmin'::public.app_role) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Não autorizado' USING ERRCODE='42501'; END IF;
  SELECT * INTO _notice FROM public.platform_whatsapp_notices WHERE id=_notice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aviso não encontrado' USING ERRCODE='P0002'; END IF;
  IF _expected_attempts IS NULL OR _expected_attempts<>_notice.attempts THEN RETURN _notice; END IF;
  IF _notice.status IN('queued','processing') THEN RETURN _notice; END IF;
  IF _notice.status NOT IN('failed','skipped') THEN RAISE EXCEPTION 'Este envio não pode ser repetido automaticamente' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-whatsapp-retry|'||_notice.batch_id::text,0));
  SELECT * INTO _company FROM public.companies WHERE id=_notice.company_id;
  IF NOT FOUND AND _recipient_phone IS NOT NULL THEN RAISE EXCEPTION 'A empresa deste aviso não está disponível' USING ERRCODE='22023'; END IF;
  _expected_phone := CASE WHEN NULLIF(btrim(to_jsonb(_company)->>'responsible_phone_e164'),'') IS NOT NULL
    THEN '+'||public.phone_stored_identity_digits(to_jsonb(_company)->>'responsible_phone_e164',NULL,COALESCE(NULLIF(to_jsonb(_company)->>'responsible_phone_country',''),'BR'))
    ELSE '+'||public.phone_stored_identity_digits(NULL,to_jsonb(_company)->>'responsible_phone',COALESCE(NULLIF(to_jsonb(_company)->>'responsible_phone_country',''),'BR')) END;
  IF _recipient_phone IS NOT NULL AND (_recipient_phone !~ '^\+[1-9][0-9]{6,14}$' OR _recipient_phone IS DISTINCT FROM _expected_phone) THEN RAISE EXCEPTION 'Contato do responsável inválido' USING ERRCODE='22023'; END IF;
  _status := CASE WHEN _recipient_phone IS NULL THEN 'skipped' ELSE 'queued' END;
  _reason := CASE WHEN _recipient_phone IS NULL THEN left(COALESCE(NULLIF(btrim(_error_message),''),'Empresa sem telefone válido do responsável.'),500) ELSE NULL END;
  IF _recipient_phone IS NOT NULL AND EXISTS(SELECT 1 FROM public.platform_whatsapp_notices WHERE batch_id=_notice.batch_id AND id<>_notice.id AND recipient_phone=_recipient_phone AND status<>'skipped') THEN
    _status:='skipped';_reason:='Contato repetido neste envio; o aviso será enviado uma única vez.';
  END IF;
  UPDATE public.platform_whatsapp_notices SET status=_status,recipient_phone=_recipient_phone,company_name=COALESCE(_company.name,_notice.company_name),error_message=_reason,
    provider_message_id=NULL,lease_token=NULL,lease_expires_at=NULL,processed_at=CASE WHEN _status='skipped' THEN now() ELSE NULL END
    WHERE id=_notice.id RETURNING * INTO _notice;
  INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,details)
    VALUES(_actor_id,'retry_whatsapp_notification','platform_whatsapp_notice',_notice.id,jsonb_build_object('company_id',_notice.company_id,'channel','whatsapp','instance','RWSL','status',_notice.status));
  RETURN _notice;
END;
$$;

REVOKE ALL ON FUNCTION public.create_platform_whatsapp_notice_batch(uuid,uuid[],text,text,uuid,jsonb),public.claim_platform_whatsapp_notices(integer,uuid),public.finish_platform_whatsapp_notice(uuid,uuid,text,text,text),public.retry_platform_whatsapp_notice(uuid,text,text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_platform_whatsapp_notice_batch(uuid,uuid[],text,text,uuid,jsonb),public.claim_platform_whatsapp_notices(integer,uuid),public.finish_platform_whatsapp_notice(uuid,uuid,text,text,text),public.retry_platform_whatsapp_notice(uuid,text,text,uuid,integer) TO service_role;
