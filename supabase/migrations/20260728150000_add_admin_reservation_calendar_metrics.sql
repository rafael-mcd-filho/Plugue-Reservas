DROP FUNCTION IF EXISTS public.get_admin_reservation_calendar_metrics(uuid, date, date);

CREATE OR REPLACE FUNCTION public.get_admin_reservation_calendar_metrics(
  _company_id uuid,
  _start_date date,
  _end_date date
)
RETURNS TABLE (
  reservation_date date,
  reservation_count bigint,
  guest_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.has_company_panel_permission(auth.uid(), _company_id, 'calendar_view') THEN
    RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
  END IF;

  IF _start_date IS NULL OR _end_date IS NULL OR _end_date < _start_date THEN
    RAISE EXCEPTION 'Intervalo de datas invalido.';
  END IF;

  IF (_end_date - _start_date) > 62 THEN
    RAISE EXCEPTION 'O intervalo do calendario nao pode ultrapassar 63 dias.';
  END IF;

  RETURN QUERY
  SELECT
    r.date AS reservation_date,
    count(*)::bigint AS reservation_count,
    COALESCE(sum(r.party_size), 0)::bigint AS guest_count
  FROM public.reservations r
  WHERE r.company_id = _company_id
    AND r.date BETWEEN _start_date AND _end_date
    -- Espelha normalizeReservationStatus + filtro "Ativas" da tela Reservas:
    -- estados legados/desconhecidos caem em confirmed, enquanto estes estados
    -- sao explicitamente nao ativos.
    AND lower(btrim(r.status)) NOT IN (
      'pending_payment',
      'cancelled',
      'no-show',
      'no_show',
      'payment_expired',
      'payment_cancelled',
      'paid_after_expiration'
    )
  GROUP BY r.date
  ORDER BY r.date;
END;
$$;

COMMENT ON FUNCTION public.get_admin_reservation_calendar_metrics(uuid, date, date)
IS 'Totais diarios de reservas ativas para os selos do calendario operacional.';

REVOKE ALL ON FUNCTION public.get_admin_reservation_calendar_metrics(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_reservation_calendar_metrics(uuid, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_reservation_calendar_metrics(uuid, date, date) TO authenticated;
