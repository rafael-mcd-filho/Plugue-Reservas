// Helper interno PlugueChat — API oficial do WhatsApp
// hiddenSession é sempre true; o token nunca é exposto ao frontend.

export interface PlugueChatSendPayload {
  from: string;
  to: string;
  body: {
    parameters: Record<string, string>;
    templateId: string;
  };
  options: {
    hiddenSession: true;
  };
}

export type PlugueChatSendResult =
  | { ok: true; provider_message_id: string | null; raw: unknown }
  | { ok: false; error: string; raw: unknown };

export function normalizePhone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (!digits.startsWith("55") && digits.length <= 11) {
    digits = `55${digits}`;
  }
  return digits;
}

export function buildPlugueChatPayload(
  fromNumber: string,
  toPhone: string,
  templateId: string,
  parameters: Record<string, string>,
): PlugueChatSendPayload {
  return {
    from: normalizePhone(fromNumber),
    to: normalizePhone(toPhone),
    body: { parameters, templateId },
    options: { hiddenSession: true },
  };
}

export async function sendPlugueChatMessage(
  apiUrl: string,
  apiToken: string,
  payload: PlugueChatSendPayload,
): Promise<PlugueChatSendResult> {
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken}`,
      },
      body: JSON.stringify(payload),
    });

    let raw: unknown = null;
    try { raw = await response.json(); } catch { /* ignore */ }

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${JSON.stringify(raw)}`, raw };
    }

    const data = raw as Record<string, unknown> | null;
    const providerId =
      typeof data?.id === "string" ? data.id
      : typeof data?.messageId === "string" ? data.messageId
      : null;

    return { ok: true, provider_message_id: providerId, raw };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error", raw: null };
  }
}

// ----------------------------------------------------------------
// Construtores de parâmetros por tipo de automação
// Os nomes de parâmetro são fixos e devem coincidir com os templates cadastrados na Meta.
// ----------------------------------------------------------------

function formatDate(date: string): string {
  const [y, m, d] = date.split("-");
  return d && m && y ? `${d}/${m}/${y}` : date;
}

function formatTime(time: string): string {
  const [h, m] = time.split(":");
  return h && m ? `${h}:${m}` : time;
}

export function buildReservationParameters(
  type: string,
  reservation: Record<string, unknown>,
  trackingUrl: string | null = null,
): Record<string, string> {
  const nome = String(reservation.guest_name ?? "");
  const pessoas = String(reservation.party_size ?? 1);
  const data = formatDate(String(reservation.date ?? ""));
  const hora = formatTime(String(reservation.time ?? ""));
  const link = trackingUrl ?? "";

  switch (type) {
    case "confirmation_message":
      return { nome, pessoas, data, hora, link_acompanhamento: link };
    case "cancellation_message":
      return { nome, data, hora, link_acompanhamento: link };
    case "reminder_24h":
      return { nome, data, hora, pessoas };
    case "reminder_1h":
      return { nome, hora, pessoas };
    case "post_visit":
      return { nome, data };
    case "no_show_message":
      return { nome, data, hora };
    default:
      return { nome, pessoas, data, hora, link_acompanhamento: link };
  }
}

export function buildWaitlistParameters(
  type: string,
  waitlist: Record<string, unknown>,
  trackingUrl: string | null = null,
): Record<string, string> {
  const nome = String(waitlist.guest_name ?? "");
  const pessoas = String(waitlist.party_size ?? 1);
  const posicao = String(waitlist.position ?? "");
  const link = trackingUrl ?? "";

  switch (type) {
    case "waitlist_entry":
      return { nome, pessoas, posicao, link_acompanhamento: link };
    case "waitlist_called":
      return { nome, tempo_limite_minutos: "5" };
    default:
      return { nome, pessoas, posicao, link_acompanhamento: link };
  }
}

export function buildBirthdayParameters(nome: string, daysUntil = 4): Record<string, string> {
  return { nome, dias_para_aniversario: String(daysUntil) };
}

