export type WhatsAppDiagnosticCode =
  | "evolution_not_configured"
  | "instance_not_configured"
  | "instance_disconnected"
  | "invalid_payload"
  | "provider_request_failed"
  | "provider_invalid_response"
  | "unknown_error";

export interface WhatsAppFailureDetails {
  code: WhatsAppDiagnosticCode;
  title: string;
  message: string;
  provider_status?: number | null;
  provider_message?: string | null;
  raw?: string | null;
}

export type WhatsAppAcceptedLogStatus = "pending" | "sent";

export const WHATSAPP_ACCEPTED_LOG_STATUSES: ReadonlyArray<WhatsAppAcceptedLogStatus> = ["pending", "sent"];

export type WhatsAppSendResult =
  | {
      ok: true;
      data: unknown;
      raw: string | null;
      provider_status_text: string | null;
    }
  | {
      ok: false;
      error: WhatsAppFailureDetails;
    };

function extractMessage(value: unknown): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    const nested = [
      candidate.message,
      candidate.error,
      candidate.msg,
      candidate.response,
      candidate.details,
      candidate.detail,
    ];

    for (const item of nested) {
      const extracted = extractMessage(item);
      if (extracted) return extracted;
    }
  }

  return null;
}

function buildFailure(
  code: WhatsAppDiagnosticCode,
  title: string,
  message: string,
  extra: Partial<WhatsAppFailureDetails> = {},
): WhatsAppSendResult {
  return {
    ok: false,
    error: {
      code,
      title,
      message,
      provider_status: extra.provider_status ?? null,
      provider_message: extra.provider_message ?? null,
      raw: extra.raw ?? null,
    },
  };
}

export function formatPhoneForWhatsApp(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (!digits.startsWith("55") && digits.length <= 11) {
    digits = `55${digits}`;
  }
  return digits;
}

export function buildReservationDispatchKey(type: string, reservationId: string): string {
  return `reservation:${reservationId}:${type}`;
}

export function buildWaitlistDispatchKey(type: string, waitlistId: string): string {
  return `waitlist:${waitlistId}:${type}`;
}

export function buildBirthdayDispatchKey(companyId: string, targetDateKey: string, phone: string): string {
  return `birthday:${companyId}:${targetDateKey}:${formatPhoneForWhatsApp(phone)}`;
}

export async function claimWhatsAppDispatch(
  supabase: { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: boolean | null; error: { message: string } | null }> },
  {
    deliveryKey,
    companyId,
    automationType,
    reservationId = null,
    phone = null,
    lockSeconds = 900,
  }: {
    deliveryKey: string;
    companyId: string;
    automationType: string;
    reservationId?: string | null;
    phone?: string | null;
    lockSeconds?: number;
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("claim_whatsapp_dispatch", {
    _delivery_key: deliveryKey,
    _company_id: companyId,
    _automation_type: automationType,
    _reservation_id: reservationId,
    _phone: phone,
    _lock_seconds: lockSeconds,
  });

  if (error) {
    throw new Error(`Erro ao bloquear dispatch do WhatsApp: ${error.message}`);
  }

  return data === true;
}

export async function finalizeWhatsAppDispatch(
  supabase: { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ error: { message: string } | null }> },
  {
    deliveryKey,
    status,
    errorDetails = null,
  }: {
    deliveryKey: string;
    status: "accepted" | "queued" | "failed";
    errorDetails?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.rpc("finalize_whatsapp_dispatch", {
    _delivery_key: deliveryKey,
    _status: status,
    _error: errorDetails,
  });

  if (error) {
    throw new Error(`Erro ao finalizar dispatch do WhatsApp: ${error.message}`);
  }
}

export async function enqueueWhatsAppMessageOnce(
  supabase: {
    from: (table: string) => {
      insert: (payload: Record<string, unknown>) => Promise<{ error: { code?: string; message: string } | null }>;
    };
  },
  payload: {
    company_id: string;
    reservation_id?: string | null;
    phone: string;
    message: string;
    type: string;
    error_details?: string | null;
    attempts?: number;
    max_attempts?: number;
    status?: string;
    expires_at?: string;
    last_attempt_at?: string | null;
  },
): Promise<"inserted" | "duplicate"> {
  const { error } = await supabase.from("whatsapp_message_queue").insert(payload);

  if (!error) {
    return "inserted";
  }

  if (error.code === "23505") {
    return "duplicate";
  }

  throw new Error(`Erro ao gravar fila do WhatsApp: ${error.message}`);
}

