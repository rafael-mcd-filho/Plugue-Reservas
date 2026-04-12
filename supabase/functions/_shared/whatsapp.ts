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

export async function sendWhatsAppText(
  evolutionUrl: string,
  evolutionToken: string,
  instanceName: string,
  phone: string,
  message: string,
): Promise<WhatsAppSendResult> {
  if (!phone || !message) {
    return buildFailure(
      "invalid_payload",
      "Dados invalidos para envio",
      "Telefone e mensagem sao obrigatorios para enviar pelo WhatsApp.",
    );
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