// ----------------------------------------------------------------
// Enfileirar mensagem na pluguechat_message_queue com idempotência
// ----------------------------------------------------------------

export async function enqueuePlugueChatMessage(
  supabaseAdmin: any,
  payload: {
    company_id: string;
    reservation_id?: string | null;
    waitlist_id?: string | null;
    phone: string;
    type: string;
    template_id: string;
    template_name?: string | null;
    parameters: Record<string, string>;
    scheduled_for?: string;
    expires_at?: string;
    idempotency_key?: string | null;
  },
): Promise<"inserted" | "duplicate"> {
  const now = new Date();
  const scheduledFor = payload.scheduled_for ?? now.toISOString();
  const expiresAt = payload.expires_at ?? new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();

  const { error } = await supabaseAdmin
    .from("pluguechat_message_queue")
    .insert({
      company_id: payload.company_id,
      reservation_id: payload.reservation_id ?? null,
      waitlist_id: payload.waitlist_id ?? null,
      phone: payload.phone,
      type: payload.type,
      template_id: payload.template_id,
      template_name: payload.template_name ?? null,
      parameters: payload.parameters,
      scheduled_for: scheduledFor,
      expires_at: expiresAt,
      idempotency_key: payload.idempotency_key ?? null,
      status: "pending",
    });

  if (error) {
    if (error.code === "23505") return "duplicate";
    throw new Error(`Erro ao enfileirar mensagem PlugueChat: ${error.message}`);
  }

  return "inserted";
}

// Verifica se já existe entrada na fila ou log para este reservation_id + type
export async function plugueChatAlreadyQueued(
  supabaseAdmin: any,
  companyId: string,
  reservationId: string,
  type: string,
): Promise<boolean> {
  const [{ data: logData }, { data: queueData }] = await Promise.all([
    supabaseAdmin
      .from("pluguechat_message_logs")
      .select("id")
      .eq("company_id", companyId)
      .eq("reservation_id", reservationId)
      .eq("type", type)
      .limit(1),
    supabaseAdmin
      .from("pluguechat_message_queue")
      .select("id")
      .eq("company_id", companyId)
      .eq("reservation_id", reservationId)
      .eq("type", type)
      .not("status", "eq", "cancelled")
      .limit(1),
  ]);

  return (logData && logData.length > 0) || (queueData && queueData.length > 0);
}

// Resolve o canal ativo de uma empresa
export async function getCompanyChannel(
  supabaseAdmin: any,
  companyId: string,
): Promise<"evolution" | "pluguechat_official"> {
  const { data } = await supabaseAdmin
    .from("companies")
    .select("whatsapp_automation_channel")
    .eq("id", companyId)
    .single();

  return (data?.whatsapp_automation_channel as "evolution" | "pluguechat_official") ?? "evolution";
}

// Resolve channels para múltiplas empresas de uma vez
export async function getCompanyChannels(
  supabaseAdmin: any,
  companyIds: string[],
): Promise<Map<string, "evolution" | "pluguechat_official">> {
  const { data } = await supabaseAdmin
    .from("companies")
    .select("id, whatsapp_automation_channel")
    .in("id", companyIds);

  const map = new Map<string, "evolution" | "pluguechat_official">();
  for (const row of data ?? []) {
    map.set(row.id, row.whatsapp_automation_channel ?? "evolution");
  }
  return map;
}

// Resolve config da empresa (from_number e token) para envio
export async function getPlugueChatCompanyConfig(
  supabaseAdmin: any,
  companyId: string,
): Promise<{ fromNumber: string; apiToken: string; apiUrl: string } | null> {
  const { data } = await supabaseAdmin
    .from("pluguechat_official_configs")
    .select("from_number, api_token_encrypted, status")
    .eq("company_id", companyId)
    .maybeSingle();

  if (!data || !data.api_token_encrypted || !data.from_number) return null;

  const apiUrl = Deno.env.get("PLUGUECHAT_API_URL") ?? "";
  if (!apiUrl) return null;

  return {
    fromNumber: data.from_number,
    apiToken: data.api_token_encrypted,
    apiUrl,
  };
}
