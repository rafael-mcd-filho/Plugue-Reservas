CREATE OR REPLACE FUNCTION public._crm_phone_state_code(_phone_normalized text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  WITH phone AS (
    SELECT regexp_replace(COALESCE(_phone_normalized, ''), '\D', '', 'g') AS digits
  ),
  ddd AS (
    SELECT CASE
      WHEN digits LIKE '55%' AND length(digits) >= 12 THEN substring(digits FROM 3 FOR 2)
      WHEN length(digits) >= 10 THEN substring(digits FROM 1 FOR 2)
      ELSE NULL
    END AS value
    FROM phone
  )
  SELECT CASE
    WHEN value = ANY (ARRAY['11','12','13','14','15','16','17','18','19']) THEN 'SP'
    WHEN value = ANY (ARRAY['21','22','24']) THEN 'RJ'
    WHEN value = ANY (ARRAY['27','28']) THEN 'ES'
    WHEN value = ANY (ARRAY['31','32','33','34','35','37','38']) THEN 'MG'
    WHEN value = ANY (ARRAY['41','42','43','44','45','46']) THEN 'PR'
    WHEN value = ANY (ARRAY['47','48','49']) THEN 'SC'
    WHEN value = ANY (ARRAY['51','53','54','55']) THEN 'RS'
    WHEN value = '61' THEN 'DF'
    WHEN value = ANY (ARRAY['62','64']) THEN 'GO'
    WHEN value = ANY (ARRAY['65','66']) THEN 'MT'
    WHEN value = '67' THEN 'MS'
    WHEN value = '68' THEN 'AC'
    WHEN value = '69' THEN 'RO'
    WHEN value = ANY (ARRAY['92','97']) THEN 'AM'
    WHEN value = '95' THEN 'RR'
    WHEN value = ANY (ARRAY['91','93','94']) THEN 'PA'
    WHEN value = '96' THEN 'AP'
    WHEN value = '63' THEN 'TO'
    WHEN value = ANY (ARRAY['98','99']) THEN 'MA'
    WHEN value = ANY (ARRAY['86','89']) THEN 'PI'
    WHEN value = ANY (ARRAY['85','88']) THEN 'CE'
    WHEN value = '84' THEN 'RN'
    WHEN value = '83' THEN 'PB'
    WHEN value = ANY (ARRAY['81','87']) THEN 'PE'
    WHEN value = '82' THEN 'AL'
    WHEN value = '79' THEN 'SE'
    WHEN value = ANY (ARRAY['71','73','74','75','77']) THEN 'BA'
    ELSE NULL
  END
  FROM ddd;
$$;

CREATE OR REPLACE FUNCTION public._crm_state_name(_state_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE upper(COALESCE(_state_code, ''))
    WHEN 'AC' THEN 'Acre'
    WHEN 'AL' THEN 'Alagoas'
    WHEN 'AP' THEN 'Amapá'
    WHEN 'AM' THEN 'Amazonas'
    WHEN 'BA' THEN 'Bahia'
    WHEN 'CE' THEN 'Ceará'
    WHEN 'DF' THEN 'Distrito Federal'
    WHEN 'ES' THEN 'Espírito Santo'
    WHEN 'GO' THEN 'Goiás'
    WHEN 'MA' THEN 'Maranhão'
    WHEN 'MT' THEN 'Mato Grosso'
    WHEN 'MS' THEN 'Mato Grosso do Sul'
    WHEN 'MG' THEN 'Minas Gerais'
    WHEN 'PA' THEN 'Pará'
    WHEN 'PB' THEN 'Paraíba'
    WHEN 'PR' THEN 'Paraná'
    WHEN 'PE' THEN 'Pernambuco'
    WHEN 'PI' THEN 'Piauí'
    WHEN 'RJ' THEN 'Rio de Janeiro'
    WHEN 'RN' THEN 'Rio Grande do Norte'
    WHEN 'RS' THEN 'Rio Grande do Sul'
    WHEN 'RO' THEN 'Rondônia'
    WHEN 'RR' THEN 'Roraima'
    WHEN 'SC' THEN 'Santa Catarina'
    WHEN 'SP' THEN 'São Paulo'
    WHEN 'SE' THEN 'Sergipe'
    WHEN 'TO' THEN 'Tocantins'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public._get_crm_contact_records(_company_id uuid)
RETURNS TABLE (
  company_id uuid,
  customer_key text,
  identity_kind text,
  identity_value text,
  canonical_event_key text,
  contact_record_key text,
  visit_id uuid,
  contact_id uuid,
  visit_origin text,
  lead_source text,
  role_kind text,
  record_date date,
  record_time time without time zone,
  record_at timestamptz,
  presence_date date,
  presence_time time without time zone,
  presence_at timestamptz,
  contact_created_at timestamptz,
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_birthdate date,
  phone_normalized text,
  email_normalized text,
  party_size integer,
  status text,
  normalized_status text,
  occasion text,
  origin_waitlist_id uuid,
  came_from_waitlist boolean,
  reservation_holder_name text,
  is_waitlist_suppressed boolean,
  is_canonical_presence boolean
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH raw_records AS (
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
      (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza' AS record_at,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date,
        reservations.date
      ) AS presence_date,
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::time,
        reservations.time
      ) AS presence_time,
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza'
      ) AS presence_at,
      reservations.created_at AS contact_created_at,
      NULLIF(btrim(reservations.guest_name), '') AS guest_name,
      NULLIF(btrim(reservations.guest_phone), '') AS guest_phone,
      NULLIF(lower(btrim(reservations.guest_email)), '') AS guest_email,
      reservations.guest_birthdate AS guest_birthdate,
      public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
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
    WHERE reservations.company_id = _company_id

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
      (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza',
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::date,
        reservations.date
      ),
      COALESCE(
        (reservations.checked_in_at AT TIME ZONE 'America/Fortaleza')::time,
        reservations.time
      ),
      COALESCE(
        reservations.checked_in_at,
        (reservations.date + reservations.time) AT TIME ZONE 'America/Fortaleza'
      ),
      reservation_companions.created_at,
      NULLIF(btrim(reservation_companions.name), ''),
      NULLIF(btrim(reservation_companions.phone), ''),
      NULLIF(lower(btrim(reservation_companions.email)), ''),
      reservation_companions.birthdate,
      public.normalize_whatsapp_phone(reservation_companions.phone),
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
    WHERE reservations.company_id = _company_id

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
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::time,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::time,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      waitlist.created_at,
      NULLIF(btrim(waitlist.guest_name), ''),
      NULLIF(btrim(waitlist.guest_phone), ''),
      NULLIF(lower(btrim(waitlist.guest_email)), ''),
      waitlist.guest_birthdate,
      public.normalize_whatsapp_phone(waitlist.guest_phone),
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
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::time,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::date,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::date
      ),
      COALESCE(
        (waitlist.seated_at AT TIME ZONE 'America/Fortaleza')::time,
        (waitlist.created_at AT TIME ZONE 'America/Fortaleza')::time
      ),
      COALESCE(waitlist.seated_at, waitlist.created_at),
      waitlist_companions.created_at,
      NULLIF(btrim(waitlist_companions.name), ''),
      NULLIF(btrim(waitlist_companions.phone), ''),
      NULLIF(lower(btrim(waitlist_companions.email)), ''),
      waitlist_companions.birthdate,
      public.normalize_whatsapp_phone(waitlist_companions.phone),
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
$$;

CREATE OR REPLACE FUNCTION public._get_customer_canonical_visit_events(
  _company_id uuid,
  _through_date date DEFAULT NULL,
  _include_companions boolean DEFAULT true
)
RETURNS TABLE (
  company_id uuid,
  customer_key text,
  identity_kind text,
  identity_value text,
  canonical_event_key text,
  contact_record_key text,
  visit_id uuid,
  contact_id uuid,
  visit_origin text,
  lead_source text,
  role_kind text,
  record_date date,
  record_time time without time zone,
  record_at timestamptz,
  presence_date date,
  presence_time time without time zone,
  presence_at timestamptz,
  contact_created_at timestamptz,
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_birthdate date,
  phone_normalized text,
  email_normalized text,
  party_size integer,
  status text,
  normalized_status text,
  occasion text,
  origin_waitlist_id uuid,
  came_from_waitlist boolean,
  reservation_holder_name text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    contact_records.company_id,
    contact_records.customer_key,
    contact_records.identity_kind,
    contact_records.identity_value,
    contact_records.canonical_event_key,
    contact_records.contact_record_key,
    contact_records.visit_id,
    contact_records.contact_id,
    contact_records.visit_origin,
    contact_records.lead_source,
    contact_records.role_kind,
    contact_records.record_date,
    contact_records.record_time,
    contact_records.record_at,
    contact_records.presence_date,
    contact_records.presence_time,
    contact_records.presence_at,
    contact_records.contact_created_at,
    contact_records.guest_name,
    contact_records.guest_phone,
    contact_records.guest_email,
    contact_records.guest_birthdate,
    contact_records.phone_normalized,
    contact_records.email_normalized,
    contact_records.party_size,
    contact_records.status,
    contact_records.normalized_status,
    contact_records.occasion,
    contact_records.origin_waitlist_id,
    contact_records.came_from_waitlist,
    contact_records.reservation_holder_name
  FROM public._get_crm_contact_records(_company_id) AS contact_records
  WHERE contact_records.is_canonical_presence
    AND (
      COALESCE(_include_companions, true)
      OR contact_records.role_kind = 'holder'
    )
    AND (
      _through_date IS NULL
      OR contact_records.presence_date <= _through_date
    );
$$;

CREATE OR REPLACE FUNCTION public._get_crm_lead_profiles(_company_id uuid)
RETURNS TABLE (
  company_id uuid,
  customer_key text,
  identity_kind text,
  identity_value text,
  phone_normalized text,
  email_normalized text,
  display_phone text,
  latest_name text,
  latest_email text,
  latest_birthdate date,
  first_seen_at timestamptz,
  last_visit_date date,
  last_visit_time time without time zone,
  last_visit_at timestamptz,
  state_code text,
  state_name text,
  source text,
  canonical_visit_count integer,
  crm_lead_id uuid,
  crm_notes text,
  crm_imported_at timestamptz,
  crm_imported_by_user_id uuid,
  crm_import_filename text,
  is_import_only boolean
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH contact_records AS MATERIALIZED (
    SELECT *
    FROM public._get_crm_contact_records(_company_id)
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
      COALESCE(
        public.normalize_whatsapp_phone(crm_leads.phone_normalized),
        public.normalize_whatsapp_phone(crm_leads.phone)
      ) AS canonical_phone,
      COALESCE(
        NULLIF(lower(btrim(crm_leads.email_normalized)), ''),
        NULLIF(lower(btrim(crm_leads.email)), '')
      ) AS canonical_email
    FROM public.crm_leads
    WHERE crm_leads.company_id = _company_id
  ),
  labeled_imports AS (
    SELECT
      normalized_imports.*,
      CASE
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
      COALESCE(visible_contact_rollup.phone_normalized, latest_imports.canonical_phone) AS phone_normalized,
      COALESCE(visible_contact_rollup.email_normalized, latest_imports.canonical_email) AS email_normalized,
      CASE
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
          COALESCE(
            NULLIF(btrim(latest_imports.phone), ''),
            latest_imports.canonical_phone,
            visible_contact_rollup.display_phone,
            ''
          )
        ELSE
          COALESCE(
            visible_contact_rollup.display_phone,
            NULLIF(btrim(latest_imports.phone), ''),
            latest_imports.canonical_phone,
            ''
          )
      END AS display_phone,
      CASE
        WHEN latest_imports.updated_at > visible_contact_rollup.latest_contact_at THEN
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
$$;

CREATE OR REPLACE FUNCTION public.get_crm_leads_page(
  _company_id uuid,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 25,
  _search text DEFAULT NULL,
  _created_from date DEFAULT NULL,
  _created_to date DEFAULT NULL,
  _state_code text DEFAULT NULL,
  _birthday_month integer DEFAULT NULL,
  _min_visits integer DEFAULT NULL,
  _max_visits integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_state_code text := NULLIF(upper(btrim(COALESCE(_state_code, ''))), '');
  _search_text text := NULLIF(lower(btrim(COALESCE(_search, ''))), '');
  _search_digits text := NULLIF(regexp_replace(COALESCE(_search, ''), '\D', '', 'g'), '');
  _offset integer;
  _result jsonb;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_company_panel_permission(auth.uid(), _company_id, 'leads_view') THEN
      RAISE EXCEPTION 'Sem permissao para visualizar leads.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _page IS NULL OR _page < 1 OR _page > 10000 THEN
    RAISE EXCEPTION 'page deve estar entre 1 e 10000.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'page_size deve estar entre 1 e 100.' USING ERRCODE = '22023';
  END IF;

  IF _search_text IS NOT NULL AND char_length(_search_text) > 200 THEN
    RAISE EXCEPTION 'search nao pode ultrapassar 200 caracteres.' USING ERRCODE = '22023';
  END IF;

  IF _created_from IS NOT NULL
    AND _created_to IS NOT NULL
    AND _created_to < _created_from THEN
    RAISE EXCEPTION 'Intervalo de criacao invalido.' USING ERRCODE = '22023';
  END IF;

  IF _effective_state_code = 'ALL' THEN
    _effective_state_code := NULL;
  END IF;

  IF _effective_state_code IS NOT NULL
    AND _effective_state_code <> 'UNKNOWN'
    AND _effective_state_code NOT IN (
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
      'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
    ) THEN
    RAISE EXCEPTION 'state_code invalido.' USING ERRCODE = '22023';
  END IF;

  IF _birthday_month IS NOT NULL
    AND (_birthday_month < 1 OR _birthday_month > 12) THEN
    RAISE EXCEPTION 'birthday_month deve estar entre 1 e 12.' USING ERRCODE = '22023';
  END IF;

  IF _min_visits IS NOT NULL AND (_min_visits < 0 OR _min_visits > 1000000) THEN
    RAISE EXCEPTION 'min_visits invalido.' USING ERRCODE = '22023';
  END IF;

  IF _max_visits IS NOT NULL AND (_max_visits < 0 OR _max_visits > 1000000) THEN
    RAISE EXCEPTION 'max_visits invalido.' USING ERRCODE = '22023';
  END IF;

  IF _min_visits IS NOT NULL
    AND _max_visits IS NOT NULL
    AND _max_visits < _min_visits THEN
    RAISE EXCEPTION 'max_visits deve ser maior ou igual a min_visits.' USING ERRCODE = '22023';
  END IF;

  _offset := (_page - 1) * _page_size;

  WITH profiles AS MATERIALIZED (
    SELECT *
    FROM public._get_crm_lead_profiles(_company_id)
  ),
  filtered_profiles AS MATERIALIZED (
    SELECT profiles.*
    FROM profiles
    WHERE (
        _search_text IS NULL
        OR position(_search_text IN lower(COALESCE(profiles.latest_name, ''))) > 0
        OR position(_search_text IN lower(COALESCE(profiles.latest_email, ''))) > 0
        OR position(_search_text IN lower(COALESCE(profiles.display_phone, ''))) > 0
        OR position(_search_text IN lower(profiles.customer_key)) > 0
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
      )
      AND (
        _created_from IS NULL
        OR (profiles.first_seen_at AT TIME ZONE 'America/Fortaleza')::date >= _created_from
      )
      AND (
        _created_to IS NULL
        OR (profiles.first_seen_at AT TIME ZONE 'America/Fortaleza')::date <= _created_to
      )
      AND (
        _effective_state_code IS NULL
        OR (
          _effective_state_code = 'UNKNOWN'
          AND profiles.state_code IS NULL
        )
        OR profiles.state_code = _effective_state_code
      )
      AND (
        _birthday_month IS NULL
        OR extract(month FROM profiles.latest_birthdate)::integer = _birthday_month
      )
      AND (
        _min_visits IS NULL
        OR profiles.canonical_visit_count >= _min_visits
      )
      AND (
        _max_visits IS NULL
        OR profiles.canonical_visit_count <= _max_visits
      )
  ),
  paged_profiles AS (
    SELECT filtered_profiles.*
    FROM filtered_profiles
    ORDER BY
      filtered_profiles.canonical_visit_count DESC,
      filtered_profiles.first_seen_at DESC,
      filtered_profiles.customer_key
    LIMIT _page_size
    OFFSET _offset
  ),
  total_stats AS (
    SELECT
      count(*)::integer AS total_leads,
      COALESCE(sum(profiles.canonical_visit_count), 0)::integer AS total_canonical_visits,
      count(*) FILTER (WHERE profiles.is_import_only)::integer AS total_import_only_leads
    FROM profiles
  ),
  filtered_stats AS (
    SELECT
      count(*)::integer AS filtered_leads,
      COALESCE(sum(filtered_profiles.canonical_visit_count), 0)::integer
        AS filtered_canonical_visits,
      count(*) FILTER (WHERE filtered_profiles.is_import_only)::integer
        AS filtered_import_only_leads
    FROM filtered_profiles
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
    'states', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'code', state_options.state_code,
            'name', state_options.state_name,
            'leads', state_options.leads
          )
          ORDER BY state_options.state_name, state_options.state_code
        )
        FROM (
          SELECT
            profiles.state_code,
            min(profiles.state_name) AS state_name,
            count(*)::integer AS leads
          FROM profiles
          WHERE profiles.state_code IS NOT NULL
          GROUP BY profiles.state_code
        ) AS state_options
      ),
      '[]'::jsonb
    ),
    'meta', jsonb_build_object(
      'page', _page,
      'page_size', _page_size,
      'total_leads', total_stats.total_leads,
      'filtered_leads', filtered_stats.filtered_leads,
      'total_canonical_visits', total_stats.total_canonical_visits,
      'filtered_canonical_visits', filtered_stats.filtered_canonical_visits,
      'total_import_only_leads', total_stats.total_import_only_leads,
      'filtered_import_only_leads', filtered_stats.filtered_import_only_leads,
      'total_records',
        total_stats.total_canonical_visits + total_stats.total_import_only_leads,
      'filtered_records',
        filtered_stats.filtered_canonical_visits + filtered_stats.filtered_import_only_leads,
      'generated_at', now()
    )
  )
  INTO _result
  FROM total_stats
  CROSS JOIN filtered_stats;

  RETURN _result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_crm_lead_presence_history(
  _company_id uuid,
  _customer_key text,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_customer_key text := btrim(COALESCE(_customer_key, ''));
  _identity_kind text;
  _identity_value text;
  _offset integer;
  _result jsonb;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_company_panel_permission(auth.uid(), _company_id, 'leads_view') THEN
      RAISE EXCEPTION 'Sem permissao para visualizar leads.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _effective_customer_key = '' OR char_length(_effective_customer_key) > 400 THEN
    RAISE EXCEPTION 'customer_key invalido.' USING ERRCODE = '22023';
  END IF;

  IF _effective_customer_key LIKE 'phone:%' THEN
    _identity_kind := 'phone';
    _identity_value := substring(_effective_customer_key FROM 7);

    IF _identity_value !~ '^[0-9]+$'
      OR public.normalize_whatsapp_phone(_identity_value) IS DISTINCT FROM _identity_value THEN
      RAISE EXCEPTION 'customer_key de telefone invalido.' USING ERRCODE = '22023';
    END IF;
  ELSIF _effective_customer_key LIKE 'email:%' THEN
    _identity_kind := 'email';
    _identity_value := substring(_effective_customer_key FROM 7);

    IF _identity_value = ''
      OR char_length(_identity_value) > 320
      OR lower(btrim(_identity_value)) IS DISTINCT FROM _identity_value THEN
      RAISE EXCEPTION 'customer_key de email invalido.' USING ERRCODE = '22023';
    END IF;
  ELSIF _effective_customer_key ~
    '^contact:(reservation_holder|reservation_companion|waitlist_holder|waitlist_companion|crm_lead):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    _identity_kind := 'contact';
    _identity_value := substring(_effective_customer_key FROM 9);
  ELSE
    RAISE EXCEPTION 'customer_key invalido.' USING ERRCODE = '22023';
  END IF;

  IF _page IS NULL OR _page < 1 OR _page > 10000 THEN
    RAISE EXCEPTION 'page deve estar entre 1 e 10000.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'page_size deve estar entre 1 e 100.' USING ERRCODE = '22023';
  END IF;

  _offset := (_page - 1) * _page_size;

  WITH customer_visits AS MATERIALIZED (
    SELECT canonical_visits.*
    FROM public._get_customer_canonical_visit_events(
      _company_id,
      NULL,
      true
    ) AS canonical_visits
    WHERE canonical_visits.customer_key = _effective_customer_key
  ),
  paged_visits AS (
    SELECT customer_visits.*
    FROM customer_visits
    ORDER BY
      customer_visits.presence_at DESC,
      customer_visits.canonical_event_key DESC
    LIMIT _page_size
    OFFSET _offset
  )
  SELECT jsonb_build_object(
    'customer_key', _effective_customer_key,
    'identity_kind', _identity_kind,
    'identity_value', _identity_value,
    'phone_normalized', CASE
      WHEN _identity_kind = 'phone' THEN _identity_value
      ELSE NULL
    END,
    'visits', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', paged_visits.canonical_event_key,
            'visit_id', paged_visits.visit_id,
            'created_at', paged_visits.contact_created_at,
            'date', paged_visits.presence_date,
            'time', paged_visits.presence_time,
            'party_size', paged_visits.party_size,
            'status', paged_visits.status,
            'occasion', paged_visits.occasion,
            'lead_source', paged_visits.lead_source,
            'visit_origin', paged_visits.visit_origin,
            'origin_waitlist_id', paged_visits.origin_waitlist_id,
            'came_from_waitlist', paged_visits.came_from_waitlist,
            'reservation_holder_name', paged_visits.reservation_holder_name
          )
          ORDER BY
            paged_visits.presence_at DESC,
            paged_visits.canonical_event_key DESC
        )
        FROM paged_visits
      ),
      '[]'::jsonb
    ),
    'meta', jsonb_build_object(
      'page', _page,
      'page_size', _page_size,
      'total_visits', (SELECT count(*)::integer FROM customer_visits),
      'generated_at', now()
    )
  )
  INTO _result;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_crm_leads_page(
  uuid, integer, integer, text, date, date, text, integer, integer, integer
)
IS 'Lista CRM paginada no servidor, com identidades normalizadas, filtros e contagem vitalicia de presencas canonicas.';

