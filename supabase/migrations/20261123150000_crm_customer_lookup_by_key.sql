-- Ficha e busca de clientes montadas só para os clientes pedidos.
--
-- 1. _get_crm_contact_records_for_keys e _get_crm_lead_profiles_for_keys
--    (20261123140000) passam a escolher os registros por conjunto: o fim do
--    telefone, o e-mail ou a chave do contato é procurado com IN (subconsulta),
--    resolvido com hash pelo Postgres. Antes, cada registro chamava uma função
--    que comparava com o telefone de cada cliente pedido, e uma busca como "ana"
--    (565 clientes) levava cerca de 10 s.
--
-- 2. A ficha do cliente (get_company_crm_relationship) e o histórico de
--    presenças (get_crm_lead_presence_history) montavam todos os clientes da
--    unidade para usar um só e passavam do limite de 8 s em unidades grandes
--    ("Não foi possível carregar estas informações do cliente"). Agora usam as
--    versões por chave, com o mesmo resultado. A troca é feita sobre a definição
--    em vigor, só no trecho que monta os clientes, e falha se o trecho não for
--    encontrado exatamente uma vez.
--
-- Fica igual: o resultado de cada função, as permissões e
-- _get_crm_contact_records, _get_crm_lead_profiles e
-- _get_customer_canonical_visit_events, usadas pelos relatórios.

