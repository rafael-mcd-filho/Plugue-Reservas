-- OPS-01: one authorized, day-scoped read for the operational Salon.
-- Read-only. The waitlist seating flow already creates a canonical reservation;
-- never append seated waitlist rows as a second occupancy source.
CREATE INDEX IF NOT EXISTS idx_service_salon_reservations_company_date
  ON public.reservations(company_id, date, time, id);
CREATE INDEX IF NOT EXISTS idx_service_salon_planned_end
  ON public.reservations(company_id, ((date+time)+make_interval(mins=>GREATEST(duration_minutes,1))))
  WHERE duration_minutes IS NOT NULL AND duration_minutes<>0;
CREATE INDEX IF NOT EXISTS idx_service_salon_arrival_end
  ON public.reservations(company_id, ((checked_in_at AT TIME ZONE 'UTC')+make_interval(mins=>GREATEST(duration_minutes,1))))
  WHERE duration_minutes IS NOT NULL AND duration_minutes<>0 AND checked_in_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_salon_arrival
  ON public.reservations(company_id,checked_in_at) WHERE checked_in_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_company_service_salon(
  _company_id uuid,
  _date date,
  _reference_time time DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _zone text;
  _time time;
  _reference_at timestamptz;
  _map_id uuid;
  _map_name text;
  _has_maps boolean;
  _mode text;
  _tables jsonb;
  _reservations jsonb;
  _legacy_days integer;
  _day_start_utc timestamp;
  _day_end_at timestamptz;
BEGIN
  -- These helpers honor effective support identity and the exact company scope.
  -- Both grants are required; access to table configuration alone must never
  -- disclose the guests attached to a table.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
      OR public.has_company_panel_permission(auth.uid(), _company_id, 'tables_view') IS DISTINCT FROM true
      OR public.has_company_panel_permission(auth.uid(), _company_id, 'reservations_view') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Sem permissao para consultar o salao desta unidade.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF _company_id IS NULL OR _date IS NULL THEN
    RAISE EXCEPTION 'Unidade e data sao obrigatorias.' USING ERRCODE = '22023';
  END IF;

  _zone := public._company_report_time_zone(_company_id);
  _time := COALESCE(_reference_time,
    CASE WHEN _date = (now() AT TIME ZONE _zone)::date
      THEN (now() AT TIME ZONE _zone)::time ELSE time '18:00' END);
  _reference_at := (_date + _time) AT TIME ZONE _zone;
  _day_start_utc := (_date::timestamp AT TIME ZONE _zone) AT TIME ZONE 'UTC';
  _day_end_at := (_date+1)::timestamp AT TIME ZONE _zone;
  -- Rule/block/slot durations have canonical CHECK constraints <=1440. The
  -- company fallback is not capped, so derive the legacy lookback from it.
  SELECT ceil(GREATEST(COALESCE(c.reservation_duration,30),1440)::numeric/1440)::integer+1
    INTO _legacy_days FROM public.companies c WHERE c.id=_company_id;
  SELECT m.id,m.name INTO _map_id,_map_name
  FROM public.get_active_table_map(_company_id,_reference_at) m
  WHERE m.is_enabled LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM public.table_maps m WHERE m.company_id=_company_id) INTO _has_maps;
  SELECT s.availability_mode INTO _mode FROM public.get_public_reservation_schedule(_company_id,_date) s LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',t.id,'number',t.number,'capacity',t.capacity,'section',t.section,'status',t.status
  ) ORDER BY COALESCE(t.section,''),t.number,t.id),'[]'::jsonb)
  INTO _tables FROM public.restaurant_tables t
  WHERE t.company_id=_company_id
    AND ((_map_id IS NOT NULL AND t.table_map_id=_map_id) OR (NOT _has_maps AND t.table_map_id IS NULL));

  -- Include the complete selected day and any earlier reservation whose
  -- recorded duration overlaps that day (including midnight carryovers).
  -- The result is not truncated by PostgREST's row limit. It contains only the
  -- operational fields needed here: no contacts, notes, payment amounts or keys.
  WITH candidate_ids AS MATERIALIZED (
    SELECT r.id FROM public.reservations r WHERE r.company_id=_company_id AND r.date=_date
    UNION
    SELECT r.id FROM public.reservations r
    WHERE r.company_id=_company_id AND r.date<_date AND r.duration_minutes IS NOT NULL AND r.duration_minutes<>0
      AND (r.date+r.time)+make_interval(mins=>GREATEST(r.duration_minutes,1))>_date::timestamp
    UNION
    SELECT r.id FROM public.reservations r
    WHERE r.company_id=_company_id AND r.duration_minutes IS NOT NULL AND r.duration_minutes<>0
      AND r.checked_in_at IS NOT NULL AND r.checked_in_at<_day_end_at
      -- UTC index prefilter is deliberately wider than the exact local-time
      -- comparison below, accommodating offset/DST changes without truncating
      -- stored multi-day durations or calling a resolver across old history.
      AND (r.checked_in_at AT TIME ZONE 'UTC')+make_interval(mins=>GREATEST(r.duration_minutes,1))>_day_start_utc-interval '2 days'
    UNION
    SELECT r.id FROM public.reservations r
    WHERE r.company_id=_company_id AND (r.duration_minutes IS NULL OR r.duration_minutes=0)
      AND r.date BETWEEN _date-_legacy_days AND _date
    UNION
    SELECT r.id FROM public.reservations r
    WHERE r.company_id=_company_id AND (r.duration_minutes IS NULL OR r.duration_minutes=0)
      AND r.checked_in_at>=((_date-_legacy_days)::timestamp AT TIME ZONE _zone)-interval '2 days'
      AND r.checked_in_at<_day_end_at
  ), candidates AS NOT MATERIALIZED (
    SELECT r.*,
      CASE lower(btrim(COALESCE(r.status,'')))
        WHEN 'completed' THEN 'checked_in' WHEN 'checked_in' THEN 'checked_in'
        WHEN 'pending_payment' THEN 'pending_payment' ELSE 'confirmed'
      END AS normalized_status,
      GREATEST(COALESCE(NULLIF(r.duration_minutes,0),
        public.resolve_reservation_slot_duration(_company_id,r.date,r.time),30),1) AS effective_duration
    FROM candidate_ids ids JOIN public.reservations r ON r.id=ids.id AND r.company_id=_company_id
    WHERE lower(btrim(COALESCE(r.status,''))) NOT IN
        ('cancelled','no_show','no-show','payment_expired','payment_cancelled','paid_after_expiration')
  ), scoped AS MATERIALIZED (
    SELECT c.* FROM candidates c
    WHERE c.date=_date OR (
      least(c.date+c.time,CASE WHEN c.normalized_status='checked_in' THEN
        COALESCE(c.checked_in_at AT TIME ZONE _zone,c.date+c.time) ELSE c.date+c.time END)<(_date+1)::timestamp
      AND greatest(c.date+c.time+make_interval(mins=>c.effective_duration),
        CASE WHEN c.normalized_status='checked_in' THEN COALESCE(c.checked_in_at AT TIME ZONE _zone,c.date+c.time)
          +make_interval(mins=>c.effective_duration) ELSE c.date+c.time+make_interval(mins=>c.effective_duration) END)>_date::timestamp)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',r.id,'guest_name',r.guest_name,'date',r.date,'time',r.time,
    'party_size',r.party_size,'checked_in_party_size',r.checked_in_party_size,
    'status',r.normalized_status,'checked_in_at',r.checked_in_at,
    'duration_minutes',r.effective_duration,'source',r.source,
    'origin_waitlist_id',r.origin_waitlist_id,'created_in_mode',r.created_in_mode,
    'table_ids',COALESCE((SELECT jsonb_agg(ids.table_id ORDER BY ids.table_id) FROM (
      SELECT a.table_id FROM public.reservation_table_assignments a
      JOIN public.restaurant_tables t ON t.id=a.table_id AND t.company_id=_company_id
      WHERE a.reservation_id=r.id
      UNION
      SELECT t.id FROM public.restaurant_tables t
      WHERE t.id=r.table_id AND t.company_id=_company_id
    ) ids),'[]'::jsonb),
    'payment_hold_active',CASE WHEN r.normalized_status<>'pending_payment' THEN true ELSE
      EXISTS(SELECT 1 FROM public.reservation_payments p
        WHERE p.company_id=_company_id AND p.reservation_id=r.id
          AND p.status IN ('awaiting_method','pending') AND (p.expires_at IS NULL OR p.expires_at>now()))
      OR (r.created_at>=now()-interval '2 minutes' AND NOT EXISTS(
        SELECT 1 FROM public.reservation_payments p WHERE p.company_id=_company_id AND p.reservation_id=r.id)) END
  ) ORDER BY r.date,r.time,r.id),'[]'::jsonb)
  INTO _reservations FROM scoped r;

  RETURN jsonb_build_object('company_id',_company_id,'date',_date,'time_zone',_zone,
    'reference_time',_time,'reference_at',_reference_at,'generated_at',now(),
    'availability_mode',COALESCE(_mode,'tables'),
    'map',CASE WHEN _map_id IS NULL THEN NULL ELSE jsonb_build_object('id',_map_id,'name',_map_name) END,
    'tables',_tables,'reservations',_reservations);
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_service_salon(uuid,date,time) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_company_service_salon(uuid,date,time) TO authenticated,service_role;

