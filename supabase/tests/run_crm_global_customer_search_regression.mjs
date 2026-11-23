import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';

// Busca de clientes da busca global (search_crm_leads) e ficha do cliente contra o
// cálculo completo da tela Clientes, com as definições de produção de 23/11/2026
// (migrações 20261123140000 e 20261123150000). Banco em memória, sem rede, chaves
// ou acesso a banco externo.
const db = new PGlite();
const load = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const companyBig = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const userA = '00000000-0000-4000-8000-00000000000a';
const userNoLeads = '00000000-0000-4000-8000-00000000000b';
let passed = 0;
let roleSet = false;
let seed = 20261123;

function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (values) => values[Math.floor(random() * values.length)];
const digits = (length) => Array.from({ length }, () => Math.floor(random() * 10)).join('');
let uuidCounter = 0;
function uuid() {
  uuidCounter += 1;
  return `10000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

async function rows(sql, values = []) { return (await db.query(sql, values)).rows; }
async function one(sql, values = []) { return (await rows(sql, values))[0]; }
async function owner() { if (roleSet) { await db.exec('RESET ROLE'); roleSet = false; } }
async function actor(user = userA, role = 'authenticated') {
  await owner();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role',$2,false)", [user ?? '', role]);
  await db.exec(`SET ROLE ${role}`);
  roleSet = true;
}
async function test(name, body) {
  try { await body(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
async function insert(table, row) {
  const keys = Object.keys(row);
  await db.query(
    `INSERT INTO public.${table}(${keys.join(',')}) VALUES(${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  );
  return row;
}
async function search(companyId, term, page = 1, pageSize = 10) {
  return (await one('SELECT public.search_crm_leads($1,$2,$3,$4) AS result', [companyId, term, page, pageSize])).result;
}
async function searchError(args, role = 'authenticated', user = userA) {
  await actor(user, role);
  try {
    await db.query('SELECT public.search_crm_leads($1,$2,$3,$4)', args);
    return null;
  } catch (error) {
    return error;
  } finally {
    await owner();
  }
}

// Mesmo filtro final de search_crm_leads, aplicado sobre o cálculo completo de produção.
const PHONE_LIKE = /^\+?[0-9\s().-]+$/;
async function oracle(companyId, term) {
  const text = term.trim().toLowerCase();
  const searchDigits = PHONE_LIKE.test(text) ? text.replace(/\D/g, '') || null : null;
  const wasActor = roleSet;
  await owner();
  const keys = (await rows(`
    SELECT profiles.customer_key
    FROM public._get_crm_lead_profiles($1) AS profiles
    WHERE position($2 IN lower(COALESCE(profiles.latest_name, ''))) > 0
      OR position($2 IN lower(COALESCE(profiles.latest_email, ''))) > 0
      OR position($2 IN lower(COALESCE(profiles.display_phone, ''))) > 0
      OR ($3::text IS NOT NULL AND (
        position($3 IN COALESCE(profiles.phone_normalized, '')) > 0
        OR position($3 IN regexp_replace(COALESCE(profiles.display_phone, ''), '\\D', '', 'g')) > 0))
    ORDER BY profiles.canonical_visit_count DESC, profiles.first_seen_at DESC, profiles.customer_key
  `, [companyId, text, searchDigits])).map((row) => row.customer_key);
  if (wasActor) await actor();
  return keys;
}
async function allPages(companyId, term, pageSize) {
  const keys = [];
  for (let page = 1; page < 500; page += 1) {
    const result = await search(companyId, term, page, pageSize);
    assert.equal(result.meta.page, page);
    assert.equal(result.meta.page_size, pageSize);
    assert.ok(result.leads.length <= pageSize);
    keys.push(...result.leads.map((lead) => lead.customer_key));
    if (!result.meta.has_more) return keys;
    assert.equal(result.leads.length, pageSize, 'página cheia antes de "carregar mais"');
  }
  throw new Error('paginação sem fim');
}

async function profileSampleKeys(companyId) {
  await owner();
  const keys = (await rows('SELECT customer_key FROM public._get_crm_lead_profiles($1) ORDER BY customer_key', [companyId]))
    .map((row) => row.customer_key);
  const chosen = keys.filter((key, index) => !key.startsWith('phone:') || index % 4 === 0);
  return [...chosen, 'phone:5562900000000', 'email:ninguem@exemplo.com', 'contact:reservation_holder:00000000-0000-4000-8000-000000000999'];
}
async function profileCall(sql, values) {
  try {
    const result = (await one(sql, values)).result;
    const { generated_at: _generated, meta, ...rest } = result;
    return { ok: true, ...rest, ...(meta ? { meta: { ...meta, generated_at: undefined } } : {}) };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}
async function profileSnapshots(companyId, keys) {
  await actor();
  const snapshots = {};
  for (const key of keys) {
    const entry = {};
    for (const section of ['summary', 'reservations', 'payments', 'messages']) {
      entry[section] = await profileCall('SELECT public.get_company_crm_relationship($1,$2,$3,1,25) AS result', [companyId, key, section]);
    }
    entry.presences = await profileCall('SELECT public.get_crm_lead_presence_history($1,$2,1,50) AS result', [companyId, key]);
    snapshots[key] = entry;
  }
  await owner();
  return snapshots;
}

const FIRST = ['Rafael', 'Rafaela', 'Ana', 'Mariana', 'Juliana', 'Bruno', 'Gabriel', 'Luana', 'Carlos', 'Fernanda', 'João', 'Lúcia', 'Pedro', 'Sofia', 'Thiago', 'Bianca'];
const LAST = ['Silva', 'Souza', 'Almeida', 'Campos', 'Lima', 'Rocha', 'Costa', 'Pereira', 'Oliveira', 'Rafaeli', 'Santos', 'Moura'];
const DDD = ['62', '64', '11', '21', '61', '31'];

function brazilianPhone() {
  const ddd = pick(DDD);
  const number = `9${digits(8)}`;
  const style = Math.floor(random() * 4);
  if (style === 0) return { phone: `+55${ddd}${number}`, e164: `+55${ddd}${number}` };
  if (style === 1) return { phone: `(${ddd}) ${number.slice(0, 5)}-${number.slice(5)}`, e164: null };
  if (style === 2) return { phone: `${ddd}${number}`, e164: null };
  return { phone: `+55 ${ddd} ${number.slice(0, 5)}-${number.slice(5)}`, e164: `+55${ddd}${number}` };
}

async function seedSmallCompany(companyId) {
  const base = { company_id: companyId, guest_phone_country: 'BR' };
  const reservation = (values) => insert('reservations', {
    id: uuid(), ...base, guest_name: 'Sem nome', guest_phone: '', guest_phone_e164: null, guest_email: null,
    date: '2026-10-01', time: '20:00', status: 'confirmed', party_size: 2, created_at: '2026-09-20T12:00:00Z', ...values,
  });
  // Mesmo telefone em várias reservas; a mais recente define o nome.
  const rafael = await reservation({ guest_name: 'Rafael Almeida', guest_phone: '+5562991312333', guest_phone_e164: '+5562991312333', date: '2026-10-02', status: 'checked_in', checked_in_at: '2026-10-02T23:10:00Z' });
  await reservation({ guest_name: 'Rafael A.', guest_phone: '(62) 99131-2333', date: '2026-11-08', time: '21:00', status: 'checked_in', checked_in_at: '2026-11-09T00:05:00Z' });
  await reservation({ guest_name: 'Rafa Sousa', guest_phone: '(62) 99999-0158', date: '2026-11-07', status: 'checked_in' });
  await reservation({ guest_name: 'Rafael Sousa', guest_phone: '62999990158', date: '2026-08-01' });
  await reservation({ guest_name: 'Samuel Rafael Campos', guest_phone: '(62) 98578-7503', date: '2026-11-07', time: '21:00', status: 'checked_in' });
  await reservation({ guest_name: 'Rafael Zero', guest_phone: '(062) 98111-2222', date: '2026-07-01', status: 'no-show' });
  await reservation({ guest_name: 'Rafael Fixo', guest_phone: '(62) 3241-1234', date: '2026-06-01', status: 'cancelled' });
  await reservation({ guest_name: 'John Rafael', guest_phone: '+1 415 555 0100', guest_phone_e164: '+14155550100', guest_phone_country: 'US', date: '2026-05-01', status: 'checked_in' });
  await reservation({ guest_name: 'Rafael Portugal', guest_phone: '912 345 678', guest_phone_country: 'PT', date: '2026-05-02' });
  await reservation({ guest_name: 'Maria Email', guest_phone: '', guest_email: '  Maria.Rafael@Example.com ', date: '2026-04-01' });
  await reservation({ guest_name: 'Maria E.', guest_phone: '', guest_email: 'maria.rafael@example.com', date: '2026-04-15', status: 'checked_in' });
  await reservation({ guest_name: 'Sem Contato Rafael', guest_phone: '', date: '2026-03-01' });
  await reservation({ guest_name: 'Curto', guest_phone: '12345', date: '2026-03-02' });
  const holder = await reservation({ guest_name: 'Bruno Titular', guest_phone: '+5564988887777', guest_phone_e164: '+5564988887777', date: '2026-09-09', status: 'checked_in' });
  await insert('reservation_companions', { id: uuid(), reservation_id: holder.id, company_id: companyId, position: 1, name: 'Rafaela Lima', phone: '+5562977776666', phone_e164: '+5562977776666', phone_country: 'BR', email: 'rafaela@lima.com', created_at: '2026-09-01T10:00:00Z' });
  await insert('reservation_companions', { id: uuid(), reservation_id: holder.id, company_id: companyId, position: 2, name: 'Acompanhante Sem Telefone Rafael', phone: null, phone_e164: null, phone_country: 'BR', email: null, created_at: '2026-09-01T10:00:00Z' });
  // Fila: sentada, sentada já ligada a reserva com check-in e esperando (fora do CRM).
  const seated = await insert('waitlist', { id: uuid(), company_id: companyId, guest_name: 'Rafael Fila', guest_phone: '(62) 98222-3333', guest_phone_e164: null, guest_phone_country: 'BR', status: 'seated', created_at: '2026-10-10T22:00:00Z', seated_at: '2026-10-10T22:30:00Z' });
  await insert('waitlist_companions', { id: uuid(), waitlist_id: seated.id, company_id: companyId, position: 1, name: 'Ana Fila Companhia', phone: '62 98444-5555', phone_country: 'BR', created_at: '2026-10-10T22:00:00Z' });
  const linked = await insert('waitlist', { id: uuid(), company_id: companyId, guest_name: 'Rafael Fila Ligada', guest_phone: '+5562971112222', guest_phone_e164: '+5562971112222', guest_phone_country: 'BR', status: 'seated', created_at: '2026-10-11T22:00:00Z', seated_at: '2026-10-11T22:20:00Z' });
  await reservation({ guest_name: 'Reserva Da Fila', guest_phone: '+5562971112222', guest_phone_e164: '+5562971112222', origin_waitlist_id: linked.id, date: '2026-10-11', status: 'checked_in' });
  await insert('waitlist', { id: uuid(), company_id: companyId, guest_name: 'Rafael Esperando', guest_phone: '(62) 90000-1111', guest_phone_country: 'BR', status: 'waiting', created_at: '2026-11-01T22:00:00Z' });
  // Importações: só importado, edição manual de um cliente e importação com e-mail.
  await insert('crm_leads', { id: uuid(), company_id: companyId, full_name: 'Rafael Importado', phone: '62 99876-5432', phone_country: 'BR', phone_normalized: '5562998765432', source: 'import', imported_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-01T10:00:00Z' });
  const rafaelKey = (await one("SELECT customer_key FROM public._get_crm_contact_records($1) WHERE visit_id=$2", [companyId, rafael.id])).customer_key;
  await insert('reservation_payments', { id: uuid(), reservation_id: rafael.id, company_id: companyId, status: 'paid', billing_type: 'PIX', base_amount: 50, charged_amount: 51.5, paid_at: '2026-10-01T12:00:00Z', created_at: '2026-10-01T11:00:00Z' });
  await insert('whatsapp_message_logs', { id: uuid(), company_id: companyId, phone: '5562991312333', type: 'confirmation', status: 'sent', message: 'Olá', reservation_id: rafael.id, created_at: '2026-10-01T11:05:00Z' });
  await insert('pluguechat_message_logs', { id: uuid(), company_id: companyId, phone: '(62) 99131-2333', type: 'reminder', status: 'sent', provider_status: 'delivered', template_name: 'lembrete', reservation_id: rafael.id, created_at: '2026-10-02T11:05:00Z' });
  await insert('crm_leads', { id: uuid(), company_id: companyId, full_name: 'Rafael Almeida Editado', phone: '+5562933334444', phone_e164: '+5562933334444', phone_country: 'BR', source: 'manual_edit', profile_customer_key: rafaelKey, imported_at: '2026-11-20T10:00:00Z', created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' });
  await insert('crm_leads', { id: uuid(), company_id: companyId, full_name: null, email: 'Importado.Email@Rafael.com', email_normalized: 'importado.email@rafael.com', source: 'import', imported_at: '2026-02-01T10:00:00Z', created_at: '2026-02-01T10:00:00Z', updated_at: '2026-02-01T10:00:00Z' });
  await insert('crm_leads', { id: uuid(), company_id: companyId, full_name: 'Lead Sem Contato', source: 'import', imported_at: '2026-02-02T10:00:00Z', created_at: '2026-02-02T10:00:00Z', updated_at: '2026-02-02T10:00:00Z' });

  // Clientes variados, com telefones repetidos entre reservas, acompanhantes e fila.
  const phones = Array.from({ length: 90 }, brazilianPhone);
  for (let index = 0; index < 260; index += 1) {
    const contact = random() < 0.85 ? pick(phones) : { phone: '', e164: null };
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const email = random() < 0.3 ? `${name.split(' ')[0].toLowerCase()}${index}@mail.com` : null;
    const day = String(1 + Math.floor(random() * 28)).padStart(2, '0');
    const month = String(1 + Math.floor(random() * 11)).padStart(2, '0');
    const status = pick(['confirmed', 'checked_in', 'checked_in', 'cancelled', 'no-show', 'completed']);
    if (random() < 0.75) {
      const row = await reservation({ guest_name: name, guest_phone: contact.phone, guest_phone_e164: contact.e164, guest_email: email, date: `2026-${month}-${day}`, time: pick(['18:00', '19:30', '21:00']), status, created_at: `2026-${month}-01T10:00:00Z` });
      if (random() < 0.3) {
        const companion = random() < 0.7 ? pick(phones) : { phone: null, e164: null };
        await insert('reservation_companions', { id: uuid(), reservation_id: row.id, company_id: companyId, position: 1, name: `${pick(FIRST)} ${pick(LAST)}`, phone: companion.phone, phone_e164: companion.e164, phone_country: 'BR', email: null, created_at: `2026-${month}-01T10:00:00Z` });
      }
    } else {
      const row = await insert('waitlist', { id: uuid(), company_id: companyId, guest_name: name, guest_phone: contact.phone, guest_phone_e164: contact.e164, guest_phone_country: 'BR', guest_email: email, status: pick(['seated', 'seated', 'expired', 'removed']), created_at: `2026-${month}-${day}T22:00:00Z`, seated_at: `2026-${month}-${day}T22:30:00Z` });
      if (random() < 0.3) {
        const companion = pick(phones);
        await insert('waitlist_companions', { id: uuid(), waitlist_id: row.id, company_id: companyId, position: 1, name: `${pick(FIRST)} ${pick(LAST)}`, phone: companion.phone, phone_e164: companion.e164, phone_country: 'BR', created_at: `2026-${month}-${day}T22:00:00Z` });
      }
    }
  }
  for (let index = 0; index < 25; index += 1) {
    const contact = random() < 0.5 ? pick(phones) : brazilianPhone();
    await insert('crm_leads', { id: uuid(), company_id: companyId, full_name: `${pick(FIRST)} ${pick(LAST)} Importado`, phone: contact.phone, phone_e164: contact.e164, phone_country: 'BR', source: 'import', imported_at: `2026-0${1 + (index % 9)}-05T10:00:00Z`, created_at: `2026-0${1 + (index % 9)}-05T10:00:00Z`, updated_at: `2026-0${1 + (index % 9)}-05T10:00:00Z` });
  }
}

async function seedBigCompany(companyId, count) {
  // Volume para medir: muitas reservas com telefones distintos, poucos "Rafael".
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const phone = `+55${pick(DDD)}9${digits(8)}`;
    const name = index % 400 === 0 ? `Rafael ${pick(LAST)}` : `${pick(FIRST.filter((value) => !value.startsWith('Rafael')))} ${pick(LAST.filter((value) => value !== 'Rafaeli'))}`;
    values.push(`('${uuid()}','${companyId}','${name}','${phone}','${phone}','BR','2026-10-${String(1 + (index % 28)).padStart(2, '0')}','20:00','${index % 3 === 0 ? 'checked_in' : 'confirmed'}',2,'2026-09-01T10:00:00Z')`);
  }
  await db.exec(`INSERT INTO public.reservations(id,company_id,guest_name,guest_phone,guest_phone_e164,guest_phone_country,date,time,status,party_size,created_at) VALUES ${values.join(',')}`);
}

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
    CREATE TABLE public.companies(id uuid PRIMARY KEY, time_zone text NOT NULL DEFAULT 'America/Sao_Paulo');
    CREATE TABLE public.test_permissions(user_id uuid, company_id uuid, permission text);
    CREATE FUNCTION public.effective_auth_uid(_company_id uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;
    CREATE FUNCTION public.has_company_panel_permission(_user_id uuid, _company_id uuid, _permission text) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.test_permissions WHERE user_id = _user_id AND company_id = _company_id AND permission = _permission)
    $$;
    CREATE TABLE public.reservations(
      id uuid PRIMARY KEY, company_id uuid NOT NULL, guest_name text NOT NULL, guest_phone text NOT NULL DEFAULT '',
      guest_phone_e164 text, guest_phone_country text NOT NULL DEFAULT 'BR', guest_email text, guest_birthdate date,
      date date NOT NULL, time time NOT NULL, checked_in_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      party_size integer NOT NULL DEFAULT 2, checked_in_party_size integer, status text NOT NULL DEFAULT 'confirmed',
      occasion text, origin_waitlist_id uuid, source text NOT NULL DEFAULT 'reservation'
    );
    CREATE TABLE public.reservation_payments(
      id uuid PRIMARY KEY, reservation_id uuid NOT NULL, company_id uuid NOT NULL, status text, billing_type text,
      base_amount numeric, charged_amount numeric, paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.whatsapp_message_logs(
      id uuid PRIMARY KEY, company_id uuid NOT NULL, phone text, type text, status text, message text,
      reservation_id uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.pluguechat_message_logs(
      id uuid PRIMARY KEY, company_id uuid NOT NULL, phone text, type text, status text, provider_status text,
      template_name text, reservation_id uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.has_role_in_company(_user_id uuid, _role text, _company_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.test_permissions WHERE user_id = _user_id AND company_id = _company_id AND permission = 'role:' || _role)
    $$;
    CREATE TABLE public.reservation_companions(
      id uuid PRIMARY KEY, reservation_id uuid NOT NULL, company_id uuid, position integer NOT NULL DEFAULT 1, name text,
      phone text, phone_e164 text, phone_country text DEFAULT 'BR', email text, birthdate date, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.waitlist(
      id uuid PRIMARY KEY, company_id uuid NOT NULL, guest_name text NOT NULL, guest_phone text NOT NULL DEFAULT '',
      guest_phone_e164 text, guest_phone_country text DEFAULT 'BR', guest_email text, guest_birthdate date, status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), seated_at timestamptz, party_size integer NOT NULL DEFAULT 2, seated_party_size integer
    );
    CREATE TABLE public.waitlist_companions(
      id uuid PRIMARY KEY, waitlist_id uuid NOT NULL, company_id uuid, position integer NOT NULL DEFAULT 1, name text,
      phone text, phone_e164 text, phone_country text DEFAULT 'BR', email text, birthdate date, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.crm_leads(
      id uuid PRIMARY KEY, company_id uuid NOT NULL, full_name text, phone text, phone_e164 text, phone_country text DEFAULT 'BR',
      phone_normalized text, email text, email_normalized text, birthdate date, notes text, imported_at timestamptz NOT NULL DEFAULT now(),
      imported_by_user_id uuid, import_filename text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      source text, profile_customer_key text
    );
    CREATE INDEX ON public.reservations(company_id);
    CREATE INDEX ON public.reservations(origin_waitlist_id);
    CREATE INDEX ON public.waitlist(company_id, status);
  `);
  await db.exec('SET check_function_bodies = off');
  await db.exec(await load('./crm_search_production_functions.sql'));
  await db.exec('RESET check_function_bodies');
  await db.exec(`
    GRANT EXECUTE ON FUNCTION public.get_crm_leads_page(uuid,integer,integer,text,date,date,text,integer,integer,integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.get_company_crm_relationship(uuid,text,text,integer,integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.get_crm_lead_presence_history(uuid,text,integer,integer) TO authenticated;
  `);
  // Como no Supabase: funções novas recebem EXECUTE para anon/authenticated por padrão.
  await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role');
  await db.exec(await load('../migrations/20261123140000_crm_global_customer_search.sql'));

  await db.query("INSERT INTO public.companies(id, time_zone) VALUES ($1,'America/Sao_Paulo'), ($2,'America/Sao_Paulo'), ($3,'America/Sao_Paulo')", [companyA, companyB, companyBig]);
  await db.query(`INSERT INTO public.test_permissions VALUES
    ($1,$2,'leads_view'), ($1,$2,'reservations_view'), ($1,$2,'automations_view'), ($1,$2,'role:admin'),
    ($1,$3,'leads_view'), ($1,$3,'reservations_view'), ($4,$2,'reservations_view')`, [userA, companyA, companyBig, userNoLeads]);
  await seedSmallCompany(companyA);
  await seedSmallCompany(companyB);

  // Ficha e histórico de cada cliente com as funções de produção, antes da 20261123150000.
  const profileSample = await profileSampleKeys(companyA);
  const profilesBefore = await profileSnapshots(companyA, profileSample);
  await db.exec(await load('../migrations/20261123150000_crm_customer_lookup_by_key.sql'));

  await test('fichas montadas só para algumas chaves são idênticas às do cálculo completo', async () => {
    await owner();
    const full = await rows('SELECT * FROM public._get_crm_lead_profiles($1) ORDER BY customer_key', [companyA]);
    assert.ok(full.length > 100, `poucos clientes no cenário: ${full.length}`);
    const allKeys = full.map((row) => row.customer_key);
    const scopedAll = await rows('SELECT * FROM public._get_crm_lead_profiles_for_keys($1,$2) ORDER BY customer_key', [companyA, allKeys]);
    assert.deepEqual(scopedAll, full);
    for (let round = 0; round < 25; round += 1) {
      const subset = allKeys.filter(() => random() < 0.08);
      const expected = full.filter((row) => subset.includes(row.customer_key));
      const scoped = await rows('SELECT * FROM public._get_crm_lead_profiles_for_keys($1,$2) ORDER BY customer_key', [companyA, subset]);
      assert.deepEqual(scoped, expected, `subconjunto ${round}`);
    }
    const records = await rows('SELECT * FROM public._get_crm_contact_records($1) ORDER BY contact_record_key, customer_key', [companyA]);
    const scopedRecords = await rows('SELECT * FROM public._get_crm_contact_records_for_keys($1,$2) ORDER BY contact_record_key, customer_key', [companyA, allKeys]);
    assert.deepEqual(scopedRecords, records);
    assert.deepEqual(await rows('SELECT * FROM public._get_crm_lead_profiles_for_keys($1,$2)', [companyA, []]), []);
  });

  const fixedTerms = [
    'rafael', 'Rafael', 'raf', 'ana', 'silva', 'sousa', 'rafa sousa', 'rafael almeida', 'editado', 'importado', 'lima',
    'fila', 'sem contato', 'maria.rafael', '@example', 'example.com', 'rafael.com', '99131', '5562991', '62 99131',
    '(62) 98578', '985787503', '+55 62', '556299', '4155550100', '+1 415', '912345', '351912', '0158', '32411234',
    '98111', '06298111', '5506298', '12345', '5512345', '33334444', '62933334444', 'xyz-nada', 'rafael esperando', 'reserva da fila',
  ];
  await test('mesmos clientes e mesma ordem do cálculo completo, para termos variados', async () => {
    await actor();
    const leads = new Map();
    for (const term of fixedTerms) {
      const expected = await oracle(companyA, term);
      assert.deepEqual(await allPages(companyA, term, 7), expected, `termo "${term}"`);
    }
    assert.deepEqual(await oracle(companyA, 'rafael esperando'), [], 'fila que não sentou fica fora');
    const rafael = await search(companyA, 'rafael', 1, 50);
    for (const lead of rafael.leads) leads.set(lead.customer_key, lead);
    assert.ok(rafael.leads.some((lead) => lead.latest_name === 'Rafael Almeida Editado'), 'edição manual vale como nome');
    assert.ok(rafael.leads.some((lead) => lead.latest_name === 'Rafaela Lima'), 'acompanhante entra');
    assert.ok(rafael.leads.some((lead) => lead.latest_name === 'Rafael Fila'), 'fila sentada entra');
    assert.ok(!rafael.leads.some((lead) => lead.latest_name === 'Rafael Sousa'), 'nome antigo não conta');
  });

  await test('mesmo conteúdo de cada cliente que a tela Clientes devolve', async () => {
    await actor();
    for (const term of ['rafael', '99131', 'maria', 'importado', '62 98']) {
      const mine = await search(companyA, term, 1, 50);
      const screen = (await one('SELECT public.get_crm_leads_page($1,1,100,$2) AS result', [companyA, term])).result;
      const byKey = new Map(screen.leads.map((lead) => [lead.customer_key, lead]));
      for (const lead of mine.leads) {
        assert.ok(byKey.has(lead.customer_key), `"${term}": ${lead.customer_key} não está na tela Clientes`);
        assert.deepEqual(lead, byKey.get(lead.customer_key), `"${term}": ${lead.customer_key}`);
      }
    }
  });

  await test('termos sorteados dos próprios dados batem com o cálculo completo', async () => {
    await owner();
    const sources = await rows(`
      SELECT guest_name AS name, guest_phone AS phone, guest_email AS email FROM public.reservations WHERE company_id = $1
      UNION ALL SELECT name, phone, email FROM public.reservation_companions rc WHERE rc.company_id = $1
      UNION ALL SELECT guest_name, guest_phone, guest_email FROM public.waitlist WHERE company_id = $1
      UNION ALL SELECT full_name, phone, email FROM public.crm_leads WHERE company_id = $1
    `, [companyA]);
    const terms = new Set();
    for (let index = 0; terms.size < 140 && index < 5000; index += 1) {
      const source = pick(sources);
      const kind = pick(['name', 'name', 'phone', 'phone', 'digits', 'email']);
      const value = kind === 'digits' ? String(source.phone ?? '').replace(/\D/g, '') : String(source[kind === 'digits' ? 'phone' : kind] ?? '');
      if (value.length < 4) continue;
      const length = 3 + Math.floor(random() * Math.min(8, value.length - 2));
      const start = Math.floor(random() * (value.length - length + 1));
      const term = value.slice(start, start + length).trim();
      if (term.length >= 3) terms.add(term);
    }
    await actor();
    for (const term of terms) {
      assert.deepEqual(await allPages(companyA, term, 10), await oracle(companyA, term), `termo "${term}"`);
    }
  });

  await test('"carregar mais" anda de 10 em 10 sem repetir nem pular', async () => {
    await actor();
    const expected = await oracle(companyA, 'a');
    assert.ok(expected.length > 25);
    const first = await search(companyA, 'a', 1, 10);
    assert.equal(first.leads.length, 10);
    assert.equal(first.meta.has_more, true);
    assert.deepEqual(await allPages(companyA, 'a', 10), expected);
    const lastPage = Math.ceil(expected.length / 10);
    const last = await search(companyA, 'a', lastPage, 10);
    assert.equal(last.meta.has_more, false);
    const beyond = await search(companyA, 'a', lastPage + 1, 10);
    assert.deepEqual(beyond.leads, []);
    assert.equal(beyond.meta.has_more, false);
    const none = await search(companyA, 'xyz-nada', 1, 10);
    assert.deepEqual(none.leads, []);
    assert.equal(none.meta.has_more, false);
  });

  await test('não compara com a chave interna nem usa dígitos de buscas com texto', async () => {
    await actor();
    assert.deepEqual((await search(companyA, 'phone')).leads, []);
    assert.deepEqual((await search(companyA, 'one', 1, 50)).leads.filter((lead) => !/one/i.test(`${lead.latest_name} ${lead.latest_email ?? ''}`)), []);
    const screen = (await one('SELECT public.get_crm_leads_page($1,1,100,$2) AS result', [companyA, 'phone'])).result;
    assert.ok(screen.meta.filtered_leads > 10, 'a tela Clientes traz todos com "phone"');
    const mixed = await search(companyA, 'rafael 62', 1, 50);
    assert.deepEqual(mixed.leads, []);
  });

  await test('cada unidade só vê os próprios clientes', async () => {
    await actor();
    const own = await allPages(companyA, 'rafael', 50);
    const ownKeys = new Set(own);
    await owner();
    const otherCompanyKeys = await oracle(companyB, 'rafael');
    assert.ok(otherCompanyKeys.length > 0);
    await actor();
    const error = await searchError([companyB, 'rafael', 1, 10]);
    assert.equal(error?.code, '42501');
    assert.ok(ownKeys.size > 0);
  });

  await test('permissões: leads_view, anon e funções internas', async () => {
    assert.equal((await searchError([companyA, 'rafael', 1, 10], 'authenticated', userNoLeads))?.code, '42501');
    assert.equal((await searchError([companyA, 'rafael', 1, 10], 'anon', null))?.code, '42501');
    await actor();
    for (const call of [
      "SELECT public._crm_search_customer_keys('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rafael', NULL)",
      "SELECT * FROM public._get_crm_lead_profiles_for_keys('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['phone:5562991312333'])",
      "SELECT * FROM public._get_crm_contact_records_for_keys('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['phone:5562991312333'])",
      "SELECT public._crm_search_phone_may_contain(NULL, '62', '62')",
    ]) {
      await assert.rejects(db.query(call), (error) => error.code === '42501', call);
    }
    await owner();
    const grants = await one(`
      SELECT has_function_privilege('anon', 'public.search_crm_leads(uuid,text,integer,integer)', 'EXECUTE') AS anon,
        has_function_privilege('authenticated', 'public.search_crm_leads(uuid,text,integer,integer)', 'EXECUTE') AS authenticated,
        has_function_privilege('service_role', 'public.search_crm_leads(uuid,text,integer,integer)', 'EXECUTE') AS service_role
    `);
    assert.deepEqual(grants, { anon: false, authenticated: true, service_role: true });
  });

  await test('valida busca vazia, página e tamanho da página', async () => {
    assert.equal((await searchError([companyA, '   ', 1, 10]))?.code, '22023');
    assert.equal((await searchError([companyA, 'rafael', 0, 10]))?.code, '22023');
    assert.equal((await searchError([companyA, 'rafael', 1, 51]))?.code, '22023');
    assert.equal((await searchError([companyA, 'r'.repeat(201), 1, 10]))?.code, '22023');
    assert.equal((await searchError([null, 'rafael', 1, 10]))?.code, '22023');
  });

  await test('ficha do cliente e histórico de presenças iguais aos de antes, para cada cliente', async () => {
    const after = await profileSnapshots(companyA, profileSample);
    assert.ok(profileSample.length > 40, `poucos clientes na amostra: ${profileSample.length}`);
    let withVisits = 0;
    for (const key of profileSample) {
      assert.deepEqual(after[key], profilesBefore[key], `cliente ${key}`);
      if (after[key].presences.ok && after[key].presences.meta.total_visits > 0) withVisits += 1;
    }
    assert.ok(withVisits > 10, 'amostra sem visitas');
    assert.equal(after['phone:5562900000000'].summary.code, 'P0002');
    assert.ok(after[profileSample[0]].summary.ok);
    await owner();
    const helpers = await one(`SELECT to_regprocedure('public._crm_contact_may_have_key(text,text,text,text,uuid,text[],text[],text[])') AS contact,
      to_regprocedure('public._crm_import_may_have_key(text,uuid,text,text,text,text,text,text[],text[],text[])') AS import_helper,
      to_regprocedure('public._crm_search_key_filter(text[])') AS key_filter`);
    assert.deepEqual(helpers, { contact: null, import_helper: null, key_filter: null });
    const definitions = await one(`SELECT
      pg_get_functiondef('public.get_company_crm_relationship(uuid,text,text,integer,integer)'::regprocedure) AS relationship,
      pg_get_functiondef('public._get_crm_relationship_reservations(uuid,text)'::regprocedure) AS reservations,
      pg_get_functiondef('public.get_crm_lead_presence_history(uuid,text,integer,integer)'::regprocedure) AS presences`);
    for (const [name, definition] of Object.entries(definitions)) {
      assert.ok(definition.includes('_for_keys('), `${name} não usa a versão por chave`);
      assert.ok(!/_get_crm_lead_profiles\(_company_id\)|_get_crm_contact_records\(_company_id\)|_get_customer_canonical_visit_events\(/.test(definition), `${name} ainda monta a unidade inteira`);
    }
  });

  await test('em volume, filtra antes e fica bem mais rápida que o cálculo completo', async () => {
    await owner();
    await seedBigCompany(companyBig, Number(process.env.CRM_SEARCH_VOLUME ?? 1500));
    const phoneTerm = (await one('SELECT guest_phone FROM public.reservations WHERE company_id=$1 ORDER BY id LIMIT 1', [companyBig])).guest_phone.slice(-8);
    await actor();
    const term = 'rafael';
    let started = performance.now();
    const screen = (await one('SELECT public.get_crm_leads_page($1,1,10,$2) AS result', [companyBig, term])).result;
    const fullMs = performance.now() - started;
    started = performance.now();
    const mine = await search(companyBig, term, 1, 10);
    const searchMs = performance.now() - started;
    started = performance.now();
    const byPhone = await search(companyBig, phoneTerm, 1, 10);
    const phoneMs = performance.now() - started;
    started = performance.now();
    const common = await search(companyBig, 'ana', 1, 10);
    const commonMs = performance.now() - started;
    const someKey = byPhone.leads[0].customer_key;
    started = performance.now();
    const profile = (await one('SELECT public.get_company_crm_relationship($1,$2,$3,1,25) AS result', [companyBig, someKey, 'reservations'])).result;
    const presences = (await one('SELECT public.get_crm_lead_presence_history($1,$2,1,50) AS result', [companyBig, someKey])).result;
    const profileMs = performance.now() - started;
    console.log(`# volume: cálculo completo ${fullMs.toFixed(0)} ms; busca "${term}" ${searchMs.toFixed(0)} ms; telefone ${phoneMs.toFixed(0)} ms; "ana" ${commonMs.toFixed(0)} ms (${common.leads.length}${common.meta.has_more ? '+' : ''}); ficha + presenças ${profileMs.toFixed(0)} ms`);
    assert.ok(profile.total >= 1);
    assert.ok(presences.meta.total_visits >= 0);
    assert.ok(commonMs < fullMs, `"ana" não ficou mais rápida (${commonMs.toFixed(0)} x ${fullMs.toFixed(0)} ms)`);
    assert.ok(profileMs * 4 < fullMs, `ficha não ficou bem mais rápida (${profileMs.toFixed(0)} x ${fullMs.toFixed(0)} ms)`);
    assert.deepEqual(mine.leads.map((lead) => lead.customer_key), screen.leads.map((lead) => lead.customer_key));
    assert.ok(byPhone.leads.length >= 1);
    assert.ok(searchMs * 4 < fullMs, `busca nova não foi bem mais rápida (${searchMs.toFixed(0)} x ${fullMs.toFixed(0)} ms)`);
    assert.ok(phoneMs * 4 < fullMs, `busca por telefone não foi bem mais rápida (${phoneMs.toFixed(0)} x ${fullMs.toFixed(0)} ms)`);
  });

  console.log(`\n${passed} testes da busca global de clientes passaram.`);
} finally {
  await owner().catch(() => {});
  await db.close();
}
