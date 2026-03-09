
-- Add new columns to companies
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS razao_social TEXT,
  ADD COLUMN IF NOT EXISTS cnpj TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS responsible_name TEXT,
  ADD COLUMN IF NOT EXISTS responsible_email TEXT,
  ADD COLUMN IF NOT EXISTS responsible_phone TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- status values: 'active', 'paused', 'defaulting' (inadimplente)
