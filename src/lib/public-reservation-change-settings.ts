export const DEFAULT_PUBLIC_RESERVATION_CHANGE_MIN_NOTICE_MINUTES = 120;
export const MAX_PUBLIC_RESERVATION_CHANGE_MIN_NOTICE_MINUTES = 10080;

export function parsePublicReservationChangeMinNoticeMinutes(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const minutes = Number(value);
  return Number.isInteger(minutes)
    && minutes >= 0
    && minutes <= MAX_PUBLIC_RESERVATION_CHANGE_MIN_NOTICE_MINUTES
    ? minutes
    : null;
}
