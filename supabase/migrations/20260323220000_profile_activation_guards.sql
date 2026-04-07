ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

UPDATE public.profiles
SET is_active = true
WHERE is_active IS NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_company_active
ON public.profiles(company_id, is_active);
