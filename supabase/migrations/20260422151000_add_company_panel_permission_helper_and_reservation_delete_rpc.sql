CREATE OR REPLACE FUNCTION public.has_company_panel_permission(
  _user_id uuid,
  _company_id uuid,
  _permission text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _overrides jsonb := '{}'::jsonb;
BEGIN
  IF _user_id IS NULL OR _company_id IS NULL OR COALESCE(btrim(_permission), '') = '' THEN
    RETURN false;
  END IF;

  IF public.has_role(_user_id, 'superadmin'::public.app_role)
    OR public.has_role_in_company(_user_id, 'admin'::public.app_role, _company_id) THEN
    RETURN true;
  END IF;

  IF NOT public.has_role_in_company(_user_id, 'operator'::public.app_role, _company_id) THEN
    RETURN false;
  END IF;

  SELECT permission_overrides
  INTO _overrides
  FROM public.company_user_panel_permissions
  WHERE user_id = _user_id
    AND company_id = _company_id
  LIMIT 1;

  _overrides := COALESCE(_overrides, '{}'::jsonb);

  CASE _permission
    WHEN 'dashboard_view' THEN
      RETURN COALESCE((_overrides ->> 'dashboard_view')::boolean, true);
    WHEN 'checkins_view' THEN
      RETURN COALESCE((_overrides ->> 'checkins_view')::boolean, true);
    WHEN 'reservations_view' THEN
      RETURN COALESCE((_overrides ->> 'reservations_view')::boolean, true);
    WHEN 'calendar_view' THEN
      RETURN COALESCE((_overrides ->> 'calendar_view')::boolean, true);
    WHEN 'waitlist_view' THEN
      RETURN COALESCE((_overrides ->> 'waitlist_view')::boolean, true);
    WHEN 'reservations_delete' THEN
      RETURN COALESCE((_overrides ->> 'reservations_delete')::boolean, false);
    WHEN 'tables_view' THEN
      RETURN COALESCE((_overrides ->> 'tables_view')::boolean, false);
    ELSE
      RETURN false;
  END CASE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_company_panel_permission(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_company_reservation(_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _reservation_company_id uuid;
BEGIN
  IF _reservation_id IS NULL THEN
    RAISE EXCEPTION 'reservation_id e obrigatorio';
  END IF;

  SELECT company_id
  INTO _reservation_company_id
  FROM public.reservations
  WHERE id = _reservation_id
  LIMIT 1;

  IF _reservation_company_id IS NULL THEN
    RAISE EXCEPTION 'Reserva nao encontrada';
  END IF;

  IF NOT public.has_company_panel_permission(auth.uid(), _reservation_company_id, 'reservations_delete') THEN
    RAISE EXCEPTION 'Seu perfil nao pode excluir reservas.';
  END IF;

  DELETE FROM public.reservations
  WHERE id = _reservation_id;

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_company_reservation(uuid) TO authenticated;
