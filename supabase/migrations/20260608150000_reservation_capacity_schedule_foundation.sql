-- Foundation for reservation programming by tables or by capacity.
-- This migration is intentionally backwards-compatible:
-- existing companies/rules keep the current table-based behavior.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS reservation_slot_interval_minutes integer;

UPDATE public.companies
SET reservation_slot_interval_minutes = COALESCE(reservation_slot_interval_minutes, reservation_duration, 30)
WHERE reservation_slot_interval_minutes IS NULL;

ALTER TABLE public.companies
  ALTER COLUMN reservation_slot_interval_minutes SET DEFAULT 30,
  ALTER COLUMN reservation_slot_interval_minutes SET NOT NULL;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_reservation_slot_interval_minutes_check,
  ADD CONSTRAINT companies_reservation_slot_interval_minutes_check
    CHECK (reservation_slot_interval_minutes BETWEEN 1 AND 1440);

ALTER TABLE public.reservation_schedule_rules
  ADD COLUMN IF NOT EXISTS availability_mode text NOT NULL DEFAULT 'tables',
  ADD COLUMN IF NOT EXISTS publish_at timestamptz,
  ADD COLUMN IF NOT EXISTS default_duration_minutes integer;

ALTER TABLE public.reservation_schedule_rules
  DROP CONSTRAINT IF EXISTS reservation_schedule_rules_availability_mode_check,
  ADD CONSTRAINT reservation_schedule_rules_availability_mode_check
    CHECK (availability_mode IN ('tables', 'capacity')),
  DROP CONSTRAINT IF EXISTS reservation_schedule_rules_default_duration_check,
  ADD CONSTRAINT reservation_schedule_rules_default_duration_check
    CHECK (default_duration_minutes IS NULL OR default_duration_minutes BETWEEN 1 AND 1440);

UPDATE public.reservation_schedule_rules
SET availability_mode = 'tables'
WHERE availability_mode IS NULL;

CREATE TABLE IF NOT EXISTS public.reservation_schedule_rule_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.reservation_schedule_rules(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Padrão',
  weekdays integer[],
  availability_mode text NOT NULL DEFAULT 'tables',
  default_duration_minutes integer,
  sort_order integer NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_schedule_rule_blocks_name_not_blank
    CHECK (btrim(name) <> ''),
  CONSTRAINT reservation_schedule_rule_blocks_weekdays_check
    CHECK (
      weekdays IS NULL
      OR (
        array_length(weekdays, 1) BETWEEN 1 AND 7
        AND weekdays <@ ARRAY[0,1,2,3,4,5,6]
      )
    ),
  CONSTRAINT reservation_schedule_rule_blocks_availability_mode_check
    CHECK (availability_mode IN ('tables', 'capacity')),
  CONSTRAINT reservation_schedule_rule_blocks_default_duration_check
    CHECK (default_duration_minutes IS NULL OR default_duration_minutes BETWEEN 1 AND 1440)
);

CREATE INDEX IF NOT EXISTS idx_reservation_schedule_rule_blocks_rule_order
  ON public.reservation_schedule_rule_blocks(rule_id, sort_order, created_at);

ALTER TABLE public.reservation_schedule_rule_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company staff can view reservation schedule rule blocks"
  ON public.reservation_schedule_rule_blocks;
CREATE POLICY "Company staff can view reservation schedule rule blocks"
ON public.reservation_schedule_rule_blocks
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.id = reservation_schedule_rule_blocks.rule_id
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, rsr.company_id)
        OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, rsr.company_id)
      )
  )
);

DROP POLICY IF EXISTS "Company admins can manage reservation schedule rule blocks"
  ON public.reservation_schedule_rule_blocks;
CREATE POLICY "Company admins can manage reservation schedule rule blocks"
ON public.reservation_schedule_rule_blocks
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.id = reservation_schedule_rule_blocks.rule_id
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, rsr.company_id)
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.reservation_schedule_rules rsr
    WHERE rsr.id = reservation_schedule_rule_blocks.rule_id
      AND (
        public.has_role(auth.uid(), 'superadmin'::public.app_role)
        OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, rsr.company_id)
      )
  )
);

DROP TRIGGER IF EXISTS trg_touch_reservation_schedule_rule_block_updated_at
  ON public.reservation_schedule_rule_blocks;
CREATE TRIGGER trg_touch_reservation_schedule_rule_block_updated_at
BEFORE UPDATE ON public.reservation_schedule_rule_blocks
FOR EACH ROW
EXECUTE FUNCTION public.touch_reservation_schedule_rule_updated_at();

ALTER TABLE public.reservation_schedule_rule_slots
  ADD COLUMN IF NOT EXISTS block_id uuid,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS max_guests_per_slot integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservation_schedule_rule_slots_block_id_fkey'
      AND conrelid = 'public.reservation_schedule_rule_slots'::regclass
  ) THEN
    ALTER TABLE public.reservation_schedule_rule_slots
      ADD CONSTRAINT reservation_schedule_rule_slots_block_id_fkey
      FOREIGN KEY (block_id)
      REFERENCES public.reservation_schedule_rule_blocks(id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

ALTER TABLE public.reservation_schedule_rule_slots
  DROP CONSTRAINT IF EXISTS reservation_schedule_rule_slots_duration_check,
  ADD CONSTRAINT reservation_schedule_rule_slots_duration_check
    CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 1440),
  DROP CONSTRAINT IF EXISTS reservation_schedule_rule_slots_max_guests_check,
  ADD CONSTRAINT reservation_schedule_rule_slots_max_guests_check
    CHECK (max_guests_per_slot IS NULL OR max_guests_per_slot BETWEEN 1 AND 10000);

