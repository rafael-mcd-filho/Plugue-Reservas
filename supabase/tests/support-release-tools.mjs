import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// No HTTP calls, credentials, customer rows or automatic production mutations.
// Run snapshotQuery through the existing authenticated Management API, keep its
// result private, then generate SQL with: node this-file.mjs snapshot.json rollback.sql
// Catalog definitions can themselves contain literal values; do not log them.
export const snapshotQuery = String.raw`
SELECT jsonb_build_object(
  'formatVersion', 1,
  'capturedAt', now(),
  'functions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', p.proname,
      'signature', format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)),
      'definition', pg_get_functiondef(p.oid),
      'owner', pg_get_userbyid(p.proowner),
      'comment', obj_description(p.oid, 'pg_proc'),
      'acl', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'grantee', CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege', a.privilege_type, 'grantable', a.is_grantable)
        ORDER BY a.grantee, a.privilege_type, a.is_grantable)
        FROM aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a), '[]'::jsonb)
    ) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.prokind='f' AND l.lanname IN ('sql','plpgsql')
      AND (p.proname IN ('has_role','has_role_in_company','is_company_member','get_user_company_id',
        'has_company_panel_permission','get_reservation_audit_actor_role','effective_auth_uid','is_real_superadmin')
        OR p.proname LIKE '%support%'
        OR (p.prorettype <> 'trigger'::regtype AND p.prosrc ~ 'auth[.]uid\s*\('
          AND p.prosrc !~ '(reservation_audit_logs|audit_logs)' AND p.proname <> 'get_my_memberships'))
  ), '[]'::jsonb),
  'policies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'table', c.relname, 'name', p.polname,
      'permissive', p.polpermissive, 'command', p.polcmd,
      'roles', ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END FROM unnest(p.polroles) r),
      'using', pg_get_expr(p.polqual,p.polrelid), 'check', pg_get_expr(p.polwithcheck,p.polrelid),
      'comment', obj_description(p.oid,'pg_policy')
    ) ORDER BY n.nspname,c.relname,p.polname)
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','storage') AND c.relname NOT LIKE 'support_%'
  ), '[]'::jsonb),
  'constraints', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',co.conname,'definition',pg_get_constraintdef(co.oid,true),
      'comment', obj_description(co.oid,'pg_constraint')
    ) ORDER BY n.nspname,c.relname,co.conname)
    FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND ((c.relname='reservation_audit_logs' AND co.conname='reservation_audit_logs_actor_role_check')
      OR (c.relname='user_roles' AND co.conname='support_role_is_global'))
  ), '[]'::jsonb),
  'triggers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled
    ) ORDER BY n.nspname,c.relname,t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname IN ('public','storage','auth')
  ), '[]'::jsonb)
) AS snapshot;`;

const quoteIdentifier = value => '"' + value.replaceAll('"', '""') + '"';
const quoteLiteral = value => value === null ? 'NULL' : "'" + value.replaceAll("'", "''") + "'";
const roleSql = role => role === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(role);
const relationSql = item => `${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`;
const newFunctionSignatures = [
  'public.revoke_support_sessions_on_access_change()', 'public.is_support_actor()',
  'public.is_real_superadmin()', 'public.support_actor_is_active()',
  'public.support_request_session_id()', 'public.support_auth_session_id()',
  'public.get_support_impersonation_context()', 'public.support_company_scope_allows(uuid)',
  'public.effective_auth_uid(uuid)', 'public.set_support_company_access(uuid,uuid[])',
  'public.support_list_companies()', 'public.support_list_impersonation_candidates(uuid)',
  'public.start_support_impersonation(uuid,uuid)', 'public.stop_support_impersonation(uuid)',
  'public.support_dashboard(uuid,date,date)', 'public.enforce_support_role_exclusivity()',
  'public.protect_support_payment_identity()', 'public.audit_support_tenant_mutation()',
];

export function unwrapSnapshot(input) {
  if (Array.isArray(input)) input = input[0];
  if (input?.snapshot) input = input.snapshot;
  if (typeof input === 'string') input = JSON.parse(input);
  if (input?.formatVersion !== 1 || !['functions','policies','constraints','triggers'].every(key => Array.isArray(input[key]))) {
    throw new Error('Expected the catalog snapshot returned by snapshotQuery, formatVersion=1.');
  }
  return input;
}

