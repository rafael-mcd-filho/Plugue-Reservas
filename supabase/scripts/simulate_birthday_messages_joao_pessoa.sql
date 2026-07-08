-- Simula a automacao send-birthday-messages para Joao Pessoa sem inserir mensagens.
--
-- Cenario padrao:
-- - hoje: 2026-07-07
-- - execucao simulada: 2026-07-08 09:05 America/Fortaleza
-- - aniversarios alvo: 2026-07-12, pois a automacao envia 4 dias antes
--
-- Para simular outro dia, altere simulated_run_date no CTE config.

SET TIME ZONE 'America/Fortaleza';

DROP TABLE IF EXISTS pg_temp.birthday_joao_pessoa_simulation_context;
DROP TABLE IF EXISTS pg_temp.birthday_joao_pessoa_simulation;

CREATE TEMP TABLE birthday_joao_pessoa_simulation_context AS
WITH config AS (
  SELECT
    DATE '2026-07-08' AS simulated_run_date,
    4::integer AS advance_days,
    TIME '09:05' AS window_start,
    TIME '18:00' AS expires_at
),
target AS (
  SELECT
    config.simulated_run_date,
    config.simulated_run_date + config.advance_days AS target_birthday_date,
    to_char(config.simulated_run_date + config.advance_days, 'MM-DD') AS target_mmdd,
    (config.simulated_run_date + config.window_start)::timestamptz AS scheduled_for,
    (config.simulated_run_date + config.expires_at)::timestamptz AS expires_at
  FROM config
);

