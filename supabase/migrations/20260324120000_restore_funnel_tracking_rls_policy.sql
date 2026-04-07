-- Restore RLS INSERT policy for public funnel tracking via RPC function
-- The SECURITY DEFINER function needs an INSERT policy to work correctly
-- (SELECT policies were not removed and already exist)

DROP POLICY IF EXISTS "Public funnel tracking via RPC" ON public.reservation_funnel_logs;

CREATE POLICY "Public funnel tracking via RPC"
ON public.reservation_funnel_logs
FOR INSERT
TO anon, authenticated
WITH CHECK (true);
