-- OPS-06: page/filter the reservation list in PostgreSQL. The overview and the
-- separate full export keep their existing contracts. This function is an
-- invoker so reservation/payment RLS continues to apply to every returned row.
CREATE INDEX IF NOT EXISTS idx_reservations_history_company_order
  ON public.reservations(company_id, date DESC, time DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_reservations_history_company_created
  ON public.reservations(company_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.get_company_reservation_history(
  _company_id uuid,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 15,
  _search text DEFAULT '',
  _operational_filter text DEFAULT 'active',
  _status text DEFAULT 'all',
  _entry_method text DEFAULT 'all',
  _date_filter_mode text DEFAULT 'reservation',
  _start_date date DEFAULT NULL,
  _end_date date DEFAULT NULL,
  _created_start_at timestamptz DEFAULT NULL,
  _created_end_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  _query text := COALESCE(_search, '');
  _query_digits text := regexp_replace(COALESCE(_search, ''), '[^0-9]', '', 'g');
  _result jsonb;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id é obrigatório.' USING ERRCODE = '22023';
  END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
      OR public.has_company_panel_permission(auth.uid(), _company_id, 'reservations_view') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Sem permissão para consultar as reservas desta unidade.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF _page IS NULL OR _page < 1 OR _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'Página ou tamanho de página inválido.' USING ERRCODE = '22023';
  END IF;
  IF length(_query) > 200 THEN
    RAISE EXCEPTION 'A busca pode ter no máximo 200 caracteres.' USING ERRCODE = '22023';
  END IF;
  IF _operational_filter IS NULL OR _operational_filter NOT IN ('active', 'lost', 'all')
    OR _status IS NULL OR _status NOT IN ('all', 'confirmed', 'checked_in', 'cancelled', 'no-show', 'pending_payment', 'payment_expired', 'payment_cancelled', 'paid_after_expiration')
    OR _entry_method IS NULL OR _entry_method NOT IN ('all', 'online', 'affiliate', 'manual', 'waitlist')
    OR _date_filter_mode IS NULL OR _date_filter_mode NOT IN ('reservation', 'created') THEN
    RAISE EXCEPTION 'Filtro de reservas inválido.' USING ERRCODE = '22023';
  END IF;
  IF (_start_date IS NOT NULL AND _end_date IS NOT NULL AND _end_date < _start_date)
    OR (_created_start_at IS NOT NULL AND _created_end_at IS NOT NULL AND _created_end_at <= _created_start_at) THEN
    RAISE EXCEPTION 'Intervalo de datas inválido.' USING ERRCODE = '22023';
  END IF;

  -- All totals, the effective page and its rows come from one SQL snapshot.
  -- Materialize only narrow filtered keys; full JSON and payments are built
  -- after LIMIT, never for the entire company history.
  WITH scoped AS NOT MATERIALIZED (
    SELECT r.id, r.date, r.time, r.party_size, r.checked_in_party_size,
      CASE lower(btrim(COALESCE(r.status, '')))
        WHEN 'checked_in' THEN 'checked_in'
        WHEN 'completed' THEN 'checked_in'
        WHEN 'cancelled' THEN 'cancelled'
        WHEN 'no-show' THEN 'no-show'
        WHEN 'no_show' THEN 'no-show'
        WHEN 'pending_payment' THEN 'pending_payment'
        WHEN 'payment_expired' THEN 'payment_expired'
        WHEN 'payment_cancelled' THEN 'payment_cancelled'
        WHEN 'paid_after_expiration' THEN 'paid_after_expiration'
        ELSE 'confirmed'
      END AS normalized_status,
      CASE
        WHEN r.source = 'waitlist' THEN 'waitlist'
        WHEN NULLIF(btrim(r.origin_affiliate_link_id::text), '') IS NOT NULL THEN 'affiliate'
        WHEN NULLIF(btrim(r.origin_tracking_session_id::text), '') IS NOT NULL
          OR NULLIF(btrim(r.origin_anonymous_id::text), '') IS NOT NULL
          OR btrim(COALESCE(r.attribution_snapshot ->> 'tracking_source', '')) = 'public_web' THEN 'online'
        ELSE 'manual'
      END AS entry_method
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND (_date_filter_mode <> 'reservation' OR (
        (_start_date IS NULL OR r.date >= _start_date)
        AND (_start_date IS NULL OR _end_date IS NULL OR r.date <= _end_date)
      ))
      AND (_date_filter_mode <> 'created' OR (
        (_created_start_at IS NULL OR r.created_at >= _created_start_at)
        AND (_created_start_at IS NULL OR _created_end_at IS NULL OR r.created_at < _created_end_at)
      ))
      AND (_query = ''
        OR strpos(lower(COALESCE(r.guest_name, '')), lower(_query)) > 0
        OR strpos(COALESCE(r.guest_phone_e164, r.guest_phone, ''), _query) > 0
        OR (_query_digits <> '' AND strpos(regexp_replace(COALESCE(r.guest_phone_e164, r.guest_phone, ''), '[^0-9]', '', 'g'), _query_digits) > 0)
      )
  ), filtered AS MATERIALIZED (
    SELECT id, date, time, normalized_status,
      CASE WHEN normalized_status = 'checked_in' THEN COALESCE(checked_in_party_size, party_size) ELSE party_size END AS people
    FROM scoped
    WHERE (_status = 'all' OR normalized_status = _status)
      AND (_entry_method = 'all' OR entry_method = _entry_method)
      AND (_operational_filter = 'all'
        OR (_operational_filter = 'active' AND normalized_status IN ('confirmed', 'checked_in'))
        OR (_operational_filter = 'lost' AND normalized_status IN ('cancelled', 'no-show', 'payment_expired', 'payment_cancelled', 'paid_after_expiration')))
  ), totals AS (
    SELECT count(*) AS total, COALESCE(sum(people), 0) AS total_people FROM filtered
  ), page_scope AS (
    SELECT total, total_people,
      LEAST(_page::bigint, GREATEST(1::bigint, (total + _page_size - 1) / _page_size))::integer AS page
    FROM totals
  ), paged AS (
    SELECT f.* FROM filtered f
    ORDER BY f.date DESC, f.time DESC, f.id DESC
    LIMIT _page_size OFFSET (SELECT (page::bigint - 1) * _page_size FROM page_scope)
  ), status_totals AS (
    SELECT normalized_status AS status, count(*) AS count, COALESCE(sum(people), 0) AS people
    FROM filtered GROUP BY normalized_status
  ), page_rows AS (
    SELECT p.date, p.time, p.id,
      to_jsonb(r) || jsonb_build_object(
        'status', p.normalized_status,
        'guest_phone', COALESCE(r.guest_phone_e164, r.guest_phone),
        'reservation_payments', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', rp.id, 'status', rp.status, 'paid_at', rp.paid_at,
            'billing_type', rp.billing_type, 'charged_amount', rp.charged_amount, 'base_amount', rp.base_amount
          ) ORDER BY rp.id)
          FROM public.reservation_payments rp
          WHERE rp.company_id = _company_id AND rp.reservation_id = r.id
        ), '[]'::jsonb)
      ) AS row
    FROM paged p JOIN public.reservations r ON r.id = p.id AND r.company_id = _company_id
  )
  SELECT jsonb_build_object(
    'company_id', _company_id,
    'rows', COALESCE((SELECT jsonb_agg(pr.row ORDER BY pr.date DESC, pr.time DESC, pr.id DESC) FROM page_rows pr), '[]'::jsonb),
    'total', ps.total, 'total_people', ps.total_people,
    'by_status', COALESCE((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.status) FROM status_totals st), '[]'::jsonb),
    'page', ps.page, 'page_size', _page_size
  ) INTO _result FROM page_scope ps;
  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_company_reservation_history(uuid, integer, integer, text, text, text, text, text, date, date, timestamptz, timestamptz)
IS 'OPS-06: filtered reservation-list page and full-filter totals in one snapshot, preserving caller RLS.';

REVOKE ALL ON FUNCTION public.get_company_reservation_history(uuid, integer, integer, text, text, text, text, text, date, date, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_company_reservation_history(uuid, integer, integer, text, text, text, text, text, date, date, timestamptz, timestamptz) TO authenticated, service_role;
