// Offline regression tests: no Supabase credentials, fetches or production calls.
// Run: node --test supabase/functions/_shared/support-authorization.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as rules from "./support-authorization.ts";

const actorId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const companyId = "00000000-0000-4000-8000-000000000003";
const otherCompanyId = "00000000-0000-4000-8000-000000000004";
const sessionId = "00000000-0000-4000-8000-000000000005";
const delegation = { id: sessionId, actorUserId: actorId, userId: targetId, companyId, effectiveRole: "operator" };

function evaluate(file, modules, deno = { env: { get: () => "offline-value" } }) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const run = vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, crypto: globalThis.crypto, console,
  });
  run(exports, (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  }, deno);
  return exports;
}

function authHarness({ role = "support", context = delegation, permission = true } = {}) {
  const auditEntries = [];
  const calls = [];
  const admin = {
    auth: { admin: { getUserById: async (id) => ({ data: { user: { id } }, error: null }) } },
    from: (table) => ({
      select: () => ({ eq: async () => ({
        data: table === "user_roles" ? [{ role, company_id: role === "admin" ? companyId : null }] : [], error: null,
      }) }),
      insert: async (entry) => { auditEntries.push(entry); return { error: null }; },
    }),
  };
  const createClient = (_url, key, options) => {
    if (!options) return admin;
    return {
      auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
      rpc: async (name, args) => {
        calls.push({ name, args, headers: options.global.headers });
        return { data: name === "get_support_impersonation_context" ? context : permission, error: null };
      },
    };
  };
  const auth = evaluate("./internal-auth.ts", {
    "https://esm.sh/@supabase/supabase-js@2.99.0": { createClient },
    "./support-authorization.ts": rules,
  });
  const request = (session = sessionId) => new Request("https://offline.invalid/functions/v1/company-action", {
    method: "POST", headers: { Authorization: "Bearer offline-token", ...(session ? { "x-support-impersonation": session } : {}) },
  });
  return { auth, request, calls, auditEntries };
}

test("delegation is accepted only for the exact actor and session, company and company role", () => {
  assert.equal(rules.validateSupportImpersonationContext(delegation, actorId, sessionId).userId, targetId);
  for (const invalid of [null, {}, { ...delegation, id: otherCompanyId },
    { ...delegation, actorUserId: targetId }, { ...delegation, companyId: null },
    { ...delegation, effectiveRole: "superadmin" }, { ...delegation, effectiveRole: "support" }]) {
    assert.throws(() => rules.validateSupportImpersonationContext(invalid, actorId, sessionId), /Sem permissao/);
  }
});

test("grants preserve an explicit empty list and reject malformed IDs", () => {
  assert.deepEqual(rules.normalizeSupportCompanyIds([]), []);
  assert.deepEqual(rules.normalizeSupportCompanyIds([companyId, companyId]), [companyId]);
  for (const input of [undefined, null, "all", ["*"], [null], [companyId, "invalid"]]) {
    assert.throws(() => rules.normalizeSupportCompanyIds(input), /support_company_ids/);
  }
});

test("company role allowlist rejects global roles and unsupported roles", () => {
  for (const role of ["admin", "operator"]) rules.assertAssignableManagedRole(role, false);
  rules.assertAssignableManagedRole("support", true);
  assert.throws(() => rules.assertAssignableManagedRole("support", false), /Sem permissao/);
  for (const role of ["superadmin", "owner", undefined, "", {}]) {
    assert.throws(() => rules.assertAssignableManagedRole(role, true), /Perfil invalido/);
  }
});

test("support cannot invoke company endpoints before entering a validated session", async () => {
  const { auth, request, calls } = authHarness();
  await assert.rejects(auth.assertUserCanAccessCompany(request(null), companyId), /inicie uma sessao/);
  assert.equal(calls.length, 0);
});

