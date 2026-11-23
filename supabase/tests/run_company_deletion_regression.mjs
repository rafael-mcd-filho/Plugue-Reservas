import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "..", "..");
const migrationDirectory = join(repositoryRoot, "supabase", "migrations");
const originalMigrations = [
  "20260826161000_add_company_deletion_requests.sql",
  "20260826162000_add_company_deletion_engine.sql",
  "20260826163000_add_company_deletion_request_rpc.sql",
  "20260826164000_fix_company_deletion_phase_index_default.sql",
  "20260826165000_gate_company_deletion_request_on_pipeline_flag.sql",
  "20260902120000_fix_meta_queue_reservation_link_conflict.sql",
];
const foreignKeyIndexMigrations = [
  "20261022121000_index_meta_queue_journey_for_deletion.sql",
  "20261022121100_index_tracking_events_session_for_deletion.sql",
  "20261022121200_index_meta_queue_reservation_for_deletion.sql",
  "20261022121300_index_meta_attempts_reservation_for_deletion.sql",
];

const database = new PGlite();

try {
  const harness = await readFile(
    join(currentDirectory, "company_deletion_regression.sql"),
    "utf8",
  );
  const [bootstrap, remaining] = harness.split("-- @apply-migration");
  const [beforeFix, afterFix] = remaining?.split("-- @apply-tracking-queue-fix") ?? [];
  if (!bootstrap || !beforeFix || !afterFix) {
    throw new Error("Company deletion regression migration markers are missing.");
  }

  await database.exec(bootstrap);
  for (const migration of originalMigrations) {
    await database.exec(await readFile(join(migrationDirectory, migration), "utf8"));
  }
  await database.exec(beforeFix);
  await database.exec(
    await readFile(
      join(migrationDirectory, "20261022120000_fix_company_deletion_tracking_queue_order.sql"),
      "utf8",
    ),
  );
  for (const migration of foreignKeyIndexMigrations) {
    const sql = await readFile(join(migrationDirectory, migration), "utf8");
    // PGlite has no concurrent sessions; validate the real index definitions
    // as ordinary indexes. Production applies each concurrent migration alone.
    await database.exec(sql.replaceAll("CREATE INDEX CONCURRENTLY", "CREATE INDEX"));
  }
  const results = await database.exec(afterFix);
  const regression = results.flatMap((result) => result.rows)
    .find((row) => row.company_deletion_regression);
  if (!regression) throw new Error("Company deletion regression did not report success.");
  console.log(JSON.stringify(regression.company_deletion_regression));
} finally {
  await database.close();
}
