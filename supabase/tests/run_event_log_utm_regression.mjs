import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION has_role_in_company(_user_id uuid, _role text, _company_id uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT _user_id = '00000000-0000-0000-0000-000000000099'::uuid AND _role = 'admin' AND _company_id = '00000000-0000-0000-0000-000000000001'::uuid
    $$;
    CREATE FUNCTION has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE TABLE tracking_sessions (id uuid PRIMARY KEY, company_id uuid, utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text);
    CREATE TABLE tracking_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, session_id uuid, event_name text, occurred_at timestamptz, metadata jsonb DEFAULT '{}');
    ALTER TABLE tracking_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tracking_sessions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_events ON tracking_events FOR SELECT TO authenticated USING (company_id = '00000000-0000-0000-0000-000000000001');
    CREATE POLICY tenant_sessions ON tracking_sessions FOR SELECT TO authenticated USING (company_id = '00000000-0000-0000-0000-000000000001');
    GRANT SELECT ON tracking_events, tracking_sessions TO authenticated;
    INSERT INTO tracking_sessions VALUES ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'google', 'organic', 'gbp_goiania', NULL, NULL);
    INSERT INTO tracking_events (company_id, session_id, event_name, occurred_at, metadata) VALUES
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'reservation_created', '2026-10-01', '{}'),
      ('00000000-0000-0000-0000-000000000001', NULL, 'reservation_created', '2026-09-01', '{"utm_campaign":"gbp_goiania"}'),
      ('00000000-0000-0000-0000-000000000002', NULL, 'reservation_created', '2026-10-01', '{"utm_campaign":"gbp_goiania"}'),
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'reservation_created', '2026-10-01', '{"utm_campaign":"other_campaign"}');
    INSERT INTO tracking_events (company_id, event_name, occurred_at, metadata)
      SELECT '00000000-0000-0000-0000-000000000001', 'page_view', '2026-10-02', '{"utm_campaign":"other"}' FROM generate_series(1, 120);
  `);
  await db.exec(await readFile(new URL('../migrations/20261002120000_search_event_log_utm.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/20261002123000_optimize_event_log_utm_permissions.sql', import.meta.url), 'utf8'));
  await db.exec('SET ROLE authenticated');
  await db.exec("SET request.jwt.claim.sub = '00000000-0000-0000-0000-000000000099'");
  const search = async (company, term, filters = {}, name = null, start = null, end = null) =>
    (await db.query('SELECT * FROM search_company_event_log_utm($1::uuid, $2, $3::jsonb, $4, $5::timestamptz, $6::timestamptz)', [company, term, JSON.stringify(filters), name, start, end])).rows;
  const company = '00000000-0000-0000-0000-000000000001';
  assert.equal((await search(company, 'GBP_GOIANIA')).length, 2, 'UTM filter must precede 100-event limit and prefer event attribution');
  assert.equal((await search(company, 'gbp_goiania', {}, 'page_view')).length, 0, 'must respect event type');
  assert.equal((await search(company, 'gbp_goiania', {}, 'reservation_created', '2026-10-01', '2026-10-02')).length, 1, 'must combine type, date and UTM');
  assert.equal((await search(company, '', { utm_source: 'google', utm_medium: 'organic', utm_campaign: 'gbp_goiania' })).length, 1, 'URL fields must all match');
  assert.equal((await search(company, '', { utm_source: 'google', utm_medium: 'paid' })).length, 0);
  assert.equal((await search(company, '%')).length, 0, 'search must treat wildcards literally');
  await assert.rejects(search('00000000-0000-0000-0000-000000000002', 'gbp_goiania'), /Access denied/, 'must block another tenant before scanning');
  assert.equal((await search(company, '')).length, 100, 'limit must remain bounded');
  await db.exec("SET request.jwt.claim.sub = ''");
  await assert.rejects(search(company, 'google'), /Access denied/, 'must block requests without a logged-in user');
  console.log('Event log UTM SQL regression passed (filters, limit, attribution and RLS).');
} finally {
  await db.close();
}
