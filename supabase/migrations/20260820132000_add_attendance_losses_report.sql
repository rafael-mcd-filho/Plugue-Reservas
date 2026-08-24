-- Relatório avançado de Comparecimento & Perdas.
--
-- O recorte usa a data agendada da reserva no calendário da empresa. A função
-- interna abaixo centraliza a classificação operacional, a evidência de
-- WhatsApp dos dois provedores, pré-pagamento recebido e o último horário de
-- cancelamento disponível na auditoria. Nenhuma associação é tratada como
-- causalidade e nenhuma receita perdida é estimada.

CREATE OR REPLACE FUNCTION public._attendance_losses_rows(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _time_zone text
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  guest_name text,
  guest_phone text,
  guest_email text,
  source text,
  origin_affiliate_code text,
  origin_affiliate_name text,
  date date,
  "time" time,
  party_size integer,
  status text,
  occasion text,
  notes text,
  checked_in_at timestamptz,
  checked_in_party_size integer,
  created_at timestamptz,
  updated_at timestamptz,
  public_tracking_code text,
  outcome text,
  entry_method text,
  scheduled_at timestamptz,
  lead_days integer,
  cancelled_at timestamptz,
  cancellation_lead_hours numeric,
  whatsapp_evolution boolean,
  whatsapp_pluguechat boolean,
  has_whatsapp boolean,
  has_prepayment boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH selected_reservations AS MATERIALIZED (
    SELECT reservations.*
    FROM public.reservations
    WHERE reservations.company_id = _company_id
      AND reservations.date BETWEEN _period_start AND _period_end
  ),
  cancellation_audit AS (
    SELECT
      logs.reservation_id,
      -- A reserva pode ser reativada e cancelada novamente. Como o relatório
      -- descreve o estado atual, usamos a última transição para cancelamento.
      max(logs.created_at) AS cancelled_at
    FROM public.reservation_audit_logs logs
    JOIN selected_reservations selected
      ON selected.id = logs.reservation_id
    WHERE logs.company_id = _company_id
      AND lower(COALESCE(logs.details #>> '{changes,status,new}', '')) IN (
        'cancelled',
        'payment_expired',
        'payment_cancelled'
      )
    GROUP BY logs.reservation_id
  ),
  evolution_delivery AS (
    SELECT logs.reservation_id
    FROM public.whatsapp_message_logs logs
    JOIN selected_reservations selected
      ON selected.id = logs.reservation_id
    WHERE logs.company_id = _company_id
      AND logs.status = 'sent'
      AND logs.type IN ('confirmation', 'reminder_1h', 'reminder_24h')
      AND logs.created_at <= ((selected.date + selected.time) AT TIME ZONE _time_zone)
    GROUP BY logs.reservation_id
  ),
  pluguechat_delivery AS (
    SELECT logs.reservation_id
    FROM public.pluguechat_message_logs logs
    JOIN selected_reservations selected
      ON selected.id = logs.reservation_id
    WHERE logs.company_id = _company_id
      AND logs.status = 'sent'
      AND logs.type IN ('confirmation_message', 'reminder_1h', 'reminder_24h')
      AND logs.created_at <= ((selected.date + selected.time) AT TIME ZONE _time_zone)
    GROUP BY logs.reservation_id
  ),
  paid_reservations AS (
    SELECT payments.reservation_id
    FROM public.reservation_payments payments
    JOIN selected_reservations selected
      ON selected.id = payments.reservation_id
    WHERE payments.company_id = _company_id
      AND payments.paid_at IS NOT NULL
      -- "Pré-pagamento" só descreve dinheiro efetivamente recebido antes do
      -- horário reservado e ainda registrado em um estado pago. Pagamentos
      -- posteriores e cobranças estornadas/em disputa não entram no grupo.
      AND payments.status IN ('paid', 'late_paid')
      AND payments.paid_at <= ((selected.date + selected.time) AT TIME ZONE _time_zone)
    GROUP BY payments.reservation_id
  ),
  classified AS (
    SELECT
      selected.id,
      selected.company_id,
      selected.guest_name,
      selected.guest_phone,
      selected.guest_email,
      selected.source,
      selected.origin_affiliate_code,
      selected.origin_affiliate_name,
      selected.date,
      selected.time,
      selected.party_size,
      selected.status,
      selected.occasion,
      selected.notes,
      selected.checked_in_at,
      selected.checked_in_party_size,
      selected.created_at,
      selected.updated_at,
      selected.public_tracking_code,
      CASE
        WHEN lower(btrim(selected.status)) IN ('checked_in', 'completed') THEN 'attended'
        WHEN lower(btrim(selected.status)) IN ('no-show', 'no_show') THEN 'no_show'
        WHEN lower(btrim(selected.status)) IN ('cancelled', 'payment_expired', 'payment_cancelled') THEN 'cancelled'
        ELSE 'scheduled'
      END AS outcome,
      CASE
        WHEN lower(btrim(COALESCE(selected.source, ''))) = 'waitlist'
          OR selected.origin_waitlist_id IS NOT NULL THEN 'waitlist'
        WHEN selected.origin_affiliate_link_id IS NOT NULL THEN 'affiliate'
        WHEN selected.origin_tracking_session_id IS NOT NULL
          OR NULLIF(btrim(COALESCE(selected.origin_anonymous_id, '')), '') IS NOT NULL
          OR selected.attribution_snapshot ->> 'tracking_source' = 'public_web' THEN 'online'
        ELSE 'manual'
      END AS entry_method,
      (selected.date + selected.time) AT TIME ZONE _time_zone AS scheduled_at,
      GREATEST(
        0,
        selected.date - (selected.created_at AT TIME ZONE _time_zone)::date
      )::integer AS lead_days,
      cancellation_audit.cancelled_at,
      CASE
        WHEN cancellation_audit.cancelled_at IS NULL THEN NULL
        ELSE round(
          extract(epoch FROM (
            ((selected.date + selected.time) AT TIME ZONE _time_zone)
            - cancellation_audit.cancelled_at
          ))::numeric / 3600.0,
          2
        )
      END AS cancellation_lead_hours,
      evolution_delivery.reservation_id IS NOT NULL AS whatsapp_evolution,
      pluguechat_delivery.reservation_id IS NOT NULL AS whatsapp_pluguechat,
      evolution_delivery.reservation_id IS NOT NULL
        OR pluguechat_delivery.reservation_id IS NOT NULL AS has_whatsapp,
      paid_reservations.reservation_id IS NOT NULL AS has_prepayment
    FROM selected_reservations selected
    LEFT JOIN cancellation_audit
      ON cancellation_audit.reservation_id = selected.id
    LEFT JOIN evolution_delivery
      ON evolution_delivery.reservation_id = selected.id
    LEFT JOIN pluguechat_delivery
      ON pluguechat_delivery.reservation_id = selected.id
    LEFT JOIN paid_reservations
      ON paid_reservations.reservation_id = selected.id
  )
  SELECT * FROM classified;
$$;

COMMENT ON FUNCTION public._attendance_losses_rows(uuid, date, date, text) IS
  'Base interna do relatório de comparecimento; não é exposta aos clientes.';

REVOKE ALL ON FUNCTION public._attendance_losses_rows(uuid, date, date, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._attendance_losses_rows(uuid, date, date, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_attendance_losses_report(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _outcome text DEFAULT 'all',
  _entry_method text DEFAULT 'all',
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 20,
  _search text DEFAULT NULL,
  _include_comparison boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _time_zone text;
  _effective_outcome text := lower(btrim(COALESCE(_outcome, 'all')));
  _effective_entry_method text := lower(btrim(COALESCE(_entry_method, 'all')));
  _search_value text := NULLIF(btrim(COALESCE(_search, '')), '');
  _search_text text := NULLIF(lower(btrim(COALESCE(_search, ''))), '');
  _search_digits text := NULLIF(regexp_replace(COALESCE(_search, ''), '\D', '', 'g'), '');
  _period_days integer;
  _comparison_start date;
  _comparison_end date;
  _offset integer;
  _result jsonb;
BEGIN
  PERFORM public._assert_company_advanced_report_access(_company_id);
  PERFORM public._validate_advanced_report_range(_period_start, _period_end, 366);
  _time_zone := public._company_report_time_zone(_company_id);

  IF _effective_outcome NOT IN ('all', 'attended', 'no_show', 'cancelled', 'scheduled') THEN
    RAISE EXCEPTION 'outcome inválido.' USING ERRCODE = '22023';
  END IF;

  IF _effective_entry_method NOT IN ('all', 'online', 'affiliate', 'manual', 'waitlist') THEN
    RAISE EXCEPTION 'entry_method inválido.' USING ERRCODE = '22023';
  END IF;

  IF _page IS NULL OR _page < 1 THEN
    RAISE EXCEPTION 'page deve ser maior ou igual a 1.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'page_size deve estar entre 1 e 100.' USING ERRCODE = '22023';
  END IF;

  IF _search_text IS NOT NULL AND char_length(_search_text) > 200 THEN
    RAISE EXCEPTION 'search não pode ultrapassar 200 caracteres.' USING ERRCODE = '22023';
  END IF;

  _period_days := (_period_end - _period_start) + 1;
  _comparison_end := _period_start - 1;
  _comparison_start := _comparison_end - (_period_days - 1);
  _offset := (_page - 1) * _page_size;

  WITH current_base AS MATERIALIZED (
    SELECT *
    FROM public._attendance_losses_rows(
      _company_id,
      _period_start,
      _period_end,
      _time_zone
    )
  ),
  current_filtered AS MATERIALIZED (
    SELECT *
    FROM current_base
    WHERE (_effective_outcome = 'all' OR current_base.outcome = _effective_outcome)
      AND (_effective_entry_method = 'all' OR current_base.entry_method = _effective_entry_method)
  ),
  comparison_filtered AS MATERIALIZED (
    SELECT comparison_base.*
    FROM (SELECT 1 WHERE COALESCE(_include_comparison, true)) comparison_gate
    CROSS JOIN LATERAL public._attendance_losses_rows(
      _company_id, _comparison_start, _comparison_end, _time_zone
    ) comparison_base
    WHERE (_effective_outcome = 'all' OR comparison_base.outcome = _effective_outcome)
      AND (_effective_entry_method = 'all' OR comparison_base.entry_method = _effective_entry_method)
  ),
  current_summary_raw AS (
    SELECT
      count(*)::integer AS reservations,
      count(*) FILTER (WHERE outcome = 'attended')::integer AS attended,
      count(*) FILTER (WHERE outcome = 'no_show')::integer AS no_show,
      count(*) FILTER (WHERE outcome = 'cancelled')::integer AS cancelled,
      count(*) FILTER (WHERE outcome = 'scheduled')::integer AS scheduled,
      COALESCE(sum(party_size), 0)::integer AS reserved_people,
      COALESCE(sum(COALESCE(checked_in_party_size, party_size)) FILTER (WHERE outcome = 'attended'), 0)::integer AS attended_people,
      COALESCE(sum(party_size) FILTER (WHERE outcome IN ('no_show', 'cancelled')), 0)::integer AS lost_people
    FROM current_filtered
  ),
  current_summary AS (
    SELECT
      current_summary_raw.*,
      COALESCE(round(100.0 * attended / NULLIF(attended + no_show, 0), 1), 0) AS attendance_rate,
      COALESCE(round(100.0 * no_show / NULLIF(attended + no_show, 0), 1), 0) AS no_show_rate,
      COALESCE(round(100.0 * (no_show + cancelled) / NULLIF(attended + no_show + cancelled, 0), 1), 0) AS loss_rate
    FROM current_summary_raw
  ),
  comparison_summary_raw AS (
    SELECT
      count(*)::integer AS reservations,
      count(*) FILTER (WHERE outcome = 'attended')::integer AS attended,
      count(*) FILTER (WHERE outcome = 'no_show')::integer AS no_show,
      count(*) FILTER (WHERE outcome = 'cancelled')::integer AS cancelled,
      count(*) FILTER (WHERE outcome = 'scheduled')::integer AS scheduled,
      COALESCE(sum(party_size), 0)::integer AS reserved_people,
      COALESCE(sum(COALESCE(checked_in_party_size, party_size)) FILTER (WHERE outcome = 'attended'), 0)::integer AS attended_people,
      COALESCE(sum(party_size) FILTER (WHERE outcome IN ('no_show', 'cancelled')), 0)::integer AS lost_people
    FROM comparison_filtered
  ),
  comparison_summary AS (
    SELECT
      comparison_summary_raw.*,
      COALESCE(round(100.0 * attended / NULLIF(attended + no_show, 0), 1), 0) AS attendance_rate,
      COALESCE(round(100.0 * no_show / NULLIF(attended + no_show, 0), 1), 0) AS no_show_rate,
      COALESCE(round(100.0 * (no_show + cancelled) / NULLIF(attended + no_show + cancelled, 0), 1), 0) AS loss_rate
    FROM comparison_summary_raw
  ),
  report_days AS (
    SELECT day::date AS date
    FROM generate_series(_period_start, _period_end, interval '1 day') day
  ),
  daily_raw AS (
    SELECT
      report_days.date,
      count(current_filtered.id)::integer AS reservations,
      count(current_filtered.id) FILTER (WHERE outcome = 'attended')::integer AS attended,
      count(current_filtered.id) FILTER (WHERE outcome = 'no_show')::integer AS no_show,
      count(current_filtered.id) FILTER (WHERE outcome = 'cancelled')::integer AS cancelled,
      count(current_filtered.id) FILTER (WHERE outcome = 'scheduled')::integer AS scheduled,
      COALESCE(sum(current_filtered.party_size), 0)::integer AS reserved_people,
      COALESCE(sum(COALESCE(current_filtered.checked_in_party_size, current_filtered.party_size)) FILTER (WHERE outcome = 'attended'), 0)::integer AS attended_people,
      COALESCE(sum(current_filtered.party_size) FILTER (WHERE outcome IN ('no_show', 'cancelled')), 0)::integer AS lost_people
    FROM report_days
    LEFT JOIN current_filtered ON current_filtered.date = report_days.date
    GROUP BY report_days.date
  ),
  daily_metrics AS (
    SELECT
      daily_raw.*,
      COALESCE(round(100.0 * attended / NULLIF(attended + no_show, 0), 1), 0) AS attendance_rate,
      COALESCE(round(100.0 * no_show / NULLIF(attended + no_show, 0), 1), 0) AS no_show_rate,
      COALESCE(round(100.0 * (no_show + cancelled) / NULLIF(attended + no_show + cancelled, 0), 1), 0) AS loss_rate
    FROM daily_raw
  ),
  segment_definitions(dimension, sort_order, key, label) AS (
    VALUES
      ('weekday', 1, '1', 'Segunda-feira'),
      ('weekday', 2, '2', 'Terça-feira'),
      ('weekday', 3, '3', 'Quarta-feira'),
      ('weekday', 4, '4', 'Quinta-feira'),
      ('weekday', 5, '5', 'Sexta-feira'),
      ('weekday', 6, '6', 'Sábado'),
      ('weekday', 7, '7', 'Domingo'),
      ('time_band', 1, 'before_18', 'Antes das 18h'),
      ('time_band', 2, '18_20', '18h às 19h59'),
      ('time_band', 3, '20_22', '20h às 21h59'),
      ('time_band', 4, 'after_22', 'A partir das 22h'),
      ('party_size', 1, '1_2', '1–2 pessoas'),
      ('party_size', 2, '3_4', '3–4 pessoas'),
      ('party_size', 3, '5_6', '5–6 pessoas'),
      ('party_size', 4, '7_plus', '7+ pessoas'),
      ('lead_time', 1, 'same_day', 'Mesmo dia'),
      ('lead_time', 2, '1_2', '1–2 dias'),
      ('lead_time', 3, '3_7', '3–7 dias'),
      ('lead_time', 4, '8_14', '8–14 dias'),
      ('lead_time', 5, '15_30', '15–30 dias'),
      ('lead_time', 6, '31_plus', '31+ dias'),
      ('entry_method', 1, 'online', 'Online'),
      ('entry_method', 2, 'affiliate', 'Filiados e parceiros'),
      ('entry_method', 3, 'manual', 'Criada no painel'),
      ('entry_method', 4, 'waitlist', 'Convertida da fila')
  ),
  segment_raw AS (
    SELECT
      definitions.dimension,
      definitions.sort_order,
      definitions.key,
      definitions.label,
      count(current_filtered.id)::integer AS reservations,
      count(current_filtered.id) FILTER (WHERE outcome = 'attended')::integer AS attended,
      count(current_filtered.id) FILTER (WHERE outcome = 'no_show')::integer AS no_show,
      count(current_filtered.id) FILTER (WHERE outcome = 'cancelled')::integer AS cancelled,
      count(current_filtered.id) FILTER (WHERE outcome = 'scheduled')::integer AS scheduled,
      COALESCE(sum(current_filtered.party_size), 0)::integer AS reserved_people,
      COALESCE(sum(COALESCE(current_filtered.checked_in_party_size, current_filtered.party_size)) FILTER (WHERE outcome = 'attended'), 0)::integer AS attended_people,
      COALESCE(sum(current_filtered.party_size) FILTER (WHERE outcome IN ('no_show', 'cancelled')), 0)::integer AS lost_people
    FROM segment_definitions definitions
    LEFT JOIN current_filtered ON CASE definitions.dimension
      WHEN 'weekday' THEN extract(isodow FROM current_filtered.date)::text = definitions.key
      WHEN 'time_band' THEN CASE
        WHEN current_filtered.time < time '18:00' THEN 'before_18'
        WHEN current_filtered.time < time '20:00' THEN '18_20'
        WHEN current_filtered.time < time '22:00' THEN '20_22'
        ELSE 'after_22'
      END = definitions.key
      WHEN 'party_size' THEN CASE
        WHEN current_filtered.party_size <= 2 THEN '1_2'
        WHEN current_filtered.party_size <= 4 THEN '3_4'
        WHEN current_filtered.party_size <= 6 THEN '5_6'
        ELSE '7_plus'
      END = definitions.key
      WHEN 'lead_time' THEN CASE
        WHEN current_filtered.lead_days = 0 THEN 'same_day'
        WHEN current_filtered.lead_days <= 2 THEN '1_2'
        WHEN current_filtered.lead_days <= 7 THEN '3_7'
        WHEN current_filtered.lead_days <= 14 THEN '8_14'
        WHEN current_filtered.lead_days <= 30 THEN '15_30'
        ELSE '31_plus'
      END = definitions.key
      WHEN 'entry_method' THEN current_filtered.entry_method = definitions.key
      ELSE false
    END
    GROUP BY definitions.dimension, definitions.sort_order, definitions.key, definitions.label
  ),
  segment_metrics AS (
    SELECT
      segment_raw.*,
      COALESCE(round(100.0 * attended / NULLIF(attended + no_show, 0), 1), 0) AS attendance_rate,
      COALESCE(round(100.0 * no_show / NULLIF(attended + no_show, 0), 1), 0) AS no_show_rate,
      COALESCE(round(100.0 * (no_show + cancelled) / NULLIF(attended + no_show + cancelled, 0), 1), 0) AS loss_rate
    FROM segment_raw
  ),
  association_definitions(dimension, sort_order, key, label) AS (
    VALUES
      ('whatsapp', 1, 'with', 'Com envio registrado'),
      ('whatsapp', 2, 'without', 'Sem envio registrado'),
      ('prepayment', 1, 'with', 'Com pré-pagamento recebido'),
      ('prepayment', 2, 'without', 'Sem pré-pagamento recebido')
  ),
  association_raw AS (
    SELECT
      definitions.dimension,
      definitions.sort_order,
      definitions.key,
      definitions.label,
      count(current_filtered.id)::integer AS reservations,
      count(current_filtered.id) FILTER (WHERE outcome = 'attended')::integer AS attended,
      count(current_filtered.id) FILTER (WHERE outcome = 'no_show')::integer AS no_show,
      count(current_filtered.id) FILTER (WHERE outcome = 'cancelled')::integer AS cancelled,
      count(current_filtered.id) FILTER (WHERE outcome = 'scheduled')::integer AS scheduled,
      COALESCE(sum(current_filtered.party_size), 0)::integer AS reserved_people,
      COALESCE(sum(COALESCE(current_filtered.checked_in_party_size, current_filtered.party_size)) FILTER (WHERE outcome = 'attended'), 0)::integer AS attended_people,
      COALESCE(sum(current_filtered.party_size) FILTER (WHERE outcome IN ('no_show', 'cancelled')), 0)::integer AS lost_people,
      count(current_filtered.id) FILTER (WHERE current_filtered.whatsapp_evolution)::integer AS evolution_reservations,
      count(current_filtered.id) FILTER (WHERE current_filtered.whatsapp_pluguechat)::integer AS pluguechat_reservations
    FROM association_definitions definitions
    LEFT JOIN current_filtered ON CASE definitions.dimension
      WHEN 'whatsapp' THEN current_filtered.has_whatsapp = (definitions.key = 'with')
      WHEN 'prepayment' THEN current_filtered.has_prepayment = (definitions.key = 'with')
      ELSE false
    END
    GROUP BY definitions.dimension, definitions.sort_order, definitions.key, definitions.label
  ),
  association_metrics AS (
    SELECT
      association_raw.*,
      COALESCE(round(100.0 * attended / NULLIF(attended + no_show, 0), 1), 0) AS attendance_rate,
      COALESCE(round(100.0 * no_show / NULLIF(attended + no_show, 0), 1), 0) AS no_show_rate,
      COALESCE(round(100.0 * (no_show + cancelled) / NULLIF(attended + no_show + cancelled, 0), 1), 0) AS loss_rate
    FROM association_raw
  ),
  cancellation_definitions(sort_order, key, label) AS (
    VALUES
      (1, '3d_plus', '3 dias ou mais antes'),
      (2, '1_3d', 'Entre 1 e 3 dias antes'),
      (3, '6_24h', 'Entre 6 e 24 horas antes'),
      (4, '2_6h', 'Entre 2 e 6 horas antes'),
      (5, 'under_2h', 'Menos de 2 horas antes'),
      (6, 'after_start', 'Após o horário agendado'),
      (7, 'without_audit', 'Sem horário auditado')
  ),
  cancelled_rows AS MATERIALIZED (
    SELECT * FROM current_filtered WHERE outcome = 'cancelled'
  ),
  cancellation_raw AS (
    SELECT
      definitions.sort_order,
      definitions.key,
      definitions.label,
      count(cancelled_rows.id)::integer AS reservations,
      COALESCE(sum(cancelled_rows.party_size), 0)::integer AS people
    FROM cancellation_definitions definitions
    LEFT JOIN cancelled_rows ON CASE
      WHEN cancelled_rows.cancelled_at IS NULL THEN definitions.key = 'without_audit'
      WHEN cancelled_rows.cancellation_lead_hours < 0 THEN definitions.key = 'after_start'
      WHEN cancelled_rows.cancellation_lead_hours < 2 THEN definitions.key = 'under_2h'
      WHEN cancelled_rows.cancellation_lead_hours < 6 THEN definitions.key = '2_6h'
      WHEN cancelled_rows.cancellation_lead_hours < 24 THEN definitions.key = '6_24h'
      WHEN cancelled_rows.cancellation_lead_hours < 72 THEN definitions.key = '1_3d'
      ELSE definitions.key = '3d_plus'
    END
    GROUP BY definitions.sort_order, definitions.key, definitions.label
  ),
  cancellation_metrics AS (
    SELECT
      cancellation_raw.*,
      COALESCE(round(
        100.0 * cancellation_raw.reservations
        / NULLIF((SELECT count(*) FROM cancelled_rows), 0),
        1
      ), 0) AS percentage
    FROM cancellation_raw
  ),
  audit_coverage AS (
    SELECT min(logs.created_at) AS coverage_start
    FROM public.reservation_audit_logs logs
    WHERE logs.company_id = _company_id
  ),
  searched_reservations AS MATERIALIZED (
    SELECT *
    FROM current_filtered
    WHERE _search_text IS NULL
      OR position(_search_text IN lower(COALESCE(guest_name, ''))) > 0
      OR position(_search_text IN lower(COALESCE(guest_email, ''))) > 0
      OR (
        _search_digits IS NOT NULL
        AND position(_search_digits IN regexp_replace(COALESCE(guest_phone, ''), '\D', '', 'g')) > 0
      )
  ),
  paged_reservations AS (
    SELECT searched_reservations.*
    FROM searched_reservations
    ORDER BY searched_reservations.date DESC, searched_reservations.time DESC, searched_reservations.id DESC
    LIMIT _page_size OFFSET _offset
  )
  SELECT jsonb_build_object(
    'summary', to_jsonb(current_summary),
    'comparison', CASE
      WHEN COALESCE(_include_comparison, true) THEN
        to_jsonb(comparison_summary) || jsonb_build_object(
          'period_start', _comparison_start,
          'period_end', _comparison_end
        )
      ELSE NULL
    END,
    'daily_series', COALESCE((
      SELECT jsonb_agg(to_jsonb(daily_metrics) ORDER BY daily_metrics.date)
      FROM daily_metrics
    ), '[]'::jsonb),
    'segments', jsonb_build_object(
      'weekday', COALESCE((SELECT jsonb_agg(to_jsonb(segment_metrics) - 'dimension' ORDER BY sort_order) FROM segment_metrics WHERE dimension = 'weekday'), '[]'::jsonb),
      'time_band', COALESCE((SELECT jsonb_agg(to_jsonb(segment_metrics) - 'dimension' ORDER BY sort_order) FROM segment_metrics WHERE dimension = 'time_band'), '[]'::jsonb),
      'party_size', COALESCE((SELECT jsonb_agg(to_jsonb(segment_metrics) - 'dimension' ORDER BY sort_order) FROM segment_metrics WHERE dimension = 'party_size'), '[]'::jsonb),
      'lead_time', COALESCE((SELECT jsonb_agg(to_jsonb(segment_metrics) - 'dimension' ORDER BY sort_order) FROM segment_metrics WHERE dimension = 'lead_time'), '[]'::jsonb),
      'entry_method', COALESCE((SELECT jsonb_agg(to_jsonb(segment_metrics) - 'dimension' ORDER BY sort_order) FROM segment_metrics WHERE dimension = 'entry_method'), '[]'::jsonb)
    ),
    'associations', jsonb_build_object(
      'whatsapp', COALESCE((SELECT jsonb_agg(to_jsonb(association_metrics) - 'dimension' - 'sort_order' ORDER BY sort_order) FROM association_metrics WHERE dimension = 'whatsapp'), '[]'::jsonb),
      'prepayment', COALESCE((SELECT jsonb_agg(to_jsonb(association_metrics) - 'dimension' - 'sort_order' - 'evolution_reservations' - 'pluguechat_reservations' ORDER BY sort_order) FROM association_metrics WHERE dimension = 'prepayment'), '[]'::jsonb)
    ),
    'cancellation_curve', jsonb_build_object(
      'coverage_start', (SELECT coverage_start FROM audit_coverage),
      'cancelled_total', (SELECT count(*)::integer FROM cancelled_rows),
      'cancelled_with_audit', (SELECT count(*)::integer FROM cancelled_rows WHERE cancelled_at IS NOT NULL),
      'coverage_percentage', COALESCE(round(
        100.0 * (SELECT count(*) FROM cancelled_rows WHERE cancelled_at IS NOT NULL)
        / NULLIF((SELECT count(*) FROM cancelled_rows), 0),
        1
      ), 0),
      'buckets', COALESCE((SELECT jsonb_agg(to_jsonb(cancellation_metrics) ORDER BY sort_order) FROM cancellation_metrics), '[]'::jsonb)
    ),
    'reservations', COALESCE((
      SELECT jsonb_agg(to_jsonb(paged_reservations) - 'scheduled_at' ORDER BY date DESC, time DESC, id DESC)
      FROM paged_reservations
    ), '[]'::jsonb),
    'meta', jsonb_build_object(
      'period_start', _period_start,
      'period_end', _period_end,
      'comparison_enabled', COALESCE(_include_comparison, true),
      'comparison_start', CASE WHEN COALESCE(_include_comparison, true) THEN _comparison_start ELSE NULL END,
      'comparison_end', CASE WHEN COALESCE(_include_comparison, true) THEN _comparison_end ELSE NULL END,
      'time_zone', _time_zone,
      'page', _page,
      'page_size', _page_size,
      'reservations_total', (SELECT count(*)::integer FROM current_filtered),
      'filtered_reservations_total', (SELECT count(*)::integer FROM searched_reservations),
      'outcome', _effective_outcome,
      'entry_method', _effective_entry_method,
      'search', _search_value,
      'generated_at', now()
    )
  ) INTO _result
  FROM current_summary
  CROSS JOIN comparison_summary;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_attendance_losses_report(uuid, date, date, text, text, integer, integer, text, boolean) IS
  'Relatório agregado de comparecimento, no-show e cancelamentos com associações observacionais e drill-down paginado.';

REVOKE ALL ON FUNCTION public.get_attendance_losses_report(uuid, date, date, text, text, integer, integer, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_attendance_losses_report(uuid, date, date, text, text, integer, integer, text, boolean)
  TO authenticated, service_role;
