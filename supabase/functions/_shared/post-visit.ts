import { getFirstName } from "./names.ts";

/** The official template already contains the URL prefix; send only its token. */
export function getPostVisitReviewToken(value: string | null | undefined): string {
  if (typeof value !== "string") return "";

  const candidate = value.trim();
  if (/^[a-fA-F0-9]{32}$/.test(candidate)) return candidate;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.pathname.match(/\/avaliacao\/([a-fA-F0-9]{32})\/?$/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function formatPostVisitDate(value: unknown): string {
  const date = String(value ?? "");
  const [year, month, day] = date.split("-");
  return day && month && year ? `${day}/${month}/${year}` : date;
}

/**
 * false: template with name/date only; true: template requiring a review token.
 * Only explicitly configured templates use this helper; legacy uses its old builder.
 * A required but unavailable token must not produce an incomplete message.
 */
export function buildPlugueChatPostVisitParameters(
  reservation: Record<string, unknown>,
  reviewValue: string | null,
  includeReviewLink: boolean,
): Record<string, string> | null {
  const base = {
    nome: getFirstName(reservation.guest_name),
    data: formatPostVisitDate(reservation.date),
  };

  if (includeReviewLink === false) return base;

  const token = getPostVisitReviewToken(reviewValue);
  if (includeReviewLink === true && !token) return null;

  return { ...base, link_avaliacao: token };
}

/** Evolution/non-official WhatsApp messages use the complete review URL. */
export function renderPostVisitWhatsAppTemplate(
  template: string,
  reservation: Record<string, unknown>,
  reviewUrl: string | null = null,
): string {
  const time = String(reservation.time || "");
  const [hours, minutes] = time.split(":");
  const timeFormatted = hours && minutes ? `${hours}:${minutes}` : time;

  return template
    .replace(/\{nome\}/g, getFirstName(reservation.guest_name))
    .replace(/\{pessoas\}/g, String(reservation.party_size || 1))
    .replace(/\{data\}/g, formatPostVisitDate(reservation.date))
    .replace(/\{hora\}/g, timeFormatted)
    .replace(/\{telefone\}/g, String(reservation.guest_phone || ""))
    .replace(/\{link_avaliacao\}/g, reviewUrl || "");
}
