import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Fully offline: check that the contracted environment survives operational
// changes while retaining the tracking code and device rate-limit boundaries.
const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE reservations (
      id uuid PRIMARY KEY, company_id uuid, guest_name text, date date, time time,
      party_size integer, status text, occasion text, notes text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      public_tracking_code text, selected_section_id uuid, selected_section_name text
    );
    CREATE TABLE public_rate_limits(scope text,company_id uuid,identifier text,created_at timestamptz DEFAULT now());
    CREATE TABLE reservation_reviews(reservation_id uuid,review_token text,status text,expires_at timestamptz);
    INSERT INTO reservations(id,company_id,guest_name,date,time,party_size,status,public_tracking_code,selected_section_id,selected_section_name)
    VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','Cliente','2030-01-01','18:00',2,'confirmed','secret-code','33333333-3333-4333-8333-333333333333','Sacada Premium');
    INSERT INTO reservation_reviews VALUES('11111111-1111-4111-8111-111111111111','review-code','pending',now()+interval '1 day');
  `);
  const sql = await readFile(new URL('../migrations/20261124121000_expose_contracted_reservation_section.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  await db.exec('SET ROLE anon');
  const lookup = (code, visitor = 'visitor-one') => db.query('SELECT * FROM get_public_reservation_by_tracking_code($1,$2)', [code, visitor]);
  const { rows } = await lookup(' SECRET-CODE ');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].selected_section_name, 'Sacada Premium');
  assert.equal(rows[0].selected_section_id, '33333333-3333-4333-8333-333333333333');
  assert.equal(rows[0].review_token, 'review-code');
  assert.equal(rows[0].review_status, 'pending');
  assert.equal((await lookup('other-code')).rows.length, 0);
  await assert.rejects(() => lookup(' '), /Codigo de acompanhamento invalido/);
  for (let i = 1; i < 60; i += 1) await lookup('secret-code');
  await assert.rejects(() => lookup('secret-code'), /Muitas consultas deste dispositivo/);
  assert.equal((await lookup('secret-code', 'another-visitor')).rows[0].selected_section_name, 'Sacada Premium');
  await db.exec('RESET ROLE');
  await db.exec("UPDATE reservations SET status='completed'");
  assert.equal((await lookup('secret-code', 'another-visitor')).rows[0].selected_section_name, 'Sacada Premium');
  console.log('Reservation section tracking regression passed (offline PostgreSQL).');
} finally {
  await db.close();
}