INSERT INTO public.reservation_schedule_rule_blocks (
  rule_id,
  name,
  weekdays,
  availability_mode,
  default_duration_minutes,
  sort_order
)
SELECT
  rsr.id,
  'Padrão',
  rsr.weekdays,
  COALESCE(rsr.availability_mode, 'tables'),
  NULL,
  10
FROM public.reservation_schedule_rules rsr
WHERE rsr.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.reservation_schedule_rule_blocks block
    WHERE block.rule_id = rsr.id
  );

UPDATE public.reservation_schedule_rule_slots slot
SET block_id = block.id
FROM public.reservation_schedule_rule_blocks block
WHERE slot.rule_id = block.rule_id
  AND slot.block_id IS NULL
  AND block.sort_order = (
    SELECT min(inner_block.sort_order)
    FROM public.reservation_schedule_rule_blocks inner_block
    WHERE inner_block.rule_id = slot.rule_id
  );

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS applied_schedule_rule_id uuid,
  ADD COLUMN IF NOT EXISTS created_in_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_applied_schedule_rule_id_fkey'
      AND conrelid = 'public.reservations'::regclass
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_applied_schedule_rule_id_fkey
      FOREIGN KEY (applied_schedule_rule_id)
      REFERENCES public.reservation_schedule_rules(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

ALTER TABLE public.reservations
  DROP CONSTRAINT IF EXISTS reservations_created_in_mode_check,
  ADD CONSTRAINT reservations_created_in_mode_check
    CHECK (created_in_mode IS NULL OR created_in_mode IN ('tables', 'capacity'));

DROP FUNCTION IF EXISTS public.get_public_reservation_schedule(uuid, date) CASCADE;

CREATE OR REPLACE FUNCTION public.get_public_reservation_schedule(
  _company_id uuid,
  _date date
)
RETURNS TABLE (
  source text,
  rule_id uuid,
  rule_name text,
  block_id uuid,
  block_name text,
  slots jsonb,
  max_party_size_per_reservation integer,
  availability_mode text,
  publish_at timestamptz,
  default_duration_minutes integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company public.companies%ROWTYPE;
  _rule public.reservation_schedule_rules%ROWTYPE;
  _block public.reservation_schedule_rule_blocks%ROWTYPE;
  _opening_hour jsonb;
  _open_time time;
  _close_time time;
  _slot_interval_minutes integer;
  _day_key text;
  _date_dow integer;
BEGIN
  SELECT *
  INTO _company
  FROM public.companies c
  WHERE c.id = _company_id
    AND c.status = 'active'
  LIMIT 1;

  IF NOT FOUND OR _date IS NULL THEN
    RETURN;
  END IF;

  _date_dow := EXTRACT(DOW FROM _date)::integer;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_dates bd
    WHERE bd.company_id = _company_id
      AND bd.date = _date
      AND bd.all_day = true
  ) THEN
    RETURN QUERY
    SELECT
      'blocked'::text,
      NULL::uuid,
      NULL::text,
      NULL::uuid,
      NULL::text,
      '[]'::jsonb,
      NULL::integer,
      'tables'::text,
      NULL::timestamptz,
      NULL::integer;
    RETURN;
  END IF;

  SELECT
    candidate.id,
    candidate.company_id,
    candidate.name,
    candidate.scope,
    candidate.weekdays,
    candidate.start_date,
    candidate.end_date,
    candidate.enabled,
    candidate.priority,
    candidate.max_party_size_per_reservation,
    candidate.archived_at,
    candidate.created_at,
    candidate.updated_at,
    candidate.availability_mode,
    candidate.publish_at,
    candidate.default_duration_minutes,
    candidate.block_id,
    candidate.block_rule_id,
    candidate.block_name,
    candidate.block_weekdays,
    candidate.block_availability_mode,
    candidate.block_default_duration_minutes,
    candidate.block_sort_order,
    candidate.block_created_at,
    candidate.block_updated_at
  INTO
    _rule.id,
    _rule.company_id,
    _rule.name,
    _rule.scope,
    _rule.weekdays,
    _rule.start_date,
    _rule.end_date,
    _rule.enabled,
    _rule.priority,
    _rule.max_party_size_per_reservation,
    _rule.archived_at,
    _rule.created_at,
    _rule.updated_at,
    _rule.availability_mode,
    _rule.publish_at,
    _rule.default_duration_minutes,
    _block.id,
    _block.rule_id,
    _block.name,
    _block.weekdays,
    _block.availability_mode,
    _block.default_duration_minutes,
    _block.sort_order,
    _block.created_at,
    _block.updated_at
  FROM (
    SELECT
      rsr.*,
      block.id AS block_id,
      block.rule_id AS block_rule_id,
      block.name AS block_name,
      block.weekdays AS block_weekdays,
      block.availability_mode AS block_availability_mode,
      block.default_duration_minutes AS block_default_duration_minutes,
      block.sort_order AS block_sort_order,
      block.created_at AS block_created_at,
      block.updated_at AS block_updated_at,
      CASE
        WHEN rsr.scope = 'date_specific' THEN 1
        WHEN rsr.scope = 'date_range' THEN 2
        ELSE 3
      END AS source_rank
    FROM public.reservation_schedule_rules rsr
    JOIN LATERAL (
      SELECT block.*
      FROM public.reservation_schedule_rule_blocks block
      WHERE block.rule_id = rsr.id
        AND (
          rsr.scope = 'date_specific'
          OR block.weekdays IS NULL
          OR cardinality(block.weekdays) = 0
          OR _date_dow = ANY(block.weekdays)
        )
      ORDER BY block.sort_order ASC, block.created_at ASC
      LIMIT 1
    ) block ON true
    WHERE rsr.company_id = _company_id
      AND rsr.enabled = true
      AND (rsr.publish_at IS NULL OR rsr.publish_at <= now())
      AND rsr.archived_at IS NULL
      AND (
        (rsr.scope = 'date_specific' AND rsr.start_date = _date)
        OR (rsr.scope = 'date_range' AND rsr.start_date <= _date AND rsr.end_date >= _date)
        OR rsr.scope = 'weekly'
      )
  ) candidate
  ORDER BY candidate.source_rank ASC, candidate.priority ASC, candidate.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY
    SELECT
      _rule.scope,
      _rule.id,
      _rule.name,
      _block.id,
      _block.name,
      COALESCE(
        (
          SELECT jsonb_agg(to_char(rsrslot.time, 'HH24:MI') ORDER BY rsrslot.time)
          FROM public.reservation_schedule_rule_slots rsrslot
          WHERE rsrslot.block_id = _block.id
        ),
        '[]'::jsonb
      ),
      _rule.max_party_size_per_reservation,
      COALESCE(_block.availability_mode, _rule.availability_mode, 'tables'),
      _rule.publish_at,
      NULL::integer;
    RETURN;
  END IF;

  _day_key := (ARRAY['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'])[EXTRACT(DOW FROM _date)::integer + 1];

  SELECT item
  INTO _opening_hour
  FROM jsonb_array_elements(COALESCE(_company.opening_hours, '[]'::jsonb)) item
  WHERE lower(
    translate(
      COALESCE(item ->> 'day', ''),
      'áàâãäéèêëíìîïóòôõöúùûüç',
      'aaaaaeeeeiiiiooooouuuuc'
    )
  ) = _day_key
  LIMIT 1;

  IF _opening_hour IS NULL OR COALESCE((_opening_hour ->> 'closed')::boolean, false) THEN
    RETURN QUERY
    SELECT 'default'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, '[]'::jsonb, NULL::integer, 'tables'::text, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  BEGIN
    _open_time := (_opening_hour ->> 'open')::time;
    _close_time := (_opening_hour ->> 'close')::time;
  EXCEPTION
    WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RETURN QUERY
      SELECT 'default'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, '[]'::jsonb, NULL::integer, 'tables'::text, NULL::timestamptz, NULL::integer;
      RETURN;
  END;

  _slot_interval_minutes := GREATEST(COALESCE(_company.reservation_slot_interval_minutes, _company.reservation_duration, 30), 1);

  IF _close_time <= _open_time THEN
    RETURN QUERY
    SELECT 'default'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, '[]'::jsonb, NULL::integer, 'tables'::text, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'default'::text,
    NULL::uuid,
    NULL::text,
    NULL::uuid,
    NULL::text,
    COALESCE(
      (
        SELECT jsonb_agg(to_char(generated.slot_at, 'HH24:MI') ORDER BY generated.slot_at)
        FROM generate_series(
          _date + _open_time,
          (_date + _close_time) - interval '1 second',
          make_interval(mins => _slot_interval_minutes)
        ) generated(slot_at)
      ),
      '[]'::jsonb
    ),
    NULL::integer,
    'tables'::text,
    NULL::timestamptz,
    NULL::integer;
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_reservation_schedule(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_schedule(uuid, date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_schedule(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_reservation_slot_duration(
  _company_id uuid,
  _date date,
  _time time
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company AS (
    SELECT GREATEST(COALESCE(c.reservation_duration, 30), 1) AS duration_minutes
    FROM public.companies c
    WHERE c.id = _company_id
      AND c.status = 'active'
    LIMIT 1
  ),
  schedule AS (
    SELECT *
    FROM public.get_public_reservation_schedule(_company_id, _date)
    LIMIT 1
  )
  SELECT GREATEST(COALESCE(slot.duration_minutes, schedule.default_duration_minutes, company.duration_minutes, 30), 1)
  FROM company
  LEFT JOIN schedule ON true
  LEFT JOIN public.reservation_schedule_rule_slots slot
    ON slot.block_id = schedule.block_id
   AND slot.time = _time;
$$;

REVOKE ALL ON FUNCTION public.resolve_reservation_slot_duration(uuid, date, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_reservation_slot_duration(uuid, date, time) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_reservation_slot_duration(uuid, date, time) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reservation_slot_duration(uuid, date, time) TO service_role;

CREATE OR REPLACE FUNCTION public.get_occupied_table_ids(
  _company_id uuid,
  _date date,
  _time time
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_slot AS (
    SELECT public.resolve_reservation_slot_duration(_company_id, _date, _time) AS duration_minutes
  )
  SELECT COALESCE(array_agg(DISTINCT r.table_id), '{}'::uuid[])
  FROM public.reservations r
  CROSS JOIN requested_slot requested
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.table_id IS NOT NULL
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
    AND (_date + r.time) < (_date + _time + make_interval(mins => requested.duration_minutes))
    AND (
      _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
    ) > (_date + _time);
$$;

REVOKE ALL ON FUNCTION public.get_occupied_table_ids(uuid, date, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO anon;
GRANT EXECUTE ON FUNCTION public.get_occupied_table_ids(uuid, date, time) TO authenticated;

DROP FUNCTION IF EXISTS public.get_public_reservation_availability(uuid, date, integer);

CREATE OR REPLACE FUNCTION public.get_public_reservation_availability(
  _company_id uuid,
  _date date,
  _party_size integer
)
RETURNS TABLE (
  time_slot time,
  available boolean,
  unavailable_reason text,
  total_tables integer,
  occupied_tables integer,
  available_tables integer,
  total_guests integer,
  reservation_count integer,
  max_party_size_per_reservation integer,
  max_reservations_per_slot integer,
  availability_mode text,
  duration_minutes integer,
  max_guests_per_slot integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH company AS (
    SELECT
      c.id,
      GREATEST(COALESCE(c.reservation_duration, 30), 1) AS duration_minutes,
      COALESCE(c.max_guests_per_slot, 0) AS max_guests_per_slot
    FROM public.companies c
    WHERE c.id = _company_id
      AND c.status = 'active'
    LIMIT 1
  ),
  schedule AS (
    SELECT resolved.*
    FROM public.get_public_reservation_schedule(_company_id, _date) resolved
    WHERE resolved.source <> 'blocked'
  ),
  allowed_slots AS (
    SELECT
      slot_value::time AS time_slot,
      schedule.rule_id,
      schedule.block_id,
      schedule.availability_mode,
      schedule.default_duration_minutes,
      schedule.max_party_size_per_reservation AS rule_max_party_size
    FROM schedule
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(schedule.slots, '[]'::jsonb)) slot_value
  ),
  resolved_slots AS (
    SELECT
      allowed.time_slot,
      COALESCE(allowed.availability_mode, 'tables') AS availability_mode,
      GREATEST(COALESCE(slot.duration_minutes, allowed.default_duration_minutes, company.duration_minutes, 30), 1) AS duration_minutes,
      COALESCE(slot.max_party_size_per_reservation, allowed.rule_max_party_size) AS max_party_size_per_reservation,
      slot.max_reservations_per_slot,
      slot.max_guests_per_slot,
      company.max_guests_per_slot AS company_max_guests_per_slot,
      EXISTS (
        SELECT 1
        FROM public.blocked_dates bd
        WHERE bd.company_id = _company_id
          AND bd.date = _date
          AND (
            bd.all_day = true
            OR (
              bd.all_day = false
              AND allowed.time_slot >= COALESCE(bd.start_time, '00:00'::time)
              AND allowed.time_slot < COALESCE(bd.end_time, '23:59:59'::time)
            )
          )
      ) AS is_blocked
    FROM allowed_slots allowed
    CROSS JOIN company
    LEFT JOIN public.reservation_schedule_rule_slots slot
      ON slot.block_id = allowed.block_id
     AND slot.time = allowed.time_slot
  ),
  slot_context AS (
    SELECT
      resolved.*,
      active_map.id AS active_table_map_id
    FROM resolved_slots resolved
    LEFT JOIN LATERAL public.get_active_table_map(
      _company_id,
      (_date + resolved.time_slot)::timestamptz
    ) active_map ON true
  ),
  slot_metrics AS (
    SELECT
      context.*,
      CASE
        WHEN context.availability_mode = 'capacity' THEN COALESCE(context.max_guests_per_slot, 0)
        ELSE (
          SELECT count(*)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
        )
      END AS total_units,
      CASE
        WHEN context.availability_mode = 'capacity' THEN (
          SELECT COALESCE(sum(r.party_size), 0)::integer
          FROM public.reservations r
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
        ELSE (
          SELECT count(DISTINCT r.table_id)::integer
          FROM public.reservations r
          JOIN public.restaurant_tables rt ON rt.id = r.table_id
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
      END AS occupied_units,
      CASE
        WHEN context.availability_mode = 'capacity' THEN GREATEST(COALESCE(context.max_guests_per_slot, 0) - (
          SELECT COALESCE(sum(r.party_size), 0)::integer
          FROM public.reservations r
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        ), 0)
        ELSE (
          SELECT count(*)::integer
          FROM public.restaurant_tables rt
          WHERE rt.company_id = _company_id
            AND rt.status = 'available'
            AND rt.capacity >= _party_size
            AND (context.active_table_map_id IS NULL OR rt.table_map_id = context.active_table_map_id)
            AND NOT EXISTS (
              SELECT 1
              FROM public.reservations r
              WHERE r.company_id = _company_id
                AND r.date = _date
                AND r.table_id = rt.id
                AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
                AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
                AND (
                  _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
                ) > (_date + context.time_slot)
            )
        )
      END AS available_units,
      CASE
        WHEN context.availability_mode = 'capacity' THEN (
          SELECT COALESCE(sum(r.party_size), 0)::integer
          FROM public.reservations r
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
        ELSE (
          SELECT COALESCE(sum(r.party_size), 0)::integer
          FROM public.reservations r
          WHERE r.company_id = _company_id
            AND r.date = _date
            AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
            AND (_date + r.time) < (_date + context.time_slot + make_interval(mins => context.duration_minutes))
            AND (
              _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
            ) > (_date + context.time_slot)
        )
      END AS total_guests,
      (
        SELECT count(*)::integer
        FROM public.reservations r
        WHERE r.company_id = _company_id
          AND r.date = _date
          AND r.time = context.time_slot
          AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      ) AS reservation_count
    FROM slot_context context
  )
  SELECT
    metrics.time_slot,
    CASE
      WHEN metrics.is_blocked THEN false
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN false
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.reservation_count >= metrics.max_reservations_per_slot THEN false
      WHEN metrics.availability_mode = 'capacity'
        AND COALESCE(metrics.max_guests_per_slot, 0) <= 0 THEN false
      WHEN metrics.availability_mode = 'capacity'
        AND metrics.occupied_units + _party_size > COALESCE(metrics.max_guests_per_slot, 0) THEN false
      WHEN metrics.availability_mode = 'tables'
        AND COALESCE(metrics.max_guests_per_slot, NULLIF(metrics.company_max_guests_per_slot, 0), 0) > 0
        AND metrics.total_guests + _party_size > COALESCE(metrics.max_guests_per_slot, NULLIF(metrics.company_max_guests_per_slot, 0), 0) THEN false
      WHEN metrics.availability_mode = 'tables'
        AND metrics.available_units <= 0 THEN false
      ELSE true
    END AS available,
    CASE
      WHEN metrics.is_blocked THEN 'blocked'
      WHEN metrics.max_party_size_per_reservation IS NOT NULL
        AND _party_size > metrics.max_party_size_per_reservation THEN 'party_size_limit'
      WHEN metrics.max_reservations_per_slot IS NOT NULL
        AND metrics.reservation_count >= metrics.max_reservations_per_slot THEN 'reservation_limit'
      WHEN metrics.availability_mode = 'capacity'
        AND COALESCE(metrics.max_guests_per_slot, 0) <= 0 THEN 'capacity_limit_missing'
      WHEN metrics.availability_mode = 'capacity'
        AND metrics.occupied_units + _party_size > COALESCE(metrics.max_guests_per_slot, 0) THEN 'guest_limit'
      WHEN metrics.availability_mode = 'tables'
        AND COALESCE(metrics.max_guests_per_slot, NULLIF(metrics.company_max_guests_per_slot, 0), 0) > 0
        AND metrics.total_guests + _party_size > COALESCE(metrics.max_guests_per_slot, NULLIF(metrics.company_max_guests_per_slot, 0), 0) THEN 'guest_limit'
      WHEN metrics.availability_mode = 'tables'
        AND metrics.available_units <= 0 THEN 'no_table'
      ELSE NULL
    END AS unavailable_reason,
    metrics.total_units AS total_tables,
    metrics.occupied_units AS occupied_tables,
    metrics.available_units AS available_tables,
    metrics.total_guests,
    metrics.reservation_count,
    metrics.max_party_size_per_reservation,
    metrics.max_reservations_per_slot,
    metrics.availability_mode,
    metrics.duration_minutes,
    CASE
      WHEN metrics.availability_mode = 'capacity' THEN metrics.max_guests_per_slot
      ELSE COALESCE(metrics.max_guests_per_slot, NULLIF(metrics.company_max_guests_per_slot, 0))
    END AS max_guests_per_slot
  FROM slot_metrics metrics
  WHERE _party_size BETWEEN 1 AND 20
  ORDER BY metrics.time_slot;
$$;

REVOKE ALL ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_reservation_availability(uuid, date, integer) TO authenticated;

DROP FUNCTION IF EXISTS public.upsert_reservation_schedule_rule(
  uuid, text, text, text[], uuid, integer[], date, date, boolean, integer, integer, jsonb
);
DROP FUNCTION IF EXISTS public.upsert_reservation_schedule_rule(
  uuid, text, text, text[], uuid, integer[], date, date, boolean, integer, integer, jsonb, text, timestamptz, integer
);
DROP FUNCTION IF EXISTS public.upsert_reservation_schedule_rule(
  uuid, text, text, uuid, date, date, boolean, integer, timestamptz, jsonb
);

CREATE OR REPLACE FUNCTION public.upsert_reservation_schedule_rule(
  _company_id uuid,
  _name text,
  _scope text,
  _rule_id uuid DEFAULT NULL,
  _start_date date DEFAULT NULL,
  _end_date date DEFAULT NULL,
  _enabled boolean DEFAULT true,
  _priority integer DEFAULT 100,
  _publish_at timestamptz DEFAULT NULL,
  _blocks jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _saved_id uuid;
  _block_item jsonb;
  _slot_item jsonb;
  _block_id uuid;
  _block_index integer;
  _slot_index integer;
  _block_name text;
  _mode text;
  _block_weekdays integer[];
  _used_weekdays integer[] := '{}'::integer[];
  _rule_weekdays integer[] := NULL;
  _first_mode text := NULL;
  _slots jsonb;
  _slot_time text;
  _slot_times text[];
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  IF _scope NOT IN ('weekly', 'date_specific', 'date_range') THEN
    RAISE EXCEPTION 'Tipo de regra invalido.';
  END IF;

  IF NULLIF(btrim(COALESCE(_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe o nome da regra.';
  END IF;

  IF _scope IN ('date_specific', 'date_range') AND _start_date IS NULL THEN
    RAISE EXCEPTION 'Informe a data inicial.';
  END IF;

  IF _scope = 'date_range' AND _end_date IS NULL THEN
    RAISE EXCEPTION 'Informe a data final.';
  END IF;

  IF _scope = 'date_range' AND _end_date < _start_date THEN
    RAISE EXCEPTION 'A data final deve ser igual ou posterior a inicial.';
  END IF;

  IF jsonb_typeof(COALESCE(_blocks, '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(_blocks, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Adicione pelo menos um bloco de disponibilidade.';
  END IF;

  IF _scope = 'date_specific' AND jsonb_array_length(COALESCE(_blocks, '[]'::jsonb)) > 1 THEN
    RAISE EXCEPTION 'Use um unico bloco em regras de data especifica.';
  END IF;

  _block_index := 0;
  FOR _block_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(_blocks, '[]'::jsonb))
  LOOP
    _block_index := _block_index + 1;
    _mode := COALESCE(NULLIF(_block_item ->> 'availability_mode', ''), 'tables');

    IF _mode NOT IN ('tables', 'capacity') THEN
      RAISE EXCEPTION 'Modo de disponibilidade invalido.';
    END IF;

    IF _first_mode IS NULL THEN
      _first_mode := _mode;
    END IF;

    _block_weekdays := NULL;
    IF jsonb_typeof(COALESCE(_block_item -> 'weekdays', '[]'::jsonb)) = 'array' THEN
      SELECT array_agg(DISTINCT weekday_value ORDER BY weekday_value)
      INTO _block_weekdays
      FROM (
        SELECT value::integer AS weekday_value
        FROM jsonb_array_elements_text(COALESCE(_block_item -> 'weekdays', '[]'::jsonb))
      ) weekdays
      WHERE weekday_value BETWEEN 0 AND 6;
    END IF;

    IF _scope IN ('weekly', 'date_range')
       AND (_block_weekdays IS NULL OR cardinality(_block_weekdays) = 0) THEN
      RAISE EXCEPTION 'Selecione os dias da semana de todos os blocos.';
    END IF;

    IF _scope IN ('weekly', 'date_range') AND (_used_weekdays && _block_weekdays) THEN
      RAISE EXCEPTION 'Nao repita o mesmo dia da semana em mais de um bloco da regra.';
    END IF;

    IF _scope IN ('weekly', 'date_range') THEN
      _used_weekdays := _used_weekdays || _block_weekdays;
      _rule_weekdays := _used_weekdays;
    ELSE
      _block_weekdays := NULL;
    END IF;

    _slots := COALESCE(_block_item -> 'slots', '[]'::jsonb);
    IF jsonb_typeof(_slots) <> 'array' OR jsonb_array_length(_slots) = 0 THEN
      RAISE EXCEPTION 'Adicione pelo menos um horario em todos os blocos.';
    END IF;

    _slot_times := '{}'::text[];
    FOR _slot_item IN SELECT value FROM jsonb_array_elements(_slots)
    LOOP
      _slot_time := _slot_item ->> 'time';
      IF _slot_time !~ '^[0-2][0-9]:[0-5][0-9]$'
         OR split_part(_slot_time, ':', 1)::integer > 23 THEN
        RAISE EXCEPTION 'Existe um horario invalido.';
      END IF;

      IF _slot_time = ANY(_slot_times) THEN
        RAISE EXCEPTION 'Nao repita horarios dentro do mesmo bloco.';
      END IF;
      _slot_times := array_append(_slot_times, _slot_time);

      IF NULLIF(_slot_item ->> 'duration_minutes', '') IS NOT NULL
         AND (
          (_slot_item ->> 'duration_minutes') !~ '^[0-9]+$'
          OR (_slot_item ->> 'duration_minutes')::integer NOT BETWEEN 1 AND 1440
         ) THEN
        RAISE EXCEPTION 'A duracao do horario deve estar entre 1 e 1440 minutos.';
      END IF;

      IF NULLIF(_slot_item ->> 'max_party_size_per_reservation', '') IS NOT NULL
         AND (
          (_slot_item ->> 'max_party_size_per_reservation') !~ '^[0-9]+$'
          OR (_slot_item ->> 'max_party_size_per_reservation')::integer NOT BETWEEN 1 AND 20
         ) THEN
        RAISE EXCEPTION 'O maximo de pessoas por reserva do horario deve estar entre 1 e 20.';
      END IF;

      IF NULLIF(_slot_item ->> 'max_reservations_per_slot', '') IS NOT NULL
         AND (
          (_slot_item ->> 'max_reservations_per_slot') !~ '^[0-9]+$'
          OR (_slot_item ->> 'max_reservations_per_slot')::integer NOT BETWEEN 1 AND 500
         ) THEN
        RAISE EXCEPTION 'O maximo de reservas do horario deve estar entre 1 e 500.';
      END IF;

      IF NULLIF(_slot_item ->> 'max_guests_per_slot', '') IS NOT NULL
         AND (
          (_slot_item ->> 'max_guests_per_slot') !~ '^[0-9]+$'
          OR (_slot_item ->> 'max_guests_per_slot')::integer NOT BETWEEN 1 AND 10000
         ) THEN
        RAISE EXCEPTION 'O limite total de pessoas do horario deve estar entre 1 e 10000.';
      END IF;

      IF _mode = 'capacity' AND NULLIF(_slot_item ->> 'max_guests_per_slot', '') IS NULL THEN
        RAISE EXCEPTION 'Informe o limite total de pessoas para todos os horarios no modo por capacidade.';
      END IF;
    END LOOP;
  END LOOP;

  IF _rule_id IS NULL THEN
    INSERT INTO public.reservation_schedule_rules (
      company_id,
      name,
      scope,
      weekdays,
      start_date,
      end_date,
      enabled,
      priority,
      max_party_size_per_reservation,
      availability_mode,
      publish_at,
      default_duration_minutes
    )
    VALUES (
      _company_id,
      btrim(_name),
      _scope,
      CASE WHEN _scope = 'weekly' THEN _rule_weekdays ELSE NULL END,
      CASE WHEN _scope IN ('date_specific', 'date_range') THEN _start_date ELSE NULL END,
      CASE
        WHEN _scope = 'date_specific' THEN _start_date
        WHEN _scope = 'date_range' THEN _end_date
        ELSE NULL
      END,
      COALESCE(_enabled, true),
      COALESCE(_priority, 100),
      NULL,
      COALESCE(_first_mode, 'tables'),
      _publish_at,
      NULL
    )
    RETURNING id
    INTO _saved_id;
  ELSE
    UPDATE public.reservation_schedule_rules rsr
    SET
      name = btrim(_name),
      scope = _scope,
      weekdays = CASE WHEN _scope = 'weekly' THEN _rule_weekdays ELSE NULL END,
      start_date = CASE WHEN _scope IN ('date_specific', 'date_range') THEN _start_date ELSE NULL END,
      end_date = CASE
        WHEN _scope = 'date_specific' THEN _start_date
        WHEN _scope = 'date_range' THEN _end_date
        ELSE NULL
      END,
      enabled = COALESCE(_enabled, true),
      priority = COALESCE(_priority, 100),
      max_party_size_per_reservation = NULL,
      availability_mode = COALESCE(_first_mode, 'tables'),
      publish_at = _publish_at,
      default_duration_minutes = NULL
    WHERE rsr.id = _rule_id
      AND rsr.company_id = _company_id
      AND rsr.archived_at IS NULL
    RETURNING rsr.id
    INTO _saved_id;

    IF _saved_id IS NULL THEN
      RAISE EXCEPTION 'Regra nao encontrada.';
    END IF;

    DELETE FROM public.reservation_schedule_rule_slots
    WHERE rule_id = _saved_id;

    DELETE FROM public.reservation_schedule_rule_blocks
    WHERE rule_id = _saved_id;
  END IF;

  _block_index := 0;
  FOR _block_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(_blocks, '[]'::jsonb))
  LOOP
    _block_index := _block_index + 1;
    _block_name := COALESCE(NULLIF(btrim(_block_item ->> 'name'), ''), format('Bloco %s', _block_index));
    _mode := COALESCE(NULLIF(_block_item ->> 'availability_mode', ''), 'tables');

    _block_weekdays := NULL;
    IF _scope IN ('weekly', 'date_range')
       AND jsonb_typeof(COALESCE(_block_item -> 'weekdays', '[]'::jsonb)) = 'array' THEN
      SELECT array_agg(DISTINCT weekday_value ORDER BY weekday_value)
      INTO _block_weekdays
      FROM (
        SELECT value::integer AS weekday_value
        FROM jsonb_array_elements_text(COALESCE(_block_item -> 'weekdays', '[]'::jsonb))
      ) weekdays
      WHERE weekday_value BETWEEN 0 AND 6;
    END IF;

    INSERT INTO public.reservation_schedule_rule_blocks (
      rule_id,
      name,
      weekdays,
      availability_mode,
      default_duration_minutes,
      sort_order
    )
    VALUES (
      _saved_id,
      _block_name,
      _block_weekdays,
      _mode,
      NULL,
      _block_index * 10
    )
    RETURNING id
    INTO _block_id;

    _slot_index := 0;
    FOR _slot_item IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(_block_item -> 'slots', '[]'::jsonb))
      ORDER BY (value ->> 'time')::time
    LOOP
      _slot_index := _slot_index + 1;
      INSERT INTO public.reservation_schedule_rule_slots (
        rule_id,
        block_id,
        time,
        sort_order,
        duration_minutes,
        max_party_size_per_reservation,
        max_reservations_per_slot,
        max_guests_per_slot
      )
      VALUES (
        _saved_id,
        _block_id,
        (_slot_item ->> 'time')::time,
        _slot_index * 10,
        NULLIF(_slot_item ->> 'duration_minutes', '')::integer,
        NULLIF(_slot_item ->> 'max_party_size_per_reservation', '')::integer,
        NULLIF(_slot_item ->> 'max_reservations_per_slot', '')::integer,
        NULLIF(_slot_item ->> 'max_guests_per_slot', '')::integer
      );
    END LOOP;
  END LOOP;

  RETURN _saved_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_reservation_schedule_rule(
  uuid, text, text, uuid, date, date, boolean, integer, timestamptz, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_reservation_schedule_rule(
  uuid, text, text, uuid, date, date, boolean, integer, timestamptz, jsonb
) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_public_reservation(
  _reservation jsonb,
  _status text DEFAULT 'confirmed'
)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company public.companies%ROWTYPE;
  _created public.reservations%ROWTYPE;
  _schedule record;
  _company_id uuid;
  _table_id uuid;
  _active_table_map_id uuid;
  _date date;
  _time time;
  _party_size integer;
  _duration_minutes integer;
  _occupied_guests integer;
  _reservation_count integer;
  _max_party_size_per_reservation integer;
  _max_reservations_per_slot integer;
  _max_guests_per_slot integer;
  _effective_max_guests_per_slot integer;
  _availability_mode text;
BEGIN
  IF jsonb_typeof(COALESCE(_reservation, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Dados da reserva invalidos.';
  END IF;

  IF _status NOT IN ('confirmed', 'pending_payment') THEN
    RAISE EXCEPTION 'Status inicial da reserva invalido.';
  END IF;

  BEGIN
    _company_id := NULLIF(_reservation ->> 'company_id', '')::uuid;
    _table_id := NULLIF(_reservation ->> 'table_id', '')::uuid;
    _date := NULLIF(_reservation ->> 'date', '')::date;
    _time := NULLIF(_reservation ->> 'time', '')::time;
    _party_size := COALESCE(NULLIF(_reservation ->> 'party_size', '')::integer, 1);
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Dados da reserva invalidos.';
  END;

  IF _company_id IS NULL OR _date IS NULL OR _time IS NULL THEN
    RAISE EXCEPTION 'Dados da reserva incompletos.';
  END IF;

  IF NULLIF(btrim(COALESCE(_reservation ->> 'guest_name', '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(_reservation ->> 'guest_phone', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe nome e WhatsApp.';
  END IF;

  IF _party_size < 1 OR _party_size > 20 THEN
    RAISE EXCEPTION 'Quantidade de pessoas invalida.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('reservation-slot|%s|%s|%s', _company_id::text, _date::text, _time::text), 0)
  );

  SELECT *
  INTO _company
  FROM public.companies c
  WHERE c.id = _company_id
    AND c.status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa nao encontrada ou indisponivel.';
  END IF;

  SELECT *
  INTO _schedule
  FROM public.get_public_reservation_schedule(_company_id, _date)
  LIMIT 1;

  IF _schedule.source IS NULL
     OR _schedule.source = 'blocked'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(COALESCE(_schedule.slots, '[]'::jsonb)) slot_value
       WHERE slot_value = to_char(_time, 'HH24:MI')
     ) THEN
    RAISE EXCEPTION 'Horario indisponivel para reserva online.';
  END IF;

  _availability_mode := COALESCE(_schedule.availability_mode, 'tables');

  SELECT
    GREATEST(COALESCE(slot.duration_minutes, _schedule.default_duration_minutes, _company.reservation_duration, 30), 1),
    COALESCE(slot.max_party_size_per_reservation, _schedule.max_party_size_per_reservation),
    slot.max_reservations_per_slot,
    slot.max_guests_per_slot
  INTO
    _duration_minutes,
    _max_party_size_per_reservation,
    _max_reservations_per_slot,
    _max_guests_per_slot
  FROM (SELECT 1) singleton
  LEFT JOIN public.reservation_schedule_rule_slots slot
    ON slot.block_id = _schedule.block_id
   AND slot.time = _time;

  _effective_max_guests_per_slot := COALESCE(_max_guests_per_slot, NULLIF(_company.max_guests_per_slot, 0), 0);

  IF _availability_mode = 'capacity' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(format('reservation-capacity|%s|%s', _company_id::text, _date::text), 0)
    );
  END IF;

  IF _max_party_size_per_reservation IS NOT NULL
     AND _party_size > _max_party_size_per_reservation THEN
    RAISE EXCEPTION 'Este horario aceita reservas online de ate % pessoas.', _max_party_size_per_reservation;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_dates bd
    WHERE bd.company_id = _company_id
      AND bd.date = _date
      AND (
        bd.all_day = true
        OR (
          bd.all_day = false
          AND _time >= COALESCE(bd.start_time, '00:00'::time)
          AND _time < COALESCE(bd.end_time, '23:59:59'::time)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Horario bloqueado para reservas.';
  END IF;

  SELECT count(*)::integer
  INTO _reservation_count
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date = _date
    AND r.time = _time
    AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at);

  IF _max_reservations_per_slot IS NOT NULL
     AND _reservation_count >= _max_reservations_per_slot THEN
    RAISE EXCEPTION 'Limite de reservas atingido para este horario.';
  END IF;

  IF _availability_mode = 'capacity' THEN
    IF COALESCE(_max_guests_per_slot, 0) <= 0 THEN
      RAISE EXCEPTION 'Capacidade nao configurada para este horario.';
    END IF;

    SELECT COALESCE(sum(r.party_size), 0)::integer
    INTO _occupied_guests
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.date = _date
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      AND (_date + r.time) < (_date + _time + make_interval(mins => _duration_minutes))
      AND (
        _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
      ) > (_date + _time);

    IF _occupied_guests + _party_size > _max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;
  ELSE
    SELECT COALESCE(sum(r.party_size), 0)::integer
    INTO _occupied_guests
    FROM public.reservations r
    WHERE r.company_id = _company_id
      AND r.date = _date
      AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
      AND (_date + r.time) < (_date + _time + make_interval(mins => _duration_minutes))
      AND (
        _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
      ) > (_date + _time);

    IF _effective_max_guests_per_slot > 0
       AND _occupied_guests + _party_size > _effective_max_guests_per_slot THEN
      RAISE EXCEPTION 'Limite de pessoas atingido para este horario.';
    END IF;

    SELECT active_map.id
    INTO _active_table_map_id
    FROM public.get_active_table_map(_company_id, (_date + _time)::timestamptz) active_map
    LIMIT 1;

    IF _table_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.restaurant_tables rt
      WHERE rt.id = _table_id
        AND rt.company_id = _company_id
        AND rt.status = 'available'
        AND rt.capacity >= _party_size
        AND (_active_table_map_id IS NULL OR rt.table_map_id = _active_table_map_id)
    ) THEN
      RAISE EXCEPTION 'Mesa indisponivel para este numero de pessoas.';
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(format('reservation-table|%s|%s', _table_id::text, _date::text), 0)
    );

    IF EXISTS (
      SELECT 1
      FROM public.reservations r
      WHERE r.company_id = _company_id
        AND r.date = _date
        AND r.table_id = _table_id
        AND public.is_reservation_occupying_capacity(r.id, r.status, r.created_at)
        AND (_date + r.time) < (_date + _time + make_interval(mins => _duration_minutes))
        AND (
          _date + r.time + make_interval(mins => GREATEST(COALESCE(r.duration_minutes, 30), 1))
        ) > (_date + _time)
    ) THEN
      RAISE EXCEPTION 'Mesa indisponivel para este horario.';
    END IF;
  END IF;

  INSERT INTO public.reservations (
    id,
    public_tracking_code,
    company_id,
    table_id,
    guest_name,
    guest_phone,
    guest_email,
    guest_birthdate,
    date,
    time,
    party_size,
    duration_minutes,
    status,
    occasion,
    notes,
    visitor_id,
    origin_tracking_session_id,
    origin_tracking_journey_id,
    origin_anonymous_id,
    origin_affiliate_link_id,
    origin_affiliate_code,
    origin_affiliate_name,
    origin_fbp,
    origin_fbc,
    attribution_snapshot,
    source,
    applied_schedule_rule_id,
    created_in_mode
  )
  VALUES (
    COALESCE(NULLIF(_reservation ->> 'id', '')::uuid, gen_random_uuid()),
    COALESCE(NULLIF(_reservation ->> 'public_tracking_code', ''), replace(gen_random_uuid()::text, '-', '')),
    _company_id,
    CASE WHEN _availability_mode = 'capacity' THEN NULL ELSE _table_id END,
    btrim(_reservation ->> 'guest_name'),
    btrim(_reservation ->> 'guest_phone'),
    NULLIF(lower(btrim(COALESCE(_reservation ->> 'guest_email', ''))), ''),
    NULLIF(_reservation ->> 'guest_birthdate', '')::date,
    _date,
    _time,
    _party_size,
    _duration_minutes,
    _status,
    NULLIF(btrim(COALESCE(_reservation ->> 'occasion', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'notes', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'visitor_id', '')), ''),
    NULLIF(_reservation ->> 'origin_tracking_session_id', '')::uuid,
    NULLIF(_reservation ->> 'origin_tracking_journey_id', '')::uuid,
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_anonymous_id', '')), ''),
    NULLIF(_reservation ->> 'origin_affiliate_link_id', '')::uuid,
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_affiliate_code', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_affiliate_name', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_fbp', '')), ''),
    NULLIF(btrim(COALESCE(_reservation ->> 'origin_fbc', '')), ''),
    COALESCE(_reservation -> 'attribution_snapshot', '{}'::jsonb),
    'public',
    _schedule.rule_id,
    _availability_mode
  )
  RETURNING *
  INTO _created;

  RETURN _created;
END;
$$;

REVOKE ALL ON FUNCTION public.create_public_reservation(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(jsonb, text) TO anon;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(jsonb, text) TO service_role;
