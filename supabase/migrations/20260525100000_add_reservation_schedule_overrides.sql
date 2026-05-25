CREATE TABLE IF NOT EXISTS public.reservation_schedule_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_interval_minutes integer NOT NULL DEFAULT 60,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, date),
  CONSTRAINT rso_end_after_start CHECK (end_time > start_time),
  CONSTRAINT rso_slot_interval_positive CHECK (slot_interval_minutes > 0)
);

CREATE INDEX IF NOT EXISTS idx_rso_company_date
  ON public.reservation_schedule_overrides(company_id, date);

ALTER TABLE public.reservation_schedule_overrides ENABLE ROW LEVEL SECURITY;

-- Admins e superadmins podem gerenciar
DROP POLICY IF EXISTS "Company admins can manage schedule overrides" ON public.reservation_schedule_overrides;
CREATE POLICY "Company admins can manage schedule overrides"
ON public.reservation_schedule_overrides
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'superadmin'::public.app_role)
  OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id)
);

-- Acesso público anônimo via RPC SECURITY DEFINER abaixo (não diretamente)

CREATE OR REPLACE FUNCTION public.touch_reservation_schedule_override_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_rso_updated_at ON public.reservation_schedule_overrides;
CREATE TRIGGER trg_touch_rso_updated_at
BEFORE UPDATE
ON public.reservation_schedule_overrides
FOR EACH ROW
EXECUTE FUNCTION public.touch_reservation_schedule_override_updated_at();

-- RPC pública: retorna os overrides futuros de uma empresa pelo ID (chamada pelo modal público)
DROP FUNCTION IF EXISTS public.get_public_schedule_overrides(uuid);
CREATE OR REPLACE FUNCTION public.get_public_schedule_overrides(_company_id uuid)
RETURNS TABLE (
  date date,
  start_time time,
  end_time time,
  slot_interval_minutes integer,
  label text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    rso.date,
    rso.start_time,
    rso.end_time,
    rso.slot_interval_minutes,
    rso.label
  FROM public.reservation_schedule_overrides rso
  INNER JOIN public.companies c ON c.id = rso.company_id
  WHERE rso.company_id = _company_id
    AND rso.date >= CURRENT_DATE
    AND c.status = 'active'
  ORDER BY rso.date;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_schedule_overrides(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_schedule_overrides(uuid) TO authenticated;
