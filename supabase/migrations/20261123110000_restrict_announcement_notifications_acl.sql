-- Supabase may explicitly grant anon EXECUTE through default privileges.
-- Revoking PUBLIC alone does not remove that inherited explicit role grant.
-- Preserve the existing function body, authenticated access and role checks.
REVOKE EXECUTE ON FUNCTION public.get_company_announcement_notifications(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_company_announcement_notifications(uuid, integer)
  TO authenticated;
