-- =============================================================================
-- NPS Surveys — Avaliações pós-visita
-- Cria: company_nps_configs, reservation_reviews, trigger ensure_reservation_review
-- RPCs públicas: get_public_review_by_token, submit_public_review
-- RPC interna:   get_company_nps_summary
-- Atualiza:      get_public_reservation_by_tracking_code (+ review_token/status)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. company_nps_configs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.company_nps_configs (
  company_id      uuid        PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled         boolean     NOT NULL DEFAULT false,
  ask_ambiance    boolean     NOT NULL DEFAULT true,
  ask_food        boolean     NOT NULL DEFAULT true,
  ask_return      boolean     NOT NULL DEFAULT true,
  comment_trigger text        NOT NULL DEFAULT 'always'
                              CHECK (comment_trigger IN ('always', 'detractor', 'never')),
  intro_message   text,
  expiration_days integer     NOT NULL DEFAULT 30 CHECK (expiration_days BETWEEN 1 AND 365),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_nps_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_nps_configs_select_own"
  ON public.company_nps_configs
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR public.has_role_in_company(auth.uid(), 'admin', company_id)
    OR public.has_role_in_company(auth.uid(), 'operator', company_id)
  );

CREATE POLICY "company_nps_configs_insert_own"
  ON public.company_nps_configs
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'superadmin')
    OR public.has_role_in_company(auth.uid(), 'admin', company_id)
  );

CREATE POLICY "company_nps_configs_update_own"
  ON public.company_nps_configs
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR public.has_role_in_company(auth.uid(), 'admin', company_id)
  );

-- -----------------------------------------------------------------------------
-- 2. reservation_reviews
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.reservation_reviews (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reservation_id       uuid        NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  lead_id              uuid        REFERENCES public.crm_leads(id) ON DELETE SET NULL,
  review_token         text        NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  status               text        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'submitted', 'expired')),
  invited_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  sent_channel         text        CHECK (sent_channel IN ('whatsapp', 'pluguechat', 'manual')),
  ambiance_rating      smallint    CHECK (ambiance_rating BETWEEN 1 AND 5),
  food_rating          smallint    CHECK (food_rating BETWEEN 1 AND 5),
  return_score         smallint    CHECK (return_score BETWEEN 0 AND 10),
  recommend_score      smallint    CHECK (recommend_score BETWEEN 0 AND 10),
  nps_category         text        CHECK (nps_category IN ('promoter', 'passive', 'detractor')),
  comment              text,
  submitted_at         timestamptz,
  submitted_visitor_id text,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_reviews_reservation_id
  ON public.reservation_reviews(reservation_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_reviews_token
  ON public.reservation_reviews(review_token);

CREATE INDEX IF NOT EXISTS idx_reservation_reviews_company_invited
  ON public.reservation_reviews(company_id, invited_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_reviews_company_status
  ON public.reservation_reviews(company_id, status);

ALTER TABLE public.reservation_reviews ENABLE ROW LEVEL SECURITY;

-- Acesso interno: membros autenticados da empresa lêem; escrita só via RPCs/trigger (service role)
CREATE POLICY "reservation_reviews_select_company"
  ON public.reservation_reviews
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'superadmin')
    OR public.has_role_in_company(auth.uid(), 'admin', company_id)
    OR public.has_role_in_company(auth.uid(), 'operator', company_id)
  );

-- -----------------------------------------------------------------------------
-- 3. Trigger: ensure_reservation_review
--    Dispara em INSERT (fila de espera → checked_in direto) e UPDATE de status
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_reservation_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _config public.company_nps_configs%ROWTYPE;
  _lead_id uuid;
