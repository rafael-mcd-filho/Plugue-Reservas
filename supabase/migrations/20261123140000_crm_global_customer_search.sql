-- Busca de clientes da busca global do painel (lupa do topo).
--
-- get_crm_leads_page monta a ficha de TODOS os clientes da unidade antes de
-- aplicar o texto procurado. Para isso padroniza o telefone de cada reserva,
-- acompanhante e entrada da fila, e cada padronização consulta o plano de
-- numeração. Em unidades grandes a chamada passa do limite de 8 s do papel
-- authenticated e a busca global mostra "Não foi possível buscar clientes"
-- (57014, statement timeout).
--
-- search_crm_leads faz o caminho inverso:
--   1. _crm_search_customer_keys acha os registros e importações cujo nome,
--      e-mail ou telefone contém o texto (comparação simples nas colunas, sem
--      padronizar) e padroniza só o telefone deles para saber quais clientes
--      (customer_key) são candidatos;
--   2. _get_crm_lead_profiles_for_keys monta a ficha só desses clientes. Ela é
--      cópia de _get_crm_lead_profiles/_get_crm_contact_records de produção,
--      com um pré-filtro barato (fim do telefone, e-mail ou chave do contato)
--      que só deixa de fora registros que não podem ser desses clientes;
--   3. o filtro final e a ordem são os da tela Clientes (visitas, primeira
--      vez, chave), aplicados sobre a ficha montada.
--
-- Diferenças de propósito em relação ao texto procurado na tela Clientes:
--   * não compara com a chave interna (phone:/email:/contact:), que fazia
--     buscas como "pho" ou "one" trazerem todos os clientes;
--   * só compara dígitos quando a busca parece um telefone (dígitos, espaço,
--     +, parênteses, ponto ou hífen), para "Ana 62" não trazer todo o DDD 62.
--
-- get_crm_leads_page, _get_crm_contact_records e _get_crm_lead_profiles não mudam.

