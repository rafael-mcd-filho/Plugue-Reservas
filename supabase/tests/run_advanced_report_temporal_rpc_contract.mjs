import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "..", "..");

const rpcMigrations = [
  {
    file: "20260827100000_expand_demand_temporal_analysis.sql",
    functionName: "get_demand_temporal_analysis",
    identityArguments: "uuid, date, date, text",
  },
  {
    file: "20260827110000_expand_occupancy_temporal_analysis.sql",
    functionName: "get_occupancy_waitlist_series",
    identityArguments: "uuid, date, date, text",
  },
  {
    file: "20260827120000_expand_attendance_outcome_series.sql",
    functionName: "get_attendance_outcome_series",
    identityArguments: "uuid, date, date, text, text, text",
  },
  {
    file: "20260827130000_expand_customer_recurrence_temporal_analysis.sql",
    functionName: "get_customer_recurrence_visit_series",
    identityArguments: "uuid, date, date, text, boolean",
  },
];
const indexMigrations = [
  "20260827111000_index_waitlist_seated_events.sql",
  "20260827111100_index_waitlist_expired_events.sql",
  "20260827111200_index_waitlist_removed_events.sql",
];

const bootstrap = String.raw`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA auth;

  CREATE FUNCTION auth.role()
  RETURNS text
  LANGUAGE sql
  STABLE
  AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
  $$;

  CREATE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

  CREATE TABLE public.companies (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    time_zone text NOT NULL DEFAULT 'America/Fortaleza',
    advanced_reports boolean NOT NULL DEFAULT true
  );

  INSERT INTO public.companies (id, name, time_zone, advanced_reports)
  VALUES (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Empresa de contrato',
    'America/Manaus',
    true
  );

  CREATE FUNCTION public._assert_company_advanced_report_access(_company_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF auth.role() = 'service_role' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Nao autorizado.' USING ERRCODE = '42501';
  END;
  $$;

  CREATE FUNCTION public._validate_advanced_report_range(
    _start_date date,
    _end_date date,
    _maximum_days integer DEFAULT 366
  )
  RETURNS void
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF _start_date IS NULL
      OR _end_date IS NULL
      OR _end_date < _start_date
      OR ((_end_date - _start_date) + 1) > _maximum_days THEN
      RAISE EXCEPTION 'Intervalo invalido.' USING ERRCODE = '22023';
    END IF;
  END;
  $$;

  CREATE FUNCTION public._company_report_time_zone(_company_id uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT companies.time_zone
    FROM public.companies
    WHERE companies.id = _company_id;
  $$;

  CREATE FUNCTION public.company_feature_enabled(_company_id uuid, _feature text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
  AS $$
    SELECT _feature = 'advanced_reports' AND companies.advanced_reports
    FROM public.companies
    WHERE companies.id = _company_id;
  $$;

  CREATE FUNCTION public.has_company_panel_permission(
    _user_id uuid,
    _company_id uuid,
    _permission text
  )
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
  AS $$
    SELECT false;
  $$;

  CREATE FUNCTION public._demand_conversion_entry_mode(
    _source text,
    _origin_waitlist_id uuid,
    _origin_affiliate_link_id uuid,
    _origin_tracking_session_id uuid,
    _origin_anonymous_id text,
    _attribution_snapshot jsonb
  )
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path = public, pg_temp
  AS $$
    SELECT CASE
      WHEN _source = 'waitlist' OR _origin_waitlist_id IS NOT NULL THEN 'waitlist'
      WHEN _origin_affiliate_link_id IS NOT NULL THEN 'affiliate'
      WHEN _origin_tracking_session_id IS NOT NULL
        OR NULLIF(btrim(COALESCE(_origin_anonymous_id, '')), '') IS NOT NULL
        OR _attribution_snapshot ->> 'tracking_source' = 'public_web' THEN 'online'
      ELSE 'manual'
    END;
  $$;

  CREATE TABLE public.reservations (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES public.companies(id),
    party_size integer NOT NULL,
    date date NOT NULL,
    created_at timestamptz NOT NULL,
    source text,
    origin_waitlist_id uuid,
    origin_affiliate_link_id uuid,
    origin_tracking_session_id uuid,
    origin_anonymous_id text,
    attribution_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
  );

  INSERT INTO public.reservations (
    id, company_id, party_size, date, created_at, source,
    origin_waitlist_id, origin_affiliate_link_id,
    origin_tracking_session_id, origin_anonymous_id, attribution_snapshot
  ) VALUES
    (
      '10000000-0000-4000-8000-000000000001',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      2, DATE '2026-08-02', '2026-08-01 04:30+00', 'public',
      NULL, NULL, NULL, 'anonymous-online', '{}'::jsonb
    ),
    (
      '10000000-0000-4000-8000-000000000002',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      4, DATE '2026-08-01', '2026-08-02 03:30+00', 'manual',
      NULL, NULL, NULL, NULL, '{}'::jsonb
    ),
    (
      '10000000-0000-4000-8000-000000000003',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      3, DATE '2026-08-02', '2026-08-02 05:00+00', 'waitlist',
      '20000000-0000-4000-8000-000000000003', NULL, NULL, NULL, '{}'::jsonb
    ),
    (
      '10000000-0000-4000-8000-000000000004',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      5, DATE '2026-08-03', '2026-08-02 06:00+00', 'affiliate',
      NULL, '30000000-0000-4000-8000-000000000004', NULL, NULL, '{}'::jsonb
    );

  CREATE TABLE public.waitlist (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES public.companies(id),
    status text NOT NULL,
    party_size integer NOT NULL,
    seated_party_size integer,
    created_at timestamptz NOT NULL,
    seated_at timestamptz,
    expired_at timestamptz,
    removed_at timestamptz
  );

  CREATE TABLE public.attendance_fixture (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES public.companies(id),
    date date NOT NULL,
    party_size integer NOT NULL,
    checked_in_party_size integer,
    outcome text NOT NULL,
    entry_method text NOT NULL
  );

  INSERT INTO public.attendance_fixture (
    id, company_id, date, party_size, checked_in_party_size, outcome, entry_method
  ) VALUES
    ('40000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', 4, 3, 'attended', 'online'),
    ('40000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', 2, NULL, 'no_show', 'manual'),
    ('40000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', 5, NULL, 'cancelled', 'affiliate'),
    ('40000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-01', 1, NULL, 'scheduled', 'waitlist');

  CREATE FUNCTION public._attendance_losses_rows(
    _company_id uuid,
    _period_start date,
    _period_end date,
    _time_zone text
  )
  RETURNS TABLE (
    id uuid,
    date date,
    party_size integer,
    checked_in_party_size integer,
    outcome text,
    entry_method text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT
      attendance_fixture.id,
      attendance_fixture.date,
      attendance_fixture.party_size,
      attendance_fixture.checked_in_party_size,
      attendance_fixture.outcome,
      attendance_fixture.entry_method
    FROM public.attendance_fixture
    WHERE attendance_fixture.company_id = _company_id
      AND attendance_fixture.date BETWEEN _period_start AND _period_end;
  $$;

  CREATE FUNCTION public._get_customer_canonical_visit_events(
    _company_id uuid,
    _through_date date DEFAULT NULL,
    _include_companions boolean DEFAULT true
  )
  RETURNS TABLE (
    company_id uuid,
    phone_normalized text,
    presence_date date,
    presence_at timestamptz,
    canonical_event_key text
  )
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
  AS $$
    SELECT
      NULL::uuid,
      NULL::text,
      NULL::date,
      NULL::timestamptz,
      NULL::text
    WHERE false;
  $$;

  CREATE FUNCTION public._get_crm_contact_records(_company_id uuid)
  RETURNS TABLE (dummy integer)
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
  AS $$
    WITH report_context AS MATERIALIZED (
      SELECT public._company_report_time_zone(_company_id) AS time_zone
    )
    SELECT NULL::integer
    FROM report_context
    WHERE false;
  $$;

  REVOKE ALL ON FUNCTION public._get_crm_contact_records(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
`;

