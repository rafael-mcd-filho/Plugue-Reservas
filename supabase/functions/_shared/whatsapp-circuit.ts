import type { WhatsAppFailureDetails } from "./whatsapp.ts";

const FAILURE_THRESHOLD = 3;
const PAUSE_DURATION_MINUTES = 15;

const BREAKER_ERROR_CODES = new Set<WhatsAppFailureDetails["code"]>([
  "provider_request_failed",
  "provider_invalid_response",
  "instance_disconnected",
  "unknown_error",
]);

export interface CircuitState {
  open: boolean;
  resumesAt: Date | null;
  consecutiveFailures: number;
}

type SupabaseLike = {
  from: (table: string) => any;
};

export async function checkWhatsAppCircuit(
  supabase: SupabaseLike,
  companyId: string,
): Promise<CircuitState> {
  const { data } = await supabase
    .from("whatsapp_circuit_state")
    .select("consecutive_failures, paused_until")
    .eq("company_id", companyId)
    .maybeSingle();

  if (!data) {
    return { open: false, resumesAt: null, consecutiveFailures: 0 };
  }

  const resumesAt = data.paused_until ? new Date(data.paused_until) : null;
  const open = resumesAt !== null && resumesAt.getTime() > Date.now();

  return {
    open,
    resumesAt,
    consecutiveFailures: data.consecutive_failures ?? 0,
  };
}

export async function recordWhatsAppSuccess(
  supabase: SupabaseLike,
  companyId: string,
): Promise<void> {
  await supabase.from("whatsapp_circuit_state").upsert(
    {
      company_id: companyId,
      consecutive_failures: 0,
      paused_until: null,
      last_error_code: null,
      last_error_message: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );
}

export async function recordWhatsAppFailure(
  supabase: SupabaseLike,
  companyId: string,
  error: WhatsAppFailureDetails,
): Promise<CircuitState> {
  const countsToBreaker = BREAKER_ERROR_CODES.has(error.code);

  const { data: current } = await supabase
    .from("whatsapp_circuit_state")
    .select("consecutive_failures")
    .eq("company_id", companyId)
    .maybeSingle();

  const currentFailures: number = current?.consecutive_failures ?? 0;
  const nextFailures = countsToBreaker ? currentFailures + 1 : currentFailures;
  const shouldPause = nextFailures >= FAILURE_THRESHOLD;
  const pausedUntil = shouldPause
    ? new Date(Date.now() + PAUSE_DURATION_MINUTES * 60 * 1000)
    : null;

  await supabase.from("whatsapp_circuit_state").upsert(
    {
      company_id: companyId,
      consecutive_failures: nextFailures,
      paused_until: pausedUntil ? pausedUntil.toISOString() : null,
      last_error_code: error.code,
      last_error_message: error.message,
      last_error_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );

  return {
    open: shouldPause,
    resumesAt: pausedUntil,
    consecutiveFailures: nextFailures,
  };
}
