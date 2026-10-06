import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { snapshotQuery, buildRollbackSql } from './support-release-tools.mjs';

// Offline catalog round-trip using the real pre-release migrations. Reuse the
// inert Auth/Storage/cron/net fixture from the existing full-schema test, not
// credentials or a remote/local Supabase project.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const db = new PGlite();
const migrationDirectory = resolve(root,'supabase/migrations');
try {
  const fixtureSource = await readFile(resolve(root,'supabase/tests/run_support_migration_replay.mjs'),'utf8');
  const fixtureSql = fixtureSource.match(/await db\.exec\(String\.raw`([\s\S]*?)`\);/)?.[1];
  assert.ok(fixtureSql,'Missing inert schema fixture');
  await db.exec(fixtureSql);
  const files = (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql')).sort();
  const beforeSupport = files.filter(file => file < '20261006120000');
  for (const file of beforeSupport) {
    if (file === '20260309211714_c61ee570-889c-44b5-9189-83eb8dc93983.sql') {
      await db.exec(`INSERT INTO companies(id,name,slug) VALUES('1e0da55b-f8e9-4199-80b6-79c64e93cb7a','Historical demo fixture','historical-demo'); INSERT INTO restaurant_tables(id,company_id,number) VALUES('9a83e0fe-79e0-40e1-bdd5-1cfbab07752f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',1),('57be60f4-936e-42f9-ac7f-7f2049f5709f','1e0da55b-f8e9-4199-80b6-79c64e93cb7a',2);`);
    }
    const sql = (await readFile(resolve(migrationDirectory,file),'utf8'))
      .replace(/CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)[^;]*;/gi,'')
      .replace(/CREATE INDEX CONCURRENTLY/gi,'CREATE INDEX');
    await db.exec(sql);
  }
  const company='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const user='00000000-0000-4000-8000-000000000002';
  await db.query(`INSERT INTO companies(id,name,slug) VALUES($1,'Preserved company','preserved-company')`,[company]);
  await db.query(`INSERT INTO reservations(company_id,guest_name,guest_phone,date,time,status,party_size,notes) VALUES($1,'Fixture guest','11999999999','2026-10-06','18:00','confirmed',2,'Keep this business row')`,[company]);
  await db.query(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,'fixture@test.local','{}')`,[user]);
  const baselineRows=(await db.query('SELECT id,company_id,status,notes FROM reservations ORDER BY id')).rows;
  const before=(await db.query(snapshotQuery)).rows[0].snapshot;
  await mkdir(resolve(root,'supabase/.temp'),{recursive:true});
  await writeFile(resolve(root,'supabase/.temp/support-baseline-snapshot.json'),JSON.stringify(before),{mode:0o600});
  const rollback=buildRollbackSql(before);
  for (const file of ['20261006120000_add_support_role.sql','20261006121000_add_support_access_and_impersonation.sql']) {
    await db.exec(await readFile(resolve(migrationDirectory,file),'utf8'));
  }
  await db.query(`INSERT INTO user_roles(user_id,role,company_id) VALUES($1,'support',null)`,[user]);
  await assert.rejects(db.exec(rollback),/Rollback refused: support accounts exist/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query(`SELECT to_regprocedure('public.get_support_impersonation_context()') IS NOT NULL value`)).rows[0].value,true);
  assert.deepEqual((await db.query('SELECT id,company_id,status,notes FROM reservations ORDER BY id')).rows,baselineRows);
  // Remove only this test fixture's role. Production rollback never does this.
  await db.query(`DELETE FROM user_roles WHERE user_id=$1 AND role='support'`,[user]);
  await db.exec(rollback);
  const after=(await db.query(snapshotQuery)).rows[0].snapshot;
  for (const key of ['functions','policies','constraints','triggers']) assert.deepEqual(after[key],before[key],`Catalog mismatch: ${key}`);
  assert.deepEqual((await db.query('SELECT id,company_id,status,notes FROM reservations ORDER BY id')).rows,baselineRows);
  assert.equal((await db.query(`SELECT to_regclass('public.support_company_access') IS NULL AND to_regclass('public.support_impersonation_sessions') IS NULL value`)).rows[0].value,true);
  assert.equal((await db.query(`SELECT 'support'::public.app_role::text value`)).rows[0].value,'support');
  console.log(`Support rollback round-trip passed (${beforeSupport.length} real legacy migrations; exact catalog restoration, business rows preserved, support data guard verified).`);
} catch (error) {
  console.error(error.message);
  process.exitCode=1;
} finally {
  await db.close();
}
