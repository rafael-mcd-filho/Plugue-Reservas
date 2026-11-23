import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { isValidPhoneNumber, getCountryCallingCode, parsePhoneNumber } from 'libphonenumber-js/max';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (path) => readFile(resolve(root, path), 'utf8');
const migration = (name) => load(`supabase/migrations/${name}.sql`);
const db = new PGlite();
const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const steps = [
  ['-- @apply-old-recurrence', '20260814120000_fix_customer_recurrence_waitlist_fallback'],
  ['-- @apply-core-migration', '20260814130000_add_server_side_crm_leads_read_model'],
  ['-- @apply-export-migration', '20260814140000_add_crm_leads_canonical_export'],
  ['-- @apply-recurrence-pagination-filter-migration', '20260817120000_add_recurrence_minimum_visits_filter'],
  ['-- @apply-unbounded-pagination-migration', '20260817130000_remove_crm_report_pagination_ceiling'],
  ['-- @apply-recurrence-profile-migration', '20260819115000_add_recurrence_lead_profile_lookup'],
];
const contractMigrations = [
  '20261019115000_add_phone_number_metadata',
  '20261019120000_add_international_phone_contract',
  '20261019121000_use_international_phone_identity',
  '20261019122000_add_phone_migration_tooling',
];
const scalar = async (sql, parameters = []) => (await db.query(sql, parameters)).rows[0]?.value;
try {
  // Reuse the complete existing CRM/recurrence bootstrap, fixtures, and assertions.
  const harness = await load('supabase/tests/crm_leads_server_read_model_regression.sql');
  let cursor = 0;
  for (const [marker, name] of steps) {
    const position = harness.indexOf(marker, cursor);
    assert.ok(position >= 0, `Missing harness marker ${marker}`);
    await db.exec(harness.slice(cursor, position));
    if (cursor === 0) {
      await db.exec(`
        CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');
        CREATE TABLE public.companies(id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz DEFAULT now());
        INSERT INTO public.companies(id, name) VALUES ('${company}', 'Empresa A');
        CREATE FUNCTION public.has_role(uuid, public.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
        CREATE FUNCTION public.has_role_in_company(uuid, public.app_role, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      `);
    }
    await db.exec(await migration(name));
    cursor = position + marker.length;
  }
  await db.exec(harness.slice(cursor));
  await db.exec(await migration('20260820130000_add_advanced_report_foundation'));
  await db.exec(await migration('20260827130000_expand_customer_recurrence_temporal_analysis'));
  await db.exec(await migration('20261007120000_add_crm_lead_profile_editing'));
  await db.exec(`
    SELECT set_config('request.jwt.claim.role', 'service_role', false);
    ALTER TABLE public.companies ADD phone text, ADD responsible_phone text, ADD whatsapp text,
      ADD slug text, ADD status text DEFAULT 'active', ADD public_waitlist_enabled boolean DEFAULT true;
    UPDATE public.companies SET slug = 'empresa-a';
    ALTER TABLE public.reservations ALTER created_at SET DEFAULT now();
    ALTER TABLE public.reservation_companions ADD company_id uuid;
    UPDATE public.reservation_companions c SET company_id = r.company_id FROM public.reservations r WHERE c.reservation_id = r.id;
    ALTER TABLE public.waitlist_companions ADD company_id uuid;
    UPDATE public.waitlist_companions c SET company_id = w.company_id FROM public.waitlist w WHERE c.waitlist_id = w.id;
    ALTER TABLE public.waitlist ADD notes text, ADD position integer, ADD tracking_code text DEFAULT 'TRACK',
      ALTER id SET DEFAULT gen_random_uuid(), ALTER created_at SET DEFAULT now();
    ALTER TABLE public.crm_leads ALTER id SET DEFAULT gen_random_uuid(),
      ALTER created_at SET DEFAULT now(), ALTER updated_at SET DEFAULT now(), ALTER imported_at SET DEFAULT now();
    CREATE UNIQUE INDEX crm_leads_company_phone_unique
      ON public.crm_leads(company_id, phone_normalized)
      WHERE phone_normalized IS NOT NULL AND phone_normalized <> '';
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, phone text);
    CREATE TABLE public.public_rate_limits(scope text, company_id uuid, identifier text, created_at timestamptz DEFAULT now());
    CREATE TABLE public.whatsapp_message_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid,
      reservation_id uuid, phone text NOT NULL, type text, message text, status text DEFAULT 'pending', attempts integer DEFAULT 0);
    CREATE TABLE public.whatsapp_broadcast_recipients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id uuid,
      phone text NOT NULL, status text DEFAULT 'pending', phone_normalized text GENERATED ALWAYS AS
      (right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 11)) STORED);
    CREATE UNIQUE INDEX idx_broadcast_recipients_broadcast_phone_unique ON public.whatsapp_broadcast_recipients(broadcast_id, phone_normalized);
    CREATE TABLE public.pluguechat_message_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, phone text, idempotency_key text UNIQUE, status text DEFAULT 'pending', attempts integer DEFAULT 0);
    CREATE TABLE public.pluguechat_broadcast_recipients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id uuid, phone text);
    CREATE TABLE public.whatsapp_dispatch_guards(delivery_key text PRIMARY KEY, company_id uuid NOT NULL, automation_type text NOT NULL,
      reservation_id uuid, phone text, status text NOT NULL DEFAULT 'processing', locked_until timestamptz NOT NULL,
      finalized_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION public.touch_whatsapp_broadcasts_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    CREATE TRIGGER touch_crm BEFORE UPDATE ON public.crm_leads FOR EACH ROW EXECUTE FUNCTION public.touch_whatsapp_broadcasts_updated_at();
    CREATE TABLE public.company_nps_configs(company_id uuid, enabled boolean, expiration_days integer);
    CREATE TABLE public.reservation_reviews(company_id uuid, reservation_id uuid UNIQUE, lead_id uuid, expires_at timestamptz);
    INSERT INTO public.company_nps_configs VALUES ('${company}', true, 7);
  `);
  await db.exec(await migration('20260527090000_require_public_waitlist_contact_details'));
  const reactivation = await migration('20260707143000_add_lead_reactivation_automation');
  await db.exec(reactivation.slice(0, reactivation.indexOf('DO $$'))); // Cron is deliberately excluded in this local harness.
  const nps = await migration('20260615100000_decouple_nps_feature_access_from_activation');
  await db.exec(nps.slice(nps.indexOf('CREATE OR REPLACE FUNCTION public.ensure_reservation_review()')));
  // Seed before migration: untouched national raw, malformed data and legacy DDD55 key.
  await db.exec(`
    INSERT INTO public.reservations(id, company_id, status, guest_name, guest_phone, date, time, party_size)
    VALUES ('90000000-0000-4000-8000-000000000001', '${company}', 'checked_in', 'DDD 55 History', '(55) 99999-1000', '2026-10-01', '19:00', 2),
      ('90000000-0000-4000-8000-000000000002', '${company}', 'confirmed', 'Invalid Legacy', 'invalid', '2026-10-01', '19:00', 2),
      ('90000000-0000-4000-8000-000000000008', '${company}', 'checked_in', 'Legacy Numeric Invalid', '119123456', '2026-10-01', '19:00', 2),
      ('90000000-0000-4000-8000-000000000009', '${company}', 'completed', 'Legacy Numeric Invalid', '119123456', '2026-10-02', '19:00', 2),
      ('90000000-0000-4000-8000-000000000010', '${company}', 'checked_in', 'Legacy Invalid DDD55', '559123456', '2026-10-03', '19:00', 2),
      ('90000000-0000-4000-8000-000000000013', '${company}', 'checked_in', 'Legacy Deliverable BR', '(11) 9123-4567', '2026-10-05', '19:00', 2);
    INSERT INTO public.waitlist(id, company_id, status, guest_name, guest_phone, seated_at, created_at, party_size)
      VALUES ('90000000-0000-4000-8000-000000000011', '${company}', 'seated', 'Legacy Numeric Invalid', '119123456', '2026-10-04 19:00:00+00', '2026-10-04 18:00:00+00', 2);
    INSERT INTO public.crm_leads(company_id, full_name, phone, phone_normalized, source, profile_customer_key)
      VALUES ('${company}', 'Manual DDD55', '(55) 99999-1000', '55999991000', 'manual_edit', 'phone:55999991000'),
        ('${company}', 'Legacy Numeric Invalid', '119123456', '55119123456', 'manual_edit', 'phone:55119123456'),
        ('${company}', 'Legacy Invalid DDD55', '559123456', '559123456', 'manual_edit', 'phone:559123456');
    INSERT INTO public.crm_leads(company_id, full_name, phone_normalized, source)
      VALUES ('${company}', 'Legacy Normalized Only', '85999993456', 'import'),
        ('${company}', 'Legacy BR Shared Digits', '33912345678', 'import');
    INSERT INTO public.whatsapp_message_queue(company_id, phone, type, message, status, attempts)
      VALUES ('${company}', '11987654321', 'reminder', 'kept', 'processing', 2);
    INSERT INTO public.whatsapp_dispatch_guards(delivery_key, company_id, automation_type, phone, status, locked_until)
      VALUES ('birthday:${company}:2026-10-19:55999991000', '${company}', 'birthday', '55999991000', 'queued', now()),
        ('birthday:${company}:2026-10-20:55999991000', '${company}', 'birthday', '55999991000', 'processing', now() - interval '1 minute'),
        ('birthday:${company}:2026-10-19:5591234567', '${company}', 'birthday', '5591234567', 'queued', now()),
        ('birthday:${company}:2026-10-20:5591234567', '${company}', 'birthday', '5591234567', 'processing', now() - interval '1 minute');
    INSERT INTO public.pluguechat_message_queue(company_id, phone, idempotency_key, status, attempts)
      VALUES ('${company}', '55999991000', 'pluguechat:broadcast:${company}:55999991000', 'sent', 2),
        ('${company}', '55999991000', 'pluguechat:birthday:${company}:2026-10-19:55999991000', 'pending', 1);
    INSERT INTO public.lead_reactivation_dispatches(company_id, phone, phone_normalized, last_visit_date, days_without_visit, channel, dispatch_key)
      VALUES ('${company}', '(55) 99999-1000', '55999991000', '2026-10-01', 30, 'evolution', 'legacy-ddd55-dispatch'),
        ('${company}', '(33) 91234-5678', '33912345678', '2026-10-01', 30, 'evolution', 'legacy-br-shared-digits');
  `);
  await db.exec(await migration('20261019115000_add_phone_number_metadata'));
  await db.exec(await load('supabase/scripts/international_phone_preflight.sql'));
  const rawBefore = await scalar(`SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS value FROM public.reservations r`);
  const baselineVisits = await scalar(`SELECT count(*)::integer AS value FROM public._get_crm_contact_records('${company}') WHERE is_canonical_presence`);
  const legacyInvalidContactsBefore = await scalar(`SELECT jsonb_agg(jsonb_build_object('record', contact_record_key, 'key', customer_key,
    'phone', phone_normalized, 'presence', is_canonical_presence) ORDER BY contact_record_key) AS value
    FROM public._get_crm_contact_records('${company}') WHERE guest_phone IN ('119123456', '559123456')`);
  const legacyInvalidVisitsBefore = await scalar(`SELECT jsonb_object_agg(customer_key, canonical_visit_count) AS value
    FROM public._get_crm_lead_profiles('${company}') WHERE customer_key IN ('phone:55119123456', 'phone:559123456')`);
  const legacyInvalidRecurrenceBefore = await scalar(`SELECT public.get_customer_recurrence_report(
    '${company}', '2026-10-01', '2026-10-31', true, 1, 100, 'Legacy Numeric Invalid', 'previous_period', 1) AS value`);
  delete legacyInvalidRecurrenceBefore.meta.generated_at;
  for (let run = 0; run < 2; run++) {
    for (const name of contractMigrations) await db.exec(await migration(name));
  }
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.reservations WHERE guest_phone_e164 IS NOT NULL`), 0, 'migration must not backfill');
  for (const [input, expected] of [
    ['(11) 98765-4321', '+5511987654321'], ['(55) 99999-1000', '+5555999991000'],
    ['(55) 3333-1000', '+555533331000'], ['+1 407 264 1934', '+14072641934'],
    ['+1 416 555 0123', '+14165550123'], ['+351 912 345 678', '+351912345678'],
    ['+44 7911 123456', '+447911123456'], ['bad', null], ['1100000000', null], ['+9991234567', null], ['+0123456789', null], ['+1234567890123456', null],
  ]) assert.equal(await scalar('SELECT public.phone_to_e164($1) AS value', [input]), expected, input);
  const examples = JSON.parse(await load('node_modules/libphonenumber-js/examples.mobile.json'));
  let parityCases = 0;
  for (const [country, national] of Object.entries(examples)) {
    const valid = `+${getCountryCallingCode(country)}${national}`;
    for (const candidate of [valid, `${valid}0`, valid.slice(0, -1)]) {
      const expected = isValidPhoneNumber(candidate) && parsePhoneNumber(candidate).number === candidate;
      assert.equal(await scalar('SELECT public.is_valid_phone_e164($1) AS value', [candidate]), expected, `SQL/libphonenumber parity: ${country} ${candidate}`);
      parityCases += 1;
    }
  }
  assert.equal(await scalar("SELECT public.phone_to_e164('4072641934', 'US') AS value"), null, 'foreign national inputs require +');
  assert.equal(await scalar("SELECT public.normalize_whatsapp_phone('+14072641934') AS value"), '14072641934');
  assert.equal(await scalar("SELECT public.phone_identity_digits('+14072641934', '14072641934', 'US') AS value"), '14072641934', 'metadata wins over ambiguous digits');
  assert.equal(await scalar("SELECT public.phone_identity_digits(NULL, '119123456', 'BR') AS value"), null,
    'deliverability remains strict for invalid legacy BR');
  for (const [raw, stored] of [
    ['1191234567', '551191234567'], ['551191234567', '551191234567'], ['+55 (11) 9123-4567', '551191234567'],
    ['5591234567', '555591234567'], ['555591234567', '555591234567'], ['+555591234567', '555591234567'],
  ]) {
    assert.equal(await scalar('SELECT public.phone_stored_identity_digits(NULL, $1) AS value', [raw]), stored,
      'legacy BR delivery identity must retain the original subscriber digits');
    assert.equal(await scalar('SELECT public.normalize_whatsapp_phone($1) AS value', [raw]), null,
      'the input normalizer must remain strict when a legacy delivery number is accepted');
  }
  assert.equal(await scalar("SELECT public.canonical_crm_customer_key('phone:5591234567') AS value"), 'phone:555591234567',
    'DDD55 aliases must also recognize deliverable legacy BR numbers');
  await db.exec(`INSERT INTO public.whatsapp_message_queue(company_id, phone, type, message)
    VALUES ('${company}', '+551191234567', 'legacy_delivery', 'keep legacy subscriber');
    INSERT INTO public.whatsapp_dispatch_guards(delivery_key, company_id, automation_type, phone, phone_e164, status, locked_until)
      VALUES ('legacy-test-key', '${company}', 'test', '+551191234567', '+551191234567', 'queued', now());`);
  assert.equal(await scalar("SELECT phone_e164 AS value FROM public.whatsapp_message_queue WHERE type = 'legacy_delivery'"), '+551191234567',
    'delivery queues may retain a historical BR subscriber rejected by current numbering metadata');
  await assert.rejects(() => db.exec(`INSERT INTO public.whatsapp_message_queue(company_id, phone, type, message)
    VALUES ('${company}', '1191234567', 'legacy_delivery', 'keep legacy subscriber')`), /unique/i,
  'legacy delivery queue dedup must compare the full stored identity');
  await assert.rejects(() => db.exec(`INSERT INTO public.reservations(id, company_id, status, guest_name, guest_phone, date, time, party_size)
    VALUES ('90000000-0000-4000-8000-000000000014', '${company}', 'confirmed', 'Legacy shape is not a new contact', '1191234567', '2026-10-19', '19:00', 2)`), /Telefone invalido/,
  'new contacts cannot opt into the delivery-only legacy fallback');
  assert.equal(await scalar("SELECT public.phone_customer_identity_digits(NULL, '119123456', 'BR') AS value"), '55119123456',
    'read-model identity preserves invalid legacy BR grouping');
  assert.equal(await scalar("SELECT public.phone_customer_identity_digits(NULL, '4070000000', 'US') AS value"), null,
    'legacy fallback must not invent BR identities for a foreign-country context');
  assert.equal(await scalar("SELECT public.canonical_crm_customer_key('phone:559123456') AS value"), 'phone:559123456',
    'invalid DDD55 historical keys must not be rewritten as if valid');
  assert.deepEqual(await scalar(`SELECT jsonb_agg(jsonb_build_object('record', contact_record_key, 'key', customer_key,
    'phone', phone_normalized, 'presence', is_canonical_presence) ORDER BY contact_record_key) AS value
    FROM public._get_crm_contact_records('${company}') WHERE guest_phone IN ('119123456', '559123456')`), legacyInvalidContactsBefore,
  'invalid legacy reservation/waitlist identities and canonical visits must remain unchanged');
  assert.deepEqual(await scalar(`SELECT jsonb_object_agg(customer_key, canonical_visit_count) AS value
    FROM public._get_crm_lead_profiles('${company}') WHERE customer_key IN ('phone:55119123456', 'phone:559123456')`), legacyInvalidVisitsBefore,
  'invalid legacy CRM groups retain all historical visit counts');
  const legacyInvalidRecurrenceAfter = await scalar(`SELECT public.get_customer_recurrence_report(
    '${company}', '2026-10-01', '2026-10-31', true, 1, 100, 'Legacy Numeric Invalid', 'previous_period', 1) AS value`);
  delete legacyInvalidRecurrenceAfter.meta.generated_at;
  assert.deepEqual(legacyInvalidRecurrenceAfter, legacyInvalidRecurrenceBefore,
    'recurrence totals, masking, opaque references and visit counts remain unchanged for invalid legacy contacts');
  for (const key of ['phone:55119123456', 'phone:559123456']) {
    const invalidHistory = await scalar('SELECT public.get_crm_lead_presence_history($1, $2) AS value', [company, key]);
    assert.equal(invalidHistory.meta.total_visits, legacyInvalidVisitsBefore[key], 'invalid legacy history stays accessible for existing company contacts');
  }
  await assert.rejects(() => db.query('SELECT public.get_crm_lead_presence_history($1, $2)', [company, 'phone:551199000000']), /telefone invalido/,
    'a nonexistent invalid phone key must not be accepted');
  await db.exec("INSERT INTO public.companies(id, name) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Other company')");
  await assert.rejects(() => db.query('SELECT public.get_crm_lead_presence_history($1, $2)', ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'phone:55119123456']), /telefone invalido/,
    'invalid fallback requires an existing contact in the requested company');
  await assert.rejects(() => db.query('SELECT public.get_crm_lead_presence_history($1, $2, $3)', [company, 'phone:55119123456', 0]), /page deve/,
    'legacy identity access must retain pagination bounds');
  await db.exec("SELECT set_config('request.jwt.claim.role', 'anon', false)");
  await assert.rejects(() => db.query('SELECT public.get_crm_lead_presence_history($1, $2)', [company, 'phone:55119123456']), /Nao autorizado/,
    'legacy identity existence must never be checked before authentication');
  const previousUserClaim = await scalar("SELECT current_setting('request.jwt.claim.sub', true) AS value");
  await db.exec("SELECT set_config('request.jwt.claim.role', 'authenticated', false); SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false); SELECT set_config('test.permission', 'off', false)");
  await assert.rejects(() => db.query('SELECT public.get_crm_lead_presence_history($1, $2)', [company, 'phone:55119123456']), /Sem permissao/,
    'legacy identity history must retain company permissions');
  await db.exec("SELECT set_config('request.jwt.claim.role', 'service_role', false); SELECT set_config('test.permission', 'on', false)");
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [previousUserClaim ?? '']);
  await assert.rejects(() => db.exec(`INSERT INTO public.reservations(id, company_id, status, guest_name, guest_phone, date, time, party_size)
    VALUES ('90000000-0000-4000-8000-000000000012', '${company}', 'confirmed', 'New invalid must fail', '119123456', '2026-10-19', '19:00', 2)`), /Telefone invalido/,
  'new writes must never use the historical identity fallback');
  assert.equal(await scalar("SELECT public._crm_phone_state_code('14072641934') AS value"), null, 'foreign number must not get a BR state');
  assert.equal(await scalar("SELECT public._crm_phone_state_code('5555999991000') AS value"), 'RS');
  assert.equal(await scalar(`SELECT latest_name AS value FROM public._get_crm_lead_profiles('${company}') WHERE customer_key = 'phone:5555999991000'`), 'Manual DDD55', 'manual edit follows DDD55 alias');
  assert.equal(await scalar(`SELECT phone_normalized AS value FROM public._get_crm_lead_profiles('${company}') WHERE latest_name = 'Legacy Normalized Only'`), '5585999993456', 'legacy normalized-only contacts retain BR interpretation');
  // Production retains national phone_normalized values; equal digit strings in
  // different countries must pass while canonical duplicates stay prohibited.
  assert.equal(await scalar("SELECT to_regclass('public.crm_leads_company_phone_unique') AS value"), null,
    'legacy CRM raw-column unique index must be replaced by canonical identity');
  await db.exec(`
    INSERT INTO public.crm_leads(company_id, full_name, phone, source)
      VALUES ('${company}', 'French Shared Digits', '+33912345678', 'import');
    INSERT INTO public.lead_reactivation_dispatches(company_id, phone, phone_normalized, last_visit_date, days_without_visit, channel, dispatch_key)
      VALUES ('${company}', '+33912345678', '33912345678', '2026-10-01', 30, 'evolution', 'french-shared-digits');
  `);
  assert.equal(await scalar("SELECT phone_normalized AS value FROM public.crm_leads WHERE full_name = 'Legacy BR Shared Digits'"), '33912345678',
    'replacing uniqueness must preserve historical national digits');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public._get_crm_lead_profiles('${company}')
    WHERE customer_key IN ('phone:5533912345678', 'phone:33912345678')`), 2,
  'BR and FR contacts sharing legacy digits retain separate identities');
  await assert.rejects(() => db.exec(`INSERT INTO public.crm_leads(company_id, full_name, phone, source)
    VALUES ('${company}', 'Duplicate BR Shared Digits', '+5533912345678', 'import')`), /unique/i,
  'canonical CRM duplicate protection must survive removal of the legacy index');
  await assert.rejects(() => db.exec(`INSERT INTO public.lead_reactivation_dispatches(company_id, phone, phone_normalized, last_visit_date, days_without_visit, channel, dispatch_key)
    VALUES ('${company}', '+5533912345678', '5533912345678', '2026-10-01', 30, 'evolution', 'duplicate-br-shared-digits')`), /unique/i,
  'canonical reactivation duplicate protection must survive removal of the legacy constraint');
  await assert.rejects(() => db.exec(`INSERT INTO public.lead_reactivation_dispatches(company_id, phone, phone_normalized, last_visit_date, days_without_visit, channel, dispatch_key)
    VALUES ('${company}', '+351912345678', '351912345678', '2026-10-02', 30, 'evolution', 'french-shared-digits')`), /unique/i,
  'unrelated dispatch_key uniqueness must remain unchanged');
  await assert.rejects(() => db.exec(`INSERT INTO public.crm_leads(company_id, full_name, phone, source)
    VALUES ('${company}', 'Duplicate Legacy Import', '+5585999993456', 'import')`), /unique/i,
  'a full international import must not duplicate a legacy national normalized-only contact before backfill');
  const history = await scalar(`SELECT public.get_crm_lead_presence_history('${company}', 'phone:55999991000') AS value`);
  assert.ok(history, 'legacy identity remains accepted');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public._get_crm_contact_records('${company}') WHERE is_canonical_presence`), baselineVisits, 'historic visits preserved');

  await db.exec(`
    INSERT INTO public.reservations(id, company_id, status, guest_name, guest_phone, date, time, party_size)
    VALUES ('90000000-0000-4000-8000-000000000003', '${company}', 'confirmed', 'US Guest', '+14072641934', '2026-10-19', '19:00', 2),
      ('90000000-0000-4000-8000-000000000004', '${company}', 'confirmed', 'Canada Guest', '+14165550123', '2026-10-19', '19:00', 2);
  `);
  assert.equal(await scalar("SELECT guest_phone_e164 AS value FROM public.reservations WHERE guest_name = 'US Guest'"), '+14072641934');
  assert.equal(await scalar("SELECT guest_phone_country AS value FROM public.reservations WHERE guest_name = 'Canada Guest'"), null, 'shared DDI must not guess US');
  await assert.rejects(() => db.exec(`UPDATE public.reservations SET guest_phone_country = 'BR' WHERE guest_name = 'US Guest'`), /Pais incompativel/);
  await assert.rejects(() => db.exec(`UPDATE public.reservations SET guest_phone_country = 'ZZ' WHERE guest_name = 'US Guest'`), /Pais incompativel/);
  await db.exec(`UPDATE public.reservations SET guest_phone_country = 'US' WHERE guest_name = 'US Guest'`);
  assert.equal(await scalar(`SELECT guest_name AS value FROM public.get_public_reservation_prefill('${company}', NULL, '+14072641934')`), 'US Guest');
  assert.equal(await scalar(`SELECT guest_name AS value FROM public.get_public_reservation_prefill('${company}', NULL, '55999991000')`), 'DDD 55 History');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public._get_crm_lead_profiles('${company}') WHERE phone_normalized = '14072641934' AND state_code IS NULL`), 1);
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.company_feature_enabled(_company_id uuid, _feature_key text) RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT $2 IN ('advanced_reports', 'nps_surveys') $$;
    CREATE TRIGGER test_nps AFTER UPDATE OF status ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.ensure_reservation_review();
    INSERT INTO public.crm_leads(company_id, full_name, phone_e164, phone_normalized, source)
      VALUES ('${company}', 'US CRM', '+14072641934', '14072641934', 'import');
    UPDATE public.reservations SET status = 'checked_in' WHERE guest_name = 'US Guest';
  `);
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.reservation_reviews rv
    JOIN public.crm_leads c ON c.id = rv.lead_id WHERE c.full_name = 'US CRM'`), 1, 'NPS links full international identity');
  assert.ok(await scalar(`SELECT public.get_crm_lead_presence_history('${company}', 'phone:14072641934') AS value`), 'US CRM history accepts canonical digits');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.get_lead_reactivation_candidates('${company}', 30, 500, '2026-12-01', true, false)
    WHERE phone_normalized = '14072641934'`), 1, 'international recurrence feeds reactivation');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.get_lead_reactivation_candidates('${company}', 30, 500, '2026-12-01', true, false)
    WHERE phone_normalized IN ('55119123456', '559123456')`), 0, 'legacy invalid contacts must never become reactivation recipients');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.get_lead_reactivation_candidates('${company}', 30, 500, '2026-12-01', true, false)
    WHERE phone_normalized = '551191234567'`), 1, 'historically deliverable BR subscribers must remain eligible for reactivation');
  await assert.rejects(() => db.exec(`INSERT INTO public.lead_reactivation_dispatches(company_id, phone, phone_normalized, last_visit_date, days_without_visit, channel, dispatch_key)
    VALUES ('${company}', '+5555999991000', '5555999991000', '2026-10-01', 30, 'evolution', 'new-ddd55-dispatch')`), /unique/i);
  assert.equal(await scalar("SELECT phone_normalized AS value FROM public.lead_reactivation_dispatches WHERE dispatch_key = 'legacy-ddd55-dispatch'"), '55999991000', 'historical guard key is not rewritten');
  // Existing finalized and interrupted dispatches keep their keys during correction.
  assert.equal(await scalar(`SELECT public.claim_whatsapp_dispatch('birthday:${company}:2026-10-19:5555999991000', '${company}', 'birthday', NULL, '+5555999991000') AS value`), false, 'queued birthday must not be claimed under a new DDD55 key');
  assert.equal(await scalar(`SELECT public.claim_whatsapp_dispatch('birthday:${company}:2026-10-20:5555999991000', '${company}', 'birthday', NULL, '+5555999991000') AS value`), true, 'expired guard is resumed through its original key');
  await db.exec(`SELECT public.finalize_whatsapp_dispatch('birthday:${company}:2026-10-20:5555999991000', 'queued')`);
  assert.equal(await scalar(`SELECT status AS value FROM public.whatsapp_dispatch_guards WHERE delivery_key = 'birthday:${company}:2026-10-20:55999991000'`), 'queued');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.whatsapp_dispatch_guards
    WHERE delivery_key IN ('birthday:${company}:2026-10-20:55999991000', 'birthday:${company}:2026-10-20:5555999991000')`), 1);
  assert.equal(await scalar(`SELECT public.claim_whatsapp_dispatch('birthday:${company}:2026-10-19:555591234567', '${company}', 'birthday', NULL, '+555591234567') AS value`), false,
    'a queued birthday for a legacy BR subscriber cannot be recreated after DDD55 canonical correction');
  assert.equal(await scalar(`SELECT public.claim_whatsapp_dispatch('birthday:${company}:2026-10-20:555591234567', '${company}', 'birthday', NULL, '+555591234567') AS value`), true,
    'an expired legacy BR subscriber guard resumes under its original delivery key');
  await db.exec(`SELECT public.finalize_whatsapp_dispatch('birthday:${company}:2026-10-20:555591234567', 'queued')`);
  assert.equal(await scalar(`SELECT status AS value FROM public.whatsapp_dispatch_guards WHERE delivery_key = 'birthday:${company}:2026-10-20:5591234567'`), 'queued',
    'finalization locates the original legacy BR subscriber key through its stored identity');
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.whatsapp_dispatch_guards
    WHERE delivery_key IN ('birthday:${company}:2026-10-20:5591234567', 'birthday:${company}:2026-10-20:555591234567')`), 1);
  for (const key of [`pluguechat:broadcast:${company}:5555999991000`, `pluguechat:birthday:${company}:2026-10-19:5555999991000`]) {
    await assert.rejects(() => db.query(`INSERT INTO public.pluguechat_message_queue(company_id, phone, idempotency_key) VALUES ($1, '+5555999991000', $2)`, [company, key]), /unique/i, 'a corrected DDD55 must not recreate a broadcast/birthday queue item');
  }
  assert.equal(await scalar(`SELECT attempts AS value FROM public.pluguechat_message_queue WHERE idempotency_key = 'pluguechat:broadcast:${company}:55999991000'`), 2);
  await assert.rejects(() => db.query(`SELECT * FROM public.join_public_waitlist('empresa-a', 'Invalid DDI', '+9991234567', 2, NULL, 'device', 'us@example.com', '1990-01-01')`), /WhatsApp valido/);
  // Queue dedup compares full numbers, including different countries with identical suffixes.
  await db.exec(`
    INSERT INTO public.whatsapp_broadcast_recipients(broadcast_id, phone) VALUES
      ('${company}', '+5513987654321'), ('${company}', '+8613987654321');
    INSERT INTO public.whatsapp_message_queue(company_id, phone, type, message) VALUES
      ('${company}', '+5513987654321', 'test', 'same'), ('${company}', '+8613987654321', 'test', 'same');
  `);
  await assert.rejects(() => db.exec(`INSERT INTO public.whatsapp_broadcast_recipients(broadcast_id, phone) VALUES ('${company}', '(13) 98765-4321')`), /unique/i);
  await assert.rejects(() => db.exec(`INSERT INTO public.whatsapp_message_queue(company_id, phone, type, message) VALUES ('${company}', '(13) 98765-4321', 'test', 'same')`), /unique/i);
  const entry = await db.query(`SELECT * FROM public.join_public_waitlist('empresa-a', 'US Waitlist', '+14072641934', 2, NULL, 'device', 'us@example.com', '1990-01-01')`);
  assert.equal(entry.rows[0].already_exists, false);
  assert.equal((await db.query(`SELECT * FROM public.join_public_waitlist('empresa-a', 'US Waitlist', '+1 407 264 1934', 2, NULL, 'device', 'us@example.com', '1990-01-01')`)).rows[0].already_exists, true);
  assert.equal(await scalar("SELECT guest_phone_e164 AS value FROM public.waitlist WHERE guest_name = 'US Waitlist'"), '+14072641934');
  // RPC edits accept E.164, and do not rewrite old operational contact rows.
  await scalar(`SELECT public.upsert_crm_lead_profile('${company}', 'phone:55999991000', 'Edited overseas', '+351912345678', NULL, NULL) AS value`);
  assert.equal(await scalar(`SELECT phone_normalized AS value FROM public._get_crm_lead_profiles('${company}') WHERE customer_key = 'phone:5555999991000'`), '351912345678');
  assert.equal(await scalar("SELECT phone_country AS value FROM public.crm_leads WHERE full_name = 'Edited overseas'"), 'PT', 'unique calling code identifies country');
  assert.equal(await scalar(`SELECT guest_phone AS value FROM public.reservations WHERE guest_name = 'DDD 55 History'`), '(55) 99999-1000');
  await assert.rejects(() => db.query('SELECT public.upsert_crm_lead_profile($1, $2, $3, $4)',
    [company, 'phone:55119123456', 'Legacy Numeric Invalid', '119123456']), /Telefone do lead invalido/,
  'an existing invalid identity does not authorize saving an invalid new phone');
  await scalar(`SELECT public.upsert_crm_lead_profile('${company}', 'phone:55119123456', 'Corrected Legacy Numeric', '+33612345678', NULL, NULL) AS value`);
  assert.equal(await scalar("SELECT phone_e164 AS value FROM public.crm_leads WHERE full_name = 'Corrected Legacy Numeric'"), '+33612345678',
    'a legacy invalid profile can be corrected to a valid international contact');
  await scalar(`SELECT public.upsert_crm_lead_profile('${company}', 'phone:55119123456', 'Corrected Legacy Numeric', NULL, 'legacy-corrected@example.com', NULL) AS value`);
  assert.equal(await scalar("SELECT phone_e164 AS value FROM public.crm_leads WHERE full_name = 'Corrected Legacy Numeric'"), null,
    'a legacy invalid profile can unlink its phone and retain a valid email');
  assert.equal((await scalar(`SELECT public.get_crm_lead_presence_history('${company}', 'phone:55119123456') AS value`)).meta.total_visits,
    legacyInvalidVisitsBefore['phone:55119123456'], 'correcting or removing a profile phone must preserve invalid historical visits');

  const timestampRow = (await db.query("SELECT id, updated_at FROM public.crm_leads WHERE phone_e164 IS NULL AND phone IS NOT NULL ORDER BY id LIMIT 1")).rows[0];
  assert.ok(timestampRow, 'must exercise a legacy CRM update');
  const report = await db.query("SELECT * FROM public.report_international_phone_migration('reservations', 'guest_phone', 10000)");
  assert.equal(report.rows.find((r) => r.raw_phone === 'invalid').migration_status, 'review_required');
  const first = (await db.query("SELECT * FROM public.backfill_international_phone_batch('reservations', 'guest_phone', 10000)")).rows[0];
  assert.ok(first.updated_rows > 0);
  assert.equal(first.review_required_rows, report.rows.filter((r) => r.migration_status === 'review_required').length);
  assert.equal((await db.query("SELECT * FROM public.backfill_international_phone_batch('reservations', 'guest_phone', 10000)")).rows[0].updated_rows, 0);
  await db.exec("SELECT * FROM public.backfill_international_phone_batch('crm_leads', 'phone', 1000)");
  assert.deepEqual(await scalar("SELECT updated_at AS value FROM public.crm_leads WHERE id = $1", [timestampRow.id]), timestampRow.updated_at, 'backfill must preserve CRM precedence timestamps');
  assert.deepEqual((await db.query("SELECT phone, phone_normalized, phone_e164 FROM public.crm_leads WHERE full_name = 'Legacy Normalized Only'")).rows[0], {
    phone: null, phone_normalized: '85999993456', phone_e164: '+5585999993456',
  }, 'backfill handles legacy normalized-only without rewriting it');
  await db.exec("UPDATE public.crm_leads SET phone_country = 'BR' WHERE full_name = 'Legacy Normalized Only'");
  assert.equal(await scalar("SELECT phone_normalized AS value FROM public.crm_leads WHERE full_name = 'Legacy Normalized Only'"), '5585999993456', 'metadata update must not erase normalized-only number');
  await scalar(`SELECT public.upsert_crm_lead_profile('${company}', 'phone:5585999993456', 'Legacy Normalized Only', NULL, 'legacy@example.com', NULL) AS value`);
  assert.equal(await scalar("SELECT phone_e164 AS value FROM public.crm_leads WHERE full_name = 'Legacy Normalized Only'"), null, 'manual removal clears normalized-only metadata');
  await db.exec("SELECT * FROM public.backfill_international_phone_batch('whatsapp_message_queue', 'phone', 1000)");
  assert.deepEqual((await db.query("SELECT phone, status, attempts, phone_e164 FROM public.whatsapp_message_queue WHERE message = 'kept'")).rows[0], {
    phone: '11987654321', status: 'processing', attempts: 2, phone_e164: '+5511987654321',
  });
  const oldRowsAfter = await scalar(`SELECT jsonb_agg((to_jsonb(r) - 'guest_phone_e164' - 'guest_phone_country') ORDER BY id) AS value FROM public.reservations r WHERE id NOT IN ('90000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000004')`);
  assert.deepEqual(oldRowsAfter, rawBefore, 'raw historic reservations must remain byte-equivalent');

  // Exercise the actual database tracking trigger, including its snapshot boundary.
  // This bootstrap and the recording enqueue adapter stay entirely inside PGlite.
  await db.exec(`
    ALTER TABLE public.reservations
      ADD COLUMN IF NOT EXISTS origin_tracking_session_id uuid,
      ADD COLUMN IF NOT EXISTS origin_tracking_journey_id uuid,
      ADD COLUMN IF NOT EXISTS origin_anonymous_id text,
      ADD COLUMN IF NOT EXISTS visitor_id text,
      ADD COLUMN IF NOT EXISTS attribution_snapshot jsonb,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
    CREATE TABLE public.tracking_journeys (
      id uuid PRIMARY KEY, reservation_id uuid, status text,
      converted_at timestamptz, last_event_at timestamptz, ended_at timestamptz
    );
    CREATE TABLE public.tracking_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, session_id uuid,
      journey_id uuid, reservation_id uuid, anonymous_id text, event_id text UNIQUE,
      event_name text, tracking_source text, step text, page_url text, path text,
      referrer text, event_source_url text, occurred_at timestamptz,
      metadata jsonb, user_data_snapshot jsonb
    );
    CREATE TABLE public.meta_event_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid, journey_id uuid,
      event_name text, meta_event_name text, payload jsonb
    );
    CREATE FUNCTION public.enqueue_meta_reservation_event(_reservation_id uuid, _event_name text, _meta_event_name text)
    RETURNS void LANGUAGE sql AS $$
      INSERT INTO public.meta_event_queue(reservation_id, journey_id, event_name, meta_event_name, payload)
      SELECT _reservation_id, e.journey_id, _event_name, _meta_event_name,
        jsonb_build_object('user_data', e.user_data_snapshot)
      FROM public.tracking_events e
      WHERE e.reservation_id = _reservation_id AND e.event_name = _event_name;
    $$;
    INSERT INTO public.tracking_journeys(id, status)
      VALUES ('a0000000-0000-4000-8000-000000000001', 'active');
    INSERT INTO public.meta_event_queue(journey_id, event_name, meta_event_name)
      VALUES ('a0000000-0000-4000-8000-000000000001', 'page_view', 'PageView');
    SELECT set_config('app.phone_backfill', 'on', true);
    INSERT INTO public.reservations(id, company_id, status, guest_name, guest_phone, date, time, party_size)
      VALUES ('90000000-0000-4000-8000-000000000007', '${company}', 'confirmed',
        'Tracking Legacy BR', '(85) 99999-1234', '2026-10-19', '19:00', 2);
    SELECT set_config('app.phone_backfill', '', true);
  `);
  const trackingMigration = await migration('20260407153500_use_lead_for_final_meta_conversion');
  const captureStart = trackingMigration.indexOf('CREATE OR REPLACE FUNCTION public.capture_reservation_tracking_events()');
  assert.ok(captureStart >= 0, 'must load the real reservation capture implementation');
  await db.exec(trackingMigration.slice(captureStart));
  // Loading the original capture after the other contracts requires replaying
  // the identity migration. Running it twice also checks its replacement is stable.
  await db.exec(await migration('20261019121000_use_international_phone_identity'));
  await db.exec(await migration('20261019121000_use_international_phone_identity'));
  await db.exec(`
    CREATE TRIGGER test_capture_reservation_tracking_events
      AFTER INSERT OR UPDATE OF status ON public.reservations
      FOR EACH ROW EXECUTE FUNCTION public.capture_reservation_tracking_events();
    INSERT INTO public.reservations(id, company_id, status, guest_name, guest_phone, date, time, party_size,
      origin_tracking_journey_id, origin_anonymous_id, attribution_snapshot)
      VALUES ('90000000-0000-4000-8000-000000000005', '${company}', 'confirmed', 'Tracking US',
        '+14072641934', '2026-10-19', '19:00', 2, 'a0000000-0000-4000-8000-000000000001', 'visitor-us',
        '{"page_url":"https://offline.invalid/empresa-a","user_data":{"country":"us"}}'),
      ('90000000-0000-4000-8000-000000000006', '${company}', 'confirmed', 'Tracking BR',
        '(11) 99999-8888', '2026-10-19', '19:00', 2, NULL, NULL, NULL);
  `);
  for (const [id, expected] of [
    ['90000000-0000-4000-8000-000000000005', '+14072641934'],
    ['90000000-0000-4000-8000-000000000006', '+5511999998888'],
  ]) {
    assert.equal(await scalar(`SELECT user_data_snapshot->>'phone' AS value FROM public.tracking_events
      WHERE reservation_id = $1 AND event_name = 'reservation_created'`, [id]), expected,
    'database-captured phone must retain its + and country code');
    assert.equal(await scalar(`SELECT payload->'user_data'->>'phone' AS value FROM public.meta_event_queue
      WHERE reservation_id = $1 AND event_name = 'reservation_created'`, [id]), expected,
    'local enqueue receives the same canonical captured phone');
  }
  assert.equal(await scalar(`SELECT count(*)::integer AS value FROM public.meta_event_queue
    WHERE reservation_id = '90000000-0000-4000-8000-000000000005'`), 2,
  'capture keeps prior journey queue rows linked to the new reservation');
  assert.equal(await scalar(`SELECT status AS value FROM public.tracking_journeys
    WHERE id = 'a0000000-0000-4000-8000-000000000001'`), 'converted');
  const trackingBeforeEdit = await scalar('SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) AS value FROM public.tracking_events e');
  const metaBeforeEdit = await scalar('SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS value FROM public.meta_event_queue q');
  await db.exec(`UPDATE public.reservations SET guest_phone = '+351912345678'
    WHERE id = '90000000-0000-4000-8000-000000000005'`);
  assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) AS value FROM public.tracking_events e'),
    trackingBeforeEdit, 'editing current contact data must not rewrite past captured snapshots or create tracking events');
  assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS value FROM public.meta_event_queue q'),
    metaBeforeEdit, 'contact edits must not enqueue a new conversion');
  await db.exec(`UPDATE public.reservations SET status = 'cancelled'
    WHERE id = '90000000-0000-4000-8000-000000000005'`);
  assert.equal(await scalar(`SELECT user_data_snapshot->>'phone' AS value FROM public.tracking_events
    WHERE reservation_id = '90000000-0000-4000-8000-000000000005' AND event_name = 'reservation_cancelled'`),
  '+351912345678', 'a later status event captures its own current international phone');
  assert.equal(await scalar(`SELECT user_data_snapshot->>'phone' AS value FROM public.tracking_events
    WHERE reservation_id = '90000000-0000-4000-8000-000000000005' AND event_name = 'reservation_created'`),
  '+14072641934', 'the original US snapshot stays immutable after a new status snapshot');
  const trackingCountBeforeBackfill = await scalar('SELECT count(*)::integer AS value FROM public.tracking_events');
  const metaCountBeforeBackfill = await scalar('SELECT count(*)::integer AS value FROM public.meta_event_queue');
  const capturedBackfill = (await db.query("SELECT * FROM public.backfill_international_phone_batch('reservations', 'guest_phone', 10000)")).rows[0];
  assert.equal(capturedBackfill.updated_rows, 1, 'the no-enqueue assertion must exercise an actual sidecar update');
  assert.equal(await scalar(`SELECT guest_phone_e164 AS value FROM public.reservations
    WHERE id = '90000000-0000-4000-8000-000000000007'`), '+5585999991234');
  assert.equal(await scalar('SELECT count(*)::integer AS value FROM public.tracking_events'), trackingCountBeforeBackfill,
    'sidecar backfill must not create tracking events');
  assert.equal(await scalar('SELECT count(*)::integer AS value FROM public.meta_event_queue'), metaCountBeforeBackfill,
    'sidecar backfill must not enqueue conversions');
  await db.exec("SELECT set_config('request.jwt.claim.role', 'authenticated', false)");
  await assert.rejects(() => db.exec("SELECT * FROM public.backfill_international_phone_batch('reservations', 'guest_phone', 10)"), /service_role/);
  process.stdout.write(`OK: ${parityCases} SQL/libphonenumber parity cases, international E.164, shared DDI, DDD55 identity/history, public waitlist/prefill, full-number queue dedup, manual CRM edits, database tracking snapshots, additive/idempotent backfill and authorization.\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  if (error.query) process.stderr.write(`SQL: ${error.query}\n`);
  process.exitCode = 1;
} finally { await db.close(); }

