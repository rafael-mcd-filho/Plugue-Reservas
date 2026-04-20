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
  party_size_total bigint,
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
      COALESCE(sum(COALESCE(r.party_size, 0)), 0)::bigint AS party_size_total,
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
    COALESCE(rs.party_size_total, 0) AS party_size_total,
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
  party_size_total bigint,
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
      COALESCE(sum(COALESCE(r.party_size, 0)), 0)::bigint AS party_size_total,
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
    COALESCE(rd.party_size_total, 0) AS party_size_total,
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
