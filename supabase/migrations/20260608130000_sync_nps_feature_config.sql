-- Keep the commercial NPS feature flag and the operational NPS config in sync.
-- The feature flag controls menu/route access; company_nps_configs.enabled controls
-- review generation from reservation status changes.

ALTER TABLE public.company_nps_configs
ADD COLUMN IF NOT EXISTS google_review_url text;

ALTER TABLE public.company_nps_configs
ADD COLUMN IF NOT EXISTS ask_service boolean NOT NULL DEFAULT true;

ALTER TABLE public.reservation_reviews
ADD COLUMN IF NOT EXISTS service_rating smallint CHECK (service_rating BETWEEN 1 AND 5);

CREATE OR REPLACE FUNCTION public.company_feature_enabled(
  _company_id uuid,
  _feature_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company_plan AS (
    SELECT COALESCE(c.plan_tier, 'enterprise') AS plan_tier
    FROM public.companies c
    WHERE c.id = _company_id
  ),
  override_value AS (
    SELECT cfo.enabled
    FROM public.company_feature_overrides cfo
    WHERE cfo.company_id = _company_id
      AND cfo.feature_key = _feature_key
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT enabled FROM override_value),
    CASE
      WHEN _feature_key IN ('reservation_prepayment', 'nps_surveys') THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'starter' THEN false
      WHEN (SELECT plan_tier FROM company_plan) = 'pro' THEN
        _feature_key IN ('whatsapp_integration', 'custom_public_page', 'active_communication', 'flow_protection')
      WHEN (SELECT plan_tier FROM company_plan) = 'enterprise' THEN
        _feature_key IN ('whatsapp_integration', 'custom_public_page', 'advanced_reports', 'active_communication', 'flow_protection')
      ELSE false
    END
  );
$$;

CREATE OR REPLACE FUNCTION public.get_company_feature_flags(_company_id uuid)
RETURNS TABLE (
  feature_key text,
  enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE public.has_role(auth.uid(), 'superadmin')
      OR EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND ur.company_id = _company_id
      )
  )
  SELECT feature_key, public.company_feature_enabled(_company_id, feature_key) AS enabled
  FROM unnest(ARRAY[
    'whatsapp_integration',
    'custom_public_page',
    'advanced_reports',
    'active_communication',
    'flow_protection',
    'reservation_prepayment',
    'nps_surveys'
  ]) AS feature_key
  WHERE EXISTS (SELECT 1 FROM has_access);
$$;

DROP FUNCTION IF EXISTS public.set_company_nps_enabled(uuid, boolean);

