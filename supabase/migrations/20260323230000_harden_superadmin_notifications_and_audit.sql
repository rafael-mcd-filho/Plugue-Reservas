-- Expand legacy "send to all" notifications into per-company rows so they are
-- visible through company-scoped policies and read state.
INSERT INTO public.notifications (
  company_id,
  title,
  message,
  type,
  is_read,
  read_at,
  created_by,
  created_at
)
SELECT
  c.id,
  n.title,
  n.message,
  n.type,
  n.is_read,
  n.read_at,
  n.created_by,
  n.created_at
FROM public.notifications n
CROSS JOIN public.companies c
WHERE n.company_id IS NULL;

DELETE FROM public.notifications
WHERE company_id IS NULL;

DROP POLICY IF EXISTS "Users can view notifications for their company" ON public.notifications;
CREATE POLICY "Users can view notifications for their company"
ON public.notifications
FOR SELECT
TO authenticated
USING (
  company_id IN (
    SELECT ur.company_id
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('admin', 'operator')
      AND ur.company_id IS NOT NULL
  )
);

CREATE OR REPLACE FUNCTION public.mark_notifications_read(_notification_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _allowed_company_ids uuid[];
  _updated_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nao autorizado';
  END IF;

  IF _notification_ids IS NULL OR array_length(_notification_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT array_agg(DISTINCT ur.company_id)
  INTO _allowed_company_ids
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.role IN ('admin', 'operator')
    AND ur.company_id IS NOT NULL;

  UPDATE public.notifications n
  SET
    is_read = true,
    read_at = COALESCE(n.read_at, now())
  WHERE n.id = ANY(_notification_ids)
    AND (
      public.has_role(auth.uid(), 'superadmin')
      OR (
        _allowed_company_ids IS NOT NULL
        AND n.company_id = ANY(_allowed_company_ids)
      )
    );

  GET DIAGNOSTICS _updated_count = ROW_COUNT;
  RETURN _updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.audit_company_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor_id uuid := auth.uid();
BEGIN
  IF _actor_id IS NULL OR NOT public.has_role(_actor_id, 'superadmin') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.audit_logs (
    user_id,
    action,
    entity_type,
    entity_id,
    details
  )
  VALUES (
    _actor_id,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete_company' ELSE 'update_company' END,
    'company',
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    jsonb_build_object(
      'name', CASE WHEN TG_OP = 'DELETE' THEN OLD.name ELSE NEW.name END,
      'slug', CASE WHEN TG_OP = 'DELETE' THEN OLD.slug ELSE NEW.slug END,
      'status', CASE WHEN TG_OP = 'DELETE' THEN OLD.status ELSE NEW.status END
    )
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_company_changes ON public.companies;
CREATE TRIGGER trg_audit_company_changes
AFTER UPDATE OR DELETE ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.audit_company_changes();

CREATE OR REPLACE FUNCTION public.audit_system_setting_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _safe_value text;
BEGIN
  IF _actor_id IS NULL OR NOT public.has_role(_actor_id, 'superadmin') THEN
    RETURN NEW;
  END IF;

  _safe_value := CASE
    WHEN NEW.key IN ('system_name', 'system_logo_url') THEN NEW.value
    WHEN NEW.key IN ('evolution_api_url') THEN NEW.value
    ELSE NULL
  END;

  INSERT INTO public.audit_logs (
    user_id,
    action,
    entity_type,
    entity_id,
    details
  )
  VALUES (
    _actor_id,
    'update_settings',
    'system_setting',
    NEW.id,
    jsonb_build_object(
      'key', NEW.key,
      'value_present', NEW.value IS NOT NULL,
      'value', _safe_value
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_system_setting_changes ON public.system_settings;
CREATE TRIGGER trg_audit_system_setting_changes
AFTER UPDATE ON public.system_settings
FOR EACH ROW
EXECUTE FUNCTION public.audit_system_setting_changes();
