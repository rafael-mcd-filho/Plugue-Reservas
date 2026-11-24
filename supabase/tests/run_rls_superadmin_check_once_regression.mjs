import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Migração 20261123180000: a conferência de superadmin das regras de acesso passa
// para dentro de (SELECT ...). Confere que cada usuário lê, cria, altera e apaga
// exatamente o que podia antes, que só esse trecho muda e que rodar de novo não
// muda nada. Banco em memória, sem rede.
const db = new PGlite();
const load = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const users = {
  superadmin: '00000000-0000-4000-8000-000000000001',
  adminA: '00000000-0000-4000-8000-000000000002',
  operatorA: '00000000-0000-4000-8000-000000000003',
  adminB: '00000000-0000-4000-8000-000000000004',
  none: '00000000-0000-4000-8000-000000000005',
};
const WRAPPED = "( SELECT has_role(( SELECT effective_auth_uid() AS effective_auth_uid), 'superadmin'::app_role) AS has_role)";
const UNWRAPPED = "has_role(( SELECT effective_auth_uid() AS effective_auth_uid), 'superadmin'::app_role)";
let passed = 0;

async function test(name, body) {
  try { await body(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
async function rows(sql, values = []) { return (await db.query(sql, values)).rows; }

async function as(user, body) {
  await db.exec('BEGIN');
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
    await db.exec('SET LOCAL ROLE authenticated');
    return await body();
  } finally {
    await db.exec('ROLLBACK');
  }
}
async function attempt(sql, values = []) {
  await db.exec('SAVEPOINT attempt');
  try {
    const result = await db.query(sql, values);
    await db.exec('RELEASE SAVEPOINT attempt');
    return result.affectedRows ?? result.rows.length;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT attempt');
    return `erro ${error.code}`;
  }
}

// O que cada usuário consegue ler, criar, alterar e apagar.
async function behavior() {
  const result = {};
  for (const [name, user] of Object.entries(users)) {
    result[name] = await as(user, async () => ({
      itemsVisible: (await rows('SELECT id FROM public.items ORDER BY id')).map((row) => row.id),
      notesVisible: (await rows('SELECT id FROM public.notes ORDER BY id')).map((row) => row.id),
      insertA: await attempt('INSERT INTO public.items(id, company_id) VALUES (100, $1)', [companyA]),
      insertB: await attempt('INSERT INTO public.items(id, company_id) VALUES (101, $1)', [companyB]),
      insertNoCompany: await attempt('INSERT INTO public.items(id, company_id) VALUES (102, NULL)'),
      updateA: await attempt("UPDATE public.items SET label = 'novo' WHERE company_id = $1", [companyA]),
      updateToB: await attempt('UPDATE public.items SET company_id = $1 WHERE id = 1', [companyB]),
      deleteNotes: await attempt('DELETE FROM public.notes'),
      adminOnly: (await rows('SELECT id FROM public.admin_only ORDER BY id')).map((row) => row.id),
    }));
  }
  return result;
}
async function policies() {
  return rows(`SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`);
}
const occurrences = (text, needle) => (text ?? '').split(needle).length - 1;

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
    CREATE TYPE public.app_role AS ENUM ('superadmin', 'admin', 'operator', 'support');
    CREATE TABLE public.user_roles(user_id uuid NOT NULL, role public.app_role NOT NULL, company_id uuid);
    CREATE FUNCTION public.effective_auth_uid(_company_id uuid DEFAULT NULL) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT auth.uid() $$;
    CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
    $$;
    CREATE FUNCTION public.has_role_in_company(_user_id uuid, _role public.app_role, _company_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role AND company_id = _company_id)
    $$;

    CREATE TABLE public.items(id integer PRIMARY KEY, company_id uuid, label text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.notes(id integer PRIMARY KEY, company_id uuid);
    CREATE TABLE public.admin_only(id integer PRIMARY KEY);
    ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.admin_only ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON public.items, public.notes, public.admin_only TO authenticated;

    -- Mesmos formatos das regras de produção.
    CREATE POLICY "Superadmins can manage all items" ON public.items FOR ALL TO authenticated
      USING (public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role))
      WITH CHECK (public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role));
    CREATE POLICY "Company admins can view items" ON public.items FOR SELECT TO authenticated
      USING (public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role)
        OR public.has_role_in_company((SELECT public.effective_auth_uid()), 'admin'::public.app_role, company_id));
    CREATE POLICY "Company staff can create items" ON public.items FOR INSERT TO authenticated
      WITH CHECK (public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role)
        OR public.has_role_in_company((SELECT public.effective_auth_uid()), 'admin'::public.app_role, company_id)
        OR public.has_role_in_company((SELECT public.effective_auth_uid()), 'operator'::public.app_role, company_id));
    CREATE POLICY "Mixed update" ON public.items FOR UPDATE TO authenticated
      USING ((SELECT public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role))
        OR public.has_role_in_company((SELECT public.effective_auth_uid()), 'admin'::public.app_role, company_id))
      WITH CHECK (public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role)
        OR public.has_role_in_company((SELECT public.effective_auth_uid()), 'admin'::public.app_role, company_id));
    CREATE POLICY "Company scope" ON public.items AS RESTRICTIVE FOR ALL TO authenticated
      USING (company_id IS NOT NULL OR public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role))
      WITH CHECK (company_id IS NOT NULL OR public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role));
    CREATE POLICY "Notes view" ON public.notes FOR SELECT TO authenticated
      USING (NOT public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role)
        AND public.has_role_in_company((SELECT public.effective_auth_uid()), 'operator'::public.app_role, company_id));
    CREATE POLICY "Notes delete" ON public.notes FOR DELETE TO authenticated
      USING (public.has_role((SELECT public.effective_auth_uid()), 'superadmin'::public.app_role) AND company_id IS NOT NULL);
    CREATE POLICY "Admins only" ON public.admin_only FOR SELECT TO authenticated
      USING (public.has_role((SELECT public.effective_auth_uid()), 'admin'::public.app_role));
  `);
  await db.query(`INSERT INTO public.user_roles VALUES ($1, 'superadmin', NULL), ($2, 'admin', $5), ($3, 'operator', $5), ($4, 'admin', $6)`,
    [users.superadmin, users.adminA, users.operatorA, users.adminB, companyA, companyB]);
  await db.query('INSERT INTO public.items(id, company_id) VALUES (1, $1), (2, $1), (3, $2), (4, NULL)', [companyA, companyB]);
  await db.query('INSERT INTO public.notes(id, company_id) VALUES (1, $1), (2, $2), (3, NULL)', [companyA, companyB]);
  await db.exec('INSERT INTO public.admin_only VALUES (1), (2)');

  const behaviorBefore = await behavior();
  const policiesBefore = await policies();
  await test('a amostra cobre quem pode e quem não pode', async () => {
    assert.deepEqual(behaviorBefore.superadmin.itemsVisible, [1, 2, 3, 4]);
    assert.deepEqual(behaviorBefore.adminA.itemsVisible, [1, 2]);
    assert.deepEqual(behaviorBefore.none.itemsVisible, []);
    assert.equal(behaviorBefore.operatorA.insertA, 1);
    assert.match(String(behaviorBefore.operatorA.insertB), /^erro/);
    assert.match(String(behaviorBefore.adminA.updateToB), /^erro/);
    assert.deepEqual(behaviorBefore.operatorA.notesVisible, [1]);
    assert.deepEqual(behaviorBefore.superadmin.notesVisible, []);
    assert.deepEqual(behaviorBefore.adminA.adminOnly, [1, 2]);
    assert.ok(policiesBefore.some((policy) => occurrences(policy.qual, UNWRAPPED) > occurrences(policy.qual, WRAPPED)));
  });

  const migration = await load('../migrations/20261123180000_rls_superadmin_check_once.sql');
  await db.exec(migration);

  await test('cada usuário lê, cria, altera e apaga o mesmo que antes', async () => {
    assert.deepEqual(await behavior(), behaviorBefore);
  });

  await test('só a conferência de superadmin muda, e fica dentro de (SELECT ...)', async () => {
    const after = await policies();
    assert.equal(after.length, policiesBefore.length);
    for (const [index, policy] of after.entries()) {
      const before = policiesBefore[index];
      assert.deepEqual({ ...policy, qual: null, with_check: null }, { ...before, qual: null, with_check: null });
      for (const part of ['qual', 'with_check']) {
        const text = policy[part];
        assert.equal(occurrences((text ?? '').split(WRAPPED).join(''), UNWRAPPED), 0, `${policy.policyname} ${part}`);
        assert.equal(occurrences(text, WRAPPED), occurrences(before[part], UNWRAPPED), `${policy.policyname} ${part}`);
        assert.equal((text ?? '').split(WRAPPED).join(UNWRAPPED), (before[part] ?? '').split(WRAPPED).join(UNWRAPPED), `${policy.policyname} ${part}`);
      }
    }
    const adminOnly = after.find((policy) => policy.policyname === 'Admins only');
    assert.ok(adminOnly.qual.startsWith('has_role('), 'conferência de admin não deveria mudar');
  });

  await test('rodar de novo não muda nada', async () => {
    const once = await policies();
    await db.exec(migration);
    assert.deepEqual(await policies(), once);
    assert.deepEqual(await behavior(), behaviorBefore);
  });

  await test('a conferência de superadmin roda uma vez por consulta', async () => {
    const plan = await as(users.adminA, async () => (await rows('EXPLAIN (COSTS OFF) SELECT id FROM public.items')).map((row) => row['QUERY PLAN']).join('\n'));
    const filter = plan.split('\n').filter((line) => line.includes('Filter:')).join('\n');
    assert.ok(/InitPlan/.test(plan), plan);
    assert.ok(!/has_role\(/.test(filter.replace(/has_role_in_company\(/g, '')), plan);
  });

  console.log(`\n${passed} testes das regras de acesso passaram.`);
} finally {
  await db.close();
}
