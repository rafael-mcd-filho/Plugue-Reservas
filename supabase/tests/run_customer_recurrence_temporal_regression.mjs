import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "..", "..");

const steps = [
  {
    marker: "-- @apply-old-recurrence",
    migration: "20260814120000_fix_customer_recurrence_waitlist_fallback.sql",
  },
  {
    marker: "-- @apply-core-migration",
    migration: "20260814130000_add_server_side_crm_leads_read_model.sql",
  },
  {
    marker: "-- @apply-export-migration",
    migration: "20260814140000_add_crm_leads_canonical_export.sql",
  },
  {
    marker: "-- @apply-recurrence-pagination-filter-migration",
    migration: "20260817120000_add_recurrence_minimum_visits_filter.sql",
  },
  {
    marker: "-- @apply-unbounded-pagination-migration",
    migration: "20260817130000_remove_crm_report_pagination_ceiling.sql",
  },
  {
    marker: "-- @apply-recurrence-profile-migration",
    migration: "20260819115000_add_recurrence_lead_profile_lookup.sql",
  },
];

function splitHarness(sql) {
  const segments = [];
  let cursor = 0;

  for (const step of steps) {
    const position = sql.indexOf(step.marker, cursor);
    if (position < 0) {
      throw new Error(`Marcador ausente no harness de CRM: ${step.marker}`);
    }
    segments.push(sql.slice(cursor, position));
    cursor = position + step.marker.length;
  }

  segments.push(sql.slice(cursor));
  return segments;
}

async function loadMigration(fileName) {
  return readFile(
    join(repositoryRoot, "supabase", "migrations", fileName),
    "utf8",
  );
}

function withoutGeneratedAt(payload) {
  const copy = structuredClone(payload);
  if (copy?.meta && typeof copy.meta === "object") {
    delete copy.meta.generated_at;
  }
  return copy;
}

const reportSql = `
  SELECT public.get_customer_recurrence_report(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    DATE '2026-08-01',
    DATE '2026-08-13',
    false,
    1,
    25,
    NULL,
    'previous_period',
    NULL
  ) AS payload
`;

const companyFoundation = String.raw`
  CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator');

  CREATE TABLE public.companies (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO public.companies (id, name) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Empresa A'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Empresa B'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Empresa C');

  CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false; $$;

  CREATE FUNCTION public.has_role_in_company(
    _user_id uuid,
    _role public.app_role,
    _company_id uuid
  ) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false; $$;
`;

const database = new PGlite();

try {
  const harnessSql = await readFile(
    join(
      repositoryRoot,
      "supabase",
      "tests",
      "crm_leads_server_read_model_regression.sql",
    ),
    "utf8",
  );
  const segments = splitHarness(harnessSql);

  await database.exec(segments[0]);
  await database.exec(companyFoundation);

  for (let index = 0; index < steps.length; index += 1) {
    await database.exec(await loadMigration(steps[index].migration));
    await database.exec(segments[index + 1]);
  }

  await database.exec(
    "SELECT set_config('request.jwt.claim.role', 'service_role', false);",
  );
  const baselineResult = await database.query(reportSql);
  const baseline = baselineResult.rows[0]?.payload;

  await database.exec(
    await loadMigration("20260820130000_add_advanced_report_foundation.sql"),
  );
  const temporalMigration = await loadMigration(
    "20260827130000_expand_customer_recurrence_temporal_analysis.sql",
  );

  await database.exec(temporalMigration);
  await database.exec(temporalMigration);

  const currentResult = await database.query(reportSql);
  const current = currentResult.rows[0]?.payload;

  if (
    JSON.stringify(withoutGeneratedAt(current)) !==
    JSON.stringify(withoutGeneratedAt(baseline))
  ) {
    throw new Error(
      "O relatorio de recorrencia mudou no fuso historico padrao.",
    );
  }

  await database.exec(`
    UPDATE public.companies
    SET time_zone = 'America/Manaus'
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  `);

  const seriesResult = await database.query(`
    SELECT public.get_customer_recurrence_visit_series(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
      DATE '2026-08-01',
      DATE '2026-08-13',
      'day',
      false
    ) AS payload
  `);
  const series = seriesResult.rows[0]?.payload;

  if (
    series?.meta?.time_zone !== "America/Manaus" ||
    !Array.isArray(series?.series) ||
    series.series.length !== 13
  ) {
    throw new Error("A serie de recorrencia nao respeitou o fuso da empresa.");
  }

  const definitionResult = await database.query(`
    SELECT pg_get_functiondef(
      'public._get_crm_contact_records(uuid)'::regprocedure
    ) AS definition
  `);
  const definition = definitionResult.rows[0]?.definition ?? "";
  const timeZoneLookups = definition.match(
    /public\._company_report_time_zone\(_company_id\)/g,
  );

  if (
    !definition.includes("report_context AS MATERIALIZED") ||
    timeZoneLookups?.length !== 1
  ) {
    throw new Error("O fuso do CRM nao foi materializado uma unica vez.");
  }

  process.stdout.write(
    "OK: recorrencia idempotente, retrocompativel e sensivel ao fuso da empresa.\n",
  );
} catch (error) {
  process.stderr.write(
    `Falha na regressao temporal de recorrencia: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
