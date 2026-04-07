CREATE TABLE IF NOT EXISTS public.table_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  is_default boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true,
  active_from timestamptz,
  active_to timestamptz,
  priority integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT table_maps_active_window_check CHECK (active_from IS NULL OR active_to IS NULL OR active_from <= active_to),
  CONSTRAINT table_maps_default_window_check CHECK ((is_default AND active_from IS NULL AND active_to IS NULL) OR NOT is_default)
);

CREATE INDEX IF NOT EXISTS idx_table_maps_company_id
  ON public.table_maps(company_id);

CREATE INDEX IF NOT EXISTS idx_table_maps_company_active_window
  ON public.table_maps(company_id, active_from, active_to)
  WHERE is_enabled = true;

ALTER TABLE public.table_maps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view table maps of active companies" ON public.table_maps;
CREATE POLICY "Public can view table maps of active companies"
ON public.table_maps
FOR SELECT
TO anon
USING (
  EXISTS (
    SELECT 1
    FROM public.companies c
    WHERE c.id = company_id
      AND c.status = 'active'
  )
);

DROP POLICY IF EXISTS "Users can view their company table maps" ON public.table_maps;
CREATE POLICY "Users can view their company table maps"
ON public.table_maps
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'superadmin')
  OR company_id IN (
    SELECT p.company_id
    FROM public.profiles p
    WHERE p.id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Admins can manage company table maps" ON public.table_maps;
CREATE POLICY "Admins can manage company table maps"
ON public.table_maps
FOR ALL
TO authenticated
USING (
  has_role(auth.uid(), 'superadmin')
  OR has_role_in_company(auth.uid(), 'admin', company_id)
)
WITH CHECK (
  has_role(auth.uid(), 'superadmin')
  OR has_role_in_company(auth.uid(), 'admin', company_id)
);

INSERT INTO public.table_maps (company_id, name, is_default, is_enabled, priority)
SELECT DISTINCT
  c.id,
  'Mapa padrao',
  true,
  true,
  1000
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1
  FROM public.table_maps tm
  WHERE tm.company_id = c.id
    AND tm.is_default = true
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_table_maps_company_default
  ON public.table_maps(company_id)
  WHERE is_default = true;

ALTER TABLE public.restaurant_tables
  ADD COLUMN IF NOT EXISTS table_map_id uuid;

UPDATE public.restaurant_tables rt
SET table_map_id = tm.id
FROM public.table_maps tm
WHERE tm.company_id = rt.company_id
  AND tm.is_default = true
  AND rt.table_map_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'restaurant_tables_table_map_id_fkey'
  ) THEN
    ALTER TABLE public.restaurant_tables
      ADD CONSTRAINT restaurant_tables_table_map_id_fkey
      FOREIGN KEY (table_map_id) REFERENCES public.table_maps(id) ON DELETE CASCADE;
  END IF;
END;
$$;

ALTER TABLE public.restaurant_tables
  ALTER COLUMN table_map_id SET NOT NULL;

DROP INDEX IF EXISTS idx_restaurant_tables_table_map_id;
CREATE INDEX idx_restaurant_tables_table_map_id
  ON public.restaurant_tables(table_map_id);

ALTER TABLE public.restaurant_tables
  DROP CONSTRAINT IF EXISTS restaurant_tables_company_id_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_tables_table_map_number
  ON public.restaurant_tables(table_map_id, number);

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS table_map_id uuid REFERENCES public.table_maps(id) ON DELETE SET NULL;

UPDATE public.reservations r
SET table_map_id = rt.table_map_id
FROM public.restaurant_tables rt
WHERE rt.id = r.table_id
  AND r.table_map_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_company_date_time_table_map
  ON public.reservations(company_id, date, time, table_map_id);

CREATE OR REPLACE FUNCTION public.sync_restaurant_table_map()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _map_company_id uuid;
BEGIN
  IF NEW.table_map_id IS NULL THEN
    SELECT tm.id, tm.company_id
    INTO NEW.table_map_id, _map_company_id
    FROM public.table_maps tm
    WHERE tm.company_id = NEW.company_id
      AND tm.is_default = true
    LIMIT 1;
  ELSE
    SELECT tm.company_id
    INTO _map_company_id
    FROM public.table_maps tm
    WHERE tm.id = NEW.table_map_id
    LIMIT 1;
  END IF;

  IF NEW.table_map_id IS NULL OR _map_company_id IS NULL THEN
    RAISE EXCEPTION 'Mapa da mesa nao encontrado.';
  END IF;

  NEW.company_id := _map_company_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_restaurant_table_map ON public.restaurant_tables;
CREATE TRIGGER trg_sync_restaurant_table_map
BEFORE INSERT OR UPDATE OF company_id, table_map_id
ON public.restaurant_tables
FOR EACH ROW
EXECUTE FUNCTION public.sync_restaurant_table_map();

CREATE OR REPLACE FUNCTION public.ensure_default_table_map_for_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.table_maps (company_id, name, is_default, is_enabled, priority)
  SELECT NEW.id, 'Mapa padrao', true, true, 1000
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.table_maps tm
    WHERE tm.company_id = NEW.id
      AND tm.is_default = true
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_default_table_map_for_company ON public.companies;
CREATE TRIGGER trg_ensure_default_table_map_for_company
AFTER INSERT
ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.ensure_default_table_map_for_company();

CREATE OR REPLACE FUNCTION public.sync_reservation_table_map()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.table_id IS NULL THEN
    NEW.table_map_id := NULL;
    RETURN NEW;
  END IF;

  SELECT rt.table_map_id
  INTO NEW.table_map_id
  FROM public.restaurant_tables rt
  WHERE rt.id = NEW.table_id
  LIMIT 1;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_reservation_table_map ON public.reservations;
CREATE TRIGGER trg_sync_reservation_table_map
BEFORE INSERT OR UPDATE OF table_id
ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.sync_reservation_table_map();

DROP FUNCTION IF EXISTS public.get_active_table_map(uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.get_active_table_map(
  _company_id uuid,
  _reservation_at timestamptz DEFAULT now()
)
RETURNS TABLE (
  id uuid,
  name text,
  is_default boolean,
  is_enabled boolean,
  active_from timestamptz,
  active_to timestamptz,
  priority integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH special_map AS (
    SELECT
      tm.id,
      tm.name,
      tm.is_default,
      tm.is_enabled,
      tm.active_from,
      tm.active_to,
      tm.priority
    FROM public.table_maps tm
    WHERE tm.company_id = _company_id
      AND tm.is_default = false
      AND tm.is_enabled = true
      AND tm.active_from IS NOT NULL
      AND tm.active_from <= _reservation_at
      AND COALESCE(tm.active_to, _reservation_at) >= _reservation_at
    ORDER BY tm.priority ASC, tm.active_from DESC, tm.created_at DESC
    LIMIT 1
  ),
  default_map AS (
    SELECT
      tm.id,
      tm.name,
      tm.is_default,
      tm.is_enabled,
      tm.active_from,
      tm.active_to,
      tm.priority
    FROM public.table_maps tm
    WHERE tm.company_id = _company_id
      AND tm.is_default = true
    ORDER BY tm.updated_at DESC
    LIMIT 1
  )
  SELECT * FROM special_map
  UNION ALL
  SELECT * FROM default_map
  WHERE NOT EXISTS (SELECT 1 FROM special_map)
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_table_map(uuid, timestamptz) TO anon;
GRANT EXECUTE ON FUNCTION public.get_active_table_map(uuid, timestamptz) TO authenticated;