-- The existing reservation SELECT policy is membership-based. Recheck the
-- Salon's two permissions when opening its full detail, even if a previously
-- authorized day snapshot is still visible in the browser cache.
CREATE OR REPLACE FUNCTION public.get_company_service_salon_reservation(_company_id uuid,_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _row jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
      OR public.has_company_panel_permission(auth.uid(),_company_id,'tables_view') IS DISTINCT FROM true
      OR public.has_company_panel_permission(auth.uid(),_company_id,'reservations_view') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Sem permissao para consultar o salao desta unidade.' USING ERRCODE='42501';
    END IF;
  END IF;
  IF _company_id IS NULL OR _reservation_id IS NULL THEN
    RAISE EXCEPTION 'Unidade e reserva sao obrigatorias.' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object('id',r.id,'company_id',r.company_id,
    'table_id',(SELECT t.id FROM public.restaurant_tables t WHERE t.id=r.table_id AND t.company_id=_company_id),
    'created_in_mode',r.created_in_mode,'guest_name',r.guest_name,'guest_phone',r.guest_phone,
    'guest_phone_e164',r.guest_phone_e164,'guest_email',r.guest_email,'source',r.source,
    'date',r.date,'time',r.time,'party_size',r.party_size,'public_tracking_code',r.public_tracking_code,
    'status',r.status,'occasion',r.occasion,'notes',r.notes,'checked_in_at',r.checked_in_at,
    'checked_in_party_size',r.checked_in_party_size,'created_at',r.created_at,'updated_at',r.updated_at)
  INTO _row FROM public.reservations r WHERE r.company_id=_company_id AND r.id=_reservation_id;
  IF _row IS NULL THEN RAISE EXCEPTION 'Reserva nao encontrada nesta unidade.' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('company_id',_company_id,'reservation_id',_reservation_id,'row',_row);
END;
$$;
REVOKE ALL ON FUNCTION public.get_company_service_salon_reservation(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_company_service_salon_reservation(uuid,uuid) TO authenticated,service_role;
