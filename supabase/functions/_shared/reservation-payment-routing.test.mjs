// Offline integration boundaries: never contacts Supabase or Asaas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, modules, deno = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports, require, Deno) { ${compiled}\n})`, {
    Request, Response, URL, crypto: globalThis.crypto, console,
  })(exports, (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  }, { env: { get: () => undefined }, ...deno });
  return exports;
}
const payments = load('./reservation-payments.ts', {});
const requirements = load('./reservation-payment-requirement.ts', {});
const globalConfig = {
  status: 'configured', provider_account_id: 'wallet-platform', api_environment: 'sandbox',
  credentials: { apiToken: 'private-platform-token', environment: 'sandbox' },
};
const reservation = {
  id: 'reservation-one', company_id: 'company-one', guest_name: 'Cliente',
  guest_phone: '+5511999999999', date: '2026-12-01', time: '19:00', party_size: 2,
  public_tracking_code: 'public-reference', status: 'pending_payment',
};

function createHarness({ config = globalConfig, paymentError = false, legacyConfigured = false, termsRecord = { id: 'terms-one', enabled: true }, rule = {} } = {}) {
  const writes = [];
  let handler;
  const admin = {
    rpc: async (name, args) => {
      if (name === 'company_feature_enabled') return { data: true, error: null };
      assert.equal(name, 'create_public_reservation');
      assert.equal(args._status, 'pending_payment');
      return { data: { ...reservation, ...args._reservation }, error: null };
    },
    from: (table) => {
      assert.ok(['reservation_payment_rules', 'reservation_payments', 'reservation_payment_events', 'reservations', 'company_asaas_configs', 'reservation_settlement_terms'].includes(table));
      let operation = 'select';
      let patch;
      const filters = [];
      const builder = {
        select: () => builder, eq: (...filter) => { filters.push(filter); return builder; },
        is: () => builder, lte: () => builder, gte: () => builder,
        order: () => builder, limit: () => builder, maybeSingle: () => builder, single: () => builder,
        insert: (data) => { operation = 'insert'; patch = data; return builder; },
        update: (data) => { operation = 'update'; patch = data; return builder; },
        then: (resolve) => {
          if (operation !== 'select') writes.push({ table, operation, patch, filters });
          if (table === 'company_asaas_configs') return Promise.resolve({ data: legacyConfigured ? { status: 'configured' } : null, error: null }).then(resolve);
          if (table === 'reservation_settlement_terms') return Promise.resolve({ data: termsRecord, error: null }).then(resolve);
          if (table === 'reservation_payment_rules') return Promise.resolve({ data: {
            id: 'rule-one', amount_type: 'per_person', base_amount: 25, pix_enabled: true,
            pix_amount: 20, payment_deadline_minutes: 10, ...rule,
          }, error: null }).then(resolve);
          if (table === 'reservation_payments') return Promise.resolve({
            data: paymentError ? null : { id: 'payment-one', ...patch },
            error: paymentError ? { message: 'persistence failed' } : null,
          }).then(resolve);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  load('../create-reservation-payment/index.ts', {
    '../_shared/phone.ts': { normalizePhoneE164: (value) => value },
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => admin },
    '../_shared/reservation-asaas-config.ts': { getGlobalReservationAsaasConfig: async () => config },
    '../_shared/reservation-payment-requirement.ts': requirements,
    '../_shared/reservation-payments.ts': payments,
  }, { serve: (fn) => { handler = fn; } });
  return { writes, request: () => handler(new Request('https://offline.invalid', {
    method: 'POST', body: JSON.stringify({ company_id: 'company-one', reservation }),
  })) };
}

test('new public payments snapshot the central account and tenant without saving credentials', async () => {
  const context = createHarness();
  const response = await context.request();
  assert.equal(response.status, 200);
  const payment = context.writes.find((row) => row.table === 'reservation_payments').patch;
  assert.equal(payment.company_id, 'company-one');
  assert.equal(payment.reservation_id, reservation.id);
  assert.equal(payment.base_amount, 50);
  assert.equal(payment.metadata.asaas_account_scope, 'platform');
  assert.equal(payment.metadata.asaas_account_id, 'wallet-platform');
  assert.equal(payment.metadata.asaas_environment, 'sandbox');
  assert.ok(!JSON.stringify(payment).includes('private-platform-token'));
  assert.ok(!(await response.text()).includes('private-platform-token'));
});

test('new reservations snapshot single-payment card terms even when an old rule permits parcels', async () => {
  const context = createHarness({ rule: { credit_card_enabled: true, credit_card_amount: 25, max_credit_card_installments: 21 } });
  assert.equal((await context.request()).status, 200);
  const payment = context.writes.find(row => row.table === 'reservation_payments').patch;
  assert.equal(payment.rule_snapshot.max_credit_card_installments, 1);
  assert.equal(payment.rule_snapshot.credit_card_amount_total, 50);
  assert.equal(payment.rule_snapshot.pix_amount_total, 40, 'Pix pricing is unchanged');
});

function cardSelectionHarness({ status = 'awaiting_method', cap = 21, storedCap = null } = {}) {
  let handler;
  let storedPayment = {
    id: 'payment-one', company_id: 'company-one', reservation_id: reservation.id,
    payment_token: 'public-payment-token', status, billing_type: status === 'pending' ? 'CREDIT_CARD' : null,
    base_amount: 50, max_installments: storedCap, expires_at: '2099-01-01T00:00:00Z',
    rule_snapshot: { name: 'Legacy rule', amount_type: 'fixed', credit_card_enabled: true, credit_card_amount: 50, max_credit_card_installments: cap },
    metadata: {},
  };
  const providerCalls = [];
  const admin = { from(table) {
    let patch;
    const builder = {
      select: () => builder, eq: () => builder, maybeSingle: () => builder, insert: () => builder,
      update: value => { patch = value; return builder; },
      then(resolve) {
        if (patch) storedPayment = { ...storedPayment, ...patch };
        return Promise.resolve({ data: table === 'reservation_payments' ? storedPayment
          : table === 'reservations' ? reservation : table === 'companies' ? { id: 'company-one', name: 'Restaurant' } : null, error: null }).then(resolve);
      },
    };
    return builder;
  } };
  load('../select-reservation-payment-method/index.ts', {
    '../_shared/phone.ts': { asaasCustomerPhone: value => value },
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => admin },
    '../_shared/reservation-asaas-config.ts': { getReservationAsaasCredentials: async () => globalConfig.credentials },
    '../_shared/reservation-payments.ts': payments,
    '../_shared/asaas.ts': {
      createAsaasPaymentLink: async (credentials, payload) => {
        assert.equal(credentials.apiToken, globalConfig.credentials.apiToken);
        providerCalls.push(payload); return { id: 'new-card-link', url: 'https://offline.invalid/card', externalReference: payload.externalReference };
      },
      getAsaasPaymentLinkUrl: link => link.url,
    },
  }, { serve: fn => { handler = fn; } });
  return { providerCalls, stored: () => storedPayment, request: (extra = {}) => handler(new Request('https://offline.invalid', {
    method: 'POST', body: JSON.stringify({ payment_token: 'public-payment-token', billing_type: 'CREDIT_CARD', ...extra }),
  })) };
}

test('new card links are detached even for old unselected snapshots and malicious installment fields', async () => {
  for (const cap of [2, 21]) {
    const context = cardSelectionHarness({ cap });
    const response = await context.request({ max_installments: cap, maxInstallmentCount: cap, chargeType: 'INSTALLMENT' });
    assert.equal(response.status, 200);
    assert.equal(context.providerCalls.length, 1);
    assert.equal(context.providerCalls[0].chargeType, 'DETACHED');
    assert.equal(context.providerCalls[0].maxInstallmentCount, undefined);
    assert.equal(context.stored().max_installments, 1);
    assert.equal(context.stored().rule_snapshot.max_credit_card_installments, cap, 'The original snapshot remains historical');
    assert.equal((await response.json()).max_credit_card_installments, 1);
  }
});

test('existing pending card links retain their actual historical installment cap without provider changes', async () => {
  const context = cardSelectionHarness({ status: 'pending', cap: 2, storedCap: 2 });
  const response = await context.request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).max_credit_card_installments, 2);
  assert.equal(context.providerCalls.length, 0);
  assert.equal(context.stored().max_installments, 2);
});

