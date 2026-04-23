DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'company_user_panel_permissions'
  ) THEN
    UPDATE public.company_user_panel_permissions
    SET permission_overrides = COALESCE((
      SELECT jsonb_object_agg(item.key, item.value)
      FROM jsonb_each(permission_overrides) AS item(key, value)
      WHERE item.key IN (
        'dashboard_view',
        'checkins_view',
        'reservations_view',
        'reservations_delete',
        'calendar_view',
        'tables_view',
        'waitlist_view'
      )
      AND jsonb_typeof(item.value) = 'boolean'
    ), '{}'::jsonb);

    UPDATE public.company_user_panel_permissions
    SET permission_overrides = jsonb_set(permission_overrides, '{reservations_view}', 'true'::jsonb, true)
    WHERE COALESCE((permission_overrides ->> 'reservations_delete')::boolean, false)
      AND COALESCE((permission_overrides ->> 'reservations_view')::boolean, true) = false;

    DELETE FROM public.company_user_panel_permissions cpp
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = cpp.user_id
        AND ur.company_id = cpp.company_id
        AND ur.role = 'operator'::public.app_role
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_operator_panel_permission_overrides(_overrides jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _overrides IS NULL THEN true
    WHEN jsonb_typeof(_overrides) <> 'object' THEN false
    ELSE (
      NOT EXISTS (
        SELECT 1
        FROM jsonb_each(_overrides) AS item(key, value)
        WHERE item.key NOT IN (
          'dashboard_view',
          'checkins_view',
          'reservations_view',
          'reservations_delete',
          'calendar_view',
          'tables_view',
          'waitlist_view'
        )
        OR jsonb_typeof(item.value) <> 'boolean'
      )
      AND NOT (
        COALESCE((_overrides ->> 'reservations_delete')::boolean, false)
        AND COALESCE((_overrides ->> 'reservations_view')::boolean, true) = false
      )
    )
  END
$$;

ALTER TABLE public.company_user_panel_permissions
  DROP CONSTRAINT IF EXISTS company_user_panel_permissions_valid_operator_overrides;

ALTER TABLE public.company_user_panel_permissions
  ADD CONSTRAINT company_user_panel_permissions_valid_operator_overrides
  CHECK (public.is_valid_operator_panel_permission_overrides(permission_overrides));

CREATE OR REPLACE FUNCTION public.enforce_company_user_panel_permissions_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role_in_company(NEW.user_id, 'operator'::public.app_role, NEW.company_id) THEN
    RAISE EXCEPTION 'As permissões modulares só podem ser salvas para operadores da própria empresa.';
  END IF;

  NEW.permission_overrides := COALESCE(NEW.permission_overrides, '{}'::jsonb);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_company_user_panel_permissions_target
  ON public.company_user_panel_permissions;
CREATE TRIGGER trg_enforce_company_user_panel_permissions_target
BEFORE INSERT OR UPDATE
ON public.company_user_panel_permissions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_company_user_panel_permissions_target();

DROP POLICY IF EXISTS "Superadmins can manage all company user panel permissions"
  ON public.company_user_panel_permissions;
DROP POLICY IF EXISTS "Admins can manage company user panel permissions in their company"
  ON public.company_user_panel_permissions;

DROP POLICY IF EXISTS "Superadmins can view all company user panel permissions"
  ON public.company_user_panel_permissions;
CREATE POLICY "Superadmins can view all company user panel permissions"
  ON public.company_user_panel_permissions
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'superadmin'::public.app_role));

DROP POLICY IF EXISTS "Admins can view company user panel permissions in their company"
  ON public.company_user_panel_permissions;
CREATE POLICY "Admins can view company user panel permissions in their company"
  ON public.company_user_panel_permissions
  FOR SELECT
  TO authenticated
  USING (public.has_role_in_company(auth.uid(), 'admin'::public.app_role, company_id));
