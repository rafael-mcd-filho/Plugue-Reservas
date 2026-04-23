CREATE TABLE IF NOT EXISTS public.affiliate_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reference_name text NOT NULL,
  code text NOT NULL,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_links_reference_name_check CHECK (btrim(reference_name) <> ''),
  CONSTRAINT affiliate_links_code_check CHECK (btrim(code) = code AND code ~ '^[A-Za-z0-9-]{3,40}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_links_company_code_unique
  ON public.affiliate_links(company_id, lower(code));

CREATE INDEX IF NOT EXISTS idx_affiliate_links_company_created_at
  ON public.affiliate_links(company_id, created_at DESC);

ALTER TABLE public.affiliate_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company admins can view affiliate links" ON public.affiliate_links;
CREATE POLICY "Company admins can view affiliate links"
ON public.affiliate_links
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can create affiliate links" ON public.affiliate_links;
CREATE POLICY "Company admins can create affiliate links"
ON public.affiliate_links
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

DROP POLICY IF EXISTS "Company admins can update affiliate links" ON public.affiliate_links;
CREATE POLICY "Company admins can update affiliate links"
ON public.affiliate_links
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

CREATE OR REPLACE FUNCTION public.touch_affiliate_links_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_affiliate_links_updated_at ON public.affiliate_links;
CREATE TRIGGER trg_touch_affiliate_links_updated_at
BEFORE UPDATE ON public.affiliate_links
FOR EACH ROW
EXECUTE FUNCTION public.touch_affiliate_links_updated_at();

CREATE TABLE IF NOT EXISTS public.affiliate_link_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_link_id uuid NOT NULL REFERENCES public.affiliate_links(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  company_slug text NOT NULL,
  visitor_id text,
  page_url text,
  landing_path text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_link_visits_company_created_at
  ON public.affiliate_link_visits(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_link_visits_link_created_at
  ON public.affiliate_link_visits(affiliate_link_id, created_at DESC);

ALTER TABLE public.affiliate_link_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company admins can view affiliate visits" ON public.affiliate_link_visits;
CREATE POLICY "Company admins can view affiliate visits"
ON public.affiliate_link_visits
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS origin_affiliate_link_id uuid REFERENCES public.affiliate_links(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_affiliate_code text,
  ADD COLUMN IF NOT EXISTS origin_affiliate_name text;

CREATE INDEX IF NOT EXISTS idx_reservations_origin_affiliate_link
  ON public.reservations(origin_affiliate_link_id);

CREATE OR REPLACE FUNCTION public.apply_reservation_affiliate_origin_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _link record;
BEGIN
  IF NEW.origin_affiliate_link_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    al.id,
    al.company_id,
    al.reference_name,
    al.code
  INTO _link
  FROM public.affiliate_links al
  WHERE al.id = NEW.origin_affiliate_link_id;

  IF NOT FOUND OR _link.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'Link de filiado invalido para esta empresa.';
  END IF;

  NEW.origin_affiliate_code := COALESCE(NULLIF(btrim(COALESCE(NEW.origin_affiliate_code, '')), ''), _link.code);
  NEW.origin_affiliate_name := COALESCE(NULLIF(btrim(COALESCE(NEW.origin_affiliate_name, '')), ''), _link.reference_name);
  NEW.attribution_snapshot := COALESCE(NEW.attribution_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'affiliate_link_id', _link.id,
      'affiliate_code', NEW.origin_affiliate_code,
      'affiliate_name', NEW.origin_affiliate_name
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_reservation_affiliate_origin_defaults ON public.reservations;
CREATE TRIGGER trg_apply_reservation_affiliate_origin_defaults
BEFORE INSERT OR UPDATE OF company_id, origin_affiliate_link_id, origin_affiliate_code, origin_affiliate_name, attribution_snapshot
ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.apply_reservation_affiliate_origin_defaults();

CREATE OR REPLACE FUNCTION public.resolve_public_affiliate_link(
  _slug text,
  _code text,
  _visitor_id text DEFAULT NULL,
  _page_url text DEFAULT NULL,
  _path text DEFAULT NULL,
  _referrer text DEFAULT NULL,
  _utm_source text DEFAULT NULL,
  _utm_medium text DEFAULT NULL,
  _utm_campaign text DEFAULT NULL,
  _user_agent text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  company_name text,
  company_slug text,
  reference_name text,
  code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _resolved record;
BEGIN
  SELECT
    al.id,
    al.company_id,
    c.name AS company_name,
    c.slug AS company_slug,
    al.reference_name,
    al.code
  INTO _resolved
  FROM public.affiliate_links al
  JOIN public.companies c
    ON c.id = al.company_id
  WHERE c.slug = NULLIF(btrim(COALESCE(_slug, '')), '')
    AND lower(al.code) = lower(NULLIF(btrim(COALESCE(_code, '')), ''))
    AND c.status = 'active'
    AND al.is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.affiliate_link_visits (
    affiliate_link_id,
    company_id,
    company_slug,
    visitor_id,
    page_url,
    landing_path,
    referrer,
    utm_source,
    utm_medium,
    utm_campaign,
    user_agent
  )
  VALUES (
    _resolved.id,
    _resolved.company_id,
    _resolved.company_slug,
    NULLIF(btrim(COALESCE(_visitor_id, '')), ''),
    NULLIF(btrim(COALESCE(_page_url, '')), ''),
    NULLIF(btrim(COALESCE(_path, '')), ''),
    NULLIF(btrim(COALESCE(_referrer, '')), ''),
    NULLIF(btrim(COALESCE(_utm_source, '')), ''),
    NULLIF(btrim(COALESCE(_utm_medium, '')), ''),
    NULLIF(btrim(COALESCE(_utm_campaign, '')), ''),
    NULLIF(btrim(COALESCE(_user_agent, '')), '')
  );

  RETURN QUERY
  SELECT
    _resolved.id,
    _resolved.company_id,
    _resolved.company_name,
    _resolved.company_slug,
    _resolved.reference_name,
    _resolved.code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_public_affiliate_link(text, text, text, text, text, text, text, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_public_affiliate_link(text, text, text, text, text, text, text, text, text, text) TO authenticated;

DROP FUNCTION IF EXISTS public.get_affiliate_link_stats(uuid, timestamptz, timestamptz);

CREATE FUNCTION public.get_affiliate_link_stats(
  _company_id uuid,
  _start_at timestamptz DEFAULT NULL,
  _end_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  affiliate_link_id uuid,
  reference_name text,
  code text,
  notes text,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  visits bigint,
  reservations bigint,
  checked_in bigint,
  cancelled bigint,
  no_show bigint,
  conversion_rate numeric,
  last_visit_at timestamptz,
  last_reservation_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE public.has_role(auth.uid(), 'superadmin'::public.app_role)
      OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ),
  visit_stats AS (
    SELECT
      alv.affiliate_link_id,
      count(*)::bigint AS visits,
      max(alv.created_at) AS last_visit_at
    FROM public.affiliate_link_visits alv
    WHERE alv.company_id = _company_id
      AND (_start_at IS NULL OR alv.created_at >= _start_at)
      AND (_end_at IS NULL OR alv.created_at <= _end_at)
    GROUP BY alv.affiliate_link_id
  ),
  reservation_stats AS (
    SELECT
      r.origin_affiliate_link_id AS affiliate_link_id,
      count(*)::bigint AS reservations,
      count(*) FILTER (WHERE r.status IN ('checked_in', 'completed'))::bigint AS checked_in,
      count(*) FILTER (WHERE r.status = 'cancelled')::bigint AS cancelled,
      count(*) FILTER (WHERE r.status IN ('no-show', 'no_show'))::bigint AS no_show,
      max(r.created_at) AS last_reservation_at
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.origin_affiliate_link_id IS NOT NULL
      AND (_start_at IS NULL OR r.created_at >= _start_at)
      AND (_end_at IS NULL OR r.created_at <= _end_at)
    GROUP BY r.origin_affiliate_link_id
  )
  SELECT
    al.id AS affiliate_link_id,
    al.reference_name,
    al.code,
    al.notes,
    al.is_active,
    al.created_at,
    al.updated_at,
    COALESCE(vs.visits, 0) AS visits,
    COALESCE(rs.reservations, 0) AS reservations,
    COALESCE(rs.checked_in, 0) AS checked_in,
    COALESCE(rs.cancelled, 0) AS cancelled,
    COALESCE(rs.no_show, 0) AS no_show,
    CASE
      WHEN COALESCE(vs.visits, 0) = 0 THEN 0
      ELSE round((COALESCE(rs.reservations, 0)::numeric / vs.visits::numeric) * 100, 2)
    END AS conversion_rate,
    vs.last_visit_at,
    rs.last_reservation_at
  FROM public.affiliate_links al
  LEFT JOIN visit_stats vs
    ON vs.affiliate_link_id = al.id
  LEFT JOIN reservation_stats rs
    ON rs.affiliate_link_id = al.id
  WHERE al.company_id = _company_id
    AND EXISTS (SELECT 1 FROM has_access)
  ORDER BY al.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_affiliate_link_stats(uuid, timestamptz, timestamptz) TO authenticated;

DROP FUNCTION IF EXISTS public.get_affiliate_link_daily_stats(uuid, timestamptz, timestamptz, uuid);

CREATE FUNCTION public.get_affiliate_link_daily_stats(
  _company_id uuid,
  _start_at timestamptz DEFAULT NULL,
  _end_at timestamptz DEFAULT NULL,
  _affiliate_link_id uuid DEFAULT NULL
)
RETURNS TABLE (
  day date,
  affiliate_link_id uuid,
  reference_name text,
  code text,
  visits bigint,
  reservations bigint,
  checked_in bigint,
  cancelled bigint,
  no_show bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH has_access AS (
    SELECT 1
    WHERE public.has_role(auth.uid(), 'superadmin'::public.app_role)
      OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ),
  visit_daily AS (
    SELECT
      alv.affiliate_link_id,
      alv.created_at::date AS day,
      count(*)::bigint AS visits
    FROM public.affiliate_link_visits alv
    WHERE alv.company_id = _company_id
      AND (_affiliate_link_id IS NULL OR alv.affiliate_link_id = _affiliate_link_id)
      AND (_start_at IS NULL OR alv.created_at >= _start_at)
      AND (_end_at IS NULL OR alv.created_at <= _end_at)
    GROUP BY alv.affiliate_link_id, alv.created_at::date
  ),
  reservation_daily AS (
    SELECT
      r.origin_affiliate_link_id AS affiliate_link_id,
      r.created_at::date AS day,
      count(*)::bigint AS reservations,
      count(*) FILTER (WHERE r.status IN ('checked_in', 'completed'))::bigint AS checked_in,
      count(*) FILTER (WHERE r.status = 'cancelled')::bigint AS cancelled,
      count(*) FILTER (WHERE r.status IN ('no-show', 'no_show'))::bigint AS no_show
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.origin_affiliate_link_id IS NOT NULL
      AND (_affiliate_link_id IS NULL OR r.origin_affiliate_link_id = _affiliate_link_id)
      AND (_start_at IS NULL OR r.created_at >= _start_at)
      AND (_end_at IS NULL OR r.created_at <= _end_at)
    GROUP BY r.origin_affiliate_link_id, r.created_at::date
  ),
  keys AS (
    SELECT affiliate_link_id, day FROM visit_daily
    UNION
    SELECT affiliate_link_id, day FROM reservation_daily
  )
  SELECT
    k.day,
    al.id AS affiliate_link_id,
    al.reference_name,
    al.code,
    COALESCE(vd.visits, 0) AS visits,
    COALESCE(rd.reservations, 0) AS reservations,
    COALESCE(rd.checked_in, 0) AS checked_in,
    COALESCE(rd.cancelled, 0) AS cancelled,
    COALESCE(rd.no_show, 0) AS no_show
  FROM keys k
  JOIN public.affiliate_links al
    ON al.id = k.affiliate_link_id
  LEFT JOIN visit_daily vd
    ON vd.affiliate_link_id = k.affiliate_link_id
    AND vd.day = k.day
  LEFT JOIN reservation_daily rd
    ON rd.affiliate_link_id = k.affiliate_link_id
    AND rd.day = k.day
  WHERE al.company_id = _company_id
    AND EXISTS (SELECT 1 FROM has_access)
  ORDER BY k.day ASC, al.reference_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_affiliate_link_daily_stats(uuid, timestamptz, timestamptz, uuid) TO authenticated;