CREATE OR REPLACE FUNCTION public._get_crm_contact_records_for_keys(_company_id uuid, _keys text[])
 RETURNS TABLE(company_id uuid, customer_key text, identity_kind text, identity_value text, canonical_event_key text, contact_record_key text, visit_id uuid, contact_id uuid, visit_origin text, lead_source text, role_kind text, record_date date, record_time time without time zone, record_at timestamp with time zone, presence_date date, presence_time time without time zone, presence_at timestamp with time zone, contact_created_at timestamp with time zone, guest_name text, guest_phone text, guest_email text, guest_birthdate date, phone_normalized text, email_normalized text, party_size integer, status text, normalized_status text, occasion text, origin_waitlist_id uuid, came_from_waitlist boolean, reservation_holder_name text, is_waitlist_suppressed boolean, is_canonical_presence boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH report_context AS MATERIALIZED (
    SELECT public._company_report_time_zone(_company_id) AS time_zone
  ),
  requested_keys AS MATERIALIZED (
    SELECT DISTINCT requested.key
    FROM unnest(COALESCE(_keys, '{}'::text[])) AS requested(key)
    WHERE requested.key IS NOT NULL
  ),
  -- O telefone padronizado é o número digitado (ou o E.164) só com dígitos,
  -- às vezes com 55 na frente: os últimos dígitos são sempre os mesmos.
  requested_phone_tails AS MATERIALIZED (
    SELECT DISTINCT right(
      substring(requested_keys.key FROM 7),
      LEAST(7, GREATEST(length(requested_keys.key) - 9, 1))
    ) AS tail
    FROM requested_keys
    WHERE requested_keys.key LIKE 'phone:_%'
  ),
  requested_emails AS MATERIALIZED (
    SELECT DISTINCT substring(requested_keys.key FROM 7) AS email
    FROM requested_keys
    WHERE requested_keys.key LIKE 'email:_%'
  ),
  -- MATERIALIZED: o telefone padronizado de cada registro é calculado uma vez só.
  raw_records AS MATERIALIZED (
    SELECT
      reservations.company_id,
      'reservation:' || reservations.id::text AS canonical_event_key,
      'reservation_holder:' || reservations.id::text AS contact_record_key,
      reservations.id AS visit_id,
      reservations.id AS contact_id,
      'reservation'::text AS visit_origin,
      'reservation_holder'::text AS lead_source,
      'holder'::text AS role_kind,
      reservations.date AS record_date,
      reservations.time AS record_time,
      (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone AS record_at,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::date,
        reservations.date
      ) AS presence_date,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::time,
        reservations.time
      ) AS presence_time,
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone
      ) AS presence_at,
      reservations.created_at AS contact_created_at,
      NULLIF(btrim(reservations.guest_name), '') AS guest_name,
      NULLIF(btrim(reservations.guest_phone), '') AS guest_phone,
      NULLIF(lower(btrim(reservations.guest_email)), '') AS guest_email,
      reservations.guest_birthdate AS guest_birthdate,
      public.phone_customer_identity_digits(reservations.guest_phone_e164, reservations.guest_phone, reservations.guest_phone_country) AS phone_normalized,
      NULLIF(lower(btrim(reservations.guest_email)), '') AS email_normalized,
      COALESCE(reservations.checked_in_party_size, reservations.party_size) AS party_size,
      reservations.status,
      CASE
        WHEN lower(btrim(reservations.status)) IN ('checked_in', 'completed') THEN 'checked_in'
        WHEN lower(btrim(reservations.status)) IN ('no-show', 'no_show') THEN 'no-show'
        WHEN lower(btrim(reservations.status)) IN (
          'pending_payment',
          'cancelled',
          'payment_expired',
          'payment_cancelled',
          'paid_after_expiration'
        ) THEN lower(btrim(reservations.status))
        ELSE 'confirmed'
      END AS normalized_status,
      reservations.occasion,
      reservations.origin_waitlist_id,
      reservations.origin_waitlist_id IS NOT NULL AS came_from_waitlist,
      NULLIF(btrim(reservations.guest_name), '') AS reservation_holder_name,
      1 AS contact_priority,
      0 AS contact_position,
      false AS is_waitlist_suppressed,
      lower(btrim(reservations.status)) IN ('checked_in', 'completed') AS is_canonical_presence
    FROM public.reservations
    CROSS JOIN report_context
    WHERE reservations.company_id = _company_id
      AND (
        right(regexp_replace(COALESCE(reservations.guest_phone, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR right(regexp_replace(COALESCE(reservations.guest_phone_e164, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR NULLIF(lower(btrim(reservations.guest_email)), '') IN (SELECT requested_emails.email FROM requested_emails)
        OR ('contact:reservation_holder:' || reservations.id::text) IN (SELECT requested_keys.key FROM requested_keys)
        OR (
          -- Números com menos de 10 dígitos: compara pelo tamanho do fim de cada chave.
          (SELECT count(*) > 0 FROM requested_phone_tails WHERE length(requested_phone_tails.tail) < 7)
          AND EXISTS (
            SELECT 1
            FROM requested_phone_tails AS short_tails
            WHERE length(short_tails.tail) < 7
              AND (
              right(regexp_replace(COALESCE(reservations.guest_phone, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              OR right(regexp_replace(COALESCE(reservations.guest_phone_e164, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              )
          )
        )
      )

    UNION ALL

    SELECT
      reservations.company_id,
      'reservation:' || reservations.id::text,
      'reservation_companion:' || reservation_companions.id::text,
      reservations.id,
      reservation_companions.id,
      'reservation',
      'reservation_companion',
      'companion',
      reservations.date,
      reservations.time,
      (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::date,
        reservations.date
      ),
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE report_context.time_zone)::time,
        reservations.time
      ),
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE report_context.time_zone
      ),
      reservation_companions.created_at,
      NULLIF(btrim(reservation_companions.name), ''),
      NULLIF(btrim(reservation_companions.phone), ''),
      NULLIF(lower(btrim(reservation_companions.email)), ''),
      reservation_companions.birthdate,
      public.phone_customer_identity_digits(reservation_companions.phone_e164, reservation_companions.phone, reservation_companions.phone_country),
      NULLIF(lower(btrim(reservation_companions.email)), ''),
      COALESCE(reservations.checked_in_party_size, reservations.party_size),
      reservations.status,
      CASE
        WHEN lower(btrim(reservations.status)) IN ('checked_in', 'completed') THEN 'checked_in'
        WHEN lower(btrim(reservations.status)) IN ('no-show', 'no_show') THEN 'no-show'
        WHEN lower(btrim(reservations.status)) IN (
          'pending_payment',
          'cancelled',
          'payment_expired',
          'payment_cancelled',
          'paid_after_expiration'
        ) THEN lower(btrim(reservations.status))
        ELSE 'confirmed'
      END,
      reservations.occasion,
      reservations.origin_waitlist_id,
      reservations.origin_waitlist_id IS NOT NULL,
      NULLIF(btrim(reservations.guest_name), ''),
      2,
      reservation_companions.position,
      false,
      lower(btrim(reservations.status)) IN ('checked_in', 'completed')
    FROM public.reservation_companions
    JOIN public.reservations
      ON reservations.id = reservation_companions.reservation_id
    CROSS JOIN report_context
    WHERE reservations.company_id = _company_id
      AND (
        right(regexp_replace(COALESCE(reservation_companions.phone, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR right(regexp_replace(COALESCE(reservation_companions.phone_e164, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR NULLIF(lower(btrim(reservation_companions.email)), '') IN (SELECT requested_emails.email FROM requested_emails)
        OR ('contact:reservation_companion:' || reservation_companions.id::text) IN (SELECT requested_keys.key FROM requested_keys)
        OR (
          -- Números com menos de 10 dígitos: compara pelo tamanho do fim de cada chave.
          (SELECT count(*) > 0 FROM requested_phone_tails WHERE length(requested_phone_tails.tail) < 7)
          AND EXISTS (
            SELECT 1
            FROM requested_phone_tails AS short_tails
            WHERE length(short_tails.tail) < 7
              AND (
              right(regexp_replace(COALESCE(reservation_companions.phone, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              OR right(regexp_replace(COALESCE(reservation_companions.phone_e164, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              )
          )
        )
      )

    UNION ALL

    SELECT
      waitlist.company_id,
      'waitlist:' || waitlist.id::text,
      'waitlist_holder:' || waitlist.id::text,
      waitlist.id,
      waitlist.id,
      'waitlist',
      'waitlist_holder',
      'holder',
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      waitlist.created_at,
      NULLIF(btrim(waitlist.guest_name), ''),
      NULLIF(btrim(waitlist.guest_phone), ''),
      NULLIF(lower(btrim(waitlist.guest_email)), ''),
      waitlist.guest_birthdate,
      public.phone_customer_identity_digits(waitlist.guest_phone_e164, waitlist.guest_phone, waitlist.guest_phone_country),
      NULLIF(lower(btrim(waitlist.guest_email)), ''),
      COALESCE(waitlist.seated_party_size, waitlist.party_size),
      waitlist.status,
      'checked_in',
      NULL::text,
      NULL::uuid,
      true,
      NULLIF(btrim(waitlist.guest_name), ''),
      1,
      0,
      linkage.has_linked_presence,
      NOT linkage.has_linked_presence
    FROM public.waitlist
    CROSS JOIN report_context
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM public.reservations linked_reservation
        WHERE linked_reservation.origin_waitlist_id = waitlist.id
          AND linked_reservation.status IN ('checked_in', 'completed')
      ) AS has_linked_presence
    ) AS linkage
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'seated'
      AND (
        right(regexp_replace(COALESCE(waitlist.guest_phone, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR right(regexp_replace(COALESCE(waitlist.guest_phone_e164, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR NULLIF(lower(btrim(waitlist.guest_email)), '') IN (SELECT requested_emails.email FROM requested_emails)
        OR ('contact:waitlist_holder:' || waitlist.id::text) IN (SELECT requested_keys.key FROM requested_keys)
        OR (
          -- Números com menos de 10 dígitos: compara pelo tamanho do fim de cada chave.
          (SELECT count(*) > 0 FROM requested_phone_tails WHERE length(requested_phone_tails.tail) < 7)
          AND EXISTS (
            SELECT 1
            FROM requested_phone_tails AS short_tails
            WHERE length(short_tails.tail) < 7
              AND (
              right(regexp_replace(COALESCE(waitlist.guest_phone, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              OR right(regexp_replace(COALESCE(waitlist.guest_phone_e164, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              )
          )
        )
      )

    UNION ALL

    SELECT
      waitlist.company_id,
      'waitlist:' || waitlist.id::text,
      'waitlist_companion:' || waitlist_companions.id::text,
      waitlist.id,
      waitlist_companions.id,
      'waitlist',
      'waitlist_companion',
      'companion',
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::date,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE report_context.time_zone)::time,
        (waitlist.created_at AT TIME ZONE report_context.time_zone)::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      waitlist_companions.created_at,
      NULLIF(btrim(waitlist_companions.name), ''),
      NULLIF(btrim(waitlist_companions.phone), ''),
      NULLIF(lower(btrim(waitlist_companions.email)), ''),
      waitlist_companions.birthdate,
      public.phone_customer_identity_digits(waitlist_companions.phone_e164, waitlist_companions.phone, waitlist_companions.phone_country),
      NULLIF(lower(btrim(waitlist_companions.email)), ''),
      COALESCE(waitlist.seated_party_size, waitlist.party_size),
      waitlist.status,
      'checked_in',
      NULL::text,
      NULL::uuid,
      true,
      NULLIF(btrim(waitlist.guest_name), ''),
      2,
      waitlist_companions.position,
      linkage.has_linked_presence,
      NOT linkage.has_linked_presence
    FROM public.waitlist_companions
    JOIN public.waitlist
      ON waitlist.id = waitlist_companions.waitlist_id
    CROSS JOIN report_context
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM public.reservations linked_reservation
        WHERE linked_reservation.origin_waitlist_id = waitlist.id
          AND linked_reservation.status IN ('checked_in', 'completed')
      ) AS has_linked_presence
    ) AS linkage
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'seated'
      AND (
        right(regexp_replace(COALESCE(waitlist_companions.phone, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR right(regexp_replace(COALESCE(waitlist_companions.phone_e164, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR NULLIF(lower(btrim(waitlist_companions.email)), '') IN (SELECT requested_emails.email FROM requested_emails)
        OR ('contact:waitlist_companion:' || waitlist_companions.id::text) IN (SELECT requested_keys.key FROM requested_keys)
        OR (
          -- Números com menos de 10 dígitos: compara pelo tamanho do fim de cada chave.
          (SELECT count(*) > 0 FROM requested_phone_tails WHERE length(requested_phone_tails.tail) < 7)
          AND EXISTS (
            SELECT 1
            FROM requested_phone_tails AS short_tails
            WHERE length(short_tails.tail) < 7
              AND (
              right(regexp_replace(COALESCE(waitlist_companions.phone, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              OR right(regexp_replace(COALESCE(waitlist_companions.phone_e164, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              )
          )
        )
      )
  ),
  labeled_records AS (
    SELECT
      raw_records.*,
      CASE
        WHEN raw_records.phone_normalized IS NOT NULL
          THEN 'phone:' || raw_records.phone_normalized
        WHEN raw_records.email_normalized IS NOT NULL
          THEN 'email:' || raw_records.email_normalized
        ELSE 'contact:' || raw_records.lead_source || ':' || raw_records.contact_id::text
      END AS customer_key,
      CASE
        WHEN raw_records.phone_normalized IS NOT NULL THEN 'phone'
        WHEN raw_records.email_normalized IS NOT NULL THEN 'email'
        ELSE 'contact'
      END AS identity_kind,
      CASE
        WHEN raw_records.phone_normalized IS NOT NULL THEN raw_records.phone_normalized
        WHEN raw_records.email_normalized IS NOT NULL THEN raw_records.email_normalized
        ELSE raw_records.lead_source || ':' || raw_records.contact_id::text
      END AS identity_value
    FROM raw_records
  ),
  ranked_records AS (
    SELECT
      labeled_records.*,
      row_number() OVER (
        PARTITION BY
          labeled_records.company_id,
          labeled_records.canonical_event_key,
          labeled_records.customer_key
        ORDER BY
          labeled_records.contact_priority,
          labeled_records.contact_position,
          labeled_records.contact_id
      ) AS event_contact_rank
    FROM labeled_records
    WHERE labeled_records.customer_key IN (SELECT requested_keys.key FROM requested_keys)
  )
  SELECT
    ranked_records.company_id,
    ranked_records.customer_key,
    ranked_records.identity_kind,
    ranked_records.identity_value,
    ranked_records.canonical_event_key,
    ranked_records.contact_record_key,
    ranked_records.visit_id,
    ranked_records.contact_id,
    ranked_records.visit_origin,
    ranked_records.lead_source,
    ranked_records.role_kind,
    ranked_records.record_date,
    ranked_records.record_time,
    ranked_records.record_at,
    ranked_records.presence_date,
    ranked_records.presence_time,
    ranked_records.presence_at,
    ranked_records.contact_created_at,
    ranked_records.guest_name,
    ranked_records.guest_phone,
    ranked_records.guest_email,
    ranked_records.guest_birthdate,
    ranked_records.phone_normalized,
    ranked_records.email_normalized,
    ranked_records.party_size,
    ranked_records.status,
    ranked_records.normalized_status,
    ranked_records.occasion,
    ranked_records.origin_waitlist_id,
    ranked_records.came_from_waitlist,
    ranked_records.reservation_holder_name,
    ranked_records.is_waitlist_suppressed,
    ranked_records.is_canonical_presence
  FROM ranked_records
  WHERE ranked_records.event_contact_rank = 1;
$function$;

CREATE OR REPLACE FUNCTION public._get_crm_lead_profiles_for_keys(_company_id uuid, _keys text[])
 RETURNS TABLE(company_id uuid, customer_key text, identity_kind text, identity_value text, phone_normalized text, email_normalized text, display_phone text, latest_name text, latest_email text, latest_birthdate date, first_seen_at timestamp with time zone, last_visit_date date, last_visit_time time without time zone, last_visit_at timestamp with time zone, state_code text, state_name text, source text, canonical_visit_count integer, crm_lead_id uuid, crm_notes text, crm_imported_at timestamp with time zone, crm_imported_by_user_id uuid, crm_import_filename text, is_import_only boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH requested_keys AS MATERIALIZED (
    SELECT DISTINCT requested.key
    FROM unnest(COALESCE(_keys, '{}'::text[])) AS requested(key)
    WHERE requested.key IS NOT NULL
  ),
  -- O telefone padronizado é o número digitado (ou o E.164) só com dígitos,
  -- às vezes com 55 na frente: os últimos dígitos são sempre os mesmos.
  requested_phone_tails AS MATERIALIZED (
    SELECT DISTINCT right(
      substring(requested_keys.key FROM 7),
      LEAST(7, GREATEST(length(requested_keys.key) - 9, 1))
    ) AS tail
    FROM requested_keys
    WHERE requested_keys.key LIKE 'phone:_%'
  ),
  requested_emails AS MATERIALIZED (
    SELECT DISTINCT substring(requested_keys.key FROM 7) AS email
    FROM requested_keys
    WHERE requested_keys.key LIKE 'email:_%'
  ),
  contact_records AS MATERIALIZED (
    SELECT *
    FROM public._get_crm_contact_records_for_keys(_company_id, _keys)
  ),
  contact_first_seen AS (
    SELECT
      contact_records.company_id,
      contact_records.customer_key,
      min(contact_records.contact_created_at) AS first_seen_at
    FROM contact_records
    GROUP BY
      contact_records.company_id,
      contact_records.customer_key
  ),
  visible_contact_rollup AS (
    SELECT
      contact_records.company_id,
      contact_records.customer_key,
      min(contact_records.identity_kind) AS identity_kind,
      min(contact_records.identity_value) AS identity_value,
      min(contact_records.phone_normalized) AS phone_normalized,
      min(contact_records.email_normalized) FILTER (
        WHERE contact_records.email_normalized IS NOT NULL
      ) AS email_normalized,
      (
        array_agg(
          contact_records.guest_phone
          ORDER BY
            contact_records.record_at DESC,
            CASE contact_records.role_kind WHEN 'holder' THEN 1 ELSE 2 END,
            contact_records.contact_record_key
        ) FILTER (
          WHERE NULLIF(btrim(contact_records.guest_phone), '') IS NOT NULL
        )
      )[1] AS display_phone,
      (
        array_agg(
          contact_records.guest_name
          ORDER BY
            contact_records.record_at DESC,
            CASE contact_records.role_kind WHEN 'holder' THEN 1 ELSE 2 END,
            contact_records.contact_record_key
        ) FILTER (
          WHERE NULLIF(btrim(contact_records.guest_name), '') IS NOT NULL
        )
      )[1] AS latest_name,
      (
        array_agg(
          contact_records.guest_email
          ORDER BY
            contact_records.record_at DESC,
            CASE contact_records.role_kind WHEN 'holder' THEN 1 ELSE 2 END,
            contact_records.contact_record_key
        ) FILTER (
          WHERE NULLIF(btrim(contact_records.guest_email), '') IS NOT NULL
        )
      )[1] AS latest_email,
      (
        array_agg(
          contact_records.guest_birthdate
          ORDER BY
            contact_records.record_at DESC,
            CASE contact_records.role_kind WHEN 'holder' THEN 1 ELSE 2 END,
            contact_records.contact_record_key
        ) FILTER (
          WHERE contact_records.guest_birthdate IS NOT NULL
        )
      )[1] AS latest_birthdate,
      (
        array_agg(
          contact_records.lead_source
          ORDER BY
            contact_records.record_at DESC,
            CASE contact_records.role_kind WHEN 'holder' THEN 1 ELSE 2 END,
            contact_records.contact_record_key
        )
      )[1] AS latest_lead_source,
      bool_or(contact_records.role_kind = 'holder') AS has_holder_role,
      bool_or(contact_records.role_kind = 'companion') AS has_companion_role,
      max(contact_records.record_at) AS latest_contact_at
    FROM contact_records
    WHERE NOT contact_records.is_waitlist_suppressed
    GROUP BY
      contact_records.company_id,
      contact_records.customer_key
  ),
  presence_rollup AS (
    SELECT
      contact_records.company_id,
      contact_records.customer_key,
      count(*)::integer AS canonical_visit_count,
      (
        array_agg(
          contact_records.presence_date
          ORDER BY
            contact_records.presence_at DESC,
            contact_records.canonical_event_key DESC
        )
      )[1] AS last_visit_date,
      (
        array_agg(
          contact_records.presence_time
          ORDER BY
            contact_records.presence_at DESC,
            contact_records.canonical_event_key DESC
        )
      )[1] AS last_visit_time,
      max(contact_records.presence_at) AS last_visit_at
    FROM contact_records
    WHERE contact_records.is_canonical_presence
    GROUP BY
      contact_records.company_id,
      contact_records.customer_key
  ),
  normalized_imports AS (
    SELECT
      crm_leads.*,
      COALESCE(public.phone_identity_digits(crm_leads.phone_e164, crm_leads.phone, crm_leads.phone_country), public.phone_customer_identity_digits(NULL, crm_leads.phone_normalized, 'BR'), public.phone_customer_identity_digits(NULL, crm_leads.phone, crm_leads.phone_country)) AS canonical_phone,
      COALESCE(
        NULLIF(lower(btrim(crm_leads.email_normalized)), ''),
        NULLIF(lower(btrim(crm_leads.email)), '')
      ) AS canonical_email
    FROM public.crm_leads
    WHERE crm_leads.company_id = _company_id
      AND (
        ('contact:crm_lead:' || crm_leads.id::text) IN (SELECT requested_keys.key FROM requested_keys)
        OR (
          NULLIF(btrim(crm_leads.profile_customer_key), '') IS NOT NULL
          AND public.canonical_crm_customer_key(crm_leads.profile_customer_key)
            IN (SELECT requested_keys.key FROM requested_keys)
        )
        OR NULLIF(lower(btrim(crm_leads.email_normalized)), '') IN (SELECT requested_emails.email FROM requested_emails)
        OR NULLIF(lower(btrim(crm_leads.email)), '') IN (SELECT requested_emails.email FROM requested_emails)
        OR right(regexp_replace(COALESCE(crm_leads.phone, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR right(regexp_replace(COALESCE(crm_leads.phone_e164, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR right(regexp_replace(COALESCE(crm_leads.phone_normalized, ''), '\D', '', 'g'), 7)
          IN (SELECT requested_phone_tails.tail FROM requested_phone_tails)
        OR (
          -- Números com menos de 10 dígitos: compara pelo tamanho do fim de cada chave.
          (SELECT count(*) > 0 FROM requested_phone_tails WHERE length(requested_phone_tails.tail) < 7)
          AND EXISTS (
            SELECT 1
            FROM requested_phone_tails AS short_tails
            WHERE length(short_tails.tail) < 7
              AND (
              right(regexp_replace(COALESCE(crm_leads.phone, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              OR right(regexp_replace(COALESCE(crm_leads.phone_e164, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              OR right(regexp_replace(COALESCE(crm_leads.phone_normalized, ''), '\D', '', 'g'), length(short_tails.tail)) = short_tails.tail
              )
          )
        )
      )
  ),
  labeled_imports AS (
    SELECT
      normalized_imports.*,
      CASE
        WHEN NULLIF(btrim(normalized_imports.profile_customer_key), '') IS NOT NULL
          THEN public.canonical_crm_customer_key(normalized_imports.profile_customer_key)
        WHEN normalized_imports.canonical_phone IS NOT NULL
          THEN 'phone:' || normalized_imports.canonical_phone
        WHEN normalized_imports.canonical_email IS NOT NULL
          THEN 'email:' || normalized_imports.canonical_email
        ELSE 'contact:crm_lead:' || normalized_imports.id::text
      END AS customer_key,
      CASE
        WHEN normalized_imports.canonical_phone IS NOT NULL THEN 'phone'
        WHEN normalized_imports.canonical_email IS NOT NULL THEN 'email'
        ELSE 'contact'
      END AS identity_kind,
      CASE
        WHEN normalized_imports.canonical_phone IS NOT NULL THEN normalized_imports.canonical_phone
        WHEN normalized_imports.canonical_email IS NOT NULL THEN normalized_imports.canonical_email
        ELSE 'crm_lead:' || normalized_imports.id::text
      END AS identity_value
    FROM normalized_imports
  ),
  ranked_imports AS (
    SELECT
      labeled_imports.*,
      min(LEAST(labeled_imports.created_at, labeled_imports.imported_at)) OVER (
        PARTITION BY labeled_imports.company_id, labeled_imports.customer_key
      ) AS first_seen_at,
      row_number() OVER (
        PARTITION BY labeled_imports.company_id, labeled_imports.customer_key
        ORDER BY
          labeled_imports.imported_at DESC,
          labeled_imports.updated_at DESC,
          labeled_imports.id
      ) AS import_rank
    FROM labeled_imports
    WHERE labeled_imports.customer_key IN (SELECT requested_keys.key FROM requested_keys)
  ),
  latest_imports AS (
    SELECT *
    FROM ranked_imports
    WHERE ranked_imports.import_rank = 1
  ),
  identity_keys AS (
    SELECT
      visible_contact_rollup.company_id,
      visible_contact_rollup.customer_key
    FROM visible_contact_rollup

    UNION

    SELECT
      latest_imports.company_id,
      latest_imports.customer_key
    FROM latest_imports
  ),
  profiles_without_state AS (
    SELECT
      identity_keys.company_id,
      identity_keys.customer_key,
      COALESCE(visible_contact_rollup.identity_kind, latest_imports.identity_kind) AS identity_kind,
      COALESCE(visible_contact_rollup.identity_value, latest_imports.identity_value) AS identity_value,
      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.canonical_phone
        ELSE COALESCE(visible_contact_rollup.phone_normalized, latest_imports.canonical_phone)
      END AS phone_normalized,
      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.canonical_email
        ELSE COALESCE(visible_contact_rollup.email_normalized, latest_imports.canonical_email)
      END AS email_normalized,
      CASE
        WHEN latest_imports.source = 'manual_edit' THEN
          COALESCE(COALESCE(latest_imports.phone_e164, NULLIF(btrim(latest_imports.phone), '')), latest_imports.canonical_phone, '')
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            COALESCE(latest_imports.phone_e164, NULLIF(btrim(latest_imports.phone), '')),
            latest_imports.canonical_phone,
            visible_contact_rollup.display_phone,
            ''
          )
        ELSE
          COALESCE(
            visible_contact_rollup.display_phone,
            COALESCE(latest_imports.phone_e164, NULLIF(btrim(latest_imports.phone), '')),
            latest_imports.canonical_phone,
            ''
          )
      END AS display_phone,
      CASE
        WHEN latest_imports.source = 'manual_edit' OR latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            NULLIF(btrim(latest_imports.full_name), ''),
            visible_contact_rollup.latest_name,
            'Lead sem nome'
          )
        ELSE
          COALESCE(
            visible_contact_rollup.latest_name,
            NULLIF(btrim(latest_imports.full_name), ''),
            'Lead sem nome'
          )
      END AS latest_name,
      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.canonical_email
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            NULLIF(lower(btrim(latest_imports.email)), ''),
            latest_imports.canonical_email,
            visible_contact_rollup.latest_email
          )
        ELSE
          COALESCE(
            visible_contact_rollup.latest_email,
            NULLIF(lower(btrim(latest_imports.email)), ''),
            latest_imports.canonical_email
          )
      END AS latest_email,
      CASE
        WHEN latest_imports.source = 'manual_edit' THEN latest_imports.birthdate
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(latest_imports.birthdate, visible_contact_rollup.latest_birthdate)
        ELSE
          COALESCE(visible_contact_rollup.latest_birthdate, latest_imports.birthdate)
      END AS latest_birthdate,
      CASE
        WHEN contact_first_seen.first_seen_at IS NULL THEN latest_imports.first_seen_at
        WHEN latest_imports.first_seen_at IS NULL THEN contact_first_seen.first_seen_at
        ELSE LEAST(contact_first_seen.first_seen_at, latest_imports.first_seen_at)
      END AS first_seen_at,
      presence_rollup.last_visit_date,
      presence_rollup.last_visit_time,
      presence_rollup.last_visit_at,
      CASE
        WHEN visible_contact_rollup.customer_key IS NULL THEN 'imported'
        WHEN visible_contact_rollup.has_holder_role
          AND visible_contact_rollup.has_companion_role THEN 'mixed'
        ELSE visible_contact_rollup.latest_lead_source
      END AS source,
      COALESCE(presence_rollup.canonical_visit_count, 0)::integer AS canonical_visit_count,
      latest_imports.id AS crm_lead_id,
      latest_imports.notes AS crm_notes,
      latest_imports.imported_at AS crm_imported_at,
      latest_imports.imported_by_user_id AS crm_imported_by_user_id,
      latest_imports.import_filename AS crm_import_filename,
      visible_contact_rollup.customer_key IS NULL AS is_import_only
    FROM identity_keys
    LEFT JOIN contact_first_seen
      ON contact_first_seen.company_id = identity_keys.company_id
     AND contact_first_seen.customer_key = identity_keys.customer_key
    LEFT JOIN visible_contact_rollup
      ON visible_contact_rollup.company_id = identity_keys.company_id
     AND visible_contact_rollup.customer_key = identity_keys.customer_key
    LEFT JOIN presence_rollup
      ON presence_rollup.company_id = identity_keys.company_id
     AND presence_rollup.customer_key = identity_keys.customer_key
    LEFT JOIN latest_imports
      ON latest_imports.company_id = identity_keys.company_id
     AND latest_imports.customer_key = identity_keys.customer_key
  ),
  profiles_with_state AS (
    SELECT
      profiles_without_state.*,
      public._crm_phone_state_code(profiles_without_state.phone_normalized) AS state_code
    FROM profiles_without_state
  )
  SELECT
    profiles_with_state.company_id,
    profiles_with_state.customer_key,
    profiles_with_state.identity_kind,
    profiles_with_state.identity_value,
    profiles_with_state.phone_normalized,
    profiles_with_state.email_normalized,
    profiles_with_state.display_phone,
    profiles_with_state.latest_name,
    profiles_with_state.latest_email,
    profiles_with_state.latest_birthdate,
    profiles_with_state.first_seen_at,
    profiles_with_state.last_visit_date,
    profiles_with_state.last_visit_time,
    profiles_with_state.last_visit_at,
    profiles_with_state.state_code,
    public._crm_state_name(profiles_with_state.state_code) AS state_name,
    profiles_with_state.source,
    profiles_with_state.canonical_visit_count,
    profiles_with_state.crm_lead_id,
    profiles_with_state.crm_notes,
    profiles_with_state.crm_imported_at,
    profiles_with_state.crm_imported_by_user_id,
    profiles_with_state.crm_import_filename,
    profiles_with_state.is_import_only
  FROM profiles_with_state;
$function$;

-- Funções auxiliares da versão anterior, chamadas linha a linha.
DROP FUNCTION IF EXISTS public._crm_contact_may_have_key(text, text, text, text, uuid, text[], text[], text[]);
DROP FUNCTION IF EXISTS public._crm_import_may_have_key(text, uuid, text, text, text, text, text, text[], text[], text[]);
DROP FUNCTION IF EXISTS public._crm_search_key_filter(text[]);

DO $rewire$
DECLARE
  _change record;
  _definition text;
  _occurrences integer;
BEGIN
  FOR _change IN
    SELECT *
    FROM (VALUES
      (
        1,
        'public.get_company_crm_relationship(uuid,text,text,integer,integer)',
        $old$IF NOT EXISTS (SELECT 1 FROM public._get_crm_lead_profiles(_company_id) p WHERE p.customer_key = _key) THEN$old$,
        $new$IF NOT EXISTS (SELECT 1 FROM public._get_crm_lead_profiles_for_keys(_company_id, ARRAY[_key]) p WHERE p.customer_key = _key) THEN$new$
      ),
      (
        2,
        'public._get_crm_relationship_reservations(uuid,text)',
        $old$FROM public._get_crm_contact_records(_company_id) c$old$,
        $new$FROM public._get_crm_contact_records_for_keys(_company_id, ARRAY[_customer_key]) c$new$
      ),
      (
        3,
        'public.get_crm_lead_presence_history(uuid,text,integer,integer)',
        $old$SELECT 1 FROM public._get_crm_contact_records(_company_id) AS legacy_contact$old$,
        $new$SELECT 1 FROM public._get_crm_contact_records_for_keys(_company_id, ARRAY[_effective_customer_key]) AS legacy_contact$new$
      ),
      (
        4,
        'public.get_crm_lead_presence_history(uuid,text,integer,integer)',
        $old$    FROM public._get_customer_canonical_visit_events(
      _company_id,
      NULL,
      true
    ) AS canonical_visits
    WHERE canonical_visits.customer_key = _effective_customer_key$old$,
        -- Mesmo recorte de _get_customer_canonical_visit_events(_company_id, NULL, true):
        -- presenças canônicas, com acompanhantes e sem data limite.
        $new$    FROM public._get_crm_contact_records_for_keys(
      _company_id,
      ARRAY[_effective_customer_key]
    ) AS canonical_visits
    WHERE canonical_visits.customer_key = _effective_customer_key
      AND canonical_visits.is_canonical_presence$new$
      )
    ) AS changes(step, signature, old_text, new_text)
    ORDER BY step
  LOOP
    _definition := pg_get_functiondef(_change.signature::regprocedure);
    _occurrences := (length(_definition) - length(replace(_definition, _change.old_text, '')))
      / length(_change.old_text);
    IF _occurrences <> 1 THEN
      RAISE EXCEPTION 'Trecho esperado aparece % vezes em %', _occurrences, _change.signature;
    END IF;
    EXECUTE replace(_definition, _change.old_text, _change.new_text);
  END LOOP;
END
$rewire$;

REVOKE ALL ON FUNCTION public._get_crm_contact_records_for_keys(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._get_crm_lead_profiles_for_keys(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
