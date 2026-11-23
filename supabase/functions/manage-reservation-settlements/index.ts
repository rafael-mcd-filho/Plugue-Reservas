import { corsHeaders, jsonResponse } from "../_shared/reservation-payments.ts";
import {
  assertSettlementAccess, companySafeSettlementSummary, decodePayoutReceipt,
  optionalText, parseWithdrawalCents, PAYOUT_RECEIPTS_BUCKET, requireInteger,
  requireIsoDate, requireUuid, SettlementApiError, validatePayoutDestination,
  validatePayoutReceiptBytes, validateReceiptPath,
} from "../_shared/reservation-settlements-api.ts";

const WITHDRAWAL_STATUSES = ["requested", "under_review", "processing", "paid", "rejected", "cancelled"];
const ADMIN_ACTIONS = ["admin_overview", "save_terms", "transition_withdrawal", "upload_receipt"];
const COMPANY_ACTIONS = ["overview", "save_destination", "request_withdrawal", "cancel_withdrawal", "download_receipt", "withdrawal_detail"];

function checkQuery(result: { error?: any; data?: any; count?: number | null }) {
  if (result.error?.code === "23505" && String(result.error.message).includes("reservation_withdrawals_paid_reference")) {
    throw new SettlementApiError("Esta transferência já foi registrada em outro saque.", 409);
  }
  if (result.error) throw new Error(result.error.message || "Não foi possível consultar os repasses.");
  return result;
}

async function rpc(admin: any, name: string, args: Record<string, unknown>) {
  return checkQuery(await admin.rpc(name, args)).data;
}

async function withdrawal(admin: any, id: string, companyId?: string) {
  let query = admin.from("reservation_withdrawals").select("*").eq("id", id);
  if (companyId) query = query.eq("company_id", companyId);
  const row = checkQuery(await query.maybeSingle()).data;
  if (!row) throw new SettlementApiError("Pedido de saque não encontrado.", 404);
  return row;
}