COMMENT ON FUNCTION public.get_crm_lead_presence_history(
  uuid, text, integer, integer
)
IS 'Historico paginado de presencas canonicas de uma identidade CRM.';

REVOKE ALL ON FUNCTION public._crm_phone_state_code(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._crm_state_name(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._get_crm_contact_records(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._get_customer_canonical_visit_events(uuid, date, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._get_crm_lead_profiles(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_crm_leads_page(
  uuid, integer, integer, text, date, date, text, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_leads_page(
  uuid, integer, integer, text, date, date, text, integer, integer, integer
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_crm_lead_presence_history(
  uuid, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_lead_presence_history(
  uuid, text, integer, integer
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_customer_recurrence_report(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _include_companions boolean DEFAULT false,
  _page integer DEFAULT 1,
  _page_size integer DEFAULT 25,
  _search text DEFAULT NULL,
  _comparison_mode text DEFAULT 'previous_period'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _effective_include_companions boolean := COALESCE(_include_companions, false);
  _period_days integer;
  _comparison_start date;
  _comparison_end date;
  _search_text text := NULLIF(lower(btrim(COALESCE(_search, ''))), '');
  _search_digits text := NULLIF(regexp_replace(COALESCE(_search, ''), '\D', '', 'g'), '');
  _effective_comparison_mode text := lower(btrim(COALESCE(_comparison_mode, 'previous_period')));
  _offset integer;
  _result jsonb;
BEGIN
  IF _company_id IS NULL THEN
    RAISE EXCEPTION 'company_id e obrigatorio.' USING ERRCODE = '22023';
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_company_panel_permission(auth.uid(), _company_id, 'leads_view') THEN
      RAISE EXCEPTION 'Sem permissao para visualizar dados de clientes.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.company_feature_enabled(_company_id, 'advanced_reports') THEN
      RAISE EXCEPTION 'Relatorios avancados nao estao habilitados para esta empresa.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_end < _period_start THEN
    RAISE EXCEPTION 'Intervalo de datas invalido.' USING ERRCODE = '22023';
  END IF;

  -- O intervalo e inclusivo; uma diferenca de 365 dias representa 366 dias.
  IF (_period_end - _period_start) > 365 THEN
    RAISE EXCEPTION 'O periodo nao pode ultrapassar 366 dias.' USING ERRCODE = '22023';
  END IF;

  IF _page IS NULL OR _page < 1 OR _page > 10000 THEN
    RAISE EXCEPTION 'page deve estar entre 1 e 10000.' USING ERRCODE = '22023';
  END IF;

  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 100 THEN
    RAISE EXCEPTION 'page_size deve estar entre 1 e 100.' USING ERRCODE = '22023';
  END IF;

  IF _search_text IS NOT NULL AND char_length(_search_text) > 200 THEN
    RAISE EXCEPTION 'search nao pode ultrapassar 200 caracteres.' USING ERRCODE = '22023';
  END IF;

  IF _effective_comparison_mode NOT IN ('month_to_date', 'previous_period') THEN
    RAISE EXCEPTION 'comparison_mode deve ser month_to_date ou previous_period.' USING ERRCODE = '22023';
  END IF;

  _period_days := (_period_end - _period_start) + 1;
  -- Presets mensais comparam o mesmo recorte do mes anterior. Intervalos
  -- personalizados comparam um intervalo de mesmo tamanho imediatamente anterior.
  IF _effective_comparison_mode = 'month_to_date' THEN
    IF _period_start <> date_trunc('month', _period_start)::date
      OR date_trunc('month', _period_end)::date <> date_trunc('month', _period_start)::date THEN
      RAISE EXCEPTION 'month_to_date exige um intervalo dentro de um unico mes e iniciado no dia 1.' USING ERRCODE = '22023';
    END IF;

    _comparison_start := date_trunc('month', _period_start - interval '1 month')::date;
    _comparison_end := LEAST(
      _comparison_start + (_period_days - 1),
      (date_trunc('month', _comparison_start) + interval '1 month - 1 day')::date
    );
  ELSE
    _comparison_end := _period_start - 1;
    _comparison_start := _period_start - _period_days;
  END IF;
  _offset := (_page - 1) * _page_size;

  WITH visit_events AS MATERIALIZED (
    SELECT
      canonical_visits.company_id,
      canonical_visits.canonical_event_key,
      canonical_visits.presence_date AS visit_date,
      canonical_visits.presence_at AS visit_at,
      canonical_visits.guest_name,
      canonical_visits.guest_phone,
      canonical_visits.phone_normalized
    FROM public._get_customer_canonical_visit_events(
      _company_id,
      _period_end,
      _effective_include_companions
    ) AS canonical_visits
    WHERE canonical_visits.phone_normalized IS NOT NULL
  ),
  ranked_customer_visits AS (
    SELECT
      visit_events.*,
      row_number() OVER (
        PARTITION BY visit_events.company_id, visit_events.phone_normalized
        ORDER BY
          visit_events.visit_at DESC,
          visit_events.canonical_event_key DESC
      ) AS customer_visit_rank
    FROM visit_events
  ),
  customer_history AS (
    SELECT
      visit_events.company_id,
      visit_events.phone_normalized,
      min(visit_events.visit_date) AS first_visit_date,
      max(visit_events.visit_date) AS last_visit_date,
      count(*) FILTER (
        WHERE visit_events.visit_date < _period_start
      )::integer AS prior_visits,
      count(*) FILTER (
        WHERE visit_events.visit_date BETWEEN _period_start AND _period_end
      )::integer AS period_visits,
      count(*) FILTER (
        WHERE visit_events.visit_date < _comparison_start
      )::integer AS comparison_prior_visits,
      count(*) FILTER (
        WHERE visit_events.visit_date BETWEEN _comparison_start AND _comparison_end
      )::integer AS comparison_period_visits,
      count(*)::integer AS total_visits
    FROM visit_events
    GROUP BY visit_events.company_id, visit_events.phone_normalized
  ),
  latest_customer_contact AS (
    SELECT
      ranked_customer_visits.company_id,
      ranked_customer_visits.phone_normalized,
      ranked_customer_visits.guest_name,
      ranked_customer_visits.guest_phone
    FROM ranked_customer_visits
    WHERE ranked_customer_visits.customer_visit_rank = 1
  ),
  previous_customer_visit AS (
    SELECT
      ranked_customer_visits.company_id,
      ranked_customer_visits.phone_normalized,
      ranked_customer_visits.visit_date AS previous_visit_date
    FROM ranked_customer_visits
    WHERE ranked_customer_visits.customer_visit_rank = 2
  ),
  future_reservation_contacts AS (
    SELECT
      reservations.company_id,
      public.normalize_whatsapp_phone(reservations.guest_phone) AS phone_normalized,
      reservations.date AS reservation_date
    FROM public.reservations
    WHERE reservations.company_id = _company_id
      AND reservations.status IN ('confirmed', 'pending_payment')
      AND reservations.date >= _period_end
      AND reservations.guest_phone IS NOT NULL

    UNION ALL

    SELECT
      reservations.company_id,
      public.normalize_whatsapp_phone(reservation_companions.phone) AS phone_normalized,
      reservations.date AS reservation_date
    FROM public.reservation_companions
    JOIN public.reservations
      ON reservations.id = reservation_companions.reservation_id
    WHERE _effective_include_companions
      AND reservations.company_id = _company_id
      AND reservations.status IN ('confirmed', 'pending_payment')
      AND reservations.date >= _period_end
      AND reservation_companions.phone IS NOT NULL
  ),
  future_reservations AS (
    SELECT
      future_reservation_contacts.company_id,
      future_reservation_contacts.phone_normalized,
      min(future_reservation_contacts.reservation_date) AS next_reservation_date
    FROM future_reservation_contacts
    WHERE future_reservation_contacts.phone_normalized IS NOT NULL
    GROUP BY
      future_reservation_contacts.company_id,
      future_reservation_contacts.phone_normalized
  ),
  current_customers AS MATERIALIZED (
    SELECT
      customer_history.company_id,
      customer_history.phone_normalized,
      latest_customer_contact.guest_name,
      latest_customer_contact.guest_phone,
      customer_history.first_visit_date,
      customer_history.last_visit_date,
      previous_customer_visit.previous_visit_date,
      customer_history.prior_visits,
      customer_history.period_visits,
      customer_history.total_visits,
      CASE
        WHEN customer_history.prior_visits > 0 THEN 'returning'
        ELSE 'new'
      END AS customer_type,
      CASE
        WHEN customer_history.total_visits = 1 THEN 'one'
        WHEN customer_history.total_visits = 2 THEN 'two'
        WHEN customer_history.total_visits BETWEEN 3 AND 4 THEN 'three_four'
        ELSE 'five_plus'
      END AS frequency_band,
      future_reservations.next_reservation_date
    FROM customer_history
    JOIN latest_customer_contact
      ON latest_customer_contact.company_id = customer_history.company_id
     AND latest_customer_contact.phone_normalized = customer_history.phone_normalized
    LEFT JOIN previous_customer_visit
      ON previous_customer_visit.company_id = customer_history.company_id
     AND previous_customer_visit.phone_normalized = customer_history.phone_normalized
    LEFT JOIN future_reservations
      ON future_reservations.company_id = customer_history.company_id
     AND future_reservations.phone_normalized = customer_history.phone_normalized
    WHERE customer_history.period_visits > 0
  ),
  comparison_customers AS (
    SELECT
      customer_history.first_visit_date,
      customer_history.comparison_prior_visits AS prior_visits,
      customer_history.comparison_period_visits AS period_visits
    FROM customer_history
    WHERE customer_history.comparison_period_visits > 0
  ),
  current_summary AS (
    SELECT
      count(*)::integer AS identified_customers,
      count(*) FILTER (WHERE current_customers.customer_type = 'returning')::integer AS returning_customers,
      count(*) FILTER (WHERE current_customers.customer_type = 'new')::integer AS new_customers,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE current_customers.customer_type = 'returning')
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS recurrence_rate,
      count(*) FILTER (WHERE current_customers.period_visits >= 2)::integer AS repeated_in_period,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE current_customers.period_visits >= 2)
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS repeat_rate,
      COALESCE(sum(current_customers.period_visits - 1), 0)::integer AS additional_visits,
      COALESCE(sum(current_customers.period_visits), 0)::integer AS period_visits,
      COALESCE(round(avg(current_customers.period_visits)::numeric, 2), 0) AS avg_visits_per_customer
    FROM current_customers
  ),
  comparison_summary AS (
    SELECT
      count(*)::integer AS identified_customers,
      count(*) FILTER (WHERE comparison_customers.prior_visits > 0)::integer AS returning_customers,
      count(*) FILTER (WHERE comparison_customers.prior_visits = 0)::integer AS new_customers,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE comparison_customers.prior_visits > 0)
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS recurrence_rate,
      count(*) FILTER (WHERE comparison_customers.period_visits >= 2)::integer AS repeated_in_period,
      COALESCE(
        round(
          100.0 * count(*) FILTER (WHERE comparison_customers.period_visits >= 2)
          / NULLIF(count(*), 0),
          1
        ),
        0
      ) AS repeat_rate,
      COALESCE(sum(comparison_customers.period_visits - 1), 0)::integer AS additional_visits,
      COALESCE(sum(comparison_customers.period_visits), 0)::integer AS period_visits,
      COALESCE(round(avg(comparison_customers.period_visits)::numeric, 2), 0) AS avg_visits_per_customer
    FROM comparison_customers
  ),
  frequency_band_definitions AS (
    SELECT *
    FROM (VALUES
      (1, 'one'::text, '1 visita'::text, 1, 1),
      (2, 'two'::text, '2 visitas'::text, 2, 2),
      (3, 'three_four'::text, '3-4 visitas'::text, 3, 4),
      (4, 'five_plus'::text, '5+ visitas'::text, 5, NULL::integer)
    ) AS definitions(sort_order, key, label, min_visits, max_visits)
  ),
  frequency_band_rollup AS (
    SELECT
      frequency_band_definitions.sort_order,
      frequency_band_definitions.key,
      frequency_band_definitions.label,
      frequency_band_definitions.min_visits,
      frequency_band_definitions.max_visits,
      count(current_customers.phone_normalized) FILTER (
        WHERE current_customers.total_visits >= frequency_band_definitions.min_visits
          AND (
            frequency_band_definitions.max_visits IS NULL
            OR current_customers.total_visits <= frequency_band_definitions.max_visits
          )
      )::integer AS customers,
      COALESCE(
        round(
          100.0 * count(current_customers.phone_normalized) FILTER (
            WHERE current_customers.total_visits >= frequency_band_definitions.min_visits
              AND (
                frequency_band_definitions.max_visits IS NULL
                OR current_customers.total_visits <= frequency_band_definitions.max_visits
              )
          ) / NULLIF((SELECT count(*) FROM current_customers), 0),
          1
        ),
        0
      ) AS percentage
    FROM frequency_band_definitions
    LEFT JOIN current_customers ON true
    GROUP BY
      frequency_band_definitions.sort_order,
      frequency_band_definitions.key,
      frequency_band_definitions.label,
      frequency_band_definitions.min_visits,
      frequency_band_definitions.max_visits
  ),
  report_months AS (
    SELECT
      month_series::date AS month_start,
      LEAST(
        (month_series + interval '1 month - 1 day')::date,
        _period_end
      ) AS month_end
    FROM generate_series(
      date_trunc('month', _period_end)::date - interval '5 months',
      date_trunc('month', _period_end)::date,
      interval '1 month'
    ) AS month_series
  ),
  monthly_customers AS (
    SELECT
      report_months.month_start,
      visit_events.company_id,
      visit_events.phone_normalized,
      customer_history.first_visit_date
    FROM report_months
    JOIN visit_events
      ON visit_events.visit_date BETWEEN report_months.month_start AND report_months.month_end
    JOIN customer_history
      ON customer_history.company_id = visit_events.company_id
     AND customer_history.phone_normalized = visit_events.phone_normalized
    GROUP BY
      report_months.month_start,
      visit_events.company_id,
      visit_events.phone_normalized,
      customer_history.first_visit_date
  ),
  monthly_rollup AS (
    SELECT
      report_months.month_start,
      count(monthly_customers.phone_normalized)::integer AS identified_customers,
      count(monthly_customers.phone_normalized) FILTER (
        WHERE monthly_customers.first_visit_date >= report_months.month_start
      )::integer AS new_customers,
      count(monthly_customers.phone_normalized) FILTER (
        WHERE monthly_customers.first_visit_date < report_months.month_start
      )::integer AS returning_customers,
      COALESCE(
        round(
          100.0 * count(monthly_customers.phone_normalized) FILTER (
            WHERE monthly_customers.first_visit_date < report_months.month_start
          ) / NULLIF(count(monthly_customers.phone_normalized), 0),
          1
        ),
        0
      ) AS recurrence_rate
    FROM report_months
    LEFT JOIN monthly_customers
      ON monthly_customers.month_start = report_months.month_start
    GROUP BY report_months.month_start
  ),
  filtered_customers AS MATERIALIZED (
    SELECT current_customers.*
    FROM current_customers
    WHERE _search_text IS NULL
      OR position(_search_text IN lower(COALESCE(current_customers.guest_name, ''))) > 0
      OR position(_search_text IN lower(COALESCE(current_customers.guest_phone, ''))) > 0
      OR (
        _search_digits IS NOT NULL
        AND position(_search_digits IN current_customers.phone_normalized) > 0
      )
  ),
  paged_customers AS (
    SELECT
      filtered_customers.*,
      row_number() OVER (
        ORDER BY
          filtered_customers.period_visits DESC,
          filtered_customers.total_visits DESC,
          filtered_customers.last_visit_date DESC,
          filtered_customers.guest_name NULLS LAST,
          filtered_customers.phone_normalized
      )::integer AS result_position
    FROM filtered_customers
    ORDER BY
      filtered_customers.period_visits DESC,
      filtered_customers.total_visits DESC,
      filtered_customers.last_visit_date DESC,
      filtered_customers.guest_name NULLS LAST,
      filtered_customers.phone_normalized
    LIMIT _page_size
    OFFSET _offset
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'identified_customers', current_summary.identified_customers,
      'returning_customers', current_summary.returning_customers,
      'new_customers', current_summary.new_customers,
      'recurrence_rate', current_summary.recurrence_rate,
      'repeated_in_period', current_summary.repeated_in_period,
      'repeat_rate', current_summary.repeat_rate,
      'additional_visits', current_summary.additional_visits,
      'period_visits', current_summary.period_visits,
      'avg_visits_per_customer', current_summary.avg_visits_per_customer
    ),
    'comparison', jsonb_build_object(
      'period_start', _comparison_start,
      'period_end', _comparison_end,
      'identified_customers', comparison_summary.identified_customers,
      'returning_customers', comparison_summary.returning_customers,
      'new_customers', comparison_summary.new_customers,
      'recurrence_rate', comparison_summary.recurrence_rate,
      'repeated_in_period', comparison_summary.repeated_in_period,
      'repeat_rate', comparison_summary.repeat_rate,
      'additional_visits', comparison_summary.additional_visits,
      'period_visits', comparison_summary.period_visits,
      'avg_visits_per_customer', comparison_summary.avg_visits_per_customer
    ),
    'frequency_bands', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'key', frequency_band_rollup.key,
            'label', frequency_band_rollup.label,
            'min_visits', frequency_band_rollup.min_visits,
            'max_visits', frequency_band_rollup.max_visits,
            'customers', frequency_band_rollup.customers,
            'percentage', frequency_band_rollup.percentage
          )
          ORDER BY frequency_band_rollup.sort_order
        )
        FROM frequency_band_rollup
      ),
      '[]'::jsonb
    ),
    'monthly_composition', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'month', monthly_rollup.month_start,
            'identified_customers', monthly_rollup.identified_customers,
            'new_customers', monthly_rollup.new_customers,
            'returning_customers', monthly_rollup.returning_customers,
            'recurrence_rate', monthly_rollup.recurrence_rate
          )
          ORDER BY monthly_rollup.month_start
        )
        FROM monthly_rollup
      ),
      '[]'::jsonb
    ),
    'customers', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            -- Identificador opaco e valido apenas para a posicao no resultado. Ele
            -- nao deriva do telefone e serve somente como chave de renderizacao.
            'customer_key', format('customer:%s', paged_customers.result_position),
            -- A busca acontece no banco; o payload entrega apenas os ultimos
            -- digitos necessarios para identificacao visual e nunca o telefone completo.
            'phone_normalized', right(paged_customers.phone_normalized, 4),
            'guest_name', paged_customers.guest_name,
            'guest_phone', NULL::text,
            'first_visit_date', paged_customers.first_visit_date,
            'last_visit_date', paged_customers.last_visit_date,
            'previous_visit_date', paged_customers.previous_visit_date,
            'prior_visits', paged_customers.prior_visits,
            'period_visits', paged_customers.period_visits,
            'total_visits', paged_customers.total_visits,
            'customer_type', paged_customers.customer_type,
            'frequency_band', paged_customers.frequency_band,
            'next_reservation_date', paged_customers.next_reservation_date
          )
          ORDER BY
            paged_customers.period_visits DESC,
            paged_customers.total_visits DESC,
            paged_customers.last_visit_date DESC,
            paged_customers.guest_name NULLS LAST,
            paged_customers.phone_normalized
        )
        FROM paged_customers
      ),
      '[]'::jsonb
    ),
    'meta', jsonb_build_object(
      'period_start', _period_start,
      'period_end', _period_end,
      'comparison_mode', _effective_comparison_mode,
      'include_companions', _effective_include_companions,
      'page', _page,
      'page_size', _page_size,
      'customers_total', (SELECT count(*)::integer FROM current_customers),
      'filtered_customers_total', (SELECT count(*)::integer FROM filtered_customers),
      'generated_at', now()
    )
  )
  INTO _result
  FROM current_summary
  CROSS JOIN comparison_summary;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text
)
IS 'Relatorio agregado de recorrencia por telefone normalizado, com comparativo, frequencia, composicao mensal e clientes paginados.';

REVOKE ALL ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_customer_recurrence_report(
  uuid, date, date, boolean, integer, integer, text, text
) TO authenticated, service_role;