-- O telefone padronizado (DDI + número) pode conter estes dígitos?
-- Resposta sem padronizar: os dígitos estão no telefone em E.164 ou no número
-- digitado, inclusive quando a busca começa pelo 55 que a padronização acrescenta.
CREATE OR REPLACE FUNCTION public._crm_search_phone_may_contain(_e164 text, _raw text, _digits text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  WITH value AS (
    SELECT
      regexp_replace(COALESCE(_e164, ''), '\D', '', 'g') AS e164_digits,
      regexp_replace(COALESCE(_raw, ''), '\D', '', 'g') AS raw_digits
  )
  SELECT COALESCE(_digits, '') <> '' AND (
    position(_digits IN value.e164_digits) > 0
    OR position(_digits IN value.raw_digits) > 0
    OR position(_digits IN '55' || value.raw_digits) > 0
    OR (
      _digits LIKE '55%'
      AND length(_digits) > 2
      AND position(substring(_digits FROM 3) IN value.raw_digits) > 0
    )
    OR (
      _digits LIKE '5%'
      AND length(_digits) > 1
      AND position(substring(_digits FROM 2) IN value.raw_digits) > 0
    )
  )
  FROM value;
$function$;

-- Partes das chaves pedidas usadas no pré-filtro: o fim de cada telefone
-- (últimos 7 dígitos, ou menos em números curtos, sempre fora do DDI), os
-- e-mails e as próprias chaves.
CREATE OR REPLACE FUNCTION public._crm_search_key_filter(_keys text[])
RETURNS TABLE(phone_tails text[], emails text[], keys text[])
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT
    COALESCE(
      array_agg(DISTINCT right(substring(requested.key FROM 7), LEAST(7, GREATEST(length(requested.key) - 9, 1))))
        FILTER (WHERE requested.key LIKE 'phone:_%'),
      '{}'::text[]
    ),
    COALESCE(
      array_agg(DISTINCT substring(requested.key FROM 7)) FILTER (WHERE requested.key LIKE 'email:_%'),
      '{}'::text[]
    ),
    COALESCE(array_agg(DISTINCT requested.key), '{}'::text[])
  FROM unnest(COALESCE(_keys, '{}'::text[])) AS requested(key)
  WHERE requested.key IS NOT NULL;
$function$;

-- Um registro de reserva, acompanhante ou fila pode ser de uma das chaves?
-- Falso só quando com certeza não é: a chave exata é calculada depois.
CREATE OR REPLACE FUNCTION public._crm_contact_may_have_key(
  _phone text,
  _phone_e164 text,
  _email text,
  _lead_source text,
  _contact_id uuid,
  _phone_tails text[],
  _emails text[],
  _keys text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  WITH value AS (
    SELECT
      regexp_replace(COALESCE(_phone, ''), '\D', '', 'g') AS raw_digits,
      regexp_replace(COALESCE(_phone_e164, ''), '\D', '', 'g') AS e164_digits
  )
  SELECT
    ('contact:' || _lead_source || ':' || _contact_id::text) = ANY(_keys)
    OR NULLIF(lower(btrim(_email)), '') = ANY(_emails)
    OR EXISTS (
      SELECT 1
      FROM unnest(_phone_tails) AS tail
      WHERE position(tail IN value.raw_digits) > 0
        OR position(tail IN value.e164_digits) > 0
    )
  FROM value;
$function$;

-- O mesmo para uma importação do CRM (crm_leads).
CREATE OR REPLACE FUNCTION public._crm_import_may_have_key(
  _profile_customer_key text,
  _id uuid,
  _phone text,
  _phone_e164 text,
  _phone_normalized text,
  _email text,
  _email_normalized text,
  _phone_tails text[],
  _emails text[],
  _keys text[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH value AS (
    SELECT
      regexp_replace(COALESCE(_phone, ''), '\D', '', 'g') AS raw_digits,
      regexp_replace(COALESCE(_phone_e164, ''), '\D', '', 'g') AS e164_digits,
      regexp_replace(COALESCE(_phone_normalized, ''), '\D', '', 'g') AS normalized_digits
  )
  SELECT
    ('contact:crm_lead:' || _id::text) = ANY(_keys)
    OR (
      NULLIF(btrim(_profile_customer_key), '') IS NOT NULL
      AND public.canonical_crm_customer_key(_profile_customer_key) = ANY(_keys)
    )
    OR NULLIF(lower(btrim(_email_normalized)), '') = ANY(_emails)
    OR NULLIF(lower(btrim(_email)), '') = ANY(_emails)
    OR EXISTS (
      SELECT 1
      FROM unnest(_phone_tails) AS tail
      WHERE position(tail IN value.raw_digits) > 0
        OR position(tail IN value.e164_digits) > 0
        OR position(tail IN value.normalized_digits) > 0
    )
  FROM value;
$function$;

CREATE OR REPLACE FUNCTION public._get_crm_contact_records_for_keys(_company_id uuid, _keys text[])
 RETURNS TABLE(company_id uuid, customer_key text, identity_kind text, identity_value text, canonical_event_key text, contact_record_key text, visit_id uuid, contact_id uuid, visit_origin text, lead_source text, role_kind text, record_date date, record_time time without time zone, record_at timestamp with time zone, presence_date date, presence_time time without time zone, presence_at timestamp with time zone, contact_created_at timestamp with time zone, guest_name text, guest_phone text, guest_email text, guest_birthdate date, phone_normalized text, email_normalized text, party_size integer, status text, normalized_status text, occasion text, origin_waitlist_id uuid, came_from_waitlist boolean, reservation_holder_name text, is_waitlist_suppressed boolean, is_canonical_presence boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH report_context AS MATERIALIZED (
    SELECT public._company_report_time_zone(_company_id) AS time_zone
  ),
  key_filter AS MATERIALIZED (
    SELECT * FROM public._crm_search_key_filter(_keys)
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
    CROSS JOIN key_filter
    WHERE reservations.company_id = _company_id
      AND public._crm_contact_may_have_key(reservations.guest_phone, reservations.guest_phone_e164, reservations.guest_email, 'reservation_holder', reservations.id,
        key_filter.phone_tails, key_filter.emails, key_filter.keys)

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
    CROSS JOIN key_filter
    WHERE reservations.company_id = _company_id
      AND public._crm_contact_may_have_key(reservation_companions.phone, reservation_companions.phone_e164, reservation_companions.email, 'reservation_companion', reservation_companions.id,
        key_filter.phone_tails, key_filter.emails, key_filter.keys)

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
    CROSS JOIN key_filter
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
      AND public._crm_contact_may_have_key(waitlist.guest_phone, waitlist.guest_phone_e164, waitlist.guest_email, 'waitlist_holder', waitlist.id,
        key_filter.phone_tails, key_filter.emails, key_filter.keys)

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
    CROSS JOIN key_filter
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
      AND public._crm_contact_may_have_key(waitlist_companions.phone, waitlist_companions.phone_e164, waitlist_companions.email, 'waitlist_companion', waitlist_companions.id,
        key_filter.phone_tails, key_filter.emails, key_filter.keys)
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
    WHERE labeled_records.customer_key = ANY(_keys)
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
  WITH key_filter AS MATERIALIZED (
    SELECT * FROM public._crm_search_key_filter(_keys)
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
    CROSS JOIN key_filter
    WHERE crm_leads.company_id = _company_id
      AND public._crm_import_may_have_key(crm_leads.profile_customer_key, crm_leads.id, crm_leads.phone,
        crm_leads.phone_e164, crm_leads.phone_normalized, crm_leads.email, crm_leads.email_normalized,
        key_filter.phone_tails, key_filter.emails, key_filter.keys)
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
    WHERE labeled_imports.customer_key = ANY(_keys)
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

-- Clientes candidatos: chave de cada registro ou importação em que o texto
-- aparece no nome, e-mail ou telefone. Só esses têm o telefone padronizado.
CREATE OR REPLACE FUNCTION public._crm_search_customer_keys(
  _company_id uuid,
  _search_text text,
  _search_digits text
)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH contact_rows AS (
    SELECT
      'reservation_holder'::text AS lead_source,
      reservations.id AS contact_id,
      reservations.guest_name AS name,
      reservations.guest_phone AS phone,
      reservations.guest_phone_e164 AS phone_e164,
      reservations.guest_phone_country AS phone_country,
      reservations.guest_email AS email
    FROM public.reservations
    WHERE reservations.company_id = _company_id

    UNION ALL

    SELECT
      'reservation_companion',
      reservation_companions.id,
      reservation_companions.name,
      reservation_companions.phone,
      reservation_companions.phone_e164,
      reservation_companions.phone_country,
      reservation_companions.email
    FROM public.reservation_companions
    JOIN public.reservations
      ON reservations.id = reservation_companions.reservation_id
    WHERE reservations.company_id = _company_id

    UNION ALL

    SELECT
      'waitlist_holder',
      waitlist.id,
      waitlist.guest_name,
      waitlist.guest_phone,
      waitlist.guest_phone_e164,
      waitlist.guest_phone_country,
      waitlist.guest_email
    FROM public.waitlist
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'seated'

    UNION ALL

    SELECT
      'waitlist_companion',
      waitlist_companions.id,
      waitlist_companions.name,
      waitlist_companions.phone,
      waitlist_companions.phone_e164,
      waitlist_companions.phone_country,
      waitlist_companions.email
    FROM public.waitlist_companions
    JOIN public.waitlist
      ON waitlist.id = waitlist_companions.waitlist_id
    WHERE waitlist.company_id = _company_id
      AND waitlist.status = 'seated'
  ),
  matched_contacts AS MATERIALIZED (
    SELECT
      contact_rows.lead_source,
      contact_rows.contact_id,
      public.phone_customer_identity_digits(
        contact_rows.phone_e164,
        contact_rows.phone,
        contact_rows.phone_country
      ) AS phone_normalized,
      NULLIF(lower(btrim(contact_rows.email)), '') AS email_normalized
    FROM contact_rows
    WHERE position(_search_text IN lower(COALESCE(contact_rows.name, ''))) > 0
      OR position(_search_text IN lower(COALESCE(contact_rows.email, ''))) > 0
      OR position(_search_text IN lower(COALESCE(contact_rows.phone, ''))) > 0
      OR (
        _search_digits IS NOT NULL
        AND public._crm_search_phone_may_contain(contact_rows.phone_e164, contact_rows.phone, _search_digits)
      )
  ),
  matched_imports AS MATERIALIZED (
    SELECT
      crm_leads.id,
      crm_leads.profile_customer_key,
      COALESCE(
        public.phone_identity_digits(crm_leads.phone_e164, crm_leads.phone, crm_leads.phone_country),
        public.phone_customer_identity_digits(NULL, crm_leads.phone_normalized, 'BR'),
        public.phone_customer_identity_digits(NULL, crm_leads.phone, crm_leads.phone_country)
      ) AS canonical_phone,
      COALESCE(
        NULLIF(lower(btrim(crm_leads.email_normalized)), ''),
        NULLIF(lower(btrim(crm_leads.email)), '')
      ) AS canonical_email
    FROM public.crm_leads
    WHERE crm_leads.company_id = _company_id
      AND (
        position(_search_text IN lower(COALESCE(crm_leads.full_name, ''))) > 0
        OR position(_search_text IN lower(COALESCE(crm_leads.email, ''))) > 0
        OR position(_search_text IN lower(COALESCE(crm_leads.email_normalized, ''))) > 0
        OR position(_search_text IN lower(COALESCE(crm_leads.phone, ''))) > 0
        OR position(_search_text IN lower(COALESCE(crm_leads.phone_e164, ''))) > 0
        OR (
          _search_digits IS NOT NULL
          AND (
            public._crm_search_phone_may_contain(crm_leads.phone_e164, crm_leads.phone, _search_digits)
            OR public._crm_search_phone_may_contain(NULL, crm_leads.phone_normalized, _search_digits)
          )
        )
      )
  ),
  candidate_keys AS (
    SELECT CASE
      WHEN matched_contacts.phone_normalized IS NOT NULL
        THEN 'phone:' || matched_contacts.phone_normalized
      WHEN matched_contacts.email_normalized IS NOT NULL
        THEN 'email:' || matched_contacts.email_normalized
      ELSE 'contact:' || matched_contacts.lead_source || ':' || matched_contacts.contact_id::text
    END AS customer_key
    FROM matched_contacts

    UNION

    SELECT CASE
      WHEN NULLIF(btrim(matched_imports.profile_customer_key), '') IS NOT NULL
        THEN public.canonical_crm_customer_key(matched_imports.profile_customer_key)
      WHEN matched_imports.canonical_phone IS NOT NULL
        THEN 'phone:' || matched_imports.canonical_phone
      WHEN matched_imports.canonical_email IS NOT NULL
        THEN 'email:' || matched_imports.canonical_email
      ELSE 'contact:crm_lead:' || matched_imports.id::text
    END
    FROM matched_imports
  )
  SELECT COALESCE(array_agg(candidate_keys.customer_key ORDER BY candidate_keys.customer_key), '{}'::text[])
  FROM candidate_keys;
$function$;

CREATE OR REPLACE FUNCTION public.search_crm_leads(
  _company_id uuid,
  _search text,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _search_text text := NULLIF(lower(btrim(COALESCE(_search, ''))), '');
  _search_digits text;
  _keys text[];
  _offset bigint;
  _result jsonb;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR public.effective_auth_uid(_company_id) IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_company_panel_permission(public.effective_auth_uid(_company_id), _company_id, 'leads_view') THEN
      RAISE EXCEPTION 'Sem permissao para visualizar leads.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _search_text IS NULL THEN
    RAISE EXCEPTION 'search e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  IF char_length(_search_text) > 200 THEN
    RAISE EXCEPTION 'search nao pode ultrapassar 200 caracteres.' USING ERRCODE = '22023';
  END IF;

  IF _page IS NULL OR _page < 1 THEN
    RAISE EXCEPTION 'page deve ser maior ou igual a 1.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 50 THEN
    RAISE EXCEPTION 'page_size deve estar entre 1 e 50.' USING ERRCODE = '22023';
  END IF;

  -- Dígitos só quando a busca parece um telefone.
  IF _search_text ~ '^\+?[0-9\s().-]+$' THEN
    _search_digits := NULLIF(regexp_replace(_search_text, '\D', '', 'g'), '');
  END IF;

  _offset := (_page::bigint - 1) * _page_size::bigint;
  _keys := public._crm_search_customer_keys(_company_id, _search_text, _search_digits);

  IF cardinality(_keys) = 0 THEN
    RETURN jsonb_build_object(
      'leads', '[]'::jsonb,
      'meta', jsonb_build_object(
        'page', _page,
        'page_size', _page_size,
        'has_more', false,
        'generated_at', now()
      )
    );
  END IF;

  WITH profiles AS MATERIALIZED (
    SELECT *
    FROM public._get_crm_lead_profiles_for_keys(_company_id, _keys)
  ),
  matched_profiles AS (
    SELECT profiles.*
    FROM profiles
    WHERE position(_search_text IN lower(COALESCE(profiles.latest_name, ''))) > 0
      OR position(_search_text IN lower(COALESCE(profiles.latest_email, ''))) > 0
      OR position(_search_text IN lower(COALESCE(profiles.display_phone, ''))) > 0
      OR (
        _search_digits IS NOT NULL
        AND (
          position(_search_digits IN COALESCE(profiles.phone_normalized, '')) > 0
          OR position(
            _search_digits
            IN regexp_replace(COALESCE(profiles.display_phone, ''), '\D', '', 'g')
          ) > 0
        )
      )
  ),
  -- Um a mais que a página para saber se há próxima.
  window_profiles AS MATERIALIZED (
    SELECT matched_profiles.*
    FROM matched_profiles
    ORDER BY
      matched_profiles.canonical_visit_count DESC,
      matched_profiles.first_seen_at DESC,
      matched_profiles.customer_key
    LIMIT _page_size + 1
    OFFSET _offset
  ),
  paged_profiles AS (
    SELECT window_profiles.*
    FROM window_profiles
    ORDER BY
      window_profiles.canonical_visit_count DESC,
      window_profiles.first_seen_at DESC,
      window_profiles.customer_key
    LIMIT _page_size
  )
  SELECT jsonb_build_object(
    'leads', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'customer_key', paged_profiles.customer_key,
            'identity_kind', paged_profiles.identity_kind,
            'phone_normalized', paged_profiles.phone_normalized,
            'display_phone', paged_profiles.display_phone,
            'latest_name', paged_profiles.latest_name,
            'latest_email', paged_profiles.latest_email,
            'latest_birthdate', paged_profiles.latest_birthdate,
            'first_seen_at', paged_profiles.first_seen_at,
            'last_visit_date', paged_profiles.last_visit_date,
            'last_visit_time', paged_profiles.last_visit_time,
            'state_code', paged_profiles.state_code,
            'state_name', paged_profiles.state_name,
            'source', paged_profiles.source,
            'canonical_visit_count', paged_profiles.canonical_visit_count,
            'is_import_only', paged_profiles.is_import_only,
            'crm_lead', CASE
              WHEN paged_profiles.crm_lead_id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', paged_profiles.crm_lead_id,
                'notes', paged_profiles.crm_notes,
                'imported_at', paged_profiles.crm_imported_at,
                'imported_by_user_id', paged_profiles.crm_imported_by_user_id,
                'import_filename', paged_profiles.crm_import_filename
              )
            END
          )
          ORDER BY
            paged_profiles.canonical_visit_count DESC,
            paged_profiles.first_seen_at DESC,
            paged_profiles.customer_key
        )
        FROM paged_profiles
      ),
      '[]'::jsonb
    ),
    'meta', jsonb_build_object(
      'page', _page,
      'page_size', _page_size,
      'has_more', (SELECT count(*) FROM window_profiles) > _page_size,
      'generated_at', now()
    )
  )
  INTO _result;

  RETURN _result;
END;
$function$;

-- As funções internas ficam só para o dono, como _get_crm_lead_profiles.
-- O Supabase concede EXECUTE a anon/authenticated por padrão em funções novas,
-- por isso a revogação é explícita para cada papel.
REVOKE ALL ON FUNCTION public._crm_search_phone_may_contain(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_search_key_filter(text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_contact_may_have_key(text, text, text, text, uuid, text[], text[], text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_import_may_have_key(text, uuid, text, text, text, text, text, text[], text[], text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._get_crm_contact_records_for_keys(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._get_crm_lead_profiles_for_keys(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_search_customer_keys(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.search_crm_leads(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_crm_leads(uuid, text, integer, integer) TO authenticated, service_role;
