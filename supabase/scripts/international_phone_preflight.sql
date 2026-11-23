-- Read-only against persistent data. Only pg_temp objects are created.
-- Run on an isolated restore first, AFTER the data-free 20261019115000 metadata
-- migration and BEFORE applying 20261019120000 (columns/indexes).
-- Results contain personal data: keep exports in the same restricted backup area.
BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.phone_e164(_phone text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH p AS (SELECT btrim(COALESCE(_phone, '')) AS raw,
    regexp_replace(COALESCE(_phone, ''), '\D', '', 'g') AS digits)
  , candidate AS (SELECT CASE
    WHEN raw = '' OR raw !~ '^\+?[0-9() .-]+$' THEN NULL
    WHEN raw LIKE '+%' AND digits ~ '^[1-9][0-9]{6,14}$' THEN '+' || digits
    WHEN digits ~ '^[1-9][0-9]9?[0-9]{8}$' THEN '+55' || digits
    WHEN digits ~ '^55[1-9][0-9]9?[0-9]{8}$' THEN '+' || digits
    ELSE NULL END AS value FROM p)
  SELECT CASE WHEN public.is_valid_phone_e164(value) THEN value ELSE NULL END FROM candidate;
$$;
-- Indexes and delivery readers also retain historically accepted BR subscriber
-- shapes. Report validation remains strict, but dedup must use the same stored
-- identity as the actual indexes, including eight-digit mobile subscribers.
CREATE OR REPLACE FUNCTION pg_temp.phone_stored_e164(_phone text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH input AS (SELECT btrim(COALESCE(_phone, '')) AS raw,
    regexp_replace(COALESCE(_phone, ''), '\D', '', 'g') AS digits)
  SELECT COALESCE(pg_temp.phone_e164(_phone), CASE
    WHEN raw !~ '^\+?[0-9() .-]+$' THEN NULL
    WHEN raw LIKE '+%' AND digits ~ '^55[1-9][0-9](9?[0-9]{8})$' THEN '+' || digits
    WHEN raw NOT LIKE '+%' AND digits ~ '^[1-9][0-9](9?[0-9]{8})$' THEN '+55' || digits
    WHEN raw NOT LIKE '+%' AND digits ~ '^55[1-9][0-9](9?[0-9]{8})$' THEN '+' || digits
    ELSE NULL END) FROM input;
$$;
CREATE TEMP TABLE phone_preflight_rows(
  source_table text, raw_column text, row_id text, company_id text,
  raw_phone text, proposed_e164 text, stored_identity_e164 text, row_data jsonb
) ON COMMIT DROP;

DO $preflight$
DECLARE _target record;
BEGIN
  FOR _target IN SELECT * FROM (VALUES
    ('reservations', 'guest_phone'), ('waitlist', 'guest_phone'),
    ('reservation_companions', 'phone'), ('waitlist_companions', 'phone'),
    ('crm_leads', 'phone'), ('profiles', 'phone'),
    ('companies', 'phone'), ('companies', 'responsible_phone'), ('companies', 'whatsapp'),
    ('whatsapp_message_queue', 'phone'), ('whatsapp_broadcast_recipients', 'phone'),
    ('pluguechat_message_queue', 'phone'), ('pluguechat_broadcast_recipients', 'phone'),
    ('lead_reactivation_dispatches', 'phone'), ('whatsapp_dispatch_guards', 'phone')
  ) targets(table_name, raw_column) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = _target.table_name AND column_name = _target.raw_column) THEN CONTINUE; END IF;
    EXECUTE format($query$
      INSERT INTO pg_temp.phone_preflight_rows
      SELECT %1$L, %2$L, COALESCE(to_jsonb(t)->>'id', to_jsonb(t)->>'delivery_key'), to_jsonb(t)->>'company_id',
        CASE WHEN %1$L = 'crm_leads' THEN COALESCE(NULLIF(btrim(%2$I), ''), to_jsonb(t)->>'phone_normalized') ELSE %2$I END,
        COALESCE(pg_temp.phone_e164(to_jsonb(t)->>(%2$L || '_e164')), pg_temp.phone_e164(%2$I),
          CASE WHEN %1$L = 'crm_leads' AND NULLIF(btrim(%2$I), '') IS NULL THEN pg_temp.phone_e164(to_jsonb(t)->>'phone_normalized') END),
        COALESCE(pg_temp.phone_stored_e164(to_jsonb(t)->>(%2$L || '_e164')), pg_temp.phone_stored_e164(%2$I),
          CASE WHEN %1$L = 'crm_leads' AND NULLIF(btrim(%2$I), '') IS NULL THEN pg_temp.phone_stored_e164(to_jsonb(t)->>'phone_normalized') END), to_jsonb(t)
      FROM public.%1$I t
    $query$, _target.table_name, _target.raw_column);
  END LOOP;
END;
$preflight$;

-- Coverage and review queue. Invalid/ambiguous values are never automatically fixed.
SELECT source_table, raw_column, count(*) AS rows,
  count(*) FILTER (WHERE NULLIF(btrim(raw_phone), '') IS NULL) AS empty,
  count(*) FILTER (WHERE proposed_e164 IS NOT NULL) AS convertible,
  count(*) FILTER (WHERE proposed_e164 IS NULL AND stored_identity_e164 IS NOT NULL) AS deliverable_legacy,
  count(*) FILTER (WHERE NULLIF(btrim(raw_phone), '') IS NOT NULL AND proposed_e164 IS NULL) AS review_required
FROM phone_preflight_rows GROUP BY source_table, raw_column ORDER BY source_table, raw_column;

SELECT source_table, raw_column, row_id, raw_phone
FROM phone_preflight_rows WHERE NULLIF(btrim(raw_phone), '') IS NOT NULL AND proposed_e164 IS NULL
ORDER BY source_table, row_id;

-- Review national DDD55 repairs and all older manual profile identities that differ.
SELECT source_table, row_id, raw_phone, proposed_e164, stored_identity_e164, row_data->>'profile_customer_key' AS previous_profile_key
FROM phone_preflight_rows
WHERE regexp_replace(COALESCE(raw_phone, ''), '\D', '', 'g') ~ '^55[0-9]{8,9}$'
  OR (row_data->>'profile_customer_key' LIKE 'phone:%'
    AND row_data->>'profile_customer_key' IS DISTINCT FROM 'phone:' || substring(proposed_e164 FROM 2))
ORDER BY source_table, row_id;

-- These conflicts BLOCK unique-index creation. Preserve all rows for manual review;
-- do not delete deliveries, reset statuses, or recreate dispatch keys to bypass them.
SELECT source_table, row_data->>'broadcast_id' AS broadcast_id, stored_identity_e164,
  count(*) AS conflicts, array_agg(row_id ORDER BY row_id) AS row_ids
FROM phone_preflight_rows
WHERE source_table IN ('whatsapp_broadcast_recipients', 'pluguechat_broadcast_recipients') AND stored_identity_e164 IS NOT NULL
GROUP BY source_table, row_data->>'broadcast_id', stored_identity_e164 HAVING count(*) > 1;

SELECT company_id, row_data->>'type' AS message_type, stored_identity_e164,
  md5(row_data->>'message') AS message_hash, count(*) AS conflicts, array_agg(row_id ORDER BY row_id) AS row_ids
FROM phone_preflight_rows
WHERE source_table = 'whatsapp_message_queue' AND row_data->>'reservation_id' IS NULL
  AND row_data->>'status' IN ('pending', 'processing') AND stored_identity_e164 IS NOT NULL
GROUP BY company_id, row_data->>'type', stored_identity_e164, md5(row_data->>'message') HAVING count(*) > 1;

SELECT company_id, stored_identity_e164, row_data->>'last_visit_date' AS last_visit_date,
  row_data->>'days_without_visit' AS days_without_visit, count(*) AS conflicts, array_agg(row_id ORDER BY row_id) AS row_ids
FROM phone_preflight_rows
WHERE source_table = 'lead_reactivation_dispatches' AND stored_identity_e164 IS NOT NULL
GROUP BY company_id, stored_identity_e164, row_data->>'last_visit_date', row_data->>'days_without_visit' HAVING count(*) > 1;

-- Canonical aliases for partially processed PlugueChat campaigns and birthdays.
-- The original keys and delivery states are never rewritten.
WITH keys AS (
  SELECT source_table, row_id,
    CASE WHEN source_table = 'whatsapp_dispatch_guards' THEN row_data->>'delivery_key' ELSE row_data->>'idempotency_key' END AS previous_key,
    substring(stored_identity_e164 FROM 2) AS digits
  FROM phone_preflight_rows
  WHERE source_table IN ('pluguechat_message_queue', 'whatsapp_dispatch_guards')
), normalized AS (
  SELECT *, CASE WHEN digits IS NOT NULL AND previous_key ~ '^(pluguechat:(broadcast:[^:]+|birthday:[^:]+:[0-9]{4}-[0-9]{2}-[0-9]{2})|birthday:[^:]+:[0-9]{4}-[0-9]{2}-[0-9]{2}):[^:]+$'
    THEN regexp_replace(previous_key, ':[^:]+$', ':' || digits) ELSE previous_key END AS canonical_key
  FROM keys
)
SELECT source_table, canonical_key, count(*) AS conflicts, array_agg(row_id ORDER BY row_id) AS row_ids
FROM normalized WHERE canonical_key IS NOT NULL
  AND (source_table = 'pluguechat_message_queue' OR previous_key LIKE 'birthday:%')
GROUP BY source_table, canonical_key HAVING count(*) > 1;

-- CRM canonical duplicates also block the new unique index. Never merge or delete
-- them automatically; manual profile edits and visit history require review.
SELECT company_id, stored_identity_e164, count(*) AS contacts, array_agg(row_id ORDER BY row_id) AS row_ids
FROM phone_preflight_rows WHERE source_table = 'crm_leads' AND stored_identity_e164 IS NOT NULL
GROUP BY company_id, stored_identity_e164 HAVING count(*) > 1;

-- Include triggers created outside versioned migrations (e.g. database webhooks).
SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname, t.tgenabled,
  pg_get_triggerdef(t.oid) AS trigger_definition, p.proname AS function_name
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'public' AND NOT t.tgisinternal
  AND c.relname IN (SELECT DISTINCT source_table FROM phone_preflight_rows)
ORDER BY c.relname, t.tgname;
ROLLBACK;