async function readOverview(admin: any, companyId: string, offset: number, limit: number, isSuperadmin: boolean) {
  await rpc(admin, "release_due_reservation_settlements", { _company_id: companyId });
  const summary = await rpc(admin, "get_reservation_settlement_summary", { _company_id: companyId });
  const [withdrawals, ledger] = await Promise.all([
    admin.from("reservation_withdrawals").select("*", { count: "exact" }).eq("company_id", companyId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1),
    admin.from("reservation_settlement_ledger").select("*", { count: "exact" }).eq("company_id", companyId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1),
  ]);
  checkQuery(withdrawals); checkQuery(ledger);
  const result = { ...summary, withdrawals: withdrawals.data ?? [], ledger: ledger.data ?? [],
    withdrawal_count: withdrawals.count ?? 0, ledger_count: ledger.count ?? 0, offset, limit };
  return isSuperadmin ? result : companySafeSettlementSummary(result);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido." }, 405);
  try {
    // Proofs are small documents, not arbitrary uploads. Limit the JSON body
    // before decoding base64 as well as the decoded document itself.
    if (Number(req.headers.get("Content-Length") || 0) > 7 * 1024 * 1024) throw new SettlementApiError("Requisição maior que o limite permitido.", 413);
    const raw = await req.text();
    if (raw.length > 7 * 1024 * 1024) throw new SettlementApiError("Requisição maior que o limite permitido.", 413);
    let body: Record<string, any>;
    try { body = JSON.parse(raw); } catch { throw new SettlementApiError("Requisição inválida."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettlementApiError("Requisição inválida.");
    const action = body.action;
    const isAdminAction = ADMIN_ACTIONS.includes(action);
    if (!isAdminAction && !COMPANY_ACTIONS.includes(action)) throw new SettlementApiError("Ação inválida.");
    const companyId = isAdminAction ? undefined : requireUuid(body.company_id, "Empresa");
    const context = await assertSettlementAccess(req, companyId, isAdminAction);
    const { supabaseAdmin: admin, actorUser: actor, isSuperadmin } = context;
    const offset = requireInteger(body.offset ?? 0, 0, 1_000_000, "Página");
    const limit = requireInteger(body.limit ?? 25, 1, 100, "Quantidade de registros");

    if (action === "overview") return jsonResponse(await readOverview(admin, companyId!, offset, limit, isSuperadmin));

    if (action === "admin_overview") {
      if (body.status && !WITHDRAWAL_STATUSES.includes(body.status)) throw new SettlementApiError("Situação inválida.");
      const companyOffset = requireInteger(body.company_offset ?? 0, 0, 1_000_000, "Página de empresas");
      const companyLimit = requireInteger(body.company_limit ?? 100, 1, 100, "Quantidade de empresas");
      const companyQuery = admin.from("companies").select("id,name", { count: "exact" }).order("name").order("id")
        .range(companyOffset, companyOffset + companyLimit - 1);
      let requestsQuery = admin.from("reservation_withdrawals").select("*", { count: "exact" })
        .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1);
      if (body.status) requestsQuery = requestsQuery.eq("status", body.status);
      if (body.company_id) requestsQuery = requestsQuery.eq("company_id", requireUuid(body.company_id, "Empresa"));
      const [companies, requests] = await Promise.all([companyQuery, requestsQuery]);
      checkQuery(companies); checkQuery(requests);
      const summaries = [];
      for (const company of companies.data ?? []) {
        await rpc(admin, "release_due_reservation_settlements", { _company_id: company.id });
        const summary = await rpc(admin, "get_reservation_settlement_summary", { _company_id: company.id });
        // The queue is returned separately. Avoid sending each company's bank
        // destination/history unnecessarily in a global summary response.
        const { destination: _destination, withdrawals: _withdrawals, ledger: _ledger, ...position } = summary;
        summaries.push({ ...position, id: company.id, name: company.name });
      }
      const names = new Map((companies.data ?? []).map((company: any) => [company.id, company.name]));
      const missing = [...new Set((requests.data ?? []).map((row: any) => row.company_id))].filter(id => !names.has(id));
      if (missing.length) {
        const extra = checkQuery(await admin.from("companies").select("id,name").in("id", missing));
        for (const company of extra.data ?? []) names.set(company.id, company.name);
      }
      return jsonResponse({ companies: summaries, withdrawals: (requests.data ?? []).map((row: any) => ({ ...row, company_name: names.get(row.company_id) ?? "Empresa" })),
        total: requests.count ?? 0, company_count: companies.count ?? 0, company_offset: companyOffset, company_limit: companyLimit, offset, limit });
    }

    if (action === "save_terms") {
      const releasePolicy = body.release_policy ?? "after_reservation";
      if (!["after_reservation", "on_settlement"].includes(releasePolicy)) throw new SettlementApiError("Regra de liberação inválida.");
      if (typeof body.enabled !== "boolean") throw new SettlementApiError("Informe se os repasses estão habilitados.");
      const methodRates = Object.hasOwn(body, "pix_fee_bps") || Object.hasOwn(body, "credit_card_fee_bps");
      const rates = methodRates ? {
        _pix_fee_bps: requireInteger(body.pix_fee_bps, 0, 10000, "Percentual de Pix"),
        _credit_card_fee_bps: requireInteger(body.credit_card_fee_bps, 0, 10000, "Percentual de cartão"),
      } : { _fee_bps: requireInteger(body.fee_bps, 0, 10000, "Percentual") };
      return jsonResponse(await rpc(admin, methodRates ? "save_reservation_settlement_method_terms" : "save_reservation_settlement_terms", {
        _company_id: requireUuid(body.company_id, "Empresa"), ...rates,
        _release_policy: releasePolicy, _hold_days: requireInteger(body.hold_days ?? 0, 0, 365, "Prazo de liberação"),
        _effective_at: body.effective_at == null || body.effective_at === "now" ? null : requireIsoDate(body.effective_at, "Início da vigência"),
        _enabled: body.enabled, _actor_id: actor.id,
      }));
    }

    if (action === "save_destination") return jsonResponse(await rpc(admin, "save_company_payout_destination", {
      _company_id: companyId, _destination: validatePayoutDestination(body.destination), _actor_id: actor.id,
    }));

    if (action === "request_withdrawal") {
      return jsonResponse(await rpc(admin, "request_reservation_withdrawal", {
        _company_id: companyId, _amount_cents: parseWithdrawalCents(body.amount),
        _idempotency_key: requireUuid(body.idempotency_key, "Identificador do pedido"), _actor_id: actor.id,
      }));
    }

    if (action === "cancel_withdrawal") return jsonResponse(await rpc(admin, "cancel_reservation_withdrawal", {
      _withdrawal_id: requireUuid(body.withdrawal_id, "Pedido de saque"), _company_id: companyId, _actor_id: actor.id,
    }));

    if (action === "withdrawal_detail") {
      const row = await withdrawal(admin, requireUuid(body.withdrawal_id, "Pedido de saque"), companyId);
      const events = checkQuery(await admin.from("reservation_withdrawal_events").select("*").eq("withdrawal_id", row.id).order("created_at").order("id"));
      return jsonResponse({ ...row, events: events.data ?? [] });
    }

    if (action === "upload_receipt") {
      const row = await withdrawal(admin, requireUuid(body.withdrawal_id, "Pedido de saque"));
      if (row.status !== "processing") throw new SettlementApiError("Inicie o pagamento antes de anexar o comprovante.", 409);
      if (row.handled_by !== actor.id) throw new SettlementApiError("Este pagamento está sendo processado por outro administrador.", 409);
      const bytes = decodePayoutReceipt(body.content_base64, body.mime_type);
      const extension = validatePayoutReceiptBytes(bytes, body.mime_type);
      const path = `${row.company_id}/${row.id}/${crypto.randomUUID()}.${extension}`;
      const result = await admin.storage.from(PAYOUT_RECEIPTS_BUCKET).upload(path, bytes, { contentType: body.mime_type, upsert: false, cacheControl: "0" });
      if (result.error) throw new Error("Não foi possível anexar o comprovante. Tente novamente.");
      return jsonResponse({ receipt_path: path });
    }

    if (action === "download_receipt") {
      const row = await withdrawal(admin, requireUuid(body.withdrawal_id, "Pedido de saque"), companyId);
      if (!row.receipt_path || row.status !== "paid") throw new SettlementApiError("Comprovante ainda não disponível.", 404);
      const path = validateReceiptPath(row.receipt_path, row.company_id, row.id);
      const result = await admin.storage.from(PAYOUT_RECEIPTS_BUCKET).createSignedUrl(path, 60, { download: `comprovante-${row.id}.${path.split(".").pop()}` });
      if (result.error || !result.data?.signedUrl) throw new Error("Não foi possível abrir o comprovante.");
      return jsonResponse({ signed_url: result.data.signedUrl });
    }

    if (action === "transition_withdrawal") {
      const status = body.status;
      if (!["under_review", "processing", "paid", "rejected"].includes(status)) throw new SettlementApiError("Mudança de situação inválida.");
      const row = await withdrawal(admin, requireUuid(body.withdrawal_id, "Pedido de saque"));
      const reason = optionalText(body.reason, 1000, "Motivo");
      if (status === "rejected" && !reason) throw new SettlementApiError("Informe o motivo da recusa.");
      let receiptPath = null;
      let reference = null;
      let paidAt = null;
      if (status === "paid") {
        if (row.handled_by !== actor.id) throw new SettlementApiError("Este pagamento está sendo processado por outro administrador.", 409);
        receiptPath = validateReceiptPath(body.receipt_path, row.company_id, row.id);
        reference = optionalText(body.bank_reference, 160, "Referência da transferência");
        if (!reference) throw new SettlementApiError("Informe a referência da transferência.");
        paidAt = requireIsoDate(body.paid_at, "Data do pagamento");
        // A lost HTTP response must not make a confirmed bank transfer look
        // failed. Only the exact same completion can be safely acknowledged.
        if (row.status === "paid") {
          if (row.receipt_path === receiptPath && row.bank_reference === reference && Date.parse(row.paid_at) === Date.parse(paidAt)) return jsonResponse(row);
          throw new SettlementApiError("Este pagamento já foi concluído com outros dados. Consulte o comprovante registrado.", 409);
        }
        if (row.status !== "processing") throw new SettlementApiError("Este pedido não está em pagamento.", 409);
        if (Date.parse(paidAt) > Date.now() + 60_000 || Date.parse(paidAt) < Date.parse(row.created_at)) throw new SettlementApiError("A data do pagamento deve estar entre a solicitação e o momento atual.");
        // A path alone is not evidence of an upload: verify the private object
        // exists and is a permitted document before completing the payout.
        const document = await admin.storage.from(PAYOUT_RECEIPTS_BUCKET).download(receiptPath);
        if (document.error || !document.data) throw new SettlementApiError("Anexe o comprovante antes de concluir o pagamento.");
        if (document.data.size > 5 * 1024 * 1024) throw new SettlementApiError("Comprovante maior que 5 MB.");
        validatePayoutReceiptBytes(new Uint8Array(await document.data.arrayBuffer()), document.data.type);
      }
      return jsonResponse(await rpc(admin, "transition_reservation_withdrawal", {
        _withdrawal_id: row.id, _status: status, _actor_id: actor.id, _reason: reason,
        _receipt_path: receiptPath, _bank_reference: reference, _paid_at: paidAt,
      }));
    }
    throw new SettlementApiError("Ação inválida.");
  } catch (error) {
    if (error instanceof SettlementApiError) return jsonResponse({ error: error.message }, error.status);
    const message = error instanceof Error ? error.message : "Não foi possível concluir a operação de repasse.";
    const status = /não autorizado|nao autorizado/i.test(message) ? 401 : /sem permiss|impersona/i.test(message) ? 403
      : /saldo|situa|status|vig.ncia|destino|configur|comprovante|saque|pagamento|percentual|bloque|idempot|transfer.ncia/i.test(message) ? 409 : 500;
    return jsonResponse({ error: message.slice(0, 500) }, status);
  }
});
