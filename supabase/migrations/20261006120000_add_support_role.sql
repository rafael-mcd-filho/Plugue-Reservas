-- PostgreSQL requires a new enum value to be committed before it is used.
-- Keep this migration separate from the support access foundation.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'support';