test('an unconfigured central account cannot create a payment reservation', async () => {
  const context = createHarness({ config: null });
  assert.equal((await context.request()).status, 409);
  assert.equal(context.writes.length, 0);
});

test('new central production payments require explicit enabled commercial terms before reserving capacity', async () => {
  const config = { ...globalConfig, api_environment: 'production', credentials: { ...globalConfig.credentials, environment: 'production' } };
  for (const termsRecord of [null, { id: 'disabled-terms', enabled: false }]) {
    const context = createHarness({ config, termsRecord });
    const response = await context.request();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'SETTLEMENT_TERMS_REQUIRED');
    assert.equal(context.writes.length, 0);
  }
  assert.equal((await createHarness({ config }).request()).status, 200);
});

test('existing company accounts keep taking payments until central setup is initialized', async () => {
  const context = createHarness({ config: null, legacyConfigured: true });
  assert.equal((await context.request()).status, 200);
  const payment = context.writes.find((row) => row.table === 'reservation_payments').patch;
  assert.equal(payment.metadata.asaas_account_scope, 'company');
  assert.equal(payment.metadata.asaas_account_id, undefined);
  assert.equal(payment.company_id, 'company-one');
});

test('an initialized central account never silently switches new payments back to a company account', async () => {
  const context = createHarness({ config: { ...globalConfig, status: 'error' }, legacyConfigured: true });
  assert.equal((await context.request()).status, 409);
  assert.equal(context.writes.length, 0);
});

