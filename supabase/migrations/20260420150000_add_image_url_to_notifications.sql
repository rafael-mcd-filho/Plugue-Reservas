ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS image_url text;
