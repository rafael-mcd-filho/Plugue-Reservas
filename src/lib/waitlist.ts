export const WAITLIST_CALL_TIMEOUT_MINUTES = 5;
export const WAITLIST_CALL_TIMEOUT_MS = WAITLIST_CALL_TIMEOUT_MINUTES * 60 * 1000;

export function getWaitlistCallRemainingMs(calledAt: string | null | undefined, nowMs: number = Date.now()) {
  if (!calledAt) {
    return null;
  }

  const calledAtMs = new Date(calledAt).getTime();
  if (Number.isNaN(calledAtMs)) {
    return null;
  }

  return Math.max(calledAtMs + WAITLIST_CALL_TIMEOUT_MS - nowMs, 0);
}

export function hasWaitlistCallExpired(calledAt: string | null | undefined, nowMs: number = Date.now()) {
  const remainingMs = getWaitlistCallRemainingMs(calledAt, nowMs);
  return remainingMs !== null && remainingMs <= 0;
}

export function formatWaitlistCountdown(remainingMs: number | null) {
  if (remainingMs === null) {
    return '--:--';
  }

  const totalSeconds = Math.max(Math.ceil(remainingMs / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
