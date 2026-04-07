CREATE TABLE IF NOT EXISTS public.table_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT table_sections_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT table_sections_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_table_sections_company_code
  ON public.table_sections(company_id, code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_table_sections_company_name
  ON public.table_sections(company_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_table_sections_company_sort_order
  ON public.table_sections(company_id, sort_order, created_at);

ALTER TABLE public.table_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view table sections of active companies" ON public.table_sections;
CREATE POLICY "Public can view table sections of active companies"
ON public.table_sections
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

DROP POLICY IF EXISTS "Users can view their company table sections" ON public.table_sections;
CREATE POLICY "Users can view their company table sections"
ON public.table_sections
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

DROP POLICY IF EXISTS "Admins can manage company table sections" ON public.table_sections;
CREATE POLICY "Admins can manage company table sections"
ON public.table_sections
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

INSERT INTO public.table_sections (company_id, code, name, sort_order)
SELECT
  c.id,
  seed.code,
  seed.name,
  seed.sort_order
FROM public.companies c
CROSS JOIN (
  VALUES
    ('salao', 'Salao Principal', 10),
    ('varanda', 'Varanda', 20),
    ('privativo', 'Area Privativa', 30)
) AS seed(code, name, sort_order)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.table_sections ts
  WHERE ts.company_id = c.id
    AND ts.code = seed.code
);

UPDATE public.restaurant_tables
SET section = 'salao'
WHERE lower(btrim(section)) IN ('salão', 'salÃ£o', 'salao');

UPDATE public.restaurant_tables
SET section = 'varanda'
WHERE lower(btrim(section)) = 'varanda';

UPDATE public.restaurant_tables
SET section = 'privativo'
WHERE lower(btrim(section)) = 'privativo';

UPDATE public.restaurant_tables
SET section = COALESCE(
  NULLIF(
    trim(
      BOTH '-'
      FROM regexp_replace(
        translate(
          lower(btrim(section)),
          'ãáàâäéèêëíìîïóòôõöúùûüçñ',
          'aaaaaeeeeiiiiooooouuuucn'
        ),
        '[^a-z0-9]+',
        '-',
        'g'
      )
    ),
    ''
  ),
  'secao-extra'
)
WHERE lower(btrim(section)) NOT IN ('salão', 'salÃ£o', 'salao', 'varanda', 'privativo');

INSERT INTO public.table_sections (company_id, code, name, sort_order)
SELECT DISTINCT
  rt.company_id,
  rt.section,
  initcap(replace(rt.section, '-', ' ')),
  100
FROM public.restaurant_tables rt
WHERE NOT EXISTS (
  SELECT 1
  FROM public.table_sections ts
  WHERE ts.company_id = rt.company_id
    AND ts.code = rt.section
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'restaurant_tables_company_id_section_fkey'
  ) THEN
    ALTER TABLE public.restaurant_tables
      ADD CONSTRAINT restaurant_tables_company_id_section_fkey
      FOREIGN KEY (company_id, section)
      REFERENCES public.table_sections(company_id, code)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_default_table_sections_for_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.table_sections (company_id, code, name, sort_order)
  VALUES
    (NEW.id, 'salao', 'Salao Principal', 10),
    (NEW.id, 'varanda', 'Varanda', 20),
    (NEW.id, 'privativo', 'Area Privativa', 30)
  ON CONFLICT (company_id, code) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_default_table_sections_for_company ON public.companies;
CREATE TRIGGER trg_ensure_default_table_sections_for_company
AFTER INSERT
ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.ensure_default_table_sections_for_company();

CREATE OR REPLACE FUNCTION public.validate_table_map_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.name := btrim(COALESCE(NEW.name, ''));

  IF NEW.name = '' THEN
    RAISE EXCEPTION 'Informe o nome do mapa.';
  END IF;

  IF NEW.is_default THEN
    NEW.is_enabled := true;
    NEW.active_from := NULL;
    NEW.active_to := NULL;
    RETURN NEW;
  END IF;

  IF NEW.active_from IS NOT NULL
     AND NEW.active_to IS NOT NULL
     AND NEW.active_from >= NEW.active_to THEN
    RAISE EXCEPTION 'O periodo final do mapa precisa ser maior que o inicial.';
  END IF;

  IF NEW.is_enabled AND NEW.active_from IS NULL THEN
    RAISE EXCEPTION 'Mapas de evento habilitados precisam ter uma data de inicio.';
  END IF;

  IF NEW.is_enabled
     AND NEW.active_from IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.table_maps tm
       WHERE tm.company_id = NEW.company_id
         AND tm.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
         AND tm.is_default = false
         AND tm.is_enabled = true
         AND tm.active_from IS NOT NULL
         AND tstzrange(
           tm.active_from,
           COALESCE(tm.active_to, 'infinity'::timestamptz),
           '[)'
         ) && tstzrange(
           NEW.active_from,
           COALESCE(NEW.active_to, 'infinity'::timestamptz),
           '[)'
         )
     ) THEN
    RAISE EXCEPTION 'Ja existe outro mapa de evento habilitado neste periodo.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_table_map_schedule ON public.table_maps;
CREATE TRIGGER trg_validate_table_map_schedule
BEFORE INSERT OR UPDATE OF company_id, name, is_default, is_enabled, active_from, active_to
ON public.table_maps
FOR EACH ROW
EXECUTE FUNCTION public.validate_table_map_schedule();