export function buildRollbackSql(input) {
  const snapshot = unwrapSnapshot(input);
  if (!snapshot.functions.some(item => item.name === 'has_role') || !snapshot.policies.length) {
    throw new Error('Incomplete schema snapshot; refusing to generate rollback.');
  }
  if (snapshot.functions.some(item => item.name === 'get_support_impersonation_context') ||
      snapshot.policies.some(item => item.name.startsWith('support_'))) {
    throw new Error('Snapshot already contains the support release; a PRE-RELEASE snapshot is required.');
  }
  const sql = [
    '-- Catalog-only rollback for the Support release, generated from its pre-release database snapshot.',
    '-- Restore the previous frontend and Edge Function versions as well. Do not run after other schema releases.',
    '-- No business rows are deleted. Any support accounts/grants/sessions/audits cause an atomic abort.',
    '-- The app_role enum value support and its enum migration remain; removing enum values is unsafe.',
    'BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='60s';",
    String.raw`DO $guard$
DECLARE _has_data boolean;
BEGIN
  LOCK TABLE public.user_roles,public.audit_logs,public.reservation_audit_logs IN SHARE ROW EXCLUSIVE MODE;
  IF to_regclass('public.support_company_access') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.support_company_access IN SHARE ROW EXCLUSIVE MODE';
  END IF;
  IF to_regclass('public.support_impersonation_sessions') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.support_impersonation_sessions IN SHARE ROW EXCLUSIVE MODE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE role::text='support') THEN
    RAISE EXCEPTION 'Rollback refused: support accounts exist; prepare a separate data-preserving deactivation plan';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_audit_logs WHERE actor_role='support')
    OR EXISTS (SELECT 1 FROM public.audit_logs WHERE action IN ('set_support_company_access','start_support_impersonation','stop_support_impersonation') OR action LIKE 'support\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'Rollback refused: support audit history exists and must be preserved';
  END IF;
  IF to_regclass('public.support_company_access') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.support_company_access)' INTO _has_data;
    IF _has_data THEN RAISE EXCEPTION 'Rollback refused: support company grants exist'; END IF;
  END IF;
  IF to_regclass('public.support_impersonation_sessions') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.support_impersonation_sessions)' INTO _has_data;
    IF _has_data THEN RAISE EXCEPTION 'Rollback refused: support sessions exist'; END IF;
  END IF;
END;
$guard$;`,
    String.raw`DO $remove_support_policies$
DECLARE p record;
BEGIN
  FOR p IN SELECT n.nspname,c.relname,pol.polname FROM pg_policy pol
    JOIN pg_class c ON c.oid=pol.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','storage') AND pol.polname IN (
      'support_identity_read_scope','support_identity_write_scope','support_identity_update_scope','support_identity_delete_scope',
      'support_tenant_scope','support_reference_insert_scope','support_reference_update_scope',
      'support_storage_insert_scope','support_storage_update_scope','support_storage_delete_scope',
      'Support and superadmin can view support grants')
  LOOP EXECUTE format('DROP POLICY %I ON %I.%I',p.polname,p.nspname,p.relname); END LOOP;
END;
$remove_support_policies$;`,
    String.raw`DO $remove_support_triggers$
DECLARE t record;
BEGIN
  FOR t IN SELECT n.nspname,c.relname,tr.tgname FROM pg_trigger tr
    JOIN pg_class c ON c.oid=tr.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc f ON f.oid=tr.tgfoid JOIN pg_namespace fn ON fn.oid=f.pronamespace
    WHERE NOT tr.tgisinternal AND n.nspname IN ('public','auth') AND fn.nspname='public'
      AND f.proname IN ('revoke_support_sessions_on_access_change','enforce_support_role_exclusivity','protect_support_payment_identity','audit_support_tenant_mutation')
  LOOP EXECUTE format('DROP TRIGGER %I ON %I.%I',t.tgname,t.nspname,t.relname); END LOOP;
END;
$remove_support_triggers$;`,
  ];
  for (const fn of snapshot.functions) {
    sql.push(fn.definition.trimEnd() + (fn.definition.trimEnd().endsWith(';') ? '' : ';'), `ALTER FUNCTION ${fn.signature} OWNER TO ${quoteIdentifier(fn.owner)};`);
    // Revoke the current ACL, including roles introduced by this release, then
    // restore the captured effective ACL. No passwords or role data are copied.
    sql.push(`DO $restore_acl$
DECLARE a record;
BEGIN
  FOR a IN SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl.grantee)) END grantee
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid=to_regprocedure(${quoteLiteral(fn.signature)})
  LOOP EXECUTE 'REVOKE ALL ON FUNCTION ${fn.signature.replaceAll("'", "''")} FROM ' || a.grantee; END LOOP;
END;
$restore_acl$;`);
    for (const acl of fn.acl) {
      if (acl.privilege !== 'EXECUTE') throw new Error('Unexpected function ACL privilege.');
      sql.push(`GRANT EXECUTE ON FUNCTION ${fn.signature} TO ${roleSql(acl.grantee)}${acl.grantable ? ' WITH GRANT OPTION' : ''};`);
    }
    sql.push(`COMMENT ON FUNCTION ${fn.signature} IS ${quoteLiteral(fn.comment)};`);
  }
  const commandNames = { '*': 'ALL', r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE' };
  for (const policy of snapshot.policies) {
    const command = commandNames[policy.command];
    if (!command) throw new Error('Unexpected policy command.');
    sql.push(`DROP POLICY IF EXISTS ${quoteIdentifier(policy.name)} ON ${relationSql(policy)};`);
    sql.push(`CREATE POLICY ${quoteIdentifier(policy.name)} ON ${relationSql(policy)} AS ${policy.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${command} TO ${policy.roles.map(roleSql).join(', ')}${policy.using === null ? '' : ` USING (${policy.using})`}${policy.check === null ? '' : ` WITH CHECK (${policy.check})`};`);
    sql.push(`COMMENT ON POLICY ${quoteIdentifier(policy.name)} ON ${relationSql(policy)} IS ${quoteLiteral(policy.comment ?? null)};`);
  }
  sql.push('ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS support_role_is_global;');
  for (const constraint of snapshot.constraints) {
    sql.push(`ALTER TABLE ${relationSql(constraint)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraint.name)};`);
    sql.push(`ALTER TABLE ${relationSql(constraint)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)} ${constraint.definition};`);
    sql.push(`COMMENT ON CONSTRAINT ${quoteIdentifier(constraint.name)} ON ${relationSql(constraint)} IS ${quoteLiteral(constraint.comment ?? null)};`);
  }
  // One DROP statement handles dependencies amongst the release's new helpers.
  // No CASCADE: an unexpected external dependency aborts the whole transaction.
  const normalizeSignature = value => value.replaceAll('public.app_role','app_role').replaceAll(/\s/g,'');
  const originalSignatures = new Set(snapshot.functions.map(fn => normalizeSignature(fn.signature)));
  const createdFunctions = [...newFunctionSignatures];
  // CREATE OR REPLACE also creates a helper when a deployed schema did not
  // already contain it. Restore only pre-existing objects; drop newly created
  // is_company_member/get_user_company_id (both absent in the repo baseline).
  for (const signature of ['public.has_role(uuid,public.app_role)','public.has_role_in_company(uuid,public.app_role,uuid)',
    'public.is_company_member(uuid,uuid)','public.get_user_company_id(uuid)','public.has_company_panel_permission(uuid,uuid,text)']) {
    if (!originalSignatures.has(normalizeSignature(signature))) createdFunctions.push(signature);
  }
  sql.push(`DROP FUNCTION IF EXISTS ${createdFunctions.join(',\n  ')};`);
  sql.push('DROP TABLE IF EXISTS public.support_impersonation_sessions, public.support_company_access;');
  sql.push(String.raw`DO $migration_history$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    DELETE FROM supabase_migrations.schema_migrations WHERE version='20261006121000';
  END IF;
END;
$migration_history$;`, "NOTIFY pgrst, 'reload schema';", 'COMMIT;');
  return sql.join('\n\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [snapshotPath, rollbackPath] = process.argv.slice(2);
  if (!snapshotPath || !rollbackPath) {
    console.error('Usage: node supabase/tests/support-release-tools.mjs <private-snapshot.json> <private-rollback.sql>');
    process.exitCode = 1;
  } else {
    const snapshot = unwrapSnapshot(JSON.parse(await readFile(snapshotPath,'utf8')));
    await writeFile(rollbackPath, buildRollbackSql(snapshot), { mode: 0o600 });
    console.log(`Rollback generated: ${snapshot.functions.length} function definitions, ${snapshot.policies.length} policies; no customer rows included.`);
  }
}