export function randomIntInRange(min: number, max: number): number {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function sendWhatsAppPresence(
  evolutionUrl: string,
  evolutionToken: string,
  instanceName: string,
  phone: string,
  presence: "composing" | "recording" | "paused" = "composing",
  delayMs = 2000,
): Promise<void> {
  try {
    await fetch(`${evolutionUrl}/chat/sendPresence/${instanceName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: evolutionToken,
      },
      body: JSON.stringify({ number: phone, presence, delay: delayMs }),
    });
  } catch {
    // Best-effort: falhas de presenca nao devem bloquear o envio real.
  }
}

export function serializeWhatsAppFailure(error: WhatsAppFailureDetails): string {
  return JSON.stringify({
    code: error.code,
    title: error.title,
    message: error.message,
    provider_status: error.provider_status ?? null,
    provider_message: error.provider_message ?? null,
    raw: error.raw ?? null,
  });
}

export function buildEvolutionNotConfiguredFailure(): WhatsAppSendResult {
  return buildFailure(
    "evolution_not_configured",
    "Evolution API nao configurada",
    "Configure a URL e o token da Evolution API nas configuracoes do sistema.",
  );
}

export function buildInstanceNotConfiguredFailure(): WhatsAppSendResult {
  return buildFailure(
    "instance_not_configured",
    "Instancia nao configurada",
    "Nenhuma instancia de WhatsApp foi criada para esta empresa.",
  );
}

export function buildInstanceDisconnectedFailure(): WhatsAppSendResult {
  return buildFailure(
    "instance_disconnected",
    "Instancia desconectada",
    "A instancia de WhatsApp desta empresa esta desconectada.",
  );
}

export function getWhatsAppAcceptedLogStatus(
  result: Extract<WhatsAppSendResult, { ok: true }>,
): WhatsAppAcceptedLogStatus {
  const providerStatus = result.provider_status_text?.trim().toUpperCase() ?? null;

  if (providerStatus === "SENT" || providerStatus === "DELIVERED" || providerStatus === "READ") {
    return "sent";
  }

  return "pending";
}

export interface SendWhatsAppTextOptions {
  typing?: boolean;
  typingMinMs?: number;
  typingMaxMs?: number;
}

export async function sendWhatsAppText(
  evolutionUrl: string,
  evolutionToken: string,
  instanceName: string,
  phone: string,
  message: string,
  options: SendWhatsAppTextOptions = {},
): Promise<WhatsAppSendResult> {
  if (!phone || !message) {
    return buildFailure(
      "invalid_payload",
      "Dados invalidos para envio",
      "Telefone e mensagem sao obrigatorios para enviar pelo WhatsApp.",
    );
  }

  const shouldType = options.typing !== false;
  if (shouldType) {
    const typingMs = randomIntInRange(options.typingMinMs ?? 2000, options.typingMaxMs ?? 4000);
    await sendWhatsAppPresence(evolutionUrl, evolutionToken, instanceName, phone, "composing", typingMs);
    await sleep(typingMs);
  }

  let response: Response;
  try {
    response = await fetch(`${evolutionUrl}/message/sendText/${instanceName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: evolutionToken,
      },
      body: JSON.stringify({ number: phone, text: message }),
    });
  } catch (error) {
    return buildFailure(
      "unknown_error",
      "Falha ao acessar a Evolution API",
      error instanceof Error ? error.message : "Erro desconhecido ao enviar a mensagem.",
    );
  }

  const raw = await response.text();
  let parsed: unknown = null;

  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (response.ok) {
    const providerStatusText = typeof parsed === "object" && parsed && "status" in parsed
      && typeof (parsed as Record<string, unknown>).status === "string"
      ? ((parsed as Record<string, unknown>).status as string)
      : null;

    return {
      ok: true,
      data: parsed ?? raw,
      raw: raw || null,
      provider_status_text: providerStatusText,
    };
  }

  const providerMessage = extractMessage(parsed) ?? extractMessage(raw);
  const lowerText = `${providerMessage ?? ""} ${raw}`.toLowerCase();

  if (lowerText.includes("not connected") || lowerText.includes("disconnected") || lowerText.includes("closed")) {
    return buildFailure(
      "instance_disconnected",
      "Instancia desconectada",
      "A Evolution API informou que a instancia esta desconectada.",
      {
        provider_status: response.status,
        provider_message: providerMessage,
        raw: raw || null,
      },
    );
  }

  if (!parsed && raw) {
    return buildFailure(
      "provider_invalid_response",
      "Resposta invalida da Evolution API",
      "A Evolution API retornou uma resposta que nao foi possivel interpretar.",
      {
        provider_status: response.status,
        raw: raw || null,
      },
    );
  }

  return buildFailure(
    "provider_request_failed",
    "Falha ao enviar mensagem",
    providerMessage ?? "A Evolution API rejeitou o envio da mensagem.",
    {
      provider_status: response.status,
      provider_message: providerMessage,
      raw: raw || null,
    },
  );
}