CREATE TEMP TABLE birthday_joao_pessoa_simulation AS
WITH target AS (
  SELECT *
  FROM pg_temp.birthday_joao_pessoa_simulation_context
),
joao_pessoa_companies AS (
  SELECT
    companies.id,
    companies.name,
    companies.slug,
    companies.address,
    COALESCE(companies.whatsapp_automation_channel, 'evolution') AS channel
  FROM public.companies
  WHERE lower(companies.slug) LIKE '%joao-pessoa%'
     OR lower(companies.slug) LIKE '%joao_pessoa%'
     OR lower(companies.slug) LIKE '%joaopessoa%'
     OR lower(companies.name) LIKE '%jo_o pessoa%'
     OR lower(COALESCE(companies.address, '')) LIKE '%jo_o pessoa%'
),
raw_contacts AS (
  SELECT
    'reservation_guest'::text AS source,
    1 AS source_priority,
    reservations.id AS source_id,
    reservations.company_id,
    reservations.guest_name,
    reservations.guest_phone,
    reservations.guest_birthdate AS birthdate,
    reservations.created_at
  FROM public.reservations
  JOIN joao_pessoa_companies
    ON joao_pessoa_companies.id = reservations.company_id
  WHERE reservations.guest_birthdate IS NOT NULL
    AND NULLIF(regexp_replace(COALESCE(reservations.guest_phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL

  UNION ALL

  SELECT
    'reservation_companion'::text AS source,
    2 AS source_priority,
    reservation_companions.id AS source_id,
    reservation_companions.company_id,
    reservation_companions.name AS guest_name,
    reservation_companions.phone AS guest_phone,
    reservation_companions.birthdate,
    reservation_companions.created_at
  FROM public.reservation_companions
  JOIN joao_pessoa_companies
    ON joao_pessoa_companies.id = reservation_companions.company_id
  WHERE reservation_companions.birthdate IS NOT NULL
    AND NULLIF(regexp_replace(COALESCE(reservation_companions.phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL

  UNION ALL

  SELECT
    'waitlist_guest'::text AS source,
    3 AS source_priority,
    waitlist.id AS source_id,
    waitlist.company_id,
    waitlist.guest_name,
    waitlist.guest_phone,
    waitlist.guest_birthdate AS birthdate,
    waitlist.created_at
  FROM public.waitlist
  JOIN joao_pessoa_companies
    ON joao_pessoa_companies.id = waitlist.company_id
  WHERE waitlist.status = 'seated'
    AND waitlist.guest_birthdate IS NOT NULL
    AND NULLIF(regexp_replace(COALESCE(waitlist.guest_phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL

  UNION ALL

  SELECT
    'waitlist_companion'::text AS source,
    4 AS source_priority,
    waitlist_companions.id AS source_id,
    waitlist_companions.company_id,
    waitlist_companions.name AS guest_name,
    waitlist_companions.phone AS guest_phone,
    waitlist_companions.birthdate,
    waitlist_companions.created_at
  FROM public.waitlist_companions
  JOIN joao_pessoa_companies
    ON joao_pessoa_companies.id = waitlist_companions.company_id
  WHERE waitlist_companions.birthdate IS NOT NULL
    AND NULLIF(regexp_replace(COALESCE(waitlist_companions.phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
),
normalized_contacts AS (
  SELECT
    raw_contacts.*,
    CASE
      WHEN phone_digits.digits !~ '^55'
        AND length(phone_digits.digits) <= 11
        THEN '55' || phone_digits.digits
      ELSE phone_digits.digits
    END AS phone_digits
  FROM raw_contacts
  CROSS JOIN LATERAL (
    SELECT regexp_replace(raw_contacts.guest_phone, '[^0-9]', '', 'g') AS digits
  ) AS phone_digits
),
matching_birthdays AS (
  SELECT
    normalized_contacts.*,
    target.simulated_run_date,
    target.target_birthday_date,
    target.scheduled_for,
    target.expires_at
  FROM normalized_contacts
  CROSS JOIN target
  WHERE to_char(normalized_contacts.birthdate, 'MM-DD') = target.target_mmdd
),
deduped_birthdays AS (
  SELECT
    matching_birthdays.*,
    row_number() OVER (
      PARTITION BY matching_birthdays.company_id, matching_birthdays.phone_digits
      ORDER BY matching_birthdays.source_priority, matching_birthdays.created_at DESC NULLS LAST
    ) AS dedupe_rank,
    count(*) OVER (
      PARTITION BY matching_birthdays.company_id, matching_birthdays.phone_digits
    ) AS duplicate_source_count
  FROM matching_birthdays
),
unique_birthdays AS (
  SELECT *
  FROM deduped_birthdays
  WHERE dedupe_rank = 1
),
evolution_automations AS (
  SELECT
    automation_settings.company_id,
    bool_or(
      automation_settings.enabled
      AND NULLIF(btrim(automation_settings.message_template), '') IS NOT NULL
    ) AS is_ready,
    max(automation_settings.message_template) FILTER (
      WHERE automation_settings.enabled
        AND NULLIF(btrim(automation_settings.message_template), '') IS NOT NULL
    ) AS message_template
  FROM public.automation_settings
  WHERE automation_settings.type = 'birthday_message'
  GROUP BY automation_settings.company_id
),
pluguechat_templates AS (
  SELECT
    pluguechat_automation_templates.company_id,
    bool_or(
      pluguechat_automation_templates.enabled
      AND NULLIF(btrim(pluguechat_automation_templates.template_id), '') IS NOT NULL
    ) AS is_ready,
    max(pluguechat_automation_templates.template_id) FILTER (
      WHERE pluguechat_automation_templates.enabled
        AND NULLIF(btrim(pluguechat_automation_templates.template_id), '') IS NOT NULL
    ) AS template_id,
    max(pluguechat_automation_templates.template_name) FILTER (
      WHERE pluguechat_automation_templates.enabled
        AND NULLIF(btrim(pluguechat_automation_templates.template_id), '') IS NOT NULL
    ) AS template_name
  FROM public.pluguechat_automation_templates
  WHERE pluguechat_automation_templates.type = 'birthday_message'
  GROUP BY pluguechat_automation_templates.company_id
),
evolution_processed AS (
  SELECT
    processed.company_id,
    processed.phone_digits,
    count(*) AS processed_count
  FROM (
    SELECT
      whatsapp_message_logs.company_id,
      CASE
        WHEN phone_digits.digits !~ '^55'
          AND length(phone_digits.digits) <= 11
          THEN '55' || phone_digits.digits
        ELSE phone_digits.digits
      END AS phone_digits
    FROM public.whatsapp_message_logs
    CROSS JOIN target
    CROSS JOIN LATERAL (
      SELECT regexp_replace(whatsapp_message_logs.phone, '[^0-9]', '', 'g') AS digits
    ) AS phone_digits
    WHERE whatsapp_message_logs.type = 'birthday'
      AND whatsapp_message_logs.status IN ('pending', 'sent')
      AND (whatsapp_message_logs.created_at AT TIME ZONE 'America/Fortaleza')::date = target.simulated_run_date

    UNION ALL

    SELECT
      whatsapp_message_queue.company_id,
      CASE
        WHEN phone_digits.digits !~ '^55'
          AND length(phone_digits.digits) <= 11
          THEN '55' || phone_digits.digits
        ELSE phone_digits.digits
      END AS phone_digits
    FROM public.whatsapp_message_queue
    CROSS JOIN target
    CROSS JOIN LATERAL (
      SELECT regexp_replace(whatsapp_message_queue.phone, '[^0-9]', '', 'g') AS digits
    ) AS phone_digits
    WHERE whatsapp_message_queue.type = 'birthday'
      AND (whatsapp_message_queue.created_at AT TIME ZONE 'America/Fortaleza')::date = target.simulated_run_date
  ) AS processed
  GROUP BY processed.company_id, processed.phone_digits
),
pluguechat_processed AS (
  SELECT
    processed.company_id,
    processed.phone_digits,
    count(*) AS processed_count
  FROM (
    SELECT
      pluguechat_message_logs.company_id,
      CASE
        WHEN phone_digits.digits !~ '^55'
          AND length(phone_digits.digits) <= 11
          THEN '55' || phone_digits.digits
        ELSE phone_digits.digits
      END AS phone_digits
    FROM public.pluguechat_message_logs
    CROSS JOIN target
    CROSS JOIN LATERAL (
      SELECT regexp_replace(pluguechat_message_logs.phone, '[^0-9]', '', 'g') AS digits
    ) AS phone_digits
    WHERE pluguechat_message_logs.type = 'birthday_message'
      AND (pluguechat_message_logs.created_at AT TIME ZONE 'America/Fortaleza')::date = target.simulated_run_date

    UNION ALL

    SELECT
      pluguechat_message_queue.company_id,
      CASE
        WHEN phone_digits.digits !~ '^55'
          AND length(phone_digits.digits) <= 11
          THEN '55' || phone_digits.digits
        ELSE phone_digits.digits
      END AS phone_digits
    FROM public.pluguechat_message_queue
    CROSS JOIN target
    CROSS JOIN LATERAL (
      SELECT regexp_replace(pluguechat_message_queue.phone, '[^0-9]', '', 'g') AS digits
    ) AS phone_digits
    WHERE pluguechat_message_queue.type = 'birthday_message'
      AND pluguechat_message_queue.status <> 'cancelled'
      AND (pluguechat_message_queue.created_at AT TIME ZONE 'America/Fortaleza')::date = target.simulated_run_date
  ) AS processed
  GROUP BY processed.company_id, processed.phone_digits
)
SELECT
  unique_birthdays.simulated_run_date AS dia_execucao_simulado,
  unique_birthdays.target_birthday_date AS data_aniversario_alvo,
  unique_birthdays.scheduled_for AS agendaria_para,
  unique_birthdays.expires_at AS expira_em,
  joao_pessoa_companies.name AS empresa,
  joao_pessoa_companies.slug AS empresa_slug,
  joao_pessoa_companies.address AS empresa_endereco,
  joao_pessoa_companies.channel AS canal,
  unique_birthdays.source AS origem,
  unique_birthdays.source_id,
  unique_birthdays.guest_name AS nome,
  split_part(btrim(COALESCE(unique_birthdays.guest_name, '')), ' ', 1) AS parametro_nome_pluguechat,
  unique_birthdays.guest_phone AS telefone_original,
  unique_birthdays.phone_digits AS telefone_normalizado,
  unique_birthdays.birthdate AS nascimento,
  extract(year from age(unique_birthdays.target_birthday_date, unique_birthdays.birthdate))::integer AS idade_no_aniversario,
  unique_birthdays.duplicate_source_count AS fontes_deduplicadas,
  CASE
    WHEN joao_pessoa_companies.channel = 'pluguechat_official'
      AND COALESCE(pluguechat_processed.processed_count, 0) > 0
      THEN 'skip_already_processed'
    WHEN joao_pessoa_companies.channel = 'pluguechat_official'
      AND NOT COALESCE(pluguechat_templates.is_ready, false)
      THEN 'skip_missing_pluguechat_template'
    WHEN joao_pessoa_companies.channel = 'pluguechat_official'
      THEN 'would_queue_pluguechat'
    WHEN COALESCE(evolution_processed.processed_count, 0) > 0
      THEN 'skip_already_processed'
    WHEN NOT COALESCE(evolution_automations.is_ready, false)
      THEN 'skip_missing_evolution_automation'
    ELSE 'would_queue_evolution'
  END AS resultado_simulacao,
  pluguechat_templates.template_id AS pluguechat_template_id,
  pluguechat_templates.template_name AS pluguechat_template_name,
  CASE
    WHEN joao_pessoa_companies.channel = 'evolution'
      THEN evolution_automations.message_template
    ELSE NULL
  END AS evolution_template_preview
FROM unique_birthdays
JOIN joao_pessoa_companies
  ON joao_pessoa_companies.id = unique_birthdays.company_id
LEFT JOIN evolution_automations
  ON evolution_automations.company_id = unique_birthdays.company_id
LEFT JOIN pluguechat_templates
  ON pluguechat_templates.company_id = unique_birthdays.company_id
LEFT JOIN evolution_processed
  ON evolution_processed.company_id = unique_birthdays.company_id
 AND evolution_processed.phone_digits = unique_birthdays.phone_digits
LEFT JOIN pluguechat_processed
  ON pluguechat_processed.company_id = unique_birthdays.company_id
 AND pluguechat_processed.phone_digits = unique_birthdays.phone_digits;

SELECT
  context.simulated_run_date AS dia_execucao_simulado,
  context.target_birthday_date AS data_aniversario_alvo,
  context.scheduled_for AS agendaria_para,
  context.expires_at AS expira_em,
  summary.contatos_unicos_encontrados,
  summary.mensagens_que_seriam_enfileiradas,
  summary.mensagens_que_seriam_puladas
FROM pg_temp.birthday_joao_pessoa_simulation_context AS context
CROSS JOIN (
  SELECT
    count(*) AS contatos_unicos_encontrados,
    count(*) FILTER (WHERE resultado_simulacao LIKE 'would_queue%') AS mensagens_que_seriam_enfileiradas,
    count(*) FILTER (WHERE resultado_simulacao LIKE 'skip%') AS mensagens_que_seriam_puladas
  FROM pg_temp.birthday_joao_pessoa_simulation
) AS summary;

SELECT
  resultado_simulacao,
  count(*) AS total
FROM pg_temp.birthday_joao_pessoa_simulation
GROUP BY resultado_simulacao
ORDER BY resultado_simulacao;

SELECT *
FROM pg_temp.birthday_joao_pessoa_simulation
ORDER BY empresa, nome, telefone_normalizado;
