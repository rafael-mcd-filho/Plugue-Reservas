-- Audit history outlives an Auth account. Keep an immutable actor snapshot
-- while allowing the live account reference to detach during Auth deletion.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.audit_logs
  ADD COLUMN actor_user_id uuid,
  ADD COLUMN actor_name text,
  ADD COLUMN actor_email text;

UPDATE public.audit_logs AS log
SET actor_user_id = log.user_id,
    actor_name = COALESCE(NULLIF(btrim(profile.full_name), ''),
      NULLIF(btrim(account.raw_user_meta_data->>'full_name'), '')),
    actor_email = COALESCE(NULLIF(btrim(profile.email), ''),
      NULLIF(btrim(account.email), ''))
FROM auth.users AS account
LEFT JOIN public.profiles AS profile ON profile.id = account.id
WHERE account.id = log.user_id;

ALTER TABLE public.audit_logs
  ALTER COLUMN actor_user_id SET NOT NULL,
  ALTER COLUMN user_id DROP NOT NULL,
  DROP CONSTRAINT audit_logs_user_id_fkey;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.audit_logs.user_id IS
  'Live Auth account reference; null after account deletion.';
COMMENT ON COLUMN public.audit_logs.actor_user_id IS
  'Immutable actor UUID captured at insertion; retained after Auth account deletion.';
COMMENT ON COLUMN public.audit_logs.actor_name IS
  'Actor name captured at insertion; later profile changes do not rewrite history.';
COMMENT ON COLUMN public.audit_logs.actor_email IS
  'Actor email captured at insertion; later account changes do not rewrite history.';

CREATE FUNCTION public.capture_audit_log_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Keep the existing requirement that new records name a live actor.
    -- The FK below still rejects non-existent UUIDs with foreign_key_violation.
    IF NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'New audit records require an actor user_id.'
        USING ERRCODE = '23502', TABLE = 'audit_logs', COLUMN = 'user_id';
    END IF;

    -- Ignore client-supplied snapshots: derive every field from the live actor.
    NEW.actor_user_id := NEW.user_id;
    SELECT COALESCE(NULLIF(btrim(profile.full_name), ''),
             NULLIF(btrim(account.raw_user_meta_data->>'full_name'), '')),
           COALESCE(NULLIF(btrim(profile.email), ''),
             NULLIF(btrim(account.email), ''))
    INTO NEW.actor_name, NEW.actor_email
    FROM auth.users AS account
    LEFT JOIN public.profiles AS profile ON profile.id = account.id
    WHERE account.id = NEW.user_id;
  ELSE
    IF NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
      OR NEW.actor_name IS DISTINCT FROM OLD.actor_name
      OR NEW.actor_email IS DISTINCT FROM OLD.actor_email THEN
      RAISE EXCEPTION 'Audit actor snapshots are immutable.' USING ERRCODE = '23514';
    END IF;
    -- An Auth FK cascade may detach the reference, but cannot replace the actor.
    IF NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL THEN
      RAISE EXCEPTION 'The actor of an audit record cannot be reassigned.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- SECURITY DEFINER lets FK-triggered updates from GoTrue run without granting
-- its database role access to profiles, audit history, or Auth snapshot fields.
REVOKE ALL ON FUNCTION public.capture_audit_log_actor() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER capture_audit_log_actor
BEFORE INSERT OR UPDATE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_log_actor();

NOTIFY pgrst, 'reload schema';