test('payment persistence failure releases the pending reservation in the same tenant', async () => {
  const context = createHarness({ paymentError: true });
  assert.equal((await context.request()).status, 500);
  const cleanup = context.writes.find((row) => row.table === 'reservations');
  assert.equal(cleanup.patch.status, 'payment_cancelled');
  assert.ok(cleanup.filters.some(([key, value]) => key === 'company_id' && value === 'company-one'));
  assert.ok(cleanup.filters.some(([key, value]) => key === 'status' && value === 'pending_payment'));
});

test('Pix creation uses the central sandbox account and keeps reconciliation and QR data on the correct tenant', async () => {
  let handler;
  let storedPayment = {
    id: 'payment-one', company_id: 'company-one', reservation_id: reservation.id,
    payment_token: 'public-payment-token', status: 'awaiting_method', base_amount: 50,
    expires_at: '2099-01-01T00:00:00Z', rule_snapshot: {
      name: 'Sinal', amount_type: 'per_person', pix_enabled: true, pix_amount: 20,
    }, metadata: { asaas_account_scope: 'platform', asaas_account_id: 'wallet-platform', asaas_environment: 'sandbox' },
  };
  const providerCalls = [];
  const admin = { from: (table) => {
    let patch;
    const filters = [];
    const builder = {
      select: () => builder, eq: (...filter) => { filters.push(filter); return builder; },
      update: (value) => { patch = value; return builder; }, insert: () => builder,
      maybeSingle: () => builder,
      then: (resolve) => {
        if (patch) {
          assert.equal(table, 'reservation_payments');
          assert.ok(filters.some(([key, value]) => key === 'id' && value === 'payment-one'));
          assert.ok(filters.some(([key, value]) => key === 'status' && value === 'awaiting_method'));
          storedPayment = { ...storedPayment, ...patch };
        }
        const data = table === 'reservation_payments' ? storedPayment
          : table === 'reservations' ? reservation : table === 'companies' ? { id: 'company-one', name: 'Restaurante Um' } : null;
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  } };
  load('../select-reservation-payment-method/index.ts', {
    '../_shared/internal-auth.ts': { createSupabaseAdminClient: () => admin },
    '../_shared/reservation-asaas-config.ts': { getReservationAsaasCredentials: async (_admin, payment) => {
      assert.equal(payment.company_id, 'company-one');
      return globalConfig.credentials;
    } },
    '../_shared/phone.ts': { asaasCustomerPhone: (value) => value },
    '../_shared/asaas.ts': {
      createAsaasCustomer: async (credential, payload) => {
        providerCalls.push({ credential, payload }); return { id: 'customer-one' };
      },
      createAsaasPayment: async (credential, payload) => {
        providerCalls.push({ credential, payload }); return { id: 'pay-pix', status: 'PENDING' };
      },
      getAsaasPixQrCode: async (credential, paymentId) => {
        assert.equal(credential.environment, 'sandbox'); assert.equal(paymentId, 'pay-pix');
        return { encodedImage: 'base64-qr', payload: 'pix-copy-paste' };
      },
    },
    '../_shared/reservation-payments.ts': payments,
  }, { serve: (fn) => { handler = fn; } });
  const response = await handler(new Request('https://offline.invalid', {
    method: 'POST', body: JSON.stringify({ payment_token: 'public-payment-token', billing_type: 'PIX', cpf: '11144477735' }),
  }));
  assert.equal(response.status, 200);
  for (const call of providerCalls) {
    assert.equal(call.credential.apiToken, globalConfig.credentials.apiToken);
    assert.equal(call.credential.environment, 'sandbox');
  }
  assert.equal(providerCalls[1].payload.value, 40);
  assert.ok(providerCalls[1].payload.description.includes('Empresa company-one'));
  assert.ok(providerCalls[1].payload.description.includes('Reserva reservation-one'));
  assert.equal(storedPayment.company_id, 'company-one');
  assert.equal(storedPayment.asaas_payment_id, 'pay-pix');
  const output = await response.json();
  assert.equal(output.status, 'pending');
  assert.equal(output.amount, 40);
  assert.equal(output.pix_copy_paste, 'pix-copy-paste');
  assert.ok(!JSON.stringify(output).includes('private-platform-token'));
});

test('company config preview is read-only and never returns central API or webhook secrets', async () => {
  let handler;
  load('../save-asaas-config/index.ts', {
    '../_shared/internal-auth.ts': { assertUserCanAccessCompany: async () => ({ supabaseAdmin: {} }) },
    '../_shared/reservation-asaas-config.ts': { getGlobalReservationAsaasConfig: async (_admin, options) => {
      assert.equal(options.decryptToken, false);
      return { ...globalConfig, api_token_encrypted: 'ciphertext', webhook_auth_token: 'secret-webhook' };
    } },
    '../_shared/reservation-payments.ts': payments,
  }, { serve: (fn) => { handler = fn; } });
  const request = (action, extra = {}) => handler(new Request('https://offline.invalid', {
    method: 'POST', body: JSON.stringify({ company_id: 'company-one', action, ...extra }),
  }));
  const response = await request('get');
  const preview = await response.json();
  assert.equal(preview.managed_by_platform, true);
  assert.equal(preview.from_company_account, false);
  assert.equal(preview.webhook_auth_token, null);
  assert.ok(!JSON.stringify(preview).includes('private-platform-token'));
  assert.ok(!JSON.stringify(preview).includes('ciphertext'));
  assert.equal((await request('save', { api_token: 'tenant-token' })).status, 403);
  assert.equal((await request('test', { api_token: 'tenant-token' })).status, 403);
});

test('installment refund never refunds a single installment as the entire reservation', async () => {
  let handler;
  let refundCount = 0;
  const record = { ...reservation, company_id: 'company-one', status: 'paid',
    reservation_id: reservation.id, asaas_payment_id: 'pay-first-installment' };
  const admin = { from: (table) => {
    const builder = {
      select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: table === 'reservation_payments' ? record : table === 'reservations' ? reservation : { id: 'company-one' }, error: null }),
    };
    return builder;
  } };
  load('../refund-reservation-payment/index.ts', {
    '../_shared/reservation-settlement-sync.ts': { synchronizeReservationSettlement: async () => null },
    '../_shared/internal-auth.ts': { assertUserCanAccessCompany: async () => ({ supabaseAdmin: admin }) },
    '../_shared/reservation-asaas-config.ts': { getReservationAsaasCredentials: async () => globalConfig.credentials },
    '../_shared/asaas.ts': {
      getAsaasPayment: async () => ({ id: 'pay-first-installment', installment: 'installment-group' }),
      refundAsaasPayment: async () => { refundCount++; },
    },
    '../_shared/reservation-payments.ts': payments,
  }, { serve: (fn) => { handler = fn; } });
  const response = await handler(new Request('https://offline.invalid', {
    method: 'POST', body: JSON.stringify({ company_id: 'company-one', payment_token: 'token' }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'INSTALLMENT_REFUND_REQUIRES_ASAAS');
  assert.equal(refundCount, 0);
});
