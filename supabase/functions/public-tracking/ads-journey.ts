export interface AdsJourneyAttributionInput {
  page_url?: string | null;
  path?: string | null;
  event_source_url?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  pr_ad?: string | null;
}

export interface AdsJourneyActivityContext {
  companyId: string;
  anonymousId: string;
  sessionId: string;
  journeyId: string | null;
  reservationId: string | null;
  eventName: string;
  eventId: string;
  receivedAt: string;
}

export interface AdsJourneyRpcArgs {
  _company_id: string;
  _anonymous_id: string;
  _activity_at: string;
  _utm_source: string | null;
  _utm_medium: string | null;
  _utm_campaign: string | null;
  _pr_ad: string | null;
  _session_id: string;
  _journey_id: string | null;
  _reservation_id: string | null;
  _event_name: string;
  _event_id: string;
}

export interface AdsJourneyRpcClient {
  rpc: (
    functionName: string,
    args: AdsJourneyRpcArgs,
  ) => PromiseLike<{
    error: {
      code?: string | null;
      message?: string | null;
    } | null;
  }>;
}

export interface AdsJourneyLogger {
  warn: (message: string, context: Record<string, unknown>) => void;
}

const DEFAULT_RPC_TIMEOUT_MS = 1_500;
const MAX_CUSTOM_MARKER_LENGTH = 512;

function nullableText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function readQueryParameter(value: unknown, parameterName: string) {
  const text = nullableText(value);
  if (!text) return null;

  try {
    const parsedUrl = new URL(text, "https://public-tracking.invalid");
    return nullableText(parsedUrl.searchParams.get(parameterName));
  } catch {
    return null;
  }
}

export function resolvePrAd(input: AdsJourneyAttributionInput) {
  const marker = nullableText(input.pr_ad)
    ?? readQueryParameter(input.event_source_url, "pr_ad")
    ?? readQueryParameter(input.page_url, "pr_ad")
    ?? readQueryParameter(input.path, "pr_ad");

  return marker?.slice(0, MAX_CUSTOM_MARKER_LENGTH) ?? null;
}

function resolveUtmMedium(input: AdsJourneyAttributionInput) {
  const candidates = [
    nullableText(input.utm_medium),
    readQueryParameter(input.event_source_url, "utm_medium"),
    readQueryParameter(input.page_url, "utm_medium"),
    readQueryParameter(input.path, "utm_medium"),
  ].filter((value): value is string => value !== null);

  return candidates.find((value) => value.toLowerCase() === "paid")
    ?? candidates[0]
    ?? null;
}

/**
 * This mirrors the paid-touch rule for diagnostics and tests. The database RPC
 * applies the same rule again and remains the source of truth.
 */
export function isPaidJourneyTouch(input: AdsJourneyAttributionInput) {
  const utmMedium = resolveUtmMedium(input);
  return utmMedium?.toLowerCase() === "paid" || resolvePrAd(input) !== null;
}

export function buildAdsJourneyRpcArgs(
  input: AdsJourneyAttributionInput,
  context: AdsJourneyActivityContext,
): AdsJourneyRpcArgs {
  return {
    _company_id: context.companyId,
    _anonymous_id: context.anonymousId,
    // Deliberately use the Edge receipt time. `occurred_at` is public input and
    // must not be able to move the rolling attribution window arbitrarily.
    _activity_at: context.receivedAt,
    _utm_source: nullableText(input.utm_source),
    _utm_medium: resolveUtmMedium(input),
    _utm_campaign: nullableText(input.utm_campaign),
    _pr_ad: resolvePrAd(input),
    _session_id: context.sessionId,
    _journey_id: context.journeyId,
    _reservation_id: context.reservationId,
    _event_name: context.eventName,
    _event_id: context.eventId,
  };
}

export async function recordAdsJourneyActivityBestEffort(
  client: AdsJourneyRpcClient,
  args: AdsJourneyRpcArgs,
  logger: AdsJourneyLogger = console,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`RPC timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const request = Promise.resolve(
      client.rpc("record_ads_journey_activity", args),
    );
    const { error } = await Promise.race([request, timeout]);

    if (!error) return true;

    logger.warn("[public-tracking] Ads journey attribution failed", {
      company_id: args._company_id,
      event_name: args._event_name,
      error_code: error.code ?? null,
      error_message: error.message ?? "RPC error",
    });
  } catch (error) {
    logger.warn("[public-tracking] Ads journey attribution failed", {
      company_id: args._company_id,
      event_name: args._event_name,
      error_message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  return false;
}