BEGIN
  -- Só interessa quando status entra em checked_in ou completed
  IF NEW.status NOT IN ('checked_in', 'completed') THEN
    RETURN NEW;
  END IF;

  -- Em UPDATE, só dispara quando o status MUDA PARA checked_in/completed
  IF TG_OP = 'UPDATE' AND OLD.status IN ('checked_in', 'completed') THEN
    RETURN NEW;
  END IF;

  -- Verificar se a empresa tem NPS habilitado
  SELECT * INTO _config
  FROM public.company_nps_configs
  WHERE company_id = NEW.company_id;

  IF NOT FOUND OR NOT _config.enabled THEN
    RETURN NEW;
  END IF;

  -- Tentar vincular ao lead CRM pelo telefone normalizado
  SELECT id INTO _lead_id
  FROM public.crm_leads
  WHERE company_id = NEW.company_id
    AND phone_normalized = regexp_replace(COALESCE(NEW.guest_phone, ''), '\D', '', 'g')
  LIMIT 1;

  -- Inserir convite (idempotente: ON CONFLICT não faz nada)
  INSERT INTO public.reservation_reviews (
    company_id,
    reservation_id,
    lead_id,
    expires_at
  )
  VALUES (
    NEW.company_id,
    NEW.id,
    _lead_id,
    now() + (_config.expiration_days || ' days')::interval
  )
  ON CONFLICT (reservation_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_reservation_review ON public.reservations;

CREATE TRIGGER trg_ensure_reservation_review
  AFTER INSERT OR UPDATE OF status ON public.reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_reservation_review();

-- -----------------------------------------------------------------------------
-- 4. RPC pública: get_public_review_by_token
--    Retorna branding + config + status para a página pública de avaliação.
--    Não expõe dados pessoais do cliente.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_public_review_by_token(text, text);

CREATE OR REPLACE FUNCTION public.get_public_review_by_token(
  _token text,
  _slug  text
)
RETURNS TABLE (
  company_id      uuid,
  company_name    text,
  company_logo_url text,
  status          text,
  ask_ambiance    boolean,
  ask_food        boolean,
  ask_return      boolean,
  intro_message   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id                                                            AS company_id,
    c.name                                                          AS company_name,
    c.logo_url                                                      AS company_logo_url,
    CASE
      WHEN rr.expires_at < now() THEN 'expired'
      ELSE rr.status
    END                                                             AS status,
    COALESCE(nc.ask_ambiance, true)                                 AS ask_ambiance,
    COALESCE(nc.ask_food,     true)                                 AS ask_food,
    COALESCE(nc.ask_return,   true)                                 AS ask_return,
    nc.intro_message                                                AS intro_message
  FROM public.reservation_reviews rr
  JOIN public.reservations res ON res.id = rr.reservation_id
  JOIN public.companies    c   ON c.id   = rr.company_id
  LEFT JOIN public.company_nps_configs nc ON nc.company_id = rr.company_id
  WHERE rr.review_token = lower(btrim(_token))
    AND c.slug          = lower(btrim(_slug))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_review_by_token(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_review_by_token(text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. RPC pública: submit_public_review
--    Valida token, expira lazy, rate-limit, grava respostas (idempotente).
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.submit_public_review(text, smallint, smallint, smallint, smallint, text, text);

CREATE OR REPLACE FUNCTION public.submit_public_review(
  _token           text,
  _ambiance_rating smallint DEFAULT NULL,
  _food_rating     smallint DEFAULT NULL,
  _return_score    smallint DEFAULT NULL,
  _recommend_score smallint DEFAULT NULL,
  _comment         text     DEFAULT NULL,
  _visitor_id      text     DEFAULT NULL
)
RETURNS TABLE (result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _review              public.reservation_reviews%ROWTYPE;
  _normalized_token    text    := lower(btrim(COALESCE(_token, '')));
  _normalized_visitor  text    := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _normalized_comment  text    := NULLIF(btrim(COALESCE(_comment, '')), '');
  _recent_count        integer := 0;
  _nps_category        text;
BEGIN
  IF _normalized_token = '' THEN
    RAISE EXCEPTION 'Token invalido';
  END IF;

  -- Rate-limit por visitor_id (5 tentativas por hora)
  IF _normalized_visitor IS NOT NULL THEN
    SELECT count(*) INTO _recent_count
    FROM public.public_rate_limits
    WHERE scope      = 'public_review_submit_visitor'
      AND identifier = _normalized_visitor
      AND created_at >= now() - interval '1 hour';

    IF _recent_count >= 5 THEN
      RAISE EXCEPTION 'Muitas tentativas. Tente novamente mais tarde.';
    END IF;
  END IF;

  -- Travar linha (FOR UPDATE evita race condition de duplo envio)
  SELECT * INTO _review
  FROM public.reservation_reviews
  WHERE review_token = _normalized_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Avaliacao nao encontrada';
  END IF;

  -- Já respondida — retorna sem regravar
  IF _review.status = 'submitted' THEN
    RETURN QUERY SELECT 'already_answered'::text;
    RETURN;
  END IF;

  -- Expiração lazy
  IF _review.expires_at < now() THEN
    UPDATE public.reservation_reviews
    SET status = 'expired', updated_at = now()
    WHERE id = _review.id;

    RAISE EXCEPTION 'Link de avaliacao expirado';
  END IF;

  -- Validações de escala
  IF _ambiance_rating IS NOT NULL AND (_ambiance_rating < 1 OR _ambiance_rating > 5) THEN
    RAISE EXCEPTION 'Nota de ambiente invalida (1-5)';
  END IF;
  IF _food_rating IS NOT NULL AND (_food_rating < 1 OR _food_rating > 5) THEN
    RAISE EXCEPTION 'Nota de comida invalida (1-5)';
  END IF;
  IF _return_score IS NOT NULL AND (_return_score < 0 OR _return_score > 10) THEN
    RAISE EXCEPTION 'Nota de retorno invalida (0-10)';
  END IF;
  IF _recommend_score IS NOT NULL AND (_recommend_score < 0 OR _recommend_score > 10) THEN
    RAISE EXCEPTION 'Nota NPS invalida (0-10)';
  END IF;

  -- Categoria NPS
  IF _recommend_score IS NOT NULL THEN
    _nps_category := CASE
      WHEN _recommend_score >= 9 THEN 'promoter'
      WHEN _recommend_score >= 7 THEN 'passive'
      ELSE 'detractor'
    END;
  END IF;

  -- Registrar rate-limit
  IF _normalized_visitor IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_review_submit_visitor', _review.company_id, _normalized_visitor);
  END IF;

  -- Gravar avaliação
  UPDATE public.reservation_reviews
  SET
    status               = 'submitted',
    ambiance_rating      = _ambiance_rating,
    food_rating          = _food_rating,
    return_score         = _return_score,
    recommend_score      = _recommend_score,
    nps_category         = _nps_category,
    comment              = _normalized_comment,
    submitted_at         = now(),
    submitted_visitor_id = _normalized_visitor,
    updated_at           = now()
  WHERE id = _review.id;

  RETURN QUERY SELECT 'submitted'::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_public_review(text, smallint, smallint, smallint, smallint, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_public_review(text, smallint, smallint, smallint, smallint, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. RPC interna: get_company_nps_summary
--    Agrega métricas NPS com breakdown de respondidos/pendentes/expirados.
--    Acessível apenas por usuários autenticados com acesso à empresa.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_company_nps_summary(uuid, date, date);

CREATE OR REPLACE FUNCTION public.get_company_nps_summary(
  _company_id uuid,
  _from       date,
  _to         date
)
RETURNS TABLE (
  total_invited   bigint,
  total_submitted bigint,
  total_pending   bigint,
  total_expired   bigint,
  response_rate   numeric,
  nps_score       integer,
  promoters       bigint,
  passives        bigint,
  detractors      bigint,
  avg_ambiance    numeric,
  avg_food        numeric,
  avg_return      numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    count(*)                                                                        AS total_invited,
    count(*) FILTER (WHERE status = 'submitted')                                    AS total_submitted,
    count(*) FILTER (WHERE status = 'pending' AND expires_at >= now())              AS total_pending,
    count(*) FILTER (
      WHERE status = 'expired'
         OR (status = 'pending' AND expires_at < now())
    )                                                                               AS total_expired,
    CASE
      WHEN count(*) > 0
      THEN round(
        count(*) FILTER (WHERE status = 'submitted')::numeric
        / count(*)::numeric * 100, 1
      )
      ELSE 0
    END                                                                             AS response_rate,
    CASE
      WHEN count(*) FILTER (WHERE status = 'submitted' AND nps_category IS NOT NULL) > 0
      THEN (
        (
          count(*) FILTER (WHERE nps_category = 'promoter')::numeric
          - count(*) FILTER (WHERE nps_category = 'detractor')::numeric
        )
        / count(*) FILTER (WHERE status = 'submitted' AND nps_category IS NOT NULL)::numeric
        * 100
      )::integer
      ELSE 0
    END                                                                             AS nps_score,
    count(*) FILTER (WHERE nps_category = 'promoter')                              AS promoters,
    count(*) FILTER (WHERE nps_category = 'passive')                               AS passives,
    count(*) FILTER (WHERE nps_category = 'detractor')                             AS detractors,
    round(avg(ambiance_rating) FILTER (WHERE status = 'submitted'), 1)             AS avg_ambiance,
    round(avg(food_rating)     FILTER (WHERE status = 'submitted'), 1)             AS avg_food,
    round(avg(return_score)    FILTER (WHERE status = 'submitted'), 1)             AS avg_return
  FROM public.reservation_reviews
  WHERE company_id = _company_id
    AND invited_at::date BETWEEN _from AND _to;
$$;

REVOKE ALL ON FUNCTION public.get_company_nps_summary(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_nps_summary(uuid, date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. Atualizar get_public_reservation_by_tracking_code
--    Adiciona review_token e review_status ao retorno para a página de acompanhamento.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_public_reservation_by_tracking_code(text);
DROP FUNCTION IF EXISTS public.get_public_reservation_by_tracking_code(text, text);

CREATE OR REPLACE FUNCTION public.get_public_reservation_by_tracking_code(
  _tracking_code text,
  _visitor_id    text DEFAULT NULL
)
RETURNS TABLE (
  id                   uuid,
  company_id           uuid,
  guest_name           text,
  date                 date,
  "time"               text,
  party_size           integer,
  status               text,
  occasion             text,
  notes                text,
  created_at           timestamptz,
  updated_at           timestamptz,
  public_tracking_code text,
  review_token         text,
  review_status        text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _entry              public.reservations%ROWTYPE;
  _normalized_code    text    := lower(btrim(COALESCE(_tracking_code, '')));
  _normalized_visitor text    := NULLIF(btrim(COALESCE(_visitor_id, '')), '');
  _recent_count       integer := 0;
  _review_token       text;
  _review_status      text;
BEGIN
  IF _normalized_code = '' THEN
    RAISE EXCEPTION 'Codigo de acompanhamento invalido.';
  END IF;

  -- Rate-limit: 60 consultas por dispositivo a cada 15 minutos
  IF _normalized_visitor IS NOT NULL THEN
    SELECT count(*)
    INTO _recent_count
    FROM public.public_rate_limits prl
    WHERE prl.scope      = 'public_reservation_lookup_visitor'
      AND prl.identifier = _normalized_visitor
      AND prl.created_at >= now() - interval '15 minutes';

    IF _recent_count >= 60 THEN
      RAISE EXCEPTION 'Muitas consultas deste dispositivo. Aguarde alguns minutos e tente novamente.';
    END IF;
  END IF;

  SELECT *
  INTO _entry
  FROM public.reservations r
  WHERE r.public_tracking_code = _normalized_code
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF _normalized_visitor IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_reservation_lookup_visitor', _entry.company_id, _normalized_visitor);
  END IF;

  -- Buscar token e status da avaliação (NULL se ainda não gerado)
  SELECT
    rr.review_token,
    CASE
      WHEN rr.expires_at < now() THEN 'expired'
      ELSE rr.status
    END
  INTO _review_token, _review_status
  FROM public.reservation_reviews rr
  WHERE rr.reservation_id = _entry.id
  LIMIT 1;

  RETURN QUERY
  SELECT
    _entry.id,
    _entry.company_id,
    _entry.guest_name,
    _entry.date,
    _entry.time::text,
    _entry.party_size,
    _entry.status,
    _entry.occasion,
    _entry.notes,
    _entry.created_at,
    _entry.updated_at,
    _entry.public_tracking_code,
    _review_token,
    _review_status;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_reservation_by_tracking_code(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_by_tracking_code(text, text) TO authenticated;