export interface SendWhatsAppMediaOptions extends SendWhatsAppTextOptions {
  mediaType?: "image" | "video" | "document";
  mimeType?: string;
  fileName?: string;
}

export async function sendWhatsAppMedia(
  evolutionUrl: string,
  evolutionToken: string,
  instanceName: string,
  phone: string,
  mediaUrl: string,
  caption: string,
  options: SendWhatsAppMediaOptions = {},
): Promise<WhatsAppSendResult> {
  if (!phone || !mediaUrl) {
    return buildFailure(
      "invalid_payload",
      "Dados invalidos para envio",
      "Telefone e imagem sao obrigatorios para enviar midia pelo WhatsApp.",
    );
  }

  const shouldType = options.typing !== false;
  if (shouldType) {
    const typingMs = randomIntInRange(options.typingMinMs ?? 2000, options.typingMaxMs ?? 4000);
    await sendWhatsAppPresence(evolutionUrl, evolutionToken, instanceName, phone, "composing", typingMs);
    await sleep(typingMs);
  }

  const mediaType = options.mediaType ?? "image";
  const mimeType = options.mimeType ?? "image/jpeg";
  const fileName = options.fileName ?? `broadcast.${mimeType.includes("png") ? "png" : "jpg"}`;

  let response: Response;
  try {
    response = await fetch(`${evolutionUrl}/message/sendMedia/${instanceName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: evolutionToken,
      },
      body: JSON.stringify({
        number: phone,
        mediatype: mediaType,
        mimetype: mimeType,
        caption: caption || "",
        media: mediaUrl,
        fileName,
      }),
    });
  } catch (error) {
    return buildFailure(
      "unknown_error",
      "Falha ao acessar a Evolution API",
      error instanceof Error ? error.message : "Erro desconhecido ao enviar a midia.",
    );
  }

  const raw = await response.text();
  let parsed: unknown = null;

  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (response.ok) {
    const providerStatusText = typeof parsed === "object" && parsed && "status" in parsed
      && typeof (parsed as Record<string, unknown>).status === "string"
      ? ((parsed as Record<string, unknown>).status as string)
      : null;

    return {
      ok: true,
      data: parsed ?? raw,
      raw: raw || null,
      provider_status_text: providerStatusText,
    };
  }

  const providerMessage = extractMessage(parsed) ?? extractMessage(raw);
  const lowerText = `${providerMessage ?? ""} ${raw}`.toLowerCase();

  if (lowerText.includes("not connected") || lowerText.includes("disconnected") || lowerText.includes("closed")) {
    return buildFailure(
      "instance_disconnected",
      "Instancia desconectada",
      "A Evolution API informou que a instancia esta desconectada.",
      {
        provider_status: response.status,
        provider_message: providerMessage,
        raw: raw || null,
      },
    );
  }

  if (!parsed && raw) {
    return buildFailure(
      "provider_invalid_response",
      "Resposta invalida da Evolution API",
      "A Evolution API retornou uma resposta que nao foi possivel interpretar.",
      {
        provider_status: response.status,
        raw: raw || null,
      },
    );
  }

  return buildFailure(
    "provider_request_failed",
    "Falha ao enviar midia",
    providerMessage ?? "A Evolution API rejeitou o envio da midia.",
    {
      provider_status: response.status,
      provider_message: providerMessage,
      raw: raw || null,
    },
  );
}
