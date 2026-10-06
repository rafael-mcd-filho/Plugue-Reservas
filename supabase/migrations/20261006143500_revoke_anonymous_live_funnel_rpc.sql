-- Hosted Supabase can retain explicit anon EXECUTE from legacy/default grants.
-- Revoking PUBLIC alone does not remove that grant. The RPC already validates
-- auth.role()/auth.uid(); remove anonymous execution as well.
REVOKE ALL ON FUNCTION public.get_live_funnel_presence(uuid, integer) FROM anon;

NOTIFY pgrst, 'reload schema';
