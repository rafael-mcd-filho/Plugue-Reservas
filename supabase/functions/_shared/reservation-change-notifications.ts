// A public change invalidates text/parameters already composed for the old visit.
// Null revisions deliberately retain the existing dispatch behavior.
export const RESERVATION_CHANGE_MESSAGE_TYPES = new Set([
  "confirmation", "confirmation_message", "reminder_1h", "reminder_24h",
]);

export function reservationChangeRevision(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid reservation change revision");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid reservation change revision");
  // PostgreSQL keeps microseconds; Date alone would merge two rapid changes.
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return (BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6))).toString();
}

export function belongsToCurrentReservationChange(
  reservation: { last_public_change_at?: string | null },
  item: { reservation_change_revision?: string | null; created_at?: string | null },
  _kind: "queue" | "log",
): boolean {
  const revision = reservationChangeRevision(reservation.last_public_change_at);
  if (!revision) return true;
  // Insertion time cannot identify the visit: a delayed scheduler or provider
  // reconciliation may persist an old snapshot after the customer changed it.
  return reservationChangeRevision(item.reservation_change_revision) === revision;
}

export function reservationChangeDispatchKey(base: string, changedAt?: string | null): string {
  const revision = reservationChangeRevision(changedAt);
  return revision ? `${base}:change:${revision}` : base;
}

export async function getReservationChangeMessageEligibility(
  database: any,
  item: { company_id: string; reservation_id?: string | null; type: string; reservation_change_revision?: string | null },
): Promise<{ eligible: boolean; reason?: "reservation_changed" | "lookup_failed" }> {
  if (!item.reservation_id || !RESERVATION_CHANGE_MESSAGE_TYPES.has(item.type)) return { eligible: true };
  try {
    const { data, error } = await database.from("reservations")
      .select("id, company_id, last_public_change_at")
      .eq("id", item.reservation_id).eq("company_id", item.company_id).maybeSingle();
    // Compatibility until this local feature's migration is published.
    if (error?.code === "42703" && !item.reservation_change_revision) return { eligible: true };
    if (error) return { eligible: false, reason: "lookup_failed" };
    if (!data) return { eligible: false, reason: "reservation_changed" };
    return belongsToCurrentReservationChange(data, item, "queue")
      ? { eligible: true } : { eligible: false, reason: "reservation_changed" };
  } catch {
    return { eligible: false, reason: "lookup_failed" };
  }
}
