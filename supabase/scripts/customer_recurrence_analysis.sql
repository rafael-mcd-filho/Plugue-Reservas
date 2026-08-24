-- Analise de recorrencia e retencao de clientes.
--
-- Use no SQL Editor para simular uma tela de "CRM de Retencao".
-- Ajuste os parametros na tabela temporaria customer_recurrence_params:
-- - company_id: filtre uma empresa especifica, ou deixe NULL para todas.
-- - company_slug_like: filtro adicional por parte do slug, por exemplo '%joao-pessoa%'.
-- - company_search_patterns: filtros por nome, slug ou endereco.
--   Por padrao esta filtrando SPOD e Beco Magico Joao Pessoa.
-- - as_of_date: data de referencia da analise.
-- - lookback_days: janela usada para frequencia.
-- - recent_days: limite para considerar cliente recente.
-- - high_frequency_threshold: visitas na janela para considerar alta frequencia.
--
-- Saidas geradas:
-- 1. Resumo geral
-- 2. Quadrantes/segmentos
-- 3. Dados para grafico de dispersao
-- 4. Top oportunidades de reativacao
-- 5. Distribuicao por dias sem visita
-- 6. Cohorts de retorno
-- 7. Base detalhada por cliente

SET TIME ZONE 'America/Fortaleza';

DROP TABLE IF EXISTS pg_temp.customer_recurrence_params;
DROP TABLE IF EXISTS pg_temp.customer_recurrence_visits;
DROP TABLE IF EXISTS pg_temp.customer_recurrence_analysis;

CREATE TEMP TABLE customer_recurrence_params AS
SELECT
  NULL::uuid AS company_id,
  NULL::text AS company_slug_like,
  ARRAY[
    '%spod%',
    '%beco%magico%joao%pessoa%'
  ]::text[] AS company_search_patterns,
  (now() AT TIME ZONE 'America/Fortaleza')::date AS as_of_date,
  180::integer AS lookback_days,
  30::integer AS recent_days,
  90::integer AS dormant_days,
  3::integer AS high_frequency_threshold;

