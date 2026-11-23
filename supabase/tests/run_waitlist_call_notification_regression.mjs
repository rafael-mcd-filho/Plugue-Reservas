import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Fully offline: execute the real migration against a small PostgreSQL schema.
// There are no Supabase credentials, provider calls or live databases here.
const database = new PGlite();
let passed = 0;
const migration = await readFile(new URL('../migrations/20261122120000_waitlist_call_failures.sql', import.meta.url), 'utf8');
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const knownEvolutionFailure = JSON.stringify({ code: 'instance_disconnected', provider_status: null });

async function one(sql, params = []) { return (await database.query(sql, params)).rows[0]; }
async function state(company = companyId) { return (await one('SELECT public.get_waitlist_call_notification_state($1) AS value', [company])).value; }
async function retry(fixture, company = companyId, calledAt = fixture.calledAt) {
  return (await one('SELECT public.retry_waitlist_call_notification($1, $2, $3) AS value', [company, fixture.waitlistId, calledAt])).value;
}
async function writeLog(item, attemptAt, status, providerId = null, calledAt = item.calledAt) {
  return (await one('SELECT public.write_waitlist_call_notification_log($1,$2,$3,$4,$5) AS written', [item.queueId, calledAt, attemptAt, status, providerId])).written;
}
async function fixture(channel = 'evolution', overrides = {}) {
  await database.exec('TRUNCATE public.whatsapp_message_queue, public.pluguechat_message_queue, public.waitlist, public.automation_settings, public.pluguechat_automation_templates, public.companies CASCADE');
  await database.query('INSERT INTO public.companies(id,whatsapp_automation_channel) VALUES($1,$2),($3,$2)', [companyId, channel, otherCompanyId]);
  await database.query("INSERT INTO public.automation_settings(company_id,type,enabled) VALUES($1,'waitlist_called',true),($2,'waitlist_called',true)", [companyId, otherCompanyId]);
  await database.query("INSERT INTO public.pluguechat_automation_templates(company_id,type,enabled,template_id,template_name) VALUES($1,'waitlist_called',true,'approved-current','Current'),($2,'waitlist_called',true,'other-approved','Other')", [companyId, otherCompanyId]);
  const waitlistId = randomUUID();
  const queueId = randomUUID();
  const { called_at: calledAt } = await one("INSERT INTO public.waitlist(id,company_id,status,called_at) VALUES($1,$2,'called',now()-interval '1 minute') RETURNING called_at", [waitlistId, companyId]);
  const table = channel === 'evolution' ? 'whatsapp_message_queue' : 'pluguechat_message_queue';
  await database.query(`INSERT INTO public.${table}(id,company_id,waitlist_id,waitlist_called_at,type,status,error_details,attempts,max_attempts)
    VALUES($1,$2,$3,$4,'waitlist_called',$5,$6,3,3)`, [queueId, companyId, waitlistId, calledAt, overrides.status ?? 'failed', overrides.error ?? (channel === 'evolution' ? knownEvolutionFailure : 'HTTP 429: rate limited')]);
  if (channel === 'pluguechat_official' && overrides.providerStatus) await database.query('UPDATE public.pluguechat_message_queue SET provider_status=$1 WHERE id=$2', [overrides.providerStatus, queueId]);
  return { waitlistId, queueId, calledAt, table };
}
async function test(name, body) {
  try { await body(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

try {
  await database.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.companies(id uuid PRIMARY KEY, whatsapp_automation_channel text NOT NULL DEFAULT 'evolution', feature_enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE public.waitlist(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies(id),status text,called_at timestamptz,position integer DEFAULT 0);
    CREATE TABLE public.automation_settings(company_id uuid REFERENCES public.companies(id),type text,enabled boolean,UNIQUE(company_id,type));
    CREATE TABLE public.pluguechat_automation_templates(company_id uuid REFERENCES public.companies(id),type text,enabled boolean,template_id text NOT NULL DEFAULT '',template_name text,UNIQUE(company_id,type));
    CREATE TABLE public.whatsapp_message_queue(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies(id),type text,status text,phone text NOT NULL DEFAULT '+5511999999999',message text NOT NULL DEFAULT 'Chamada de exemplo',attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3,error_details text,scheduled_for timestamptz DEFAULT now(),expires_at timestamptz DEFAULT now()+interval '2 hours',created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX existing_whatsapp_active_phone_message ON public.whatsapp_message_queue(company_id,type,phone,(md5(message))) WHERE status IN ('pending','processing');
    CREATE TABLE public.pluguechat_message_queue(id uuid PRIMARY KEY,company_id uuid REFERENCES public.companies(id),waitlist_id uuid,type text,status text,attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3,error_details text,scheduled_for timestamptz DEFAULT now(),expires_at timestamptz DEFAULT now()+interval '2 hours',created_at timestamptz DEFAULT now(),provider_message_id text,provider_status text,provider_status_url text,provider_status_checked_at timestamptz,template_id text DEFAULT 'old-template',template_name text DEFAULT 'Old');
    ALTER TABLE public.pluguechat_message_queue ADD COLUMN last_attempt_at timestamptz, ADD COLUMN reservation_id uuid, ADD COLUMN phone text NOT NULL DEFAULT '+5511999999999', ADD COLUMN phone_e164 text, ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE public.pluguechat_message_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),queue_id uuid UNIQUE REFERENCES public.pluguechat_message_queue(id) ON DELETE SET NULL,company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,reservation_id uuid,waitlist_id uuid,phone text NOT NULL,type text NOT NULL,template_id text NOT NULL,template_name text,parameters jsonb NOT NULL DEFAULT '{}'::jsonb,status text NOT NULL,provider_message_id text,provider_status text,error_details text,created_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION public.company_feature_enabled(_company_id uuid,_feature_key text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT feature_enabled FROM public.companies WHERE id=_company_id $$;
  `);
  await database.exec(migration);
  await database.exec(migration); // Deployment replay must be safe.

  await test('RPCs and helpers cannot be called by anonymous or authenticated clients', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['get_waitlist_call_notification_state(uuid)', 'retry_waitlist_call_notification(uuid,uuid,timestamptz)', 'waitlist_call_automation_enabled(uuid,text)', 'is_retryable_waitlist_call_failure(text,text,text)', 'write_waitlist_call_notification_log(uuid,timestamptz,timestamptz,text,text)']) {
        assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, `public.${fn}`])).allowed, false);
      }
    }
    assert.equal((await one("SELECT has_function_privilege('service_role','public.retry_waitlist_call_notification(uuid,uuid,timestamptz)','EXECUTE') AS allowed")).allowed, true);
    assert.equal((await one("SELECT has_function_privilege('service_role','public.write_waitlist_call_notification_log(uuid,timestamptz,timestamptz,text,text)','EXECUTE') AS allowed")).allowed, true);
  });

  for (const channel of ['evolution', 'pluguechat_official']) {
    await test(`${channel}: persists only the entry/call failure with no raw provider details`, async () => {
      const item = await fixture(channel);
      const snapshot = await state();
      assert.equal(snapshot.company_id, companyId);
      assert.equal(snapshot.automation_enabled, true);
      assert.equal(snapshot.channel, channel);
      assert.equal(snapshot.failures.length, 1);
      assert.deepEqual(Object.keys(snapshot.failures[0]).sort(), ['called_at', 'can_retry', 'waitlist_id']);
      assert.equal(snapshot.failures[0].waitlist_id, item.waitlistId);
      assert.equal(snapshot.failures[0].can_retry, true);
      assert.equal((await state(otherCompanyId)).failures.length, 0);
    });

    await test(`${channel}: requeues the same row, preserves original call/deadline and error until worker claim`, async () => {
      const item = await fixture(channel);
      const before = await one('SELECT * FROM public.waitlist WHERE id=$1', [item.waitlistId]);
      assert.deepEqual(await retry(item), { result: 'queued', channel, queue_id: item.queueId });
      const queue = await one(`SELECT * FROM public.${item.table} WHERE id=$1`, [item.queueId]);
      assert.equal(queue.status, 'pending');
      assert.equal(queue.manual_retry_count, 1);
      assert.equal(queue.max_attempts, 4);
      assert.ok(queue.error_details);
      assert.equal(Number((await one(`SELECT count(*) AS count FROM public.${item.table}`)).count), 1);
      assert.deepEqual(await one('SELECT * FROM public.waitlist WHERE id=$1', [item.waitlistId]), before);
      assert.equal(new Date(queue.expires_at).getTime(), new Date(before.called_at).getTime() + 300000);
      assert.equal((await state()).failures[0].can_retry, false);
      await database.query(`UPDATE public.${item.table} SET status='processing',error_details=NULL WHERE id=$1`, [item.queueId]);
      assert.deepEqual((await state()).failures, []);
    });

    await test(`${channel}: repeated retry requests are serialized by the cooldown and never create another row`, async () => {
      const item = await fixture(channel);
      const replies = await Promise.all([retry(item), retry(item)]);
      assert.deepEqual(replies.map((reply) => reply.result).sort(), ['cooldown', 'queued']);
      assert.equal((await one(`SELECT manual_retry_count FROM public.${item.table} WHERE id=$1`, [item.queueId])).manual_retry_count, 1);
      await database.query(`UPDATE public.${item.table} SET last_manual_retry_at=now()-interval '31 seconds' WHERE id=$1`, [item.queueId]);
      assert.equal((await retry(item)).result, 'queued');
      assert.equal((await one(`SELECT manual_retry_count FROM public.${item.table} WHERE id=$1`, [item.queueId])).manual_retry_count, 2);
    });

    await test(`${channel}: turning the active automation off removes the warning and blocks retry`, async () => {
      const item = await fixture(channel);
      await database.query(`UPDATE public.${channel === 'evolution' ? 'automation_settings' : 'pluguechat_automation_templates'} SET enabled=false WHERE company_id=$1`, [companyId]);
      assert.equal((await state()).automation_enabled, false);
      assert.deepEqual((await state()).failures, []);
      assert.equal((await retry(item)).result, 'disabled');
      assert.equal((await one(`SELECT status FROM public.${item.table} WHERE id=$1`, [item.queueId])).status, 'failed');
    });

    await test(`${channel}: disabling the WhatsApp feature also hides the warning and blocks retry`, async () => {
      const item = await fixture(channel);
      await database.query('UPDATE public.companies SET feature_enabled=false WHERE id=$1', [companyId]);
      assert.equal((await state()).automation_enabled, false);
      assert.equal((await retry(item)).result, 'disabled');
    });

    await test(`${channel}: another company cannot reuse a known entry ID`, async () => {
      const item = await fixture(channel);
      assert.equal((await retry(item, otherCompanyId)).result, 'not_found');
      assert.equal((await one(`SELECT manual_retry_count FROM public.${item.table} WHERE id=$1`, [item.queueId])).manual_retry_count, 0);
    });

    await test(`${channel}: expired calls are hidden and cannot be revived`, async () => {
      const item = await fixture(channel);
      const { called_at } = await one("UPDATE public.waitlist SET called_at=now()-interval '6 minutes' WHERE id=$1 RETURNING called_at", [item.waitlistId]);
      await database.query(`UPDATE public.${item.table} SET waitlist_called_at=$1 WHERE id=$2`, [called_at, item.queueId]);
      assert.deepEqual((await state()).failures, []);
      assert.equal((await retry(item, companyId, called_at)).result, 'expired');
    });

    await test(`${channel}: seated/expired/removed entries never expose a retry`, async () => {
      const item = await fixture(channel);
      for (const status of ['seated', 'expired', 'removed', 'waiting']) {
        await database.query('UPDATE public.waitlist SET status=$1 WHERE id=$2', [status, item.waitlistId]);
        assert.deepEqual((await state()).failures, []);
        assert.equal((await retry(item)).result, 'not_called');
      }
    });

    await test(`${channel}: a stale call token and a previous call failure cannot affect the current call`, async () => {
      const item = await fixture(channel);
      const { called_at } = await one("UPDATE public.waitlist SET called_at=now()-interval '10 seconds' WHERE id=$1 RETURNING called_at", [item.waitlistId]);
      assert.deepEqual((await state()).failures, []);
      assert.equal((await retry(item)).result, 'not_retryable');
      assert.equal((await retry(item, companyId, called_at)).result, 'not_retryable');
    });

    await test(`${channel}: pending preflight errors can expedite the existing queue without clearing the error`, async () => {
      const item = await fixture(channel, { status: 'pending' });
      await database.query(`UPDATE public.${item.table} SET scheduled_for=now()+interval '1 minute' WHERE id=$1`, [item.queueId]);
      const oldError = (await one(`SELECT error_details FROM public.${item.table} WHERE id=$1`, [item.queueId])).error_details;
      assert.equal((await state()).failures.length, 1);
      assert.equal((await retry(item)).result, 'queued');
      assert.equal((await one(`SELECT error_details FROM public.${item.table} WHERE id=$1`, [item.queueId])).error_details, oldError);
    });

    await test(`${channel}: an already expired queue cannot be extended by a manual retry`, async () => {
      const item = await fixture(channel);
      await database.query(`UPDATE public.${item.table} SET expires_at=now()-interval '1 second' WHERE id=$1`, [item.queueId]);
      assert.equal((await state()).failures[0].can_retry, false);
      assert.equal((await retry(item)).result, 'expired');
      assert.equal((await one(`SELECT status FROM public.${item.table} WHERE id=$1`, [item.queueId])).status, 'failed');
    });

    await test(`${channel}: accepted, processing and provider-pending requests are never manually resent`, async () => {
      const item = await fixture(channel);
      for (const status of ['sent', 'processing', 'provider_queued']) {
        await database.query(`UPDATE public.${item.table} SET status=$1 WHERE id=$2`, [status, item.queueId]);
        assert.deepEqual((await state()).failures, []);
        assert.equal((await retry(item)).result, 'not_retryable');
      }
    });
  }

  await test('Evolution: rejects ambiguous network/5xx/malformed responses and accepts only explicit safe failures', async () => {
    const item = await fixture();
    const failures = [null, 'bad json', JSON.stringify({ code: 'unknown_error' }), JSON.stringify({ code: 'provider_invalid_response', provider_status: 200 }), JSON.stringify({ code: 'provider_request_failed', provider_status: 500 }), JSON.stringify({ code: 'provider_request_failed', provider_status: 408 })];
    for (const error of failures) {
      await database.query('UPDATE public.whatsapp_message_queue SET error_details=$1 WHERE id=$2', [error, item.queueId]);
      assert.deepEqual((await state()).failures, []);
      assert.equal((await retry(item)).result, 'not_retryable');
    }
    await database.query('UPDATE public.whatsapp_message_queue SET error_details=$1 WHERE id=$2', [JSON.stringify({ code: 'provider_request_failed', provider_status: 403 }), item.queueId]);
    assert.equal((await state()).failures[0].can_retry, true);
  });

  await test('Evolution: the new call index prevents a second queue row for the same call', async () => {
    const item = await fixture();
    await assert.rejects(database.query("INSERT INTO public.whatsapp_message_queue(id,company_id,waitlist_id,waitlist_called_at,type,status) VALUES($1,$2,$3,$4,'waitlist_called','pending')", [randomUUID(), companyId, item.waitlistId, item.calledAt]), /duplicate key/);
  });

  await test('Evolution: a broader existing dispatch collision blocks requeue without changing call or queue state', async () => {
    const item = await fixture();
    const competingCallId = randomUUID();
    await database.query("INSERT INTO public.waitlist(id,company_id,status,called_at) VALUES($1,$2,'called',now())", [competingCallId, companyId]);
    await database.query("INSERT INTO public.whatsapp_message_queue(id,company_id,waitlist_id,waitlist_called_at,type,status) VALUES($1,$2,$3,now(),'waitlist_called','pending')", [randomUUID(), companyId, competingCallId]);
    assert.equal((await retry(item)).result, 'not_retryable');
    const queue = await one('SELECT * FROM public.whatsapp_message_queue WHERE id=$1', [item.queueId]);
    assert.equal(queue.status, 'failed');
    assert.equal(queue.manual_retry_count, 0);
    assert.equal((await one('SELECT called_at FROM public.waitlist WHERE id=$1', [item.waitlistId])).called_at.getTime(), item.calledAt.getTime());
  });

  await test('PlugueChat: provider acceptance without an ID, expiry, unknown errors and 5xx cannot authorize retry', async () => {
    const item = await fixture('pluguechat_official');
    for (const [providerStatus, error] of [['MISSING_MESSAGE_ID', 'HTTP 400: ambiguous'], ['EXPIRED', 'HTTP 400: ambiguous'], [null, 'Network timeout'], [null, 'HTTP 500: provider error'], [null, 'HTTP 408: timeout']]) {
      await database.query('UPDATE public.pluguechat_message_queue SET provider_status=$1,error_details=$2 WHERE id=$3', [providerStatus, error, item.queueId]);
      assert.deepEqual((await state()).failures, []);
      assert.equal((await retry(item)).result, 'not_retryable');
    }
  });

  await test('PlugueChat: a known provider rejection can retry the same row while preserving evidence until the worker claims it', async () => {
    const item = await fixture('pluguechat_official', { error: 'Provider rejected the message.', providerStatus: 'REJECTED' });
    await database.query("UPDATE public.pluguechat_message_queue SET provider_message_id='old-message',provider_status_url='https://example.invalid/old',provider_status_checked_at=now() WHERE id=$1", [item.queueId]);
    assert.equal((await retry(item)).result, 'queued');
    const queue = await one('SELECT * FROM public.pluguechat_message_queue WHERE id=$1', [item.queueId]);
    assert.equal(queue.provider_message_id, 'old-message');
    assert.equal(queue.provider_status, 'REJECTED');
    assert.equal(queue.error_details, 'Provider rejected the message.');
    assert.equal(queue.template_id, 'approved-current');
    assert.equal(queue.template_name, 'Current');
    assert.equal((await state()).failures.length, 1);
    assert.equal((await state()).failures[0].can_retry, false);
  });

  await test('PlugueChat: a newer accepted queue result suppresses an older failure for the same call', async () => {
    const item = await fixture('pluguechat_official');
    await database.query("INSERT INTO public.pluguechat_message_queue(id,company_id,waitlist_id,waitlist_called_at,type,status,error_details,created_at) VALUES($1,$2,$3,$4,'waitlist_called','sent',NULL,now()+interval '1 second')", [randomUUID(), companyId, item.waitlistId, item.calledAt]);
    assert.deepEqual((await state()).failures, []);
    assert.equal((await retry(item)).result, 'not_retryable');
  });

  await test('PlugueChat: an active missing-template failure stays visible but cannot retry until an approved ID is configured', async () => {
    const item = await fixture('pluguechat_official', { error: 'Template da chamada não configurado.' });
    await database.query("UPDATE public.pluguechat_automation_templates SET template_id='' WHERE company_id=$1", [companyId]);
    assert.equal((await state()).automation_enabled, true);
    assert.equal((await state()).failures[0].can_retry, false);
    assert.equal((await retry(item)).result, 'not_retryable');
    await database.query("UPDATE public.pluguechat_automation_templates SET template_id='new-approved',template_name='New' WHERE company_id=$1", [companyId]);
    assert.equal((await state()).failures[0].can_retry, true);
    assert.equal((await retry(item)).result, 'queued');
    assert.equal((await one('SELECT template_id FROM public.pluguechat_message_queue WHERE id=$1', [item.queueId])).template_id, 'new-approved');
  });

  await test('switching channels never exposes or requeues the prior channel failure', async () => {
    const item = await fixture();
    await database.query("UPDATE public.companies SET whatsapp_automation_channel='pluguechat_official' WHERE id=$1", [companyId]);
    assert.deepEqual((await state()).failures, []);
    assert.equal((await retry(item)).result, 'not_retryable');
    assert.equal((await one('SELECT status FROM public.whatsapp_message_queue WHERE id=$1', [item.queueId])).status, 'failed');
  });

  await test('unlinked legacy failures are never guessed by telephone or leaked to a call', async () => {
    const item = await fixture();
    await database.query('UPDATE public.whatsapp_message_queue SET waitlist_id=NULL,waitlist_called_at=NULL WHERE id=$1', [item.queueId]);
    assert.deepEqual((await state()).failures, []);
    assert.equal((await retry(item)).result, 'not_retryable');
  });

  await test('PlugueChat log: current terminal attempt writes only queue-owned data, with idempotent upsert', async () => {
    const item = await fixture('pluguechat_official', { status: 'sent', error: null });
    const { last_attempt_at: attemptedAt } = await one("UPDATE public.pluguechat_message_queue SET last_attempt_at=now(),provider_message_id='current-id',provider_status='SENT',phone_e164='+442012345678',parameters='{\"nome\":\"Exemplo\"}',error_details=NULL WHERE id=$1 RETURNING last_attempt_at", [item.queueId]);
    assert.equal(await writeLog(item, attemptedAt, 'sent', 'current-id'), true);
    assert.equal(await writeLog(item, attemptedAt, 'sent', 'current-id'), true);
    const log = await one('SELECT * FROM public.pluguechat_message_logs WHERE queue_id=$1', [item.queueId]);
    assert.equal(log.company_id, companyId);
    assert.equal(log.waitlist_id, item.waitlistId);
    assert.equal(log.phone, '+442012345678');
    assert.equal(log.status, 'sent');
    assert.equal(log.provider_status, 'SENT');
    assert.equal(log.error_details, null);
    assert.deepEqual(log.parameters, { nome: 'Exemplo' });
    assert.equal(Number((await one('SELECT count(*) AS total FROM public.pluguechat_message_logs WHERE queue_id=$1', [item.queueId])).total), 1);
  });

  await test('PlugueChat log: a delayed failed result cannot overwrite a newer successful attempt/log', async () => {
    const item = await fixture('pluguechat_official', { providerStatus: 'REJECTED' });
    const { last_attempt_at: oldAttempt } = await one("UPDATE public.pluguechat_message_queue SET last_attempt_at=now()-interval '20 seconds',provider_message_id='old-id' WHERE id=$1 RETURNING last_attempt_at", [item.queueId]);
    assert.equal(await writeLog(item, oldAttempt, 'failed', 'old-id'), true);
    assert.equal((await retry(item)).result, 'queued');
    const { last_attempt_at: newAttempt } = await one("UPDATE public.pluguechat_message_queue SET status='sent',last_attempt_at=now(),provider_message_id='new-id',provider_status='SENT',error_details=NULL WHERE id=$1 RETURNING last_attempt_at", [item.queueId]);
    assert.equal(await writeLog(item, newAttempt, 'sent', 'new-id'), true);
    assert.equal(await writeLog(item, oldAttempt, 'failed', 'old-id'), false);
    const log = await one('SELECT status,provider_message_id,error_details FROM public.pluguechat_message_logs WHERE queue_id=$1', [item.queueId]);
    assert.deepEqual(log, { status: 'sent', provider_message_id: 'new-id', error_details: null });
  });

  await test('PlugueChat log: status and call/attempt nonces must still match the locked row', async () => {
    const item = await fixture('pluguechat_official');
    const { last_attempt_at: attemptedAt } = await one('UPDATE public.pluguechat_message_queue SET last_attempt_at=now() WHERE id=$1 RETURNING last_attempt_at', [item.queueId]);
    assert.equal(await writeLog(item, attemptedAt, 'sent'), false);
    assert.equal(await writeLog(item, attemptedAt, 'failed', null, new Date(item.calledAt.getTime() - 1000)), false);
    assert.equal(await writeLog(item, new Date(attemptedAt.getTime() - 1000), 'failed'), false);
    assert.equal(await writeLog(item, null, 'failed'), false);
    assert.equal(Number((await one('SELECT count(*) AS total FROM public.pluguechat_message_logs')).total), 0);
  });

  await test('PlugueChat log: a changed provider ID or requeued state rejects old log writes', async () => {
    const item = await fixture('pluguechat_official');
    const { last_attempt_at: attemptedAt } = await one("UPDATE public.pluguechat_message_queue SET last_attempt_at=now(),provider_message_id='new-id' WHERE id=$1 RETURNING last_attempt_at", [item.queueId]);
    assert.equal(await writeLog(item, attemptedAt, 'failed', 'old-id'), false);
    assert.equal(await writeLog(item, attemptedAt, 'failed'), false);
    await database.query("UPDATE public.pluguechat_message_queue SET status='pending' WHERE id=$1", [item.queueId]);
    assert.equal(await writeLog(item, attemptedAt, 'failed', 'new-id'), false);
    assert.equal(Number((await one('SELECT count(*) AS total FROM public.pluguechat_message_logs')).total), 0);
  });

  console.log(`\n${passed} PostgreSQL regression cases passed; no network or external database used.`);
} finally {
  await database.close();
}
