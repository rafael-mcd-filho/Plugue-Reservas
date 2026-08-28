import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "..", "..");

const foundationMarker = "-- __APPLY_ADVANCED_REPORT_FOUNDATION__";
const seriesMarker = "-- __APPLY_OCCUPANCY_WAITLIST_SERIES__";
const indexContracts = [
  {
    file: "20260827111000_index_waitlist_seated_events.sql",
    indexName: "idx_waitlist_company_seated_event",
    queries: [
      "company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND seated_at >= '2026-08-01 00:00+00' AND seated_at < '2026-08-03 00:00+00'",
    ],
  },
  {
    file: "20260827111100_index_waitlist_expired_events.sql",
    indexName: "idx_waitlist_company_expired_event",
    queries: [
      "company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND status = 'expired' AND expired_at >= '2026-08-01 00:00+00' AND expired_at < '2026-08-03 00:00+00'",
      "company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND status = 'removed' AND removed_at IS NULL AND expired_at >= '2026-08-01 00:00+00' AND expired_at < '2026-08-03 00:00+00'",
    ],
  },
  {
    file: "20260827111200_index_waitlist_removed_events.sql",
    indexName: "idx_waitlist_company_removed_event",
    queries: [
      "company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND status = 'removed' AND removed_at >= '2026-08-01 00:00+00' AND removed_at < '2026-08-03 00:00+00'",
      "company_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND status = 'expired' AND expired_at IS NULL AND removed_at >= '2026-08-01 00:00+00' AND removed_at < '2026-08-03 00:00+00'",
    ],
  },
];

function splitHarness(sql) {
  const foundationPosition = sql.indexOf(foundationMarker);
  const seriesPosition = sql.indexOf(seriesMarker);

  if (
    foundationPosition < 0 ||
    seriesPosition < 0 ||
    seriesPosition <= foundationPosition
  ) {
    throw new Error("Marcadores do harness de ocupacao nao foram encontrados.");
  }

  return {
    bootstrap: sql.slice(0, foundationPosition),
    betweenMigrations: sql.slice(
      foundationPosition + foundationMarker.length,
      seriesPosition,
    ),
    assertions: sql.slice(seriesPosition + seriesMarker.length),
  };
}

const database = new PGlite();

try {
  const harness = splitHarness(
    await readFile(
      join(
        repositoryRoot,
        "supabase",
        "tests",
        "occupancy_waitlist_series_regression.sql",
      ),
      "utf8",
    ),
  );
  const foundationMigration = await readFile(
    join(
      repositoryRoot,
      "supabase",
      "migrations",
      "20260820130000_add_advanced_report_foundation.sql",
    ),
    "utf8",
  );
  const seriesMigration = await readFile(
    join(
      repositoryRoot,
      "supabase",
      "migrations",
      "20260827110000_expand_occupancy_temporal_analysis.sql",
    ),
    "utf8",
  );

  await database.exec(harness.bootstrap);
  await database.exec(foundationMigration);
  await database.exec(harness.betweenMigrations);
  await database.exec(seriesMigration);
  await database.exec(harness.assertions);

  for (const contract of indexContracts) {
    const indexMigration = await readFile(
      join(repositoryRoot, "supabase", "migrations", contract.file),
      "utf8",
    );
    try {
      await database.exec(
        indexMigration.replaceAll(
          "CREATE INDEX CONCURRENTLY",
          "CREATE INDEX",
        ),
      );
    } catch (error) {
      throw new Error(
        `Falha ao criar ${contract.indexName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await database.exec("SET enable_seqscan = off;");
  for (const contract of indexContracts) {
    for (const predicate of contract.queries) {
      const plan = await database.query(
        `EXPLAIN (FORMAT JSON) SELECT * FROM public.waitlist WHERE ${predicate}`,
      );
      if (!JSON.stringify(plan.rows).includes(contract.indexName)) {
        throw new Error(
          `O planner nao selecionou ${contract.indexName} para: ${predicate}`,
        );
      }
    }
  }

  process.stdout.write(
    "OK: serie temporal da fila e planos dos indices validados.\n",
  );
} catch (error) {
  process.stderr.write(
    `Falha na regressao da serie temporal da fila: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