function extractRpcMigration(sql, functionName, identityArguments) {
  const startMarker = `CREATE OR REPLACE FUNCTION public.${functionName}(`;
  const endMarker =
    `GRANT EXECUTE ON FUNCTION public.${functionName}(${identityArguments})`;
  const start = sql.indexOf(startMarker);
  const grantStart = sql.indexOf(endMarker, start);

  if (start < 0 || grantStart < 0) {
    throw new Error(`Nao foi possivel extrair ${functionName} da migration.`);
  }

  const end = sql.indexOf(";", grantStart);
  if (end < 0) {
    throw new Error(`GRANT de ${functionName} nao termina com ponto e virgula.`);
  }

  return sql.slice(start, end + 1);
}

const database = new PGlite();

try {
  await database.exec(bootstrap);

  for (const contract of rpcMigrations) {
    const migration = await readFile(
      join(repositoryRoot, "supabase", "migrations", contract.file),
      "utf8",
    );
    await database.exec(
      extractRpcMigration(
        migration,
        contract.functionName,
        contract.identityArguments,
      ),
    );
  }

  for (const fileName of indexMigrations) {
    const migration = await readFile(
      join(repositoryRoot, "supabase", "migrations", fileName),
      "utf8",
    );
    await database.exec(
      migration.replaceAll("CREATE INDEX CONCURRENTLY", "CREATE INDEX"),
    );
  }

  const contractSql = await readFile(
    join(
      repositoryRoot,
      "supabase",
      "tests",
      "advanced_report_temporal_rpc_contract_regression.sql",
    ),
    "utf8",
  );
  await database.exec(contractSql);

  const productionPreflight = await readFile(
    join(
      repositoryRoot,
      "supabase",
      "tests",
      "advanced_report_temporal_production_preflight.sql",
    ),
    "utf8",
  );
  await database.exec(productionPreflight);

  process.stdout.write(
    "OK: contratos e cenarios funcionais dos RPCs temporais validados em PGlite.\n",
  );
} catch (error) {
  process.stderr.write(
    `Falha no contrato dos RPCs temporais: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