test("valid support requests keep actor token while using only target company and role", async () => {
  const { auth, request, calls, auditEntries } = authHarness();
  const context = await auth.assertUserCanAccessCompany(request(), companyId, ["operator"], "reservations_view");
  assert.equal(context.user.id, targetId);
  assert.equal(context.actorUser.id, actorId);
  assert.equal(context.isSuperadmin, false);
  assert.deepEqual(Array.from(context.roleRows, (row) => ({ ...row })), [{ role: "operator", company_id: companyId }]);
  assert.equal(calls[0].name, "get_support_impersonation_context");
  assert.equal(calls[0].args, undefined);
  assert.equal(calls[0].headers.Authorization, "Bearer offline-token");
  assert.equal(calls[0].headers["x-support-impersonation"], sessionId);
  assert.equal(calls[1].args._user_id, actorId);
  assert.equal(auditEntries[0].user_id, actorId);
  assert.equal(auditEntries[0].details.impersonated_user_id, targetId);
});

test("support cannot change tenant, elevate operator, or bypass an individual permission", async () => {
  const { auth, request } = authHarness();
  await assert.rejects(auth.assertUserCanAccessCompany(request(), otherCompanyId), /Sem permissao/);
  await assert.rejects(auth.assertUserCanAccessCompany(request(), companyId, ["admin"]), /Sem permissao/);
  await assert.rejects(auth.assertSuperadmin(request()), /Sem permissao/);
  const denied = authHarness({ permission: false });
  await assert.rejects(denied.auth.assertUserCanAccessCompany(denied.request(), companyId, ["operator"], "reservations_view"), /Sem permissao/);
  assert.equal(denied.auditEntries.length, 0);
});

test("revoked sessions and fabricated delegation headers fail closed", async () => {
  const revoked = authHarness({ context: null });
  await assert.rejects(revoked.auth.assertUserCanAccessCompany(revoked.request(), companyId), /Sem permissao/);
  const admin = authHarness({ role: "admin" });
  await assert.rejects(admin.auth.assertUserCanAccessCompany(admin.request(), companyId), /Sem permissao/);
  await assert.rejects(revoked.auth.assertUserCanAccessCompany(revoked.request("bad-id"), companyId), /Sem permissao/);
});

