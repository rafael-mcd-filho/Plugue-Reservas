import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type RpcMigrationContract = {
  migration: string;
  functionName: string;
  identityArguments: string;
  expectedDefaults: string[];
};

const contracts: RpcMigrationContract[] = [
  {
    migration: "20260827100000_expand_demand_temporal_analysis.sql",
    functionName: "get_demand_temporal_analysis",
    identityArguments: "uuid, date, date, text",
    expectedDefaults: ["_granularity text DEFAULT 'day'"],
  },
  {
    migration: "20260827110000_expand_occupancy_temporal_analysis.sql",
    functionName: "get_occupancy_waitlist_series",
    identityArguments: "uuid, date, date, text",
    expectedDefaults: ["_granularity text DEFAULT 'day'"],
  },
  {
    migration: "20260827120000_expand_attendance_outcome_series.sql",
    functionName: "get_attendance_outcome_series",
    identityArguments: "uuid, date, date, text, text, text",
    expectedDefaults: [
      "_granularity text DEFAULT 'day'",
      "_outcome text DEFAULT 'all'",
      "_entry_method text DEFAULT 'all'",
    ],
  },
  {
    migration: "20260827130000_expand_customer_recurrence_temporal_analysis.sql",
    functionName: "get_customer_recurrence_visit_series",
    identityArguments: "uuid, date, date, text, boolean",
    expectedDefaults: [
      "_granularity text DEFAULT 'day'",
      "_include_companions boolean DEFAULT false",
    ],
  },
];

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function readMigration(fileName: string) {
  return readFileSync(
    resolve(process.cwd(), "supabase", "migrations", fileName),
    "utf8",
  );
}

function extractRpcDefinition(sql: string, functionName: string) {
  const startMarker = `CREATE OR REPLACE FUNCTION public.${functionName}(`;
  const endMarker = `COMMENT ON FUNCTION public.${functionName}`;
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker, start);

  if (start < 0 || end < 0) {
    throw new Error(`Nao foi possivel extrair a definicao de ${functionName}.`);
  }

  return sql.slice(start, end);
}

