-- CRM-02: extend the existing canonical customer profile without changing
-- reservation details, write flows, or the meaning of a completed presence.
CREATE INDEX IF NOT EXISTS idx_crm_relationship_payments
  ON public.reservation_payments(company_id, reservation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_crm_relationship_evolution_recipient
  ON public.whatsapp_message_logs(company_id,
    (public.phone_customer_identity_digits(NULL, phone, 'BR')), created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_crm_relationship_pluguechat_recipient
  ON public.pluguechat_message_logs(company_id,
    (public.phone_customer_identity_digits(NULL, phone, 'BR')), created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public._get_crm_relationship_reservations(_company_id uuid, _customer_key text)
RETURNS TABLE (
  id uuid, date date, "time" time, party_size integer, checked_in_party_size integer,
  status text, source text, occasion text, relationship_role text, holder_name text, is_upcoming boolean
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH contacts AS MATERIALIZED (
    SELECT DISTINCT ON (c.visit_id) c.visit_id, c.role_kind
    FROM public._get_crm_contact_records(_company_id) c
    WHERE c.company_id = _company_id AND c.customer_key = _customer_key AND c.visit_origin = 'reservation'
    ORDER BY c.visit_id, CASE c.role_kind WHEN 'holder' THEN 0 ELSE 1 END, c.contact_record_key
  ), normalized AS (
    SELECT r.id, r.date, r.time, r.party_size, r.checked_in_party_size,
      CASE
        WHEN lower(btrim(r.status)) IN ('checked_in','completed') THEN 'checked_in'
        WHEN lower(btrim(r.status)) IN ('no_show','no-show') THEN 'no-show'
        WHEN lower(btrim(r.status)) IN ('pending_payment','cancelled','payment_expired','payment_cancelled','paid_after_expiration') THEN lower(btrim(r.status))
        ELSE 'confirmed'
      END AS status,
      r.source, r.occasion, c.role_kind AS relationship_role, r.guest_name AS holder_name
    FROM contacts c JOIN public.reservations r ON r.id = c.visit_id AND r.company_id = _company_id
  )
  SELECT n.*, n.status IN ('confirmed','pending_payment')
    AND (n.date + n.time) AT TIME ZONE public._company_report_time_zone(_company_id) >= now() AS is_upcoming
  FROM normalized n;
$$;

REVOKE ALL ON FUNCTION public._get_crm_relationship_reservations(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._get_crm_relationship_reservations(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_company_crm_relationship(
  _company_id uuid, _customer_key text, _section text DEFAULT 'summary',
  _page integer DEFAULT 1, _page_size integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _key text;
  _can_reservations boolean;
  _can_payments boolean;
  _can_messages boolean;
  _service boolean := auth.role() = 'service_role';
  _summary jsonb;
  _rows jsonb := '[]'::jsonb;
  _total bigint := 0;
  _effective_page integer := 1;
  _phone text;
BEGIN
  -- Permission helpers resolve support impersonation and its exact company
  -- scope. Authorize before inspecting any caller-controlled customer identity.
  IF NOT COALESCE(_service, false) THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;
    IF public.has_company_panel_permission(auth.uid(), _company_id, 'leads_view') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Sem permissao para visualizar clientes.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF _company_id IS NULL OR NULLIF(btrim(_customer_key), '') IS NULL OR char_length(_customer_key) > 500 THEN
    RAISE EXCEPTION 'Cliente invalido.' USING ERRCODE = '22023';
  END IF;
  IF _section IS NULL OR _section NOT IN ('summary','reservations','payments','messages')
    OR _page IS NULL OR _page < 1 OR _page > 1000000 OR _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'Parametros de consulta invalidos.' USING ERRCODE = '22023';
  END IF;

  _key := public.canonical_crm_customer_key(_customer_key);
  IF NOT EXISTS (SELECT 1 FROM public._get_crm_lead_profiles(_company_id) p WHERE p.customer_key = _key) THEN
    RAISE EXCEPTION 'Cliente nao encontrado nesta unidade.' USING ERRCODE = 'P0002';
  END IF;

  _can_reservations := COALESCE(_service, false) OR COALESCE(public.has_company_panel_permission(auth.uid(), _company_id, 'reservations_view'),false);
  _can_payments := _can_reservations AND (COALESCE(_service, false)
    OR COALESCE(public.has_role(auth.uid(), 'superadmin'),false) OR COALESCE(public.has_role_in_company(auth.uid(), 'admin', _company_id),false));
  _can_messages := COALESCE(_service, false) OR COALESCE(public.has_company_panel_permission(auth.uid(), _company_id, 'automations_view'),false);
  IF (_section = 'reservations' AND NOT _can_reservations)
    OR (_section = 'payments' AND NOT _can_payments) OR (_section = 'messages' AND NOT _can_messages) THEN
    RAISE EXCEPTION 'Sem permissao para esta parte do perfil.' USING ERRCODE = '42501';
  END IF;

  IF _can_reservations THEN
    SELECT jsonb_build_object(
      'upcoming_count', count(*) FILTER (WHERE r.is_upcoming),
      'reservation_count', count(*),
      'cancelled_count', count(*) FILTER (WHERE r.status = 'cancelled'),
      'no_show_count', count(*) FILTER (WHERE r.status = 'no-show')
    ) INTO _summary FROM public._get_crm_relationship_reservations(_company_id, _key) r;
  ELSE
    _summary := jsonb_build_object('upcoming_count',NULL,'reservation_count',NULL,'cancelled_count',NULL,'no_show_count',NULL);
  END IF;

  IF _section = 'reservations' THEN
    WITH all_rows AS MATERIALIZED (
      SELECT r.* FROM public._get_crm_relationship_reservations(_company_id, _key) r
    ), totals AS (SELECT count(*) AS total FROM all_rows), bounds AS (
      SELECT total, least(_page, greatest(1, ceil(total::numeric / _page_size)::integer)) AS page FROM totals
    ), paged AS (
      SELECT a.* FROM all_rows a
      ORDER BY a.is_upcoming DESC,
        CASE WHEN a.is_upcoming THEN a.date END ASC, CASE WHEN a.is_upcoming THEN a.time END ASC,
        a.date DESC, a.time DESC, a.id DESC
      LIMIT _page_size OFFSET (SELECT (page-1)*_page_size FROM bounds)
    )
    SELECT b.total,b.page,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.is_upcoming DESC,
      CASE WHEN p.is_upcoming THEN p.date END ASC, CASE WHEN p.is_upcoming THEN p.time END ASC,
      p.date DESC,p.time DESC,p.id DESC) FROM paged p),'[]'::jsonb)
    INTO _total,_effective_page,_rows FROM bounds b;
  ELSIF _section = 'payments' THEN
    -- A companion's participation is not their payment or personal spend.
    WITH holder_reservations AS MATERIALIZED (
      SELECT r.id,r.date,r.time FROM public._get_crm_relationship_reservations(_company_id, _key) r
      WHERE r.relationship_role = 'holder'
    ), all_rows AS MATERIALIZED (
      SELECT p.id,p.reservation_id,r.date AS reservation_date,r.time AS reservation_time,
        p.status,p.billing_type,p.base_amount,p.charged_amount,p.paid_at,p.created_at,
        NULL::timestamptz AS refunded_at
      FROM holder_reservations r JOIN public.reservation_payments p ON p.reservation_id=r.id AND p.company_id=_company_id
    ), totals AS (SELECT count(*) AS total FROM all_rows), bounds AS (
      SELECT total,least(_page,greatest(1,ceil(total::numeric/_page_size)::integer)) AS page FROM totals
    ), paged AS (
      SELECT a.* FROM all_rows a ORDER BY a.created_at DESC,a.id DESC
      LIMIT _page_size OFFSET (SELECT (page-1)*_page_size FROM bounds)
    )
    SELECT b.total,b.page,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC,p.id DESC) FROM paged p),'[]'::jsonb)
    INTO _total,_effective_page,_rows FROM bounds b;
  ELSIF _section = 'messages' THEN
    -- Match the canonical recipient, never the name, phone suffix, or another
    -- guest's messages merely because they accompanied the same reservation.
    _phone := CASE WHEN _key LIKE 'phone:%' THEN substring(_key FROM 7) ELSE NULL END;
    WITH all_rows AS MATERIALIZED (
      SELECT 'evolution:'||l.id AS id,'evolution'::text AS channel,l.type,l.status,l.created_at,
        l.reservation_id,'log'::text AS record_source,NULL::text AS provider_status,
        left(l.message,240) AS message_preview,NULL::text AS template_name
      FROM public.whatsapp_message_logs l
      WHERE l.company_id=_company_id AND _phone IS NOT NULL
        AND public.phone_customer_identity_digits(NULL,l.phone,'BR')=_phone
      UNION ALL
      SELECT 'pluguechat:'||l.id,'pluguechat_official',l.type,l.status,l.created_at,
        l.reservation_id,'log',l.provider_status,NULL::text,l.template_name
      FROM public.pluguechat_message_logs l
      WHERE l.company_id=_company_id AND _phone IS NOT NULL
        AND public.phone_customer_identity_digits(NULL,l.phone,'BR')=_phone
    ), totals AS (SELECT count(*) AS total FROM all_rows), bounds AS (
      SELECT total,least(_page,greatest(1,ceil(total::numeric/_page_size)::integer)) AS page FROM totals
    ), paged AS (
      SELECT a.* FROM all_rows a ORDER BY a.created_at DESC,a.id DESC
      LIMIT _page_size OFFSET (SELECT (page-1)*_page_size FROM bounds)
    )
    SELECT b.total,b.page,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC,p.id DESC) FROM paged p),'[]'::jsonb)
    INTO _total,_effective_page,_rows FROM bounds b;
  END IF;

  RETURN jsonb_build_object('company_id',_company_id,'customer_key',_customer_key,'canonical_customer_key',_key,
    'section',_section,'page',_effective_page,'page_size',_page_size,'total',_total,'rows',_rows,
    'capabilities',jsonb_build_object('reservations',_can_reservations,'payments',_can_payments,'messages',_can_messages),
    'summary',_summary,'generated_at',now());
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_crm_relationship(uuid,text,text,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_company_crm_relationship(uuid,text,text,integer,integer) TO authenticated,service_role;
