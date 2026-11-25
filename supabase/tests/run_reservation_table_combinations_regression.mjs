import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Local PostgreSQL only. Exercise the real planner and table-conflict helper;
// no credentials, remote queries or reservation/business side effects.
const db = new PGlite();
const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherCompany = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const map = '10000000-0000-4000-8000-000000000001';
const otherMap = '10000000-0000-4000-8000-000000000002';
const normal = '20000000-0000-4000-8000-000000000001';
const premium = '20000000-0000-4000-8000-000000000002';
const foreignSection = '20000000-0000-4000-8000-000000000003';
const day = '2030-12-31';
const tableId = (number) => `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const reservationId = '40000000-0000-4000-8000-000000000001';
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
let cases = 0;

async function tables(rows) {
  await db.exec('TRUNCATE reservation_table_assignments, reservations, restaurant_tables');
  for (const [number, capacity, section = 'normal', status = 'available', tableMap = map, tableCompany = company] of rows) {
    await db.query('INSERT INTO restaurant_tables(id,company_id,table_map_id,number,capacity,section,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [tableId(number), tableCompany, tableMap, number, capacity, section, status]);
  }
}
async function choose(size, options = {}) {
  return scalar('SELECT pick_best_fit_reservation_tables($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value', [
    options.company ?? company, day, options.time ?? '21:00', options.duration ?? 60, size,
    Object.hasOwn(options, 'map') ? options.map : map,
    options.exclude ?? null, options.section ?? null, options.required ?? null,
  ]);
}
async function expectTables(size, expected, options = {}) {
  assert.deepEqual(await choose(size, options), expected.map(tableId)); cases++;
}

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE restaurant_tables(id uuid PRIMARY KEY,company_id uuid,table_map_id uuid,
      number integer,capacity integer,section text,status text);
    CREATE TABLE table_sections(id uuid PRIMARY KEY,company_id uuid,code text);
    CREATE TABLE reservations(id uuid PRIMARY KEY,company_id uuid,date date,time time,party_size integer,
      duration_minutes integer,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE reservation_table_assignments(reservation_id uuid,table_id uuid);
    CREATE FUNCTION is_reservation_occupying_capacity(uuid,text,timestamptz) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT $2 IN ('confirmed','checked_in') $$;
    INSERT INTO table_sections VALUES('${normal}','${company}','normal'),('${premium}','${company}','premium'),
      ('${foreignSection}','${otherCompany}','normal');
  `);
  const conflictMigration = await readFile(new URL('../migrations/20260919120000_add_multi_table_reservation_assignments.sql', import.meta.url), 'utf8');
  const start = conflictMigration.indexOf('CREATE OR REPLACE FUNCTION public.reservation_table_conflict_id(');
  const end = conflictMigration.indexOf('$$;', start);
  assert(start >= 0 && end > start);
  await db.exec(conflictMigration.slice(start, end + 3));
  const migration = await readFile(new URL('../migrations/20261124130000_reservation_table_combinations.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // Replacement and ACLs are safe on migration replay.

  await tables([[1, 2], [2, 4], [3, 4], [4, 4]]);
  await expectTables(2, [1]);
  await expectTables(8, [2, 3]);
  await tables([[1, 4], [2, 4]]);
  await expectTables(9, []);
  await tables([[1, 4], [2, 4], [3, 4]]);
  await expectTables(9, [1, 2, 3]);
  await tables([[1, 10], [2, 4], [3, 5]]);
  await expectTables(9, [2, 3]);
  await tables([[1, 8], [2, 4], [3, 4]]);
  await expectTables(8, [1]);
  await tables([[2, 4], [10, 4], [3, 4], [11, 4]]);
  await expectTables(8, [2, 3]); // Numeric ordering, not lexical "10" before "2".

  await tables([[1, 4, 'normal'], [2, 4, 'premium']]);
  await expectTables(8, []);
  await tables([[1, 4, 'normal'], [2, 4, 'normal'], [3, 8, 'premium']]);
  await expectTables(8, [3]);
  await expectTables(8, [1, 2], { section: normal });
  await expectTables(8, [3], { section: premium });
  await expectTables(4, [], { section: foreignSection });
  await tables([[1, 4], [2, 4, 'normal', 'maintenance'], [3, 4, 'normal', 'available', otherMap],
    [4, 4, 'normal', 'available', map, otherCompany]]);
  await expectTables(8, []);
  await expectTables(4, [], { map: null });

  await tables([[1, 4], [2, 4], [3, 4], [10, 4, 'premium']]);
  await db.query(`INSERT INTO reservations(id,company_id,date,time,party_size,duration_minutes,status)
    VALUES($1,$2,$3,'20:30',8,60,'confirmed')`, [reservationId, company, day]);
  await db.query('INSERT INTO reservation_table_assignments VALUES($1,$2),($1,$3)', [reservationId, tableId(1), tableId(2)]);
  await expectTables(8, []); // Both the primary and secondary assigned tables conflict.
  await expectTables(8, [1, 2], { exclude: reservationId });
  await expectTables(8, [1, 2], { time: '21:30' }); // End is exclusive.
  await expectTables(8, [], { required: tableId(1) });
  await expectTables(8, [], { required: tableId(10), section: normal });

  await tables([[1, 2], [2, 4], [3, 4], [10, 4, 'premium']]);
  await expectTables(6, [2, 1], { required: tableId(2) });
  await expectTables(2, [2], { required: tableId(2) });
  await expectTables(8, [], { required: tableId(10) });
  await expectTables(6, [], { required: tableId(99) });
  await expectTables(0, []);
  await expectTables(10001, []);

  await tables(Array.from({ length: 43 }, (_, index) => [index + 1, 4, index < 33 ? 'normal' : 'premium']));
  await expectTables(40, Array.from({ length: 10 }, (_, index) => index + 1), { section: normal });
  await expectTables(40, Array.from({ length: 10 }, (_, index) => index + 34), { section: premium });
  await expectTables(41, [], { section: premium });
  await expectTables(45, Array.from({ length: 12 }, (_, index) => index + 1), { section: normal });

  // Small exhaustive oracles catch pruning/tie-break errors without duplicating
  // the dynamic-programming implementation used by the production planner.
  let seed = 20261231;
  const random = (limit) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % limit);
  const compareNumbers = (left, right) => {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
  };
  for (let iteration = 0; iteration < 40; iteration++) {
    const rows = Array.from({ length: 7 }, (_, index) => [index + 1, 1 + random(7),
      random(2) ? 'normal' : 'premium', random(7) === 0 ? 'maintenance' : 'available']);
    const size = 1 + random(18);
    const requiredNumber = iteration % 4 === 0 ? 1 + random(rows.length) : null;
    const candidates = [];
    for (let mask = 1; mask < 2 ** rows.length; mask++) {
      const selected = rows.filter((_, index) => mask & (1 << index));
      const capacity = selected.reduce((sum, row) => sum + row[1], 0);
      if (capacity < size || selected.some(row => row[3] !== 'available')
        || new Set(selected.map(row => row[2])).size !== 1
        || requiredNumber && !selected.some(row => row[0] === requiredNumber)) continue;
      const numbers = selected.map(row => row[0]);
      if (requiredNumber) numbers.sort((a, b) => a === requiredNumber ? -1 : b === requiredNumber ? 1 : a - b);
      candidates.push({ numbers, capacity });
    }
    candidates.sort((a, b) => a.capacity - b.capacity || a.numbers.length - b.numbers.length
      || compareNumbers(a.numbers, b.numbers));
    await tables(rows);
    await expectTables(size, candidates[0]?.numbers ?? [], requiredNumber ? { required: tableId(requiredNumber) } : {});
  }

  const signature = 'public.pick_best_fit_reservation_tables(uuid,date,time,integer,integer,uuid,uuid,uuid,uuid)';
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await scalar('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS value', [role, signature]), false); cases++;
  }
  assert.equal(await scalar('SELECT has_function_privilege(\'service_role\',$1,\'EXECUTE\') AS value', [signature]), true); cases++;
  assert.equal(await scalar('SELECT provolatile=\'s\' AND prosecdef AS value FROM pg_proc WHERE oid=$1::regprocedure', [signature]), true); cases++;

  console.log(JSON.stringify({ passed: cases, planner: 'same-environment complete table combinations', migrationReplay: true }));
} finally {
  await db.close();
}
