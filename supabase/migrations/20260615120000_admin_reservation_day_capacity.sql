-- Fase 1 do plano calendario-capacidade-e-mesas.
--
-- Calendario operacional por horario para o painel. Esta RPC move o calculo de
-- capacidade por horario (hoje feito no cliente em buildCapacitySlots) para o
-- banco, retornando uma linha por horario publicado com metricas de ocupacao e
-- as reservas relacionadas embutidas em JSON.
--
-- Diferente da RPC publica get_public_reservation_availability, esta nao filtra
-- por um tamanho de grupo (_party_size) - ela responde a pergunta operacional
-- "como esta a capacidade deste dia por horario?" para a equipe.
--
-- Uma linha extra com time_slot = NULL representa o balde "fora dos horarios":
-- reservas ativas do dia cujo horario nao cai em nenhuma faixa publicada.

DROP FUNCTION IF EXISTS public.get_admin_reservation_day_capacity(uuid, date);

CREATE OR REPLACE FUNCTION public.get_admin_reservation_day_capacity(
  _company_id uuid,
  _date date
)
RETURNS TABLE (
  time_slot time,
  slot_start timestamptz,
  slot_end timestamptz,
  slot_label text,
  source text,
  rule_id uuid,
  rule_name text,
  block_id uuid,
  block_name text,
  availability_mode text,
  active_table_map_id uuid,
  active_table_map_name text,
  duration_minutes integer,
  capacity_limit integer,
  occupying_guest_count integer,
  arrival_guest_count integer,
  checked_in_guest_count integer,
  remaining_capacity integer,
  fill_rate numeric,
  arrival_reservation_count integer,
  occupying_reservation_count integer,
  total_tables integer,
  occupied_tables integer,
  available_tables integer,
  unassigned_reservation_count integer,
  reservation_limit integer,
  blocked boolean,
  configuration_issue text,
  status text,
  reservations jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _schedule record;
  _company_duration integer;
  _company_guest_limit integer;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.has_company_panel_permission(auth.uid(), _company_id, 'calendar_view') THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF _date IS NULL THEN
    RETURN;
  END IF;

  SELECT
    GREATEST(COALESCE(c.reservation_duration, 30), 1),
    COALESCE(c.max_guests_per_slot, 0)
  INTO _company_duration, _company_guest_limit
  FROM public.companies c
  WHERE c.id = _company_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT *
  INTO _schedule
  FROM public.get_public_reservation_schedule(_company_id, _date)
  LIMIT 1;

  RETURN QUERY
  WITH schedule AS (
    SELECT
      _schedule.source AS source,
      _schedule.rule_id AS rule_id,
      _schedule.rule_name AS rule_name,
      _schedule.block_id AS block_id,
      _schedule.block_name AS block_name,
      COALESCE(_schedule.availability_mode, 'tables') AS availability_mode,
      _schedule.default_duration_minutes AS default_duration_minutes,
      COALESCE(_schedule.slots, '[]'::jsonb) AS slots
  ),
  -- Conjunto operacional do dia: reservas que ocupam capacidade (confirmadas,
  -- check-in e pendentes de pagamento ainda validas). Canceladas, no-show e
  -- pagamentos expirados/cancelados ficam de fora.
  day_reservations AS (
    SELECT
      r.id,
      r.company_id,
      r.guest_name,
      r.guest_phone,
      r.guest_email,
      r.date,
      r.time,
      r.party_size,
      GREATEST(COALESCE(r.duration_minutes, _company_duration, 30), 1) AS duration_minutes,
      r.status,
      r.source,
      r.checked_in_at,
      r.checked_in_party_size,
      r.public_tracking_code,
      r.table_id,
      r.created_in_mode,
      r.occasion,
      r.notes,
      r.created_at,
      r.updated_at,
      rt.number AS table_number,
      rt.capacity AS table_capacity,
      rt.section AS table_section,
      CASE
        WHEN r.status = 'checked_in' THEN COALESCE(r.checked_in_party_size, r.party_size)
        ELSE r.party_size
      END AS occupancy_guests,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', rp.id,
              'status', rp.status,
              'paid_at', rp.paid_at,
              'billing_type', rp.billing_type,
              'expires_at', rp.expires_at
            )
            ORDER BY rp.created_at
          )
          FROM public.reservation_payments rp
          WHERE rp.reservation_id = r.id
        ),
        '[]'::jsonb
      ) AS reservation_payments
    FROM public.reservations r
    LEFT JOIN public.restaurant_tables rt ON rt.id = r.table_id
    WHERE r.company_id = _company_id
      AND r.date = _date
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
  ),
  slot_list AS (
    SELECT
      slot_value::time AS time_slot,
      row_number() OVER (ORDER BY slot_value::time) AS slot_index,
      lead(slot_value::time) OVER (ORDER BY slot_value::time) AS next_time_slot
    FROM schedule
    CROSS JOIN LATERAL jsonb_array_elements_text(schedule.slots) slot_value
  ),
  slot_config AS (
    SELECT
      sl.time_slot,
      sl.slot_index,
      sl.next_time_slot,
      sched.source,
      sched.rule_id,
      sched.rule_name,
      sched.block_id,
      sched.block_name,
      sched.availability_mode,
      slot.max_reservations_per_slot,
      slot.max_guests_per_slot,
      -- Duracao da faixa: distancia ate o proximo horario, com fallback na
      -- duracao configurada do slot/regra/empresa.
      GREATEST(
        COALESCE(
          NULLIF(
            CASE
              WHEN sl.next_time_slot IS NOT NULL AND sl.next_time_slot > sl.time_slot
                THEN (EXTRACT(EPOCH FROM (sl.next_time_slot - sl.time_slot)) / 60)::integer
              ELSE NULL
            END,
            0
          ),
          slot.duration_minutes,
          sched.default_duration_minutes,
          _company_duration,
          30
        ),
        1
      ) AS duration_minutes
    FROM slot_list sl
    CROSS JOIN schedule sched
    LEFT JOIN LATERAL (
      SELECT rule_slot.*
      FROM public.reservation_schedule_rule_slots rule_slot
      WHERE rule_slot.time = sl.time_slot
        AND (
          rule_slot.block_id = sched.block_id
          OR (rule_slot.block_id IS NULL AND rule_slot.rule_id = sched.rule_id)
        )
      ORDER BY
        CASE WHEN rule_slot.block_id = sched.block_id THEN 0 ELSE 1 END,
        rule_slot.sort_order ASC,
        rule_slot.created_at ASC
      LIMIT 1
    ) slot ON true
  ),
  slot_context AS (
    SELECT
      sc.*,
      active_map.id AS active_table_map_id,
      active_map.name AS active_table_map_name,
      EXISTS (
        SELECT 1
        FROM public.blocked_dates bd
        WHERE bd.company_id = _company_id
          AND bd.date = _date
          AND (
            bd.all_day = true
            OR (
              bd.all_day = false
              AND sc.time_slot >= COALESCE(bd.start_time, '00:00'::time)
              AND sc.time_slot < COALESCE(bd.end_time, '23:59:59'::time)
            )
          )
      ) AS is_blocked,
      CASE
        WHEN sc.availability_mode = 'tables' THEN (
          SELECT COALESCE(sum(rt.capacity), 0)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND (active_map.id IS NULL OR rt.table_map_id = active_map.id)
        )
        ELSE NULL
      END AS table_capacity_total,
      CASE
        WHEN sc.availability_mode = 'tables' THEN (
          SELECT count(*)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND (active_map.id IS NULL OR rt.table_map_id = active_map.id)
        )
        ELSE NULL
      END AS table_count_total
    FROM slot_config sc
    LEFT JOIN LATERAL public.get_active_table_map(
      _company_id,
      (_date + sc.time_slot)::timestamptz
    ) active_map ON true
  ),
  slot_metrics AS (
    SELECT
      ctx.*,
      agg.occupying_guest_count,
      agg.occupying_reservation_count,
      agg.checked_in_guest_count,
      agg.arrival_guest_count,
      agg.arrival_reservation_count,
      agg.occupied_table_count,
      agg.unassigned_reservation_count,
      agg.reservations
    FROM slot_context ctx
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(sum(dr.occupancy_guests) FILTER (WHERE related.is_occupying), 0)::integer AS occupying_guest_count,
        count(*) FILTER (WHERE related.is_occupying)::integer AS occupying_reservation_count,
        COALESCE(sum(dr.occupancy_guests) FILTER (WHERE related.is_occupying AND dr.status = 'checked_in'), 0)::integer AS checked_in_guest_count,
        COALESCE(sum(dr.party_size) FILTER (WHERE related.is_arrival), 0)::integer AS arrival_guest_count,
        count(*) FILTER (WHERE related.is_arrival)::integer AS arrival_reservation_count,
        count(DISTINCT dr.table_id) FILTER (WHERE related.is_occupying AND dr.table_id IS NOT NULL)::integer AS occupied_table_count,
        count(*) FILTER (WHERE related.is_occupying AND dr.table_id IS NULL AND ctx.availability_mode = 'tables')::integer AS unassigned_reservation_count,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', dr.id,
              'company_id', dr.company_id,
              'guest_name', dr.guest_name,
              'guest_phone', dr.guest_phone,
              'guest_email', dr.guest_email,
              'date', dr.date,
              'time', dr.time,
              'party_size', dr.party_size,
              'duration_minutes', dr.duration_minutes,
              'status', dr.status,
              'source', dr.source,
              'checked_in_at', dr.checked_in_at,
              'checked_in_party_size', dr.checked_in_party_size,
              'public_tracking_code', dr.public_tracking_code,
              'table_id', dr.table_id,
              'table_number', dr.table_number,
              'table_capacity', dr.table_capacity,
              'table_section', dr.table_section,
              'created_in_mode', dr.created_in_mode,
              'occasion', dr.occasion,
              'notes', dr.notes,
              'created_at', dr.created_at,
              'updated_at', dr.updated_at,
              'reservation_payments', dr.reservation_payments,
              'is_arrival', related.is_arrival,
              'is_occupying', related.is_occupying
            )
            ORDER BY related.is_arrival DESC, dr.time ASC, dr.guest_name ASC
          ) FILTER (WHERE related.is_arrival OR related.is_occupying),
          '[]'::jsonb
        ) AS reservations
      FROM day_reservations dr
      CROSS JOIN LATERAL (
        SELECT
          (dr.time >= ctx.time_slot
            AND dr.time < (ctx.time_slot + make_interval(mins => ctx.duration_minutes))) AS is_arrival,
          ((_date + dr.time) < (_date + ctx.time_slot + make_interval(mins => ctx.duration_minutes))
            AND (_date + dr.time + make_interval(mins => dr.duration_minutes)) > (_date + ctx.time_slot)) AS is_occupying
      ) related
    ) agg
  ),
  finalized AS (
    SELECT
      sm.*,
      CASE
        WHEN sm.availability_mode = 'capacity' THEN NULLIF(COALESCE(sm.max_guests_per_slot, 0), 0)
        ELSE (
          CASE
            WHEN COALESCE(sm.max_guests_per_slot, NULLIF(_company_guest_limit, 0)) IS NOT NULL
              THEN LEAST(
                COALESCE(sm.max_guests_per_slot, NULLIF(_company_guest_limit, 0)),
                COALESCE(sm.table_capacity_total, 0)
              )
            ELSE NULLIF(COALESCE(sm.table_capacity_total, 0), 0)
          END
        )
      END AS resolved_capacity_limit
    FROM slot_metrics sm
  )
  SELECT
    f.time_slot,
    (_date + f.time_slot)::timestamptz AS slot_start,
    (_date + f.time_slot + make_interval(mins => f.duration_minutes))::timestamptz AS slot_end,
    to_char(f.time_slot, 'HH24:MI')
      || ' - '
      || to_char((f.time_slot + make_interval(mins => f.duration_minutes))::time, 'HH24:MI') AS slot_label,
    f.source,
    f.rule_id,
    f.rule_name,
    f.block_id,
    f.block_name,
    f.availability_mode,
    f.active_table_map_id,
    f.active_table_map_name,
    f.duration_minutes,
    f.resolved_capacity_limit AS capacity_limit,
    f.occupying_guest_count,
    f.arrival_guest_count,
    f.checked_in_guest_count,
    CASE
      WHEN f.resolved_capacity_limit IS NULL THEN NULL
      ELSE GREATEST(f.resolved_capacity_limit - f.occupying_guest_count, 0)
    END AS remaining_capacity,
    CASE
      WHEN COALESCE(f.resolved_capacity_limit, 0) > 0
        THEN round((f.occupying_guest_count::numeric / f.resolved_capacity_limit::numeric), 4)
      ELSE 0
    END AS fill_rate,
    f.arrival_reservation_count,
    f.occupying_reservation_count,
    COALESCE(f.table_count_total, 0) AS total_tables,
    COALESCE(f.occupied_table_count, 0) AS occupied_tables,
    GREATEST(COALESCE(f.table_count_total, 0) - COALESCE(f.occupied_table_count, 0), 0) AS available_tables,
    f.unassigned_reservation_count,
    f.max_reservations_per_slot AS reservation_limit,
    f.is_blocked AS blocked,
    CASE
      WHEN f.availability_mode = 'capacity' AND COALESCE(f.max_guests_per_slot, 0) <= 0
        THEN 'missing_capacity'
      ELSE NULL
    END AS configuration_issue,
    CASE
      WHEN f.is_blocked THEN 'blocked'
      WHEN f.availability_mode = 'capacity' AND COALESCE(f.max_guests_per_slot, 0) <= 0 THEN 'configuration'
      WHEN COALESCE(f.resolved_capacity_limit, 0) <= 0 THEN 'configuration'
      WHEN f.occupying_guest_count > f.resolved_capacity_limit THEN 'over_capacity'
      WHEN f.occupying_guest_count >= f.resolved_capacity_limit THEN 'full'
      WHEN f.resolved_capacity_limit > 0
        AND (f.occupying_guest_count::numeric / f.resolved_capacity_limit::numeric) >= 0.75 THEN 'near_full'
      ELSE 'available'
    END AS status,
    f.reservations
  FROM finalized f

  UNION ALL

  -- Balde "fora dos horarios": reservas ativas cujo horario nao cai em nenhuma
  -- faixa publicada (ex.: agenda mudou apos a reserva, conversao de fila).
  SELECT
    NULL::time AS time_slot,
    NULL::timestamptz AS slot_start,
    NULL::timestamptz AS slot_end,
    'Fora dos horarios configurados'::text AS slot_label,
    'off_schedule'::text AS source,
    NULL::uuid, NULL::text, NULL::uuid, NULL::text,
    COALESCE(_schedule.availability_mode, 'tables') AS availability_mode,
    NULL::uuid, NULL::text,
    _company_duration AS duration_minutes,
    NULL::integer AS capacity_limit,
    COALESCE(sum(off.occupancy_guests), 0)::integer AS occupying_guest_count,
    COALESCE(sum(off.party_size), 0)::integer AS arrival_guest_count,
    COALESCE(sum(off.occupancy_guests) FILTER (WHERE off.status = 'checked_in'), 0)::integer AS checked_in_guest_count,
    NULL::integer AS remaining_capacity,
    0::numeric AS fill_rate,
    count(*)::integer AS arrival_reservation_count,
    count(*)::integer AS occupying_reservation_count,
    0 AS total_tables,
    0 AS occupied_tables,
    0 AS available_tables,
    0 AS unassigned_reservation_count,
    NULL::integer AS reservation_limit,
    false AS blocked,
    NULL::text AS configuration_issue,
    'off_schedule'::text AS status,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', off.id,
          'company_id', off.company_id,
          'guest_name', off.guest_name,
          'guest_phone', off.guest_phone,
          'guest_email', off.guest_email,
          'date', off.date,
          'time', off.time,
          'party_size', off.party_size,
          'duration_minutes', off.duration_minutes,
          'status', off.status,
          'source', off.source,
          'checked_in_at', off.checked_in_at,
          'checked_in_party_size', off.checked_in_party_size,
          'public_tracking_code', off.public_tracking_code,
          'table_id', off.table_id,
          'table_number', off.table_number,
          'table_capacity', off.table_capacity,
          'table_section', off.table_section,
          'created_in_mode', off.created_in_mode,
          'occasion', off.occasion,
          'notes', off.notes,
          'created_at', off.created_at,
          'updated_at', off.updated_at,
          'reservation_payments', off.reservation_payments,
          'is_arrival', true,
          'is_occupying', true
        )
        ORDER BY off.time ASC, off.guest_name ASC
      ),
      '[]'::jsonb
    ) AS reservations
  FROM (
    SELECT dr.*
    FROM day_reservations dr
    WHERE NOT EXISTS (
      -- Reusa as mesmas faixas calculadas para os horarios publicados, para que
      -- a deteccao de "fora dos horarios" seja consistente com is_arrival.
      SELECT 1
      FROM slot_config sc
      WHERE dr.time >= sc.time_slot
        AND dr.time < (sc.time_slot + make_interval(mins => sc.duration_minutes))
    )
  ) off
  HAVING count(*) > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_reservation_day_capacity(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_reservation_day_capacity(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_reservation_day_capacity(uuid, date) TO service_role;
