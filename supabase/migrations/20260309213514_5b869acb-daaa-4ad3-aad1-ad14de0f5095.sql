ALTER TABLE public.reservations ALTER COLUMN status SET DEFAULT 'confirmed';

-- Update any existing pending reservations to confirmed
UPDATE public.reservations SET status = 'confirmed' WHERE status = 'pending';