CREATE TEMP TABLE customer_recurrence_visits AS
WITH params AS (
  SELECT *
  FROM pg_temp.customer_recurrence_params
),
selected_companies AS (
  SELECT company_search.id, company_search.name, company_search.slug
  FROM (
    SELECT
      companies.id,
      companies.name,
      companies.slug,
      lower(translate(
        concat_ws(' ', companies.name, companies.slug, companies.address),
        'áàâãäÁÀÂÃÄéèêëÉÈÊËíìîïÍÌÎÏóòôõöÓÒÔÕÖúùûüÚÙÛÜçÇ',
        'aaaaaAAAAAeeeeEEEEiiiiIIIIoooooOOOOOuuuuUUUUcC'
      )) AS search_text
    FROM public.companies
  ) AS company_search
  CROSS JOIN params
  WHERE (params.company_id IS NULL OR company_search.id = params.company_id)
    AND (params.company_slug_like IS NULL OR company_search.slug ILIKE params.company_slug_like)
    AND (
      params.company_search_patterns IS NULL
      OR EXISTS (
        SELECT 1
        FROM unnest(params.company_search_patterns) AS pattern(value)
        WHERE company_search.search_text LIKE lower(pattern.value)
      )
    )
),
raw_visit_events AS (
  SELECT
    reservations.company_id,
    selected_companies.name AS company_name,
    selected_companies.slug AS company_slug,
    reservations.guest_name,
    reservations.guest_phone,
    public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
    COALESCE((reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date, reservations.date) AS visit_date,
    COALESCE(reservations.checked_in_at, (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza') AS visit_at,
    'reservation_guest'::text AS visit_source,
    1 AS source_priority,
    reservations.id AS reservation_id,
    NULL::uuid AS waitlist_id,
    reservations.party_size
  FROM public.reservations
  JOIN selected_companies
    ON selected_companies.id = reservations.company_id
  CROSS JOIN params
  WHERE reservations.status IN ('checked_in', 'completed')
    AND reservations.guest_phone IS NOT NULL
    AND COALESCE((reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date, reservations.date) <= params.as_of_date

  UNION ALL

  SELECT
    reservations.company_id,
    selected_companies.name AS company_name,
    selected_companies.slug AS company_slug,
    reservation_companions.name AS guest_name,
    reservation_companions.phone AS guest_phone,
    public.normalize_whatsapp_phone(reservation_companions.phone) AS phone_normalized,
    COALESCE((reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date, reservations.date) AS visit_date,
    COALESCE(reservations.checked_in_at, (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza') AS visit_at,
    'reservation_companion'::text AS visit_source,
    2 AS source_priority,
    reservations.id AS reservation_id,
    NULL::uuid AS waitlist_id,
    reservations.party_size
  FROM public.reservation_companions
  JOIN public.reservations
    ON reservations.id = reservation_companions.reservation_id
  JOIN selected_companies
    ON selected_companies.id = reservations.company_id
  CROSS JOIN params
  WHERE reservations.status IN ('checked_in', 'completed')
    AND reservation_companions.phone IS NOT NULL
    AND COALESCE((reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date, reservations.date) <= params.as_of_date

  UNION ALL

  SELECT
    waitlist.company_id,
    selected_companies.name AS company_name,
    selected_companies.slug AS company_slug,
    waitlist.guest_name,
    waitlist.guest_phone,
    public.normalize_whatsapp_phone(waitlist.guest_phone) AS phone_normalized,
    COALESCE((waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date, (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date) AS visit_date,
    COALESCE(waitlist.seated_at, waitlist.created_at) AS visit_at,
    'waitlist_guest'::text AS visit_source,
    3 AS source_priority,
    NULL::uuid AS reservation_id,
    waitlist.id AS waitlist_id,
    waitlist.party_size
  FROM public.waitlist
  JOIN selected_companies
    ON selected_companies.id = waitlist.company_id
  CROSS JOIN params
  WHERE waitlist.status = 'seated'
    AND waitlist.guest_phone IS NOT NULL
    AND COALESCE((waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date, (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date) <= params.as_of_date

  UNION ALL

  SELECT
    waitlist_companions.company_id,
    selected_companies.name AS company_name,
    selected_companies.slug AS company_slug,
    waitlist_companions.name AS guest_name,
    waitlist_companions.phone AS guest_phone,
    public.normalize_whatsapp_phone(waitlist_companions.phone) AS phone_normalized,
    COALESCE((waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date, (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date) AS visit_date,
    COALESCE(waitlist.seated_at, waitlist.created_at) AS visit_at,
    'waitlist_companion'::text AS visit_source,
    4 AS source_priority,
    NULL::uuid AS reservation_id,
    waitlist.id AS waitlist_id,
    waitlist.party_size
  FROM public.waitlist_companions
  JOIN public.waitlist
    ON waitlist.id = waitlist_companions.waitlist_id
  JOIN selected_companies
    ON selected_companies.id = waitlist_companions.company_id
  CROSS JOIN params
  WHERE waitlist.status = 'seated'
    AND waitlist_companions.phone IS NOT NULL
    AND COALESCE((waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date, (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date) <= params.as_of_date
),
daily_deduped AS (
  SELECT
    raw_visit_events.*,
    row_number() OVER (
      PARTITION BY raw_visit_events.company_id, raw_visit_events.phone_normalized, raw_visit_events.visit_date
      ORDER BY raw_visit_events.source_priority, raw_visit_events.visit_at DESC
    ) AS daily_rank
  FROM raw_visit_events
  WHERE raw_visit_events.phone_normalized IS NOT NULL
)
SELECT
  company_id,
  company_name,
  company_slug,
  NULLIF(btrim(COALESCE(guest_name, '')), '') AS guest_name,
  guest_phone,
  phone_normalized,
  visit_date,
  visit_at,
  visit_source,
  reservation_id,
  waitlist_id,
  party_size
FROM daily_deduped
WHERE daily_rank = 1;

CREATE INDEX ON pg_temp.customer_recurrence_visits(company_id, phone_normalized, visit_date);

CREATE TEMP TABLE customer_recurrence_analysis AS
WITH params AS (
  SELECT *
  FROM pg_temp.customer_recurrence_params
),
visit_gaps AS (
  SELECT
    visits.company_id,
    visits.phone_normalized,
    visits.visit_date,
    visits.visit_date - lag(visits.visit_date) OVER (
      PARTITION BY visits.company_id, visits.phone_normalized
      ORDER BY visits.visit_date
    ) AS gap_days
  FROM pg_temp.customer_recurrence_visits AS visits
),
latest_visit AS (
  SELECT *
  FROM (
    SELECT
      visits.*,
      row_number() OVER (
        PARTITION BY visits.company_id, visits.phone_normalized
        ORDER BY visits.visit_at DESC
      ) AS rank
    FROM pg_temp.customer_recurrence_visits AS visits
  ) ranked
  WHERE rank = 1
),
customer_rollup AS (
  SELECT
    visits.company_id,
    visits.company_name,
    visits.company_slug,
    visits.phone_normalized,
    min(visits.visit_date) AS first_visit_date,
    max(visits.visit_date) AS last_visit_date,
    count(*)::integer AS total_visits,
    count(*) FILTER (WHERE visits.visit_date >= params.as_of_date - params.lookback_days)::integer AS visits_last_lookback,
    count(*) FILTER (WHERE visits.visit_date >= params.as_of_date - 30)::integer AS visits_last_30d,
    count(*) FILTER (WHERE visits.visit_date >= params.as_of_date - 60)::integer AS visits_last_60d,
    count(*) FILTER (WHERE visits.visit_date >= params.as_of_date - 90)::integer AS visits_last_90d,
    count(*) FILTER (WHERE visits.visit_date >= params.as_of_date - 365)::integer AS visits_last_365d
  FROM pg_temp.customer_recurrence_visits AS visits
  CROSS JOIN params
  GROUP BY visits.company_id, visits.company_name, visits.company_slug, visits.phone_normalized
),
average_gaps AS (
  SELECT
    visit_gaps.company_id,
    visit_gaps.phone_normalized,
    round(avg(visit_gaps.gap_days)::numeric, 1) AS avg_days_between_visits,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY visit_gaps.gap_days)::numeric(10, 1) AS median_days_between_visits
  FROM visit_gaps
  WHERE visit_gaps.gap_days IS NOT NULL
    AND visit_gaps.gap_days > 0
  GROUP BY visit_gaps.company_id, visit_gaps.phone_normalized
),
future_reservations AS (
  SELECT
    reservations.company_id,
    public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
    min(reservations.date) AS next_reservation_date,
    count(*)::integer AS future_reservation_count
  FROM public.reservations
  CROSS JOIN params
  WHERE reservations.status IN ('confirmed', 'pending_payment')
    AND reservations.date >= params.as_of_date
    AND public.normalize_whatsapp_phone(reservations.guest_phone) IS NOT NULL
  GROUP BY reservations.company_id, public.normalize_whatsapp_phone(reservations.guest_phone)
),
reactivation_history AS (
  SELECT
    dispatches.company_id,
    dispatches.phone_normalized,
    max(dispatches.created_at) AS last_reactivation_at,
    count(*)::integer AS reactivation_dispatch_count
  FROM public.lead_reactivation_dispatches AS dispatches
  GROUP BY dispatches.company_id, dispatches.phone_normalized
),
scored AS (
  SELECT
    params.as_of_date AS analysis_date,
    params.lookback_days,
    params.recent_days,
    params.high_frequency_threshold,
    rollup.company_id,
    rollup.company_name,
    rollup.company_slug,
    latest.guest_name,
    latest.guest_phone,
    rollup.phone_normalized,
    rollup.first_visit_date,
    rollup.last_visit_date,
    params.as_of_date - rollup.last_visit_date AS days_since_last_visit,
    rollup.total_visits,
    rollup.visits_last_lookback,
    rollup.visits_last_30d,
    rollup.visits_last_60d,
    rollup.visits_last_90d,
    rollup.visits_last_365d,
    COALESCE(gaps.avg_days_between_visits, 0) AS avg_days_between_visits,
    COALESCE(gaps.median_days_between_visits, 0) AS median_days_between_visits,
    future.next_reservation_date,
    COALESCE(future.future_reservation_count, 0) AS future_reservation_count,
    history.last_reactivation_at,
    COALESCE(history.reactivation_dispatch_count, 0) AS reactivation_dispatch_count
  FROM customer_rollup AS rollup
  JOIN latest_visit AS latest
    ON latest.company_id = rollup.company_id
   AND latest.phone_normalized = rollup.phone_normalized
  CROSS JOIN params
  LEFT JOIN average_gaps AS gaps
    ON gaps.company_id = rollup.company_id
   AND gaps.phone_normalized = rollup.phone_normalized
  LEFT JOIN future_reservations AS future
    ON future.company_id = rollup.company_id
   AND future.phone_normalized = rollup.phone_normalized
  LEFT JOIN reactivation_history AS history
    ON history.company_id = rollup.company_id
   AND history.phone_normalized = rollup.phone_normalized
)
SELECT
  scored.*,
  CASE
    WHEN scored.days_since_last_visit <= scored.recent_days
      AND scored.visits_last_lookback >= scored.high_frequency_threshold
      THEN 'Fiéis ativos'
    WHEN scored.days_since_last_visit <= scored.recent_days
      THEN 'Novos/promissores'
    WHEN scored.days_since_last_visit > scored.recent_days
      AND scored.visits_last_lookback >= scored.high_frequency_threshold
      THEN 'Valiosos em risco'
    WHEN scored.days_since_last_visit > 90
      THEN 'Dormindo'
    ELSE 'Baixo engajamento'
  END AS recurrence_quadrant,
  CASE
    WHEN scored.future_reservation_count > 0
      THEN 'Tem reserva futura'
    WHEN scored.days_since_last_visit > scored.recent_days
      AND scored.visits_last_lookback >= scored.high_frequency_threshold
      THEN 'Prioridade alta para reativação'
    WHEN scored.days_since_last_visit <= scored.recent_days
      AND scored.visits_last_lookback = 1
      THEN 'Incentivar segunda visita'
    WHEN scored.days_since_last_visit <= scored.recent_days
      AND scored.visits_last_lookback >= scored.high_frequency_threshold
      THEN 'Manter relacionamento/VIP'
    WHEN scored.days_since_last_visit > 90
      THEN 'Campanha de recuperação'
    ELSE 'Campanha leve de retorno'
  END AS suggested_action,
  CASE
    WHEN scored.future_reservation_count > 0 THEN 0
    WHEN scored.days_since_last_visit > scored.recent_days
      AND scored.visits_last_lookback >= scored.high_frequency_threshold
      THEN 100 + LEAST(scored.days_since_last_visit, 120) + (scored.visits_last_lookback * 10)
    WHEN scored.days_since_last_visit > 90
      THEN 60 + LEAST(scored.days_since_last_visit, 120)
    WHEN scored.days_since_last_visit <= scored.recent_days
      AND scored.visits_last_lookback = 1
      THEN 50
    ELSE 30 + scored.visits_last_lookback
  END AS opportunity_score,
  scored.days_since_last_visit AS chart_x_days_since_visit,
  scored.visits_last_lookback AS chart_y_visits_in_window
FROM scored;

-- 1. Resumo geral para cards do topo.
SELECT
  count(*) AS clientes_identificados,
  count(*) FILTER (WHERE recurrence_quadrant = 'Fiéis ativos') AS fieis_ativos,
  count(*) FILTER (WHERE recurrence_quadrant = 'Valiosos em risco') AS valiosos_em_risco,
  count(*) FILTER (WHERE recurrence_quadrant = 'Novos/promissores') AS novos_promissores,
  count(*) FILTER (WHERE recurrence_quadrant IN ('Dormindo', 'Baixo engajamento')) AS frios_ou_baixo_engajamento,
  count(*) FILTER (WHERE future_reservation_count > 0) AS com_reserva_futura,
  round(avg(days_since_last_visit)::numeric, 1) AS media_dias_sem_visita,
  round(avg(visits_last_lookback)::numeric, 1) AS media_visitas_na_janela
FROM pg_temp.customer_recurrence_analysis;

-- 2. Segmentos/quadrantes para grafico de barras ou cards.
SELECT
  recurrence_quadrant,
  suggested_action,
  count(*) AS clientes,
  round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS percentual_clientes,
  round(avg(days_since_last_visit)::numeric, 1) AS media_dias_sem_visita,
  round(avg(visits_last_lookback)::numeric, 1) AS media_visitas_na_janela,
  max(opportunity_score) AS maior_score
FROM pg_temp.customer_recurrence_analysis
GROUP BY recurrence_quadrant, suggested_action
ORDER BY maior_score DESC, clientes DESC;

-- 3. Dados para scatter/quadrante.
SELECT
  company_name,
  guest_name,
  guest_phone,
  phone_normalized,
  chart_x_days_since_visit AS x_dias_sem_visita,
  chart_y_visits_in_window AS y_visitas_ultimos_180d,
  recurrence_quadrant,
  suggested_action,
  opportunity_score,
  next_reservation_date
FROM pg_temp.customer_recurrence_analysis
ORDER BY x_dias_sem_visita DESC, y_visitas_ultimos_180d DESC, guest_name;

-- 4. Top oportunidades para acao comercial.
SELECT
  company_name,
  guest_name,
  guest_phone,
  last_visit_date,
  days_since_last_visit,
  total_visits,
  visits_last_lookback,
  avg_days_between_visits,
  recurrence_quadrant,
  suggested_action,
  opportunity_score,
  last_reactivation_at
FROM pg_temp.customer_recurrence_analysis
WHERE future_reservation_count = 0
ORDER BY opportunity_score DESC, visits_last_lookback DESC, days_since_last_visit DESC
LIMIT 100;

-- 5. Distribuicao por recencia.
WITH recency_bands AS (
  SELECT
    CASE
      WHEN days_since_last_visit <= 7 THEN '0-7 dias'
      WHEN days_since_last_visit <= 15 THEN '8-15 dias'
      WHEN days_since_last_visit <= 30 THEN '16-30 dias'
      WHEN days_since_last_visit <= 60 THEN '31-60 dias'
      WHEN days_since_last_visit <= 90 THEN '61-90 dias'
      WHEN days_since_last_visit <= 180 THEN '91-180 dias'
      ELSE '181+ dias'
    END AS faixa_dias_sem_visita,
    CASE
      WHEN days_since_last_visit <= 7 THEN 1
      WHEN days_since_last_visit <= 15 THEN 2
      WHEN days_since_last_visit <= 30 THEN 3
      WHEN days_since_last_visit <= 60 THEN 4
      WHEN days_since_last_visit <= 90 THEN 5
      WHEN days_since_last_visit <= 180 THEN 6
      ELSE 7
    END AS faixa_ordem,
    visits_last_lookback
  FROM pg_temp.customer_recurrence_analysis
)
SELECT
  faixa_dias_sem_visita,
  count(*) AS clientes,
  round(avg(visits_last_lookback)::numeric, 1) AS media_visitas_na_janela
FROM recency_bands
GROUP BY faixa_dias_sem_visita, faixa_ordem
ORDER BY faixa_ordem;

-- 6. Cohort de retorno: clientes por mes da primeira visita e retorno apos a primeira visita.
WITH first_visits AS (
  SELECT
    company_id,
    company_name,
    phone_normalized,
    min(visit_date) AS first_visit_date
  FROM pg_temp.customer_recurrence_visits
  GROUP BY company_id, company_name, phone_normalized
),
cohort_flags AS (
  SELECT
    first_visits.*,
    EXISTS (
      SELECT 1
      FROM pg_temp.customer_recurrence_visits AS visits
      WHERE visits.company_id = first_visits.company_id
        AND visits.phone_normalized = first_visits.phone_normalized
        AND visits.visit_date > first_visits.first_visit_date
        AND visits.visit_date <= first_visits.first_visit_date + 30
    ) AS returned_30d,
    EXISTS (
      SELECT 1
      FROM pg_temp.customer_recurrence_visits AS visits
      WHERE visits.company_id = first_visits.company_id
        AND visits.phone_normalized = first_visits.phone_normalized
        AND visits.visit_date > first_visits.first_visit_date
        AND visits.visit_date <= first_visits.first_visit_date + 60
    ) AS returned_60d,
    EXISTS (
      SELECT 1
      FROM pg_temp.customer_recurrence_visits AS visits
      WHERE visits.company_id = first_visits.company_id
        AND visits.phone_normalized = first_visits.phone_normalized
        AND visits.visit_date > first_visits.first_visit_date
        AND visits.visit_date <= first_visits.first_visit_date + 90
    ) AS returned_90d,
    EXISTS (
      SELECT 1
      FROM pg_temp.customer_recurrence_visits AS visits
      WHERE visits.company_id = first_visits.company_id
        AND visits.phone_normalized = first_visits.phone_normalized
        AND visits.visit_date > first_visits.first_visit_date
        AND visits.visit_date <= first_visits.first_visit_date + 180
    ) AS returned_180d
  FROM first_visits
)
SELECT
  date_trunc('month', first_visit_date)::date AS cohort_mes_primeira_visita,
  count(*) AS clientes_novos,
  count(*) FILTER (WHERE returned_30d) AS retornaram_ate_30d,
  round(100.0 * count(*) FILTER (WHERE returned_30d) / NULLIF(count(*), 0), 1) AS taxa_retorno_30d,
  count(*) FILTER (WHERE returned_60d) AS retornaram_ate_60d,
  round(100.0 * count(*) FILTER (WHERE returned_60d) / NULLIF(count(*), 0), 1) AS taxa_retorno_60d,
  count(*) FILTER (WHERE returned_90d) AS retornaram_ate_90d,
  round(100.0 * count(*) FILTER (WHERE returned_90d) / NULLIF(count(*), 0), 1) AS taxa_retorno_90d,
  count(*) FILTER (WHERE returned_180d) AS retornaram_ate_180d,
  round(100.0 * count(*) FILTER (WHERE returned_180d) / NULLIF(count(*), 0), 1) AS taxa_retorno_180d
FROM cohort_flags
GROUP BY cohort_mes_primeira_visita
ORDER BY cohort_mes_primeira_visita DESC;

-- 7. Base detalhada por cliente para inspecao e prototipo de tabela.
SELECT *
FROM pg_temp.customer_recurrence_analysis
ORDER BY company_name, opportunity_score DESC, days_since_last_visit DESC, guest_name;
