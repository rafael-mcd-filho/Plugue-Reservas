ALTER TABLE public.company_whatsapp_instances
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS profile_picture_url text;