describe("migrations dos RPCs temporais de relatorios avancados", () => {
  it.each(contracts)(
    "$functionName preserva assinatura, defaults e contrato de seguranca",
    ({ migration, functionName, identityArguments, expectedDefaults }) => {
      const sql = readMigration(migration);
      const definition = extractRpcDefinition(sql, functionName);
      const normalizedDefinition = normalizeSql(definition);
      const normalizedMigration = normalizeSql(sql);

      expect(normalizedDefinition).toContain("RETURNS jsonb");
      expect(normalizedDefinition).toContain("LANGUAGE plpgsql");
      expect(normalizedDefinition).toContain("STABLE");
      expect(normalizedDefinition).toContain("SECURITY DEFINER");
      expect(normalizedDefinition).toContain("SET search_path = public, pg_temp");

      for (const expectedDefault of expectedDefaults) {
        expect(normalizedDefinition).toContain(expectedDefault);
      }

      expect(normalizedMigration).toContain(
        normalizeSql(
          `REVOKE ALL ON FUNCTION public.${functionName}(${identityArguments}) ` +
            "FROM PUBLIC, anon, authenticated;",
        ),
      );
      expect(normalizedMigration).toContain(
        normalizeSql(
          `GRANT EXECUTE ON FUNCTION public.${functionName}(${identityArguments}) ` +
            "TO authenticated, service_role;",
        ),
      );
    },
  );

  it.each(contracts)(
    "$functionName permanece somente leitura e isolado do pipeline da Meta",
    ({ migration, functionName }) => {
      const definition = extractRpcDefinition(readMigration(migration), functionName);

      expect(definition).not.toMatch(
        /\b(?:INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+)\b/i,
      );
      expect(definition).not.toMatch(
        /meta_event_queue|process_meta_event|process-meta-event|facebook_capi|conversion_api/i,
      );
    },
  );

  it("mantem a recorrencia idempotente e resolve o fuso uma vez por leitura", () => {
    const canonicalSql = readMigration(
      "20260814130000_add_server_side_crm_leads_read_model.sql",
    );
    const sql = readMigration(
      "20260827130000_expand_customer_recurrence_temporal_analysis.sql",
    );
    const canonicalContactModelStart = canonicalSql.indexOf(
      "CREATE OR REPLACE FUNCTION public._get_crm_contact_records(_company_id uuid)",
    );
    const canonicalContactModelEnd =
      canonicalSql.indexOf("\n$$;", canonicalContactModelStart) + "\n$$;".length;
    const canonicalContactModel = canonicalSql.slice(
      canonicalContactModelStart,
      canonicalContactModelEnd,
    );
    const contactModelStart = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public._get_crm_contact_records(_company_id uuid)",
    );
    const contactModelEnd =
      sql.indexOf("\n$$;", contactModelStart) + "\n$$;".length;
    const contactModel = sql.slice(contactModelStart, contactModelEnd);
    const series = extractRpcDefinition(
      sql,
      "get_customer_recurrence_visit_series",
    );

    expect(contactModelStart).toBeGreaterThanOrEqual(0);
    expect(contactModelEnd).toBeGreaterThan(contactModelStart);
    expect(normalizeSql(contactModel)).toContain(
      "WITH report_context AS MATERIALIZED ( SELECT public._company_report_time_zone(_company_id) AS time_zone )",
    );
    expect(
      contactModel.match(/public\._company_report_time_zone\(_company_id\)/g),
    ).toHaveLength(1);
    expect(sql).not.toContain("pg_get_functiondef");
    expect(sql).not.toContain("EXECUTE _updated_definition");
    expect(sql).not.toContain("America/Fortaleza");
    expect(normalizeSql(sql)).toContain(
      "REVOKE ALL ON FUNCTION public._get_crm_contact_records(uuid) FROM PUBLIC, anon, authenticated, service_role;",
    );
    expect(normalizeSql(series)).toContain(
      "public._get_customer_canonical_visit_events( _company_id, _period_end, COALESCE(_include_companions, false) )",
    );
    expect(series).not.toContain("visits.presence_date <= _period_end");

    const restoredHistoricalDefinition = contactModel
      .replace(
        /WITH report_context AS MATERIALIZED \(\s*SELECT public\._company_report_time_zone\(_company_id\) AS time_zone\s*\),\s*raw_records AS/,
        "WITH raw_records AS",
      )
      .replaceAll("report_context.time_zone", "'America/Fortaleza'")
      .replaceAll("\n    CROSS JOIN report_context", "");

    expect(normalizeSql(restoredHistoricalDefinition)).toBe(
      normalizeSql(canonicalContactModel),
    );
  });

  it("mantem as saidas da fila indexaveis e os indices seguros para retry", () => {
    const migration = readMigration(
      "20260827110000_expand_occupancy_temporal_analysis.sql",
    );
    const definition = normalizeSql(
      extractRpcDefinition(migration, "get_occupancy_waitlist_series"),
    );

    expect(definition).not.toContain("dropped.drop_at");
    expect(definition).not.toContain("SELECT CASE WHEN waitlist.status = 'expired'");
    expect(definition).toContain(
      "waitlist.status = 'expired' AND waitlist.expired_at >= _start_at",
    );
    expect(definition).toContain(
      "waitlist.status = 'expired' AND waitlist.expired_at IS NULL AND waitlist.removed_at >= _start_at",
    );
    expect(definition).toContain(
      "waitlist.status = 'removed' AND waitlist.removed_at >= _start_at",
    );
    expect(definition).toContain(
      "waitlist.status = 'removed' AND waitlist.removed_at IS NULL AND waitlist.expired_at >= _start_at",
    );

    for (const fileName of [
      "20260827111000_index_waitlist_seated_events.sql",
      "20260827111100_index_waitlist_expired_events.sql",
      "20260827111200_index_waitlist_removed_events.sql",
    ]) {
      const indexMigration = readMigration(fileName);
      expect(indexMigration).toMatch(/CREATE INDEX CONCURRENTLY idx_waitlist_/);
      expect(indexMigration).not.toContain("IF NOT EXISTS");
      expect(indexMigration).toContain("pg_index.indisvalid");
      expect(indexMigration).toContain("pg_index.indisready");
      expect(indexMigration).toContain("DROP INDEX CONCURRENTLY");
    }
  });
});
