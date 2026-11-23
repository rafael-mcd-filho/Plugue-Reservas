// Offline handler regressions: no Supabase credentials, fetches or production calls.
// Run: node --test supabase/functions/create-company/index.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

const phoneCore = {};
const phoneCoreJs = ts.transpileModule(readFileSync(new URL("../_shared/phone-core.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInThisContext(`(function(exports) { ${phoneCoreJs}\n})`)(phoneCore);
const phoneTools = phoneCore.createPhoneTools(parsePhoneNumberFromString);

const actorId = "00000000-0000-4000-8000-000000000001";
const companyId = "00000000-0000-4000-8000-000000000002";
const freshUserId = "00000000-0000-4000-8000-000000000003";
const reusedUserId = "00000000-0000-4000-8000-000000000004";
const duplicateError = { code: "email_exists", message: "A user with this email address has already been registered" };
const recoveryLink = "https://auth.offline.invalid/verify?token=offline-recovery-token";
const input = {
  name: "Restaurante de teste",
  slug: "restaurante-de-teste",
  responsible_name: "Responsavel de teste",
  responsible_email: "responsavel@example.test",
  responsible_phone: "(84) 99999-9999",
};

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function harness({
  authError = null,
  createUserError = null,
  reuseError = null,
  reuseData = reusedUserId,
  profileError = null,
  roleError = null,
  recoveryError = null,
  auditError = null,
} = {}) {
  let handler;
  const calls = [];
  const writes = [];
  const logs = [];
  const company = { id: companyId, name: input.name, slug: input.slug };
  const admin = {
    from(table) {
      let operation = "select";
      let data;
      const filters = [];
      const builder = {
        select: () => builder,
        single: () => builder,
        eq: (key, value) => { filters.push([key, value]); return builder; },
        insert: (value) => { operation = "insert"; data = value; return builder; },
        upsert: (value) => { operation = "upsert"; data = value; return builder; },
        delete: () => { operation = "delete"; return builder; },
        then(resolve, reject) {
          writes.push({ table, operation, data: copy(data), filters: copy(filters) });
          assert.notEqual(operation, "select", "No unscoped database lookup may be used to find an existing Auth account");
          const error = operation === "delete" ? null
            : table === "profiles" ? profileError
            : table === "user_roles" ? roleError
            : table === "audit_logs" ? auditError : null;
          const result = { data: table === "companies" && operation === "insert" ? company : null, error };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc: async (name, args) => {
      calls.push({ operation: "rpc", name, args: copy(args) });
      assert.equal(name, "reuse_unassigned_company_admin");
      return { data: reuseError ? null : reuseData, error: reuseError };
    },
    auth: { admin: {
      createUser: async (data) => {
        calls.push({ operation: "createUser", data: copy(data) });
        return { data: { user: createUserError ? null : { id: freshUserId } }, error: createUserError };
      },
      updateUserById: async (id, data) => {
        calls.push({ operation: "updateAuth", id, data: copy(data) });
        throw new Error("Reusing an account must preserve its credentials");
      },
      deleteUser: async (id) => {
        calls.push({ operation: "deleteAuth", id });
        return { error: null };
      },
      generateLink: async (data) => {
        calls.push({ operation: "generateLink", data: copy(data) });
        return { data: recoveryError ? null : { properties: { action_link: recoveryLink } }, error: recoveryError };
      },
    } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const run = vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, crypto: globalThis.crypto,
    console: { error: (...args) => { logs.push(args); } },
  });
  run({}, (name) => {
    if (name === "../_shared/phone.ts") return phoneTools;
    assert.equal(name, "../_shared/internal-auth.ts", "Unexpected dependency in create-company handler");
    return { assertSuperadmin: async (req) => {
      calls.push({ operation: "authorize", authorization: req.headers.get("Authorization") });
      if (authError) throw new Error(authError);
      if (req.headers.get("Authorization") !== "Bearer offline-token") throw new Error("Nao autorizado");
      return { supabaseAdmin: admin, user: { id: actorId } };
    } };
  }, {
    env: { get: (name) => name === "APP_URL" ? "https://app.offline.invalid" : undefined },
    serve: (fn) => { handler = fn; },
  });
  assert.equal(typeof handler, "function");
  const invoke = async (overrides = {}, authorization = "Bearer offline-token") => {
    const response = await handler(new Request("https://offline.invalid/functions/v1/create-company", {
      method: "POST",
      headers: { ...(authorization ? { Authorization: authorization } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, ...overrides }),
    }));
    return { response, body: await response.json() };
  };
  return { invoke, calls, writes, logs };
}

test("fresh admin accounts retain normal provisioning and recovery behavior", async () => {
  const { invoke, calls, writes } = harness();
  const { response, body } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(body.admin_user.id, freshUserId);
  assert.equal(body.admin_user.reused, false);
  assert.equal(body.admin_user.access_link, recoveryLink);
  assert.equal(body.warning, null);
  assert.equal(calls.filter((call) => call.operation === "createUser").length, 1);
  assert.deepEqual(calls.find((call) => call.operation === "createUser").data.app_metadata, {
    provisioning_company_id: companyId,
  }, "New Auth accounts must identify their original provisioning company before profile/role writes");
  assert.equal(calls.some((call) => call.operation === "rpc"), false);
  assert.equal(calls.some((call) => call.operation === "deleteAuth"), false);
  assert.equal(writes.find((row) => row.table === "profiles").data.company_id, companyId);
  assert.deepEqual(writes.find((row) => row.table === "user_roles").data, {
    user_id: freshUserId, role: "admin", company_id: companyId,
  });
  const audit = writes.find((row) => row.table === "audit_logs").data;
  assert.equal(audit.user_id, actorId);
  assert.equal(audit.details.admin_user_id, freshUserId);
  assert.equal(audit.details.admin_user_reused, false);
});

test("duplicate email reuses an eligible account through the atomic RPC without resetting credentials", async () => {
  const { invoke, calls, writes } = harness({ createUserError: duplicateError });
  const { response, body } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(body.admin_user.id, reusedUserId);
  assert.equal(body.admin_user.reused, true);
  assert.deepEqual(calls.find((call) => call.operation === "rpc"), {
    operation: "rpc", name: "reuse_unassigned_company_admin", args: {
      _company_id: companyId,
      _email: input.responsible_email,
      _full_name: input.responsible_name,
      _phone: "+5584999999999",
    },
  });
  assert.equal(writes.some((row) => ["profiles", "user_roles"].includes(row.table)), false,
    "The atomic RPC owns profile and role attachment for reused accounts");
  assert.equal(calls.some((call) => ["deleteAuth", "updateAuth"].includes(call.operation)), false);
  assert.equal(calls.find((call) => call.operation === "generateLink").data.email, input.responsible_email);
  const audit = writes.find((row) => row.table === "audit_logs").data;
  assert.equal(audit.details.admin_user_id, reusedUserId);
  assert.equal(audit.details.admin_user_reused, true);
});

test("normalized email and optional profile fields reach Auth and reuse consistently", async () => {
  const { invoke, calls, writes } = harness({ createUserError: duplicateError });
  const { response, body } = await invoke({
    responsible_email: "  Responsavel@EXAMPLE.Test  ",
    responsible_name: "",
    responsible_phone: "  (84) 99999-9999  ",
    email: "  Restaurante@EXAMPLE.Test  ",
  });
  assert.equal(response.status, 200);
  assert.equal(body.admin_user.email, input.responsible_email);
  assert.equal(calls.find((call) => call.operation === "createUser").data.email, input.responsible_email);
  assert.equal(calls.find((call) => call.operation === "rpc").args._email, input.responsible_email);
  assert.equal(calls.find((call) => call.operation === "rpc").args._full_name, input.name);
  assert.equal(calls.find((call) => call.operation === "rpc").args._phone, "+5584999999999");
  const companyWrite = writes.find((row) => row.table === "companies" && row.operation === "insert").data;
  assert.equal(companyWrite.responsible_email, input.responsible_email);
  assert.equal(companyWrite.email, "restaurante@example.test");
});

test("duplicate compatibility messages trigger reuse when Auth omits its error code", async () => {
  for (const message of [
    "A user with this email address has already been registered",
    "Email already registered",
  ]) {
    const { invoke, calls } = harness({ createUserError: { message } });
    const { response, body } = await invoke();
    assert.equal(response.status, 200, message);
    assert.equal(body.admin_user.reused, true, message);
    assert.equal(calls.filter((call) => call.operation === "rpc").length, 1, message);
  }
});

test("Auth user_already_exists compatibility code can reuse an eligible email account", async () => {
  const { invoke, calls } = harness({ createUserError: { code: "user_already_exists", message: "Account exists" } });
  const { response, body } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(body.admin_user.id, reusedUserId);
  assert.equal(body.admin_user.reused, true);
  assert.equal(calls.filter((call) => call.operation === "rpc").length, 1);
  assert.equal(calls.some((call) => ["deleteAuth", "updateAuth"].includes(call.operation)), false);
});

test("missing or malformed reuse results fail closed and only roll back the new company", async () => {
  for (const reuseData of [null, "", false, {}, []]) {
    const { invoke, calls, writes } = harness({ createUserError: duplicateError, reuseData });
    const { response, body } = await invoke();
    assert.equal(response.status, 400);
    assert.match(body.error, /Nao foi possivel vincular a conta existente/);
    assert.equal(calls.filter((call) => call.operation === "rpc").length, 1);
    assert.equal(calls.some((call) => ["deleteAuth", "updateAuth", "generateLink"].includes(call.operation)), false);
    assert.equal(writes.some((row) => ["profiles", "user_roles", "audit_logs"].includes(row.table)), false);
    assert.deepEqual(writes.filter((row) => row.operation === "delete"), [{
      table: "companies", operation: "delete", data: undefined, filters: [["id", companyId]],
    }]);
  }
});

test("an ineligible existing account blocks creation and never gets deleted or overwritten", async () => {
  const { invoke, calls, writes } = harness({
    createUserError: duplicateError,
    reuseError: { code: "23505", message: "Este email ja esta cadastrado no sistema" },
  });
  const { response, body } = await invoke();
  assert.equal(response.status, 400);
  assert.equal(body.code, "23505");
  assert.match(body.error, /email ja esta cadastrado/);
  assert.equal(calls.some((call) => ["deleteAuth", "updateAuth", "generateLink"].includes(call.operation)), false);
  assert.equal(writes.some((row) => ["profiles", "user_roles", "audit_logs"].includes(row.table)), false);
  assert.deepEqual(writes.find((row) => row.operation === "delete"), {
    table: "companies", operation: "delete", data: undefined, filters: [["id", companyId]],
  });
});

test("nonduplicate Auth errors cannot attach an existing account", async () => {
  for (const error of [
    { code: "unexpected_failure", message: "Database error saving new user" },
    { code: "email_address_invalid", message: "Email address invalid" },
    { code: "over_email_send_rate_limit", message: "Email rate limit exceeded" },
  ]) {
    const { invoke, calls, writes } = harness({ createUserError: error });
    const { response, body } = await invoke();
    assert.equal(response.status, 400, error.code);
    assert.equal(body.code, error.code);
    assert.equal(calls.some((call) => ["rpc", "deleteAuth", "updateAuth", "generateLink"].includes(call.operation)), false, error.code);
    assert.equal(writes.filter((row) => row.table === "companies" && row.operation === "delete").length, 1, error.code);
  }
});

test("recovery link failure preserves the reused account and returns an actionable warning", async () => {
  const { invoke, calls, writes } = harness({
    createUserError: duplicateError,
    recoveryError: { message: "Recovery service unavailable" },
  });
  const { response, body } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(body.admin_user.reused, true);
  assert.equal(body.admin_user.access_link, null);
  assert.match(body.warning, /link de recuperacao/);
  assert.equal(calls.some((call) => ["deleteAuth", "updateAuth"].includes(call.operation)), false);
  assert.equal(writes.some((row) => row.operation === "delete"), false);
  const audit = writes.find((row) => row.table === "audit_logs").data;
  assert.equal(audit.details.recovery_link_generated, false);
  assert.equal(audit.details.recovery_link_error, "Recovery service unavailable");
  assert.equal(audit.details.admin_user_reused, true);
});

test("audit write failure does not destroy a successfully reused account", async () => {
  const { invoke, calls, writes, logs } = harness({
    createUserError: duplicateError,
    auditError: { message: "Audit storage unavailable" },
  });
  const { response, body } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(body.admin_user.reused, true);
  assert.equal(calls.some((call) => ["deleteAuth", "updateAuth"].includes(call.operation)), false);
  assert.equal(writes.some((row) => row.operation === "delete"), false);
  assert.equal(logs.length, 1);
});

test("fresh profile or role failures roll back only the Auth account created in this request", async () => {
  for (const [option, table] of [["profileError", "profiles"], ["roleError", "user_roles"]]) {
    const { invoke, calls, writes } = harness({ [option]: { code: "23514", message: "Rejected invalid binding" } });
    const { response, body } = await invoke();
    assert.equal(response.status, 400, table);
    assert.equal(body.code, "23514", table);
    assert.deepEqual(calls.filter((call) => call.operation === "deleteAuth"), [{ operation: "deleteAuth", id: freshUserId }], table);
    assert.equal(calls.some((call) => ["rpc", "generateLink"].includes(call.operation)), false, table);
    assert.equal(writes.filter((row) => row.table === "companies" && row.operation === "delete").length, 1, table);
    assert.equal(writes.some((row) => row.table === "audit_logs"), false, table);
  }
});

test("unauthenticated or unauthorized callers cannot create or reuse accounts", async () => {
  for (const authError of ["Nao autorizado", "Sem permissao para criar empresas"]) {
    const { invoke, calls, writes } = harness({ authError, createUserError: duplicateError });
    const { response } = await invoke();
    assert.equal(response.status, authError === "Nao autorizado" ? 401 : 403);
    assert.deepEqual(calls.map((call) => call.operation), ["authorize"]);
    assert.equal(writes.length, 0);
  }
  const { invoke, calls, writes } = harness();
  const { response } = await invoke({}, null);
  assert.equal(response.status, 401);
  assert.deepEqual(calls.map((call) => call.operation), ["authorize"]);
  assert.equal(writes.length, 0);
});
