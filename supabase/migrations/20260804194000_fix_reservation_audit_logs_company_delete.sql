-- The original table definition declares ON DELETE CASCADE, but environments
-- where reservation_audit_logs already existed kept the previous NO ACTION
-- foreign key because that migration used CREATE TABLE IF NOT EXISTS.
-- Company deletion is explicitly permanent, so its reservation audit history
-- must be removed with the rest of the company-owned data.

ALTER TABLE public.reservation_audit_logs
DROP CONSTRAINT IF EXISTS reservation_audit_logs_company_id_fkey;

ALTER TABLE public.reservation_audit_logs
ADD CONSTRAINT reservation_audit_logs_company_id_fkey
FOREIGN KEY (company_id)
REFERENCES public.companies(id)
ON DELETE CASCADE
NOT VALID;

ALTER TABLE public.reservation_audit_logs
VALIDATE CONSTRAINT reservation_audit_logs_company_id_fkey;

-- Keep INSERT/UPDATE on the existing audit function. DELETE needs a guarded
-- path because deleting a company cascades into reservations after the parent
-- row is no longer visible. In that case, inserting a new child audit row
-- would violate the company foreign key. A direct reservation deletion still
-- has a live parent company and remains fully audited.
DROP TRIGGER IF EXISTS trg_audit_reservation_changes ON public.reservations;

CREATE TRIGGER trg_audit_reservation_changes
AFTER INSERT OR UPDATE ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.audit_reservation_changes();

CREATE OR REPLACE FUNCTION public.audit_reservation_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor_user_id uuid := auth.uid();
  _actor_role text;
  _actor_source text;
  _actor_name text;
  _changes jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.companies company
    WHERE company.id = OLD.company_id
  ) THEN
    RETURN OLD;
  END IF;

  _actor_role := public.get_reservation_audit_actor_role(
    _actor_user_id,
    OLD.company_id,
    false
  );
  _actor_source := CASE
    WHEN _actor_user_id IS NOT NULL THEN 'panel'
    ELSE 'system'
  END;
  _actor_name := public.get_reservation_audit_actor_name(
    _actor_user_id,
    OLD.guest_name,
    false
  );
  _changes := jsonb_build_object(
    'guest_name', jsonb_build_object('old', to_jsonb(OLD.guest_name), 'new', to_jsonb(NULL::text)),
    'date', jsonb_build_object('old', to_jsonb(OLD.date), 'new', to_jsonb(NULL::date)),
    'time', jsonb_build_object('old', to_jsonb(OLD.time), 'new', to_jsonb(NULL::time)),
    'party_size', jsonb_build_object('old', to_jsonb(OLD.party_size), 'new', to_jsonb(NULL::integer)),
    'status', jsonb_build_object('old', to_jsonb(OLD.status), 'new', to_jsonb(NULL::text))
  );

  INSERT INTO public.reservation_audit_logs (
    reservation_id,
    company_id,
    actor_user_id,
    actor_name,
    actor_role,
    actor_source,
    action,
    summary,
    details
  )
  VALUES (
    OLD.id,
    OLD.company_id,
    _actor_user_id,
    _actor_name,
    _actor_role,
    _actor_source,
    'deleted',
    'Reserva excluida',
    jsonb_build_object('changes', _changes)
  );

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_reservation_deletion()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_reservation_deletion()
TO service_role;

DROP TRIGGER IF EXISTS trg_audit_reservation_deletion ON public.reservations;

CREATE TRIGGER trg_audit_reservation_deletion
AFTER DELETE ON public.reservations
FOR EACH ROW
EXECUTE FUNCTION public.audit_reservation_deletion();