CREATE OR REPLACE FUNCTION public.set_company_nps_enabled(
  _company_id uuid,
  _enabled boolean
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  feature_key text,
  enabled boolean,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _override public.company_feature_overrides%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(), 'superadmin') THEN
    RAISE EXCEPTION 'Sem permissao para alterar a feature de NPS.';
  END IF;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa invalida.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = _company_id) THEN
    RAISE EXCEPTION 'Empresa nao encontrada.';
  END IF;

  INSERT INTO public.company_feature_overrides (
    company_id,
    feature_key,
    enabled,
    updated_at
  )
  VALUES (
    _company_id,
    'nps_surveys',
    COALESCE(_enabled, false),
    now()
  )
  ON CONFLICT (company_id, feature_key)
  DO UPDATE SET
    enabled = EXCLUDED.enabled,
    updated_at = now()
  RETURNING * INTO _override;

  INSERT INTO public.company_nps_configs (
    company_id,
    enabled,
    updated_at
  )
  VALUES (
    _company_id,
    COALESCE(_enabled, false),
    now()
  )
  ON CONFLICT (company_id)
  DO UPDATE SET
    enabled = EXCLUDED.enabled,
    updated_at = now();

  RETURN QUERY
  SELECT
    _override.id,
    _override.company_id,
    _override.feature_key,
    _override.enabled,
    _override.created_at,
    _override.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_company_nps_enabled(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_company_nps_enabled(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_feature_flags(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_feature_enabled(uuid, text) TO authenticated;

DROP FUNCTION IF EXISTS public.get_public_review_by_token(text, text);

CREATE OR REPLACE FUNCTION public.get_public_review_by_token(
  _token text,
  _slug  text
)
RETURNS TABLE (
  company_id        uuid,
  company_name      text,
  company_logo_url  text,
  status            text,
  ask_ambiance      boolean,
  ask_food          boolean,
  ask_service       boolean,
  ask_return        boolean,
  intro_message     text,
  google_review_url text
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
    COALESCE(nc.ask_service,  true)                                 AS ask_service,
    COALESCE(nc.ask_return,   true)                                 AS ask_return,
    nc.intro_message                                                AS intro_message,
    nc.google_review_url                                            AS google_review_url
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

DROP FUNCTION IF EXISTS public.submit_public_review(text, smallint, smallint, smallint, smallint, text, text);
DROP FUNCTION IF EXISTS public.submit_public_review(text, smallint, smallint, smallint, smallint, smallint, text, text);

CREATE OR REPLACE FUNCTION public.submit_public_review(
  _token           text,
  _ambiance_rating smallint DEFAULT NULL,
  _food_rating     smallint DEFAULT NULL,
  _service_rating  smallint DEFAULT NULL,
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

  SELECT * INTO _review
  FROM public.reservation_reviews
  WHERE review_token = _normalized_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Avaliacao nao encontrada';
  END IF;

  IF _review.status = 'submitted' THEN
    RETURN QUERY SELECT 'already_answered'::text;
    RETURN;
  END IF;

  IF _review.expires_at < now() THEN
    UPDATE public.reservation_reviews
    SET status = 'expired', updated_at = now()
    WHERE id = _review.id;

    RAISE EXCEPTION 'Link de avaliacao expirado';
  END IF;

  IF _ambiance_rating IS NOT NULL AND (_ambiance_rating < 1 OR _ambiance_rating > 5) THEN
    RAISE EXCEPTION 'Nota de ambiente invalida (1-5)';
  END IF;
  IF _food_rating IS NOT NULL AND (_food_rating < 1 OR _food_rating > 5) THEN
    RAISE EXCEPTION 'Nota de comida invalida (1-5)';
  END IF;
  IF _service_rating IS NOT NULL AND (_service_rating < 1 OR _service_rating > 5) THEN
    RAISE EXCEPTION 'Nota de atendimento invalida (1-5)';
  END IF;
  IF _return_score IS NOT NULL AND (_return_score < 0 OR _return_score > 10) THEN
    RAISE EXCEPTION 'Nota de retorno invalida (0-10)';
  END IF;
  IF _recommend_score IS NOT NULL AND (_recommend_score < 0 OR _recommend_score > 10) THEN
    RAISE EXCEPTION 'Nota NPS invalida (0-10)';
  END IF;

  IF _recommend_score IS NOT NULL THEN
    _nps_category := CASE
      WHEN _recommend_score >= 9 THEN 'promoter'
      WHEN _recommend_score >= 7 THEN 'passive'
      ELSE 'detractor'
    END;
  END IF;

  IF _normalized_visitor IS NOT NULL THEN
    INSERT INTO public.public_rate_limits (scope, company_id, identifier)
    VALUES ('public_review_submit_visitor', _review.company_id, _normalized_visitor);
  END IF;

  UPDATE public.reservation_reviews
  SET
    status               = 'submitted',
    ambiance_rating      = _ambiance_rating,
    food_rating          = _food_rating,
    service_rating       = _service_rating,
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

GRANT EXECUTE ON FUNCTION public.submit_public_review(text, smallint, smallint, smallint, smallint, smallint, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_public_review(text, smallint, smallint, smallint, smallint, smallint, text, text) TO authenticated;

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
  avg_service     numeric,
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
    round(avg(service_rating)  FILTER (WHERE status = 'submitted'), 1)             AS avg_service,
    round(avg(return_score)    FILTER (WHERE status = 'submitted'), 1)             AS avg_return
  FROM public.reservation_reviews
  WHERE company_id = _company_id
    AND invited_at::date BETWEEN _from AND _to;
$$;

REVOKE ALL ON FUNCTION public.get_company_nps_summary(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_nps_summary(uuid, date, date) TO authenticated;

INSERT INTO public.company_nps_configs (
  company_id,
  enabled,
  updated_at
)
SELECT
  cfo.company_id,
  cfo.enabled,
  now()
FROM public.company_feature_overrides cfo
WHERE cfo.feature_key = 'nps_surveys'
ON CONFLICT (company_id)
DO UPDATE SET
  enabled = EXCLUDED.enabled,
  updated_at = now();