function manageHarness({ actorRole = "superadmin", targetRole = "support", impersonation = null, availableCompanyIds = [] } = {}) {
  let handler;
  const writes = [];
  const grants = [];
  const profile = { id: targetId, company_id: null, is_active: true, full_name: "Target", email: "target@example.test" };
  function query(table) {
    let operation = "select";
    let data;
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      maybeSingle: () => builder,
      update: (value) => { operation = "update"; data = value; return builder; },
      insert: (value) => { operation = "insert"; data = value; return builder; },
      delete: () => { operation = "delete"; return builder; },
      then: (resolve) => {
        if (operation !== "select") writes.push({ table, operation, data });
        const result = operation !== "select" ? null : table === "profiles" ? profile
          : table === "user_roles" ? [{ user_id: targetId, role: targetRole, company_id: targetRole === "support" ? null : companyId }]
          : table === "companies" ? availableCompanyIds.map((id) => ({ id })) : [];
        return Promise.resolve({ data: result, error: null }).then(resolve);
      },
    };
    return builder;
  }
  const admin = {
    from: query,
    auth: { admin: {
      createUser: async (value) => { writes.push({ operation: "createUser", data: value }); return { data: { user: { id: targetId } }, error: null }; },
      updateUserById: async () => { writes.push({ operation: "updateAuth" }); return { error: null }; },
      deleteUser: async () => { writes.push({ operation: "deleteAuth" }); return { error: null }; },
    } },
  };
  const userClient = { rpc: async (name, args) => { grants.push({ name, args }); return { data: true, error: null }; } };
  const requestContext = {
    supabaseAdmin: admin, supabaseUser: userClient,
    actorUser: { id: actorId }, user: { id: impersonation?.userId ?? actorId },
    isSupport: actorRole === "support", impersonation,
    roleRows: [{ role: impersonation?.effectiveRole ?? actorRole,
      company_id: impersonation?.companyId ?? (actorRole === "admin" ? companyId : null) }],
  };
  evaluate("../manage-user/index.ts", {
    "../_shared/internal-auth.ts": { getRequestAuthContext: async () => requestContext, impersonationAuditDetails: () => ({}) },
    "../_shared/support-authorization.ts": rules,
  }, { env: { get: () => undefined }, serve: (fn) => { handler = fn; } });
  const invoke = async (body) => {
    const response = await handler(new Request("https://offline.invalid/manage-user", {
      method: "POST", headers: { Authorization: "Bearer offline-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    return { response, body: await response.json() };
  };
  return { invoke, writes, grants };
}

test("company admins cannot create support or any noncompany role through seed_users", async () => {
  for (const role of ["support", "superadmin", "owner"]) {
    const { invoke, writes } = manageHarness({ actorRole: "admin" });
    const { body } = await invoke({ action: "seed_users", users: [{ role, company_id: companyId, email: "support@example.test", password: "offline-password" }] });
    assert.ok(body.results[0].error);
    assert.equal(writes.length, 0);
  }
});

test("only global superadmin creates support with null company and default empty grants", async () => {
  const { invoke, writes, grants } = manageHarness();
  const { body } = await invoke({ action: "seed_users", users: [{ role: "support", company_id: null, email: "support@example.test", full_name: "Support", password: "offline-password" }] });
  assert.equal(body.results[0].id, targetId);
  assert.equal(writes.find((row) => row.table === "profiles").data.company_id, null);
  const roleWrite = writes.find((row) => row.table === "user_roles");
  assert.equal(roleWrite.data.role, "support");
  assert.equal(roleWrite.data.company_id, null);
  assert.equal(grants[0].name, "set_support_company_access");
  assert.deepEqual(JSON.parse(JSON.stringify(grants[0].args)), { _user_id: targetId, _company_ids: [] });
});

test("company admins cannot modify, delete, ban or reset credentials of support", async () => {
  for (const action of ["update_user", "delete_user", "toggle_ban", "reset_password", "set_user_password"]) {
    const { invoke, writes, grants } = manageHarness({ actorRole: "admin" });
    const { response } = await invoke({ action, user_id: targetId, password: "offline-password", role: "operator", company_id: companyId });
    assert.equal(response.status, 403, action);
    assert.equal(writes.length, 0, action);
    assert.equal(grants.length, 0, action);
  }
});

test("support body cannot override the delegated company or edit target login credentials", async () => {
  const { invoke, writes } = manageHarness({ actorRole: "support", impersonation: { ...delegation, effectiveRole: "admin" } });
  const mismatch = await invoke({ action: "list_users", scope_company_id: otherCompanyId, effective_role: "admin", impersonated_by_superadmin: true });
  assert.equal(mismatch.response.status, 403);
  const ownAccount = await invoke({ action: "update_my_account", email: "changed@example.test" });
  assert.equal(ownAccount.response.status, 403);
  assert.equal(writes.length, 0);
});

test("support grants are validated before changing user data or roles", async () => {
  const { invoke, writes, grants } = manageHarness();
  const { response } = await invoke({ action: "update_user", user_id: targetId,
    role: "support", full_name: "Changed", support_company_ids: [otherCompanyId] });
  assert.equal(response.status, 400);
  assert.equal(writes.length, 0);
  assert.equal(grants.length, 0);
});

test("editing support preserves omitted grants and an explicit empty list clears grants", async () => {
  const preserve = manageHarness();
  const preserved = await preserve.invoke({ action: "update_user", user_id: targetId, role: "support" });
  assert.equal(preserved.response.status, 200);
  assert.equal(preserve.grants.length, 0);
  const clear = manageHarness();
  const cleared = await clear.invoke({ action: "update_user", user_id: targetId, role: "support", support_company_ids: [] });
  assert.equal(cleared.response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(clear.grants[0].args)), { _user_id: targetId, _company_ids: [] });
});

test("support creation sends selected companies only through the authenticated grant RPC", async () => {
  const { invoke, grants } = manageHarness({ availableCompanyIds: [companyId, otherCompanyId] });
  const { body } = await invoke({ action: "seed_users", users: [{ role: "support", email: "support@example.test",
    password: "offline-password", support_company_ids: [companyId, otherCompanyId, companyId] }] });
  assert.equal(body.results[0].id, targetId);
  assert.deepEqual(JSON.parse(JSON.stringify(grants[0].args)), { _user_id: targetId, _company_ids: [companyId, otherCompanyId] });
});

test("company admin cannot turn a company user into a global support user", async () => {
  const { invoke, writes } = manageHarness({ actorRole: "admin", targetRole: "operator" });
  const { response } = await invoke({ action: "update_user", user_id: targetId, role: "support", support_company_ids: [] });
  assert.equal(response.status, 403);
  assert.equal(writes.length, 0);
});

test("the delegated queue worker scopes pending and provider reconciliation to the chosen company", async () => {
  for (const requestedCompanyId of [companyId, null]) {
    const queries = [];
    let handler;
    const admin = { from: (table) => {
      const filters = [];
      const builder = { then: (resolve) => {
        queries.push({ table, filters });
        return Promise.resolve({ data: [], error: null }).then(resolve);
      } };
      for (const name of ["select", "eq", "order", "limit", "lte", "gt", "lt", "is", "not", "gte"]) {
        builder[name] = (...args) => { filters.push([name, ...args]); return builder; };
      }
      return builder;
    } };
    evaluate("../process-pluguechat-message-queue/index.ts", {
      "../_shared/internal-auth.ts": { createSupabaseAdminClient: () => admin, isAuthorizedInternalJob: async () => true },
      "../_shared/post-visit.ts": {}, "../_shared/pluguechat.ts": {},
    }, { env: { get: () => undefined }, serve: (fn) => { handler = fn; } });
    const response = await handler(new Request("https://offline.invalid/queue", {
      method: "POST", body: JSON.stringify(requestedCompanyId ? { company_id: requestedCompanyId } : {}),
    }));
    assert.equal(response.status, 200);
    assert.equal(queries.length, 3); // pending, provider_queued and sent status reconciliation
    for (const query of queries) {
      const scope = query.filters.find((filter) => filter[0] === "eq" && filter[1] === "company_id");
      assert.equal(scope?.[2] ?? null, requestedCompanyId);
    }
  }
});

test("reservation automation rejects mixed reservation/waitlist payloads before reading either tenant", async () => {
  let handler;
  let reads = 0;
  evaluate("../reservation-events/index.ts", {
    "../_shared/internal-auth.ts": { createSupabaseAdminClient: () => ({ from: () => { reads++; throw new Error("Unexpected query"); } }) },
    "../_shared/whatsapp.ts": {}, "../_shared/pluguechat.ts": {}, "../_shared/names.ts": {},
  }, { env: { get: () => undefined }, serve: (fn) => { handler = fn; } });
  for (const event of ["waitlist_added", "waitlist_called", "reservation_created", "reservation_cancelled", "unknown"]) {
    const response = await handler(new Request("https://offline.invalid/event", {
      method: "POST", body: JSON.stringify({ event, reservation: { id: targetId }, waitlist: { id: otherCompanyId } }),
    }));
    assert.equal(response.status, 400, event);
  }
  assert.equal(reads, 0);
});

function paymentHarness() {
  const foreignReservation = { id: targetId, company_id: otherCompanyId, status: "pending_payment", guest_name: "Private foreign customer" };
  const payment = { id: sessionId, company_id: companyId, reservation_id: targetId,
    payment_token: "offline-payment-token", asaas_payment_id: "pay_offline", status: "paid",
    expires_at: "2099-01-01T00:00:00Z", metadata: {}, cancelled_at: null };
  const company = { id: companyId, name: "Allowed company" };
  const writes = [];
  const records = { reservation_payments: [payment], reservations: [foreignReservation], companies: [company] };
  const admin = { from: (table) => {
    let operation = "select";
    let input;
    let single = false;
    const predicates = [];
    const builder = {
      select: () => builder,
      eq: (key, value) => { predicates.push((row) => row[key] === value); return builder; },
      in: (key, values) => { predicates.push((row) => values.includes(row[key])); return builder; },
      maybeSingle: () => { single = true; return builder; },
      single: () => { single = true; return builder; },
      order: () => builder,
      limit: () => builder,
      update: (value) => { operation = "update"; input = value; return builder; },
      insert: (value) => { operation = "insert"; input = value; return builder; },
      then: (resolve) => {
        const selected = (records[table] ?? []).filter((row) => predicates.every((predicate) => predicate(row)));
        if (operation === "update") {
          for (const row of selected) {
            writes.push({ table, id: row.id, input });
            Object.assign(row, input);
          }
        } else if (operation === "insert") writes.push({ table, input });
        return Promise.resolve({ data: single ? selected[0] ?? null : selected, error: null }).then(resolve);
      },
    };
    return builder;
  } };
  return { admin, payment, foreignReservation, writes };
}

test("payment endpoints cannot expose or refund a reservation belonging to another company", async () => {
  const sharedPayments = evaluate("./reservation-payments.ts", {});
  for (const endpoint of ["get-reservation-payment", "check-reservation-payment", "select-reservation-payment-method", "refund-reservation-payment"]) {
    const { admin, writes } = paymentHarness();
    let handler;
    let providerRefunds = 0;
    evaluate(`../${endpoint}/index.ts`, {
      "../_shared/internal-auth.ts": { createSupabaseAdminClient: () => admin, assertUserCanAccessCompany: async () => ({ supabaseAdmin: admin }) },
      "../_shared/reservation-payments.ts": sharedPayments,
      "../_shared/asaas.ts": { refundAsaasPayment: async () => { providerRefunds++; } },
    }, { env: { get: () => undefined }, serve: (fn) => { handler = fn; } });
    const response = await handler(new Request(`https://offline.invalid/${endpoint}`, {
      method: "POST", body: JSON.stringify({ company_id: companyId, payment_token: "offline-payment-token", billing_type: "PIX" }),
    }));
    const body = await response.text();
    assert.notEqual(response.status, 200, endpoint);
    assert.equal(body.includes("Private foreign customer"), false, endpoint);
    assert.equal(providerRefunds, 0, endpoint);
    assert.equal(writes.length, 0, endpoint);
  }
});

test("provider confirmation cannot update a reservation outside the payment company", async () => {
  const sharedPayments = evaluate("./reservation-payments.ts", {});
  const { admin, payment, foreignReservation, writes } = paymentHarness();
  await assert.rejects(sharedPayments.confirmReservationPayment(admin, payment, "RECEIVED", "offline-test"), /Reserva nao encontrada/);
  assert.equal(foreignReservation.status, "pending_payment");
  assert.equal(writes.length, 0);
});

test("provider refund outcomes cannot cancel a reservation outside the payment company", async () => {
  const sharedPayments = evaluate("./reservation-payments.ts", {});
  const { admin, payment, foreignReservation, writes } = paymentHarness();
  await sharedPayments.markReservationPaymentProviderOutcome(admin, payment, "refunded", { source: "offline-test", asaasStatus: "REFUNDED" });
  assert.equal(foreignReservation.status, "pending_payment");
  assert.equal(writes.some((write) => write.table === "reservations"), false);
});
