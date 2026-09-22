-- Ciclo de vida completo das regras de disponibilidade.
--
--   * restore_reservation_schedule_rule devolve uma regra arquivada para a
--     lista, sempre como rascunho, para nao reativar horarios sem querer;
--   * delete_reservation_schedule_rule exclui em definitivo apenas regras que
--     nunca publicaram o horario de uma reserva, preservando a rastreabilidade
--     de reservations.applied_schedule_rule_id;
--   * get_reservation_schedule_rule_usage diz ao painel quais regras ainda
--     podem ser excluidas.

CREATE INDEX IF NOT EXISTS idx_reservations_applied_schedule_rule
  ON public.reservations(applied_schedule_rule_id)
  WHERE applied_schedule_rule_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.restore_reservation_schedule_rule(
  _rule_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company_id uuid;
BEGIN
  SELECT rsr.company_id
  INTO _company_id
  FROM public.reservation_schedule_rules rsr
  WHERE rsr.id = _rule_id
    AND rsr.archived_at IS NOT NULL;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Regra arquivada nao encontrada.';
  END IF;

  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  UPDATE public.reservation_schedule_rules
  SET
    archived_at = NULL,
    enabled = false
  WHERE id = _rule_id;
END;
$$;

REVOKE ALL ON FUNCTION public.restore_reservation_schedule_rule(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_reservation_schedule_rule(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_reservation_schedule_rule(
  _rule_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company_id uuid;
  _linked_reservations integer;
BEGIN
  SELECT rsr.company_id
  INTO _company_id
  FROM public.reservation_schedule_rules rsr
  WHERE rsr.id = _rule_id;

  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'Regra nao encontrada.';
  END IF;

  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'superadmin'::public.app_role)
    OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
  ) THEN
    RAISE EXCEPTION 'Nao autorizado.';
  END IF;

  SELECT count(*)::integer
  INTO _linked_reservations
  FROM public.reservations r
  WHERE r.applied_schedule_rule_id = _rule_id;

  IF _linked_reservations > 0 THEN
    RAISE EXCEPTION 'Esta regra ja gerou % reserva(s) e por isso so pode ser arquivada.', _linked_reservations;
  END IF;

  DELETE FROM public.reservation_schedule_rules
  WHERE id = _rule_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_reservation_schedule_rule(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_reservation_schedule_rule(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_reservation_schedule_rule_usage(
  _company_id uuid
)
RETURNS TABLE (
  rule_id uuid,
  reservations_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    rsr.id,
    count(r.id)::integer
  FROM public.reservation_schedule_rules rsr
  LEFT JOIN public.reservations r
    ON r.applied_schedule_rule_id = rsr.id
  WHERE rsr.company_id = _company_id
    AND auth.uid() IS NOT NULL
    AND (
      public.has_role(auth.uid(), 'superadmin'::public.app_role)
      OR public.has_role_in_company(auth.uid(), 'admin'::public.app_role, _company_id)
      OR public.has_role_in_company(auth.uid(), 'operator'::public.app_role, _company_id)
    )
  GROUP BY rsr.id;
$$;

REVOKE ALL ON FUNCTION public.get_reservation_schedule_rule_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reservation_schedule_rule_usage(uuid) TO authenticated;
