// Executes the real migration in an isolated, in-memory PostgreSQL. No network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const metadata = { asaas_account_scope: 'platform', asaas_account_id: 'wallet-1', asaas_environment: 'production' };
const migration = await readFile(new URL('../migrations/20261107120000_add_central_reservation_asaas_config.sql', import.meta.url), 'utf8');
try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.reservation_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), metadata jsonb NOT NULL DEFAULT '{}', status text DEFAULT 'pending');
    CREATE TABLE public.reservation_payment_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.asaas_webhook_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON public.reservation_payments, public.reservation_payment_events, public.asaas_webhook_events TO anon, authenticated, service_role;
    ALTER TABLE public.reservation_payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Company admins can update reservation payments" ON public.reservation_payments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
    CREATE POLICY "Staff can read payments" ON public.reservation_payments FOR SELECT TO authenticated USING (true);
  `);
  await db.exec(migration);
  const row = (await db.query('SELECT * FROM public.platform_reservation_asaas_config')).rows[0];
  assert.equal(row.status, 'not_configured');
  assert.equal(row.webhook_auth_token.length, 64);
  const lease1 = '00000000-0000-4000-8000-000000000001';
  const lease2 = '00000000-0000-4000-8000-000000000002';
  const claim = async (lease) => (await db.query('SELECT public.claim_central_reservation_asaas_config($1,$2) AS claimed', [row.revision, lease])).rows[0].claimed;
  const release = async (lease) => (await db.query('SELECT public.release_central_reservation_asaas_config($1) AS released', [lease])).rows[0].released;
  assert.equal(await claim(lease1), true);
  assert.equal(await claim(lease2), false, 'a concurrent save cannot provision a second webhook');
  assert.equal(await release(lease2), false, 'another request cannot release the first lease');
  assert.equal(await release(lease1), true);
  assert.equal(await claim(lease2), true);
  await db.exec("UPDATE public.platform_reservation_asaas_config SET provisioning_lease_until = now() - interval '1 minute'");
  assert.equal(await claim(lease1), true, 'a crashed provisioner cannot block configuration forever');
  assert.equal(await release(lease1), true);
  await db.exec("UPDATE public.platform_reservation_asaas_config SET provider_account_id = 'wallet-1', api_token_encrypted = 'ciphertext', status = 'configured'");

  // Matching central scope is mandatory; legacy rows still retain old accounts.
  await db.query('INSERT INTO public.reservation_payments(metadata) VALUES ($1)', [{}]);
  await assert.rejects(db.query('INSERT INTO public.reservation_payments(metadata) VALUES ($1)', [{ ...metadata, asaas_account_id: 'another-account' }]), /outra conta ou ambiente/);
  await assert.rejects(db.query('INSERT INTO public.reservation_payments(metadata) VALUES ($1)', [{ ...metadata, asaas_environment: 'sandbox' }]), /outra conta ou ambiente/);
  await assert.rejects(db.query('INSERT INTO public.reservation_payments(metadata) VALUES ($1)', [{ asaas_account_scope: 'platform' }]), /outra conta ou ambiente/);
  await db.query('INSERT INTO public.reservation_payments(metadata) VALUES ($1)', [metadata]);

  // Credential rotation for the same wallet is allowed. Account/environment
  // switches are rejected while any central financial history exists.
  await db.exec("UPDATE public.platform_reservation_asaas_config SET api_token_encrypted = 'rotated-ciphertext'");
  await assert.rejects(db.exec("UPDATE public.platform_reservation_asaas_config SET provider_account_id = 'wallet-2'"), /não podem mudar/);
  await assert.rejects(db.exec("UPDATE public.platform_reservation_asaas_config SET api_environment = 'sandbox'"), /não podem mudar/);
  assert.equal((await db.query('SELECT api_token_encrypted FROM public.platform_reservation_asaas_config')).rows[0].api_token_encrypted, 'rotated-ciphertext');

  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM public.platform_reservation_asaas_config'), /permission denied/);
    await assert.rejects(claim(lease1), /permission denied/);
    await assert.rejects(release(lease1), /permission denied/);
    await assert.rejects(db.exec("UPDATE public.reservation_payments SET status = 'paid'"), /permission denied/);
    await assert.rejects(db.exec('INSERT INTO public.reservation_payments DEFAULT VALUES'), /permission denied/);
    await assert.rejects(db.exec('DELETE FROM public.reservation_payments'), /permission denied/);
    for (const table of ['reservation_payment_events', 'asaas_webhook_events']) {
      await assert.rejects(db.exec(`INSERT INTO public.${table} DEFAULT VALUES`), /permission denied/);
    }
    if (role === 'authenticated') assert.equal((await db.query('SELECT count(*)::int AS total FROM public.reservation_payments')).rows[0].total, 2);
    await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE service_role');
  assert.equal(await claim(lease1), true, 'the service role may serialize webhook provisioning');
  assert.equal(await release(lease1), true);
  assert.equal((await db.query('SELECT count(*)::int AS total FROM public.platform_reservation_asaas_config')).rows[0].total, 1);
  await db.exec("UPDATE public.reservation_payments SET status = 'paid'");
  await db.exec('RESET ROLE');
  assert.equal((await db.query("SELECT count(*)::int AS total FROM public.reservation_payments WHERE status = 'paid'")).rows[0].total, 2);
  console.log('Central reservation Asaas SQL regression passed: migration, scope guards, rotation, RLS and financial write ACLs.');
} finally {
  await db.close();
}
