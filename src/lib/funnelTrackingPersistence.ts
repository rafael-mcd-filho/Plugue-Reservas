const TRACKING_ANONYMOUS_KEY = 'pg_tracking_anonymous_id';
const TRACKING_STATES_KEY = 'pg_tracking_states_v2';
const PENDING_EVENTS_KEY = 'pg_tracking_pending_events_v2';
const DEAD_LETTERS_KEY = 'pg_tracking_dead_letters_v1';
const TRACKING_STATE_KEY_PREFIX = 'pg_tracking_state_v3:';
const PENDING_EVENT_KEY_PREFIX = 'pg_tracking_pending_event_v3:';

const LEGACY_TRACKING_STATE_KEY = 'pg_tracking_state_v1';
const LEGACY_PENDING_EVENTS_KEY = 'pg_tracking_pending_events';

// Pending payloads keep their original event_id for idempotent replay. When the
// queue reaches 80 items, the oldest entry becomes a redacted diagnostic record.
export const MAX_PENDING_TRACKING_EVENTS = 80;
export const MAX_TRACKING_COMPANY_SCOPES = 20;
export const TRACKING_PENDING_EVENT_TTL_MS = 24 * 60 * 60 * 1_000;
// Dead letters never contain the event payload/PII and expire on read after 7 days.
export const MAX_TRACKING_DEAD_LETTERS = 200;
export const TRACKING_DEAD_LETTER_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface FunnelTrackingIdentity {
  company_id?: string;
  company_slug?: string;
}

export interface PersistedTrackingState extends FunnelTrackingIdentity {
  anonymous_id: string;
  session_id?: string | null;
  pending_session_id?: string | null;
  pending_session_event_id?: string | null;
  journey_id?: string | null;
  journey_confirmed?: boolean;
  touched_at?: string;
}

export interface FunnelQueuePayload extends Record<string, unknown> {
  event_id: string;
  event_name: string;
  anonymous_id: string;
  company_id?: string;
  slug?: string;
}

export interface PendingFunnelEvent<TPayload extends FunnelQueuePayload = FunnelQueuePayload> {
  payload: TPayload;
  dedupeKey: string;
  retryCount: number;
  nextAttemptAt: number;
  queuedAt: string;
  lastError?: string;
}

export type FunnelDeadLetterReason = 'permanent_error' | 'expired' | 'queue_capacity' | 'scope_capacity';

export interface FunnelDeadLetter {
  eventId: string;
  eventName: string;
  scope: string;
  retryCount: number;
  queuedAt: string;
  nextAttemptAt: number;
  lastError?: string;
  reason: FunnelDeadLetterReason;
  deadLetteredAt: string;
}

interface EnqueueResult<TPayload extends FunnelQueuePayload> {
  queued: boolean;
  overflow: FunnelDeadLetter[];
  persisted: boolean;
}

interface FailureResult {
  retryCount: number;
  deadLetter: FunnelDeadLetter | null;
}

interface FailureOptions {
  now?: number;
  permanent?: boolean;
}

const memoryStorage = new Map<string, string>();
const volatileStorageKeys = new Set<string>();
let memoryVisitorId: string | null = null;

function listRawKeys(prefix?: string): string[] {
  const keys = new Set(memoryStorage.keys());
  if (typeof window !== 'undefined') {
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key) keys.add(key);
      }
    } catch {
      // Memory-backed keys remain enumerable when localStorage is blocked.
    }
  }
  return [...keys].filter((key) => !prefix || key.startsWith(prefix));
}

function readRaw(key: string): string | null {
  if (volatileStorageKeys.has(key)) return memoryStorage.get(key) ?? null;

  if (typeof window !== 'undefined') {
    try {
      const value = window.localStorage.getItem(key);
      if (value !== null) {
        memoryStorage.set(key, value);
        return value;
      }
      memoryStorage.delete(key);
      return null;
    } catch {
      // The in-memory mirror keeps tracking functional in restricted browsers.
    }
  }

  return memoryStorage.get(key) ?? null;
}

function writeRaw(key: string, value: string): boolean {
  memoryStorage.set(key, value);

  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, value);
    volatileStorageKeys.delete(key);
    return true;
  } catch {
    // Quota/security failures fall back to the in-memory mirror.
    volatileStorageKeys.add(key);
    return false;
  }
}

function removeRaw(key: string): void {
  memoryStorage.delete(key);

  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
    volatileStorageKeys.delete(key);
  } catch {
    // Nothing else is required: the in-memory copy is already gone.
    volatileStorageKeys.add(key);
  }
}

function readRecord<T>(key: string): Record<string, T> {
  try {
    const parsed = JSON.parse(readRaw(key) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, T>;
  } catch {
    return {};
  }
}

function writeRecord<T>(key: string, record: Record<string, T>): boolean {
  return writeRaw(key, JSON.stringify(record));
}

function isDurablyStored(key: string): boolean {
  if (volatileStorageKeys.has(key) || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function isQueuePayload(value: unknown): value is FunnelQueuePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<FunnelQueuePayload>;
  return typeof payload.event_id === 'string'
    && typeof payload.event_name === 'string'
    && typeof payload.anonymous_id === 'string';
}

function isPendingEvent(value: unknown): value is PendingFunnelEvent {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PendingFunnelEvent>;
  return isQueuePayload(item.payload)
    && typeof item.dedupeKey === 'string'
    && typeof item.retryCount === 'number'
    && typeof item.nextAttemptAt === 'number'
    && typeof item.queuedAt === 'string';
}

const DURABLE_URL_FIELDS = ['page_url', 'event_source_url', 'referrer', 'path'] as const;
const DURABLE_QUERY_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'pr_ad',
]);

function sanitizeDurableUrl(value: unknown, pathOnly: boolean): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;

  const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  try {
    const parsed = new URL(value, 'https://tracking.invalid');
    const allowed = new URLSearchParams();
    for (const [key, queryValue] of parsed.searchParams.entries()) {
      if (DURABLE_QUERY_KEYS.has(key.toLowerCase())) allowed.append(key, queryValue);
    }
    const query = allowed.toString();
    const safePath = `${parsed.pathname}${query ? `?${query}` : ''}`;
    if (pathOnly || !absolute) return safePath;
    return `${parsed.origin}${safePath}`;
  } catch {
    // Invalid URLs are retained only up to the first query/fragment delimiter,
    // preventing arbitrary tokens from becoming durable browser data.
    return value.split(/[?#]/, 1)[0];
  }
}

function redactDurablePayload<TPayload extends FunnelQueuePayload>(payload: TPayload): TPayload {
  const redacted = { ...payload };
  delete redacted.user_data;
  for (const field of DURABLE_URL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(redacted, field)) {
      redacted[field] = sanitizeDurableUrl(redacted[field], field === 'path');
    }
  }
  return redacted;
}

function isDeadLetter(value: unknown): value is FunnelDeadLetter {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FunnelDeadLetter>;
  return typeof item.eventId === 'string'
    && typeof item.eventName === 'string'
    && typeof item.scope === 'string'
    && typeof item.retryCount === 'number'
    && typeof item.queuedAt === 'string'
    && typeof item.nextAttemptAt === 'number'
    && typeof item.deadLetteredAt === 'string'
    && (
      item.reason === 'permanent_error'
      || item.reason === 'expired'
      || item.reason === 'queue_capacity'
      || item.reason === 'scope_capacity'
    );
}

interface StoredPendingEnvelope<TPayload extends FunnelQueuePayload = FunnelQueuePayload> {
  scope: string;
  item: PendingFunnelEvent<TPayload>;
}

function pendingEventStorageKey(scope: string, eventId: string) {
  return `${PENDING_EVENT_KEY_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(eventId)}`;
}

function writePendingItem<TPayload extends FunnelQueuePayload>(
  scope: string,
  item: PendingFunnelEvent<TPayload>,
): boolean {
  return writeRaw(pendingEventStorageKey(scope, item.payload.event_id), JSON.stringify({
    scope,
    item: {
      ...item,
      payload: redactDurablePayload(item.payload),
    },
  } satisfies StoredPendingEnvelope<TPayload>));
}

function removePendingItem(scope: string, eventId: string): void {
  removeRaw(pendingEventStorageKey(scope, eventId));
}

function migrateV2QueueMap(): void {
  const raw = readRaw(PENDING_EVENTS_KEY);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeRaw(PENDING_EVENTS_KEY);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    removeRaw(PENDING_EVENTS_KEY);
    return;
  }

  const retained: Record<string, PendingFunnelEvent[]> = {};
  for (const [scope, items] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue;
    for (const rawItem of items) {
      if (!isPendingEvent(rawItem)) continue;
      const item = {
        ...rawItem,
        payload: redactDurablePayload(rawItem.payload),
      };
      if (!writePendingItem(scope, item)) (retained[scope] ??= []).push(item);
    }
  }

  if (Object.keys(retained).length > 0) {
    // Fail-safe migration: the old durable copy is retained until every
    // per-event write succeeds, but any legacy user_data is redacted first.
    writeRaw(PENDING_EVENTS_KEY, JSON.stringify(retained));
  } else {
    removeRaw(PENDING_EVENTS_KEY);
  }
}

function readQueueMap<TPayload extends FunnelQueuePayload>(): Record<string, PendingFunnelEvent<TPayload>[]> {
  migrateV2QueueMap();
  const result: Record<string, PendingFunnelEvent<TPayload>[]> = {};

  for (const key of listRawKeys(PENDING_EVENT_KEY_PREFIX)) {
    const raw = readRaw(key);
    if (!raw) continue;
    try {
      const envelope = JSON.parse(raw) as Partial<StoredPendingEnvelope<TPayload>>;
      if (typeof envelope.scope !== 'string' || !isPendingEvent(envelope.item)) {
        removeRaw(key);
        continue;
      }
      const payload = redactDurablePayload(envelope.item.payload as TPayload);
      const item = payload === envelope.item.payload
        ? envelope.item as PendingFunnelEvent<TPayload>
        : { ...envelope.item, payload } as PendingFunnelEvent<TPayload>;
      const expectedKey = pendingEventStorageKey(envelope.scope, item.payload.event_id);
      if (expectedKey !== key) {
        removeRaw(key);
        continue;
      }
      if (payload !== envelope.item.payload) writePendingItem(envelope.scope, item);
      (result[envelope.scope] ??= []).push(item);
    } catch {
      removeRaw(key);
    }
  }

  for (const items of Object.values(result)) {
    items.sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
  }

  return result;
}

function sanitizeDiagnosticError(errorMessage?: string): string | undefined {
  if (!errorMessage) return undefined;
  if (/timeout|timed out/i.test(errorMessage)) return 'timeout';
  if (/offline|network|failed to fetch|fetch failed/i.test(errorMessage)) return 'network_error';
  if (/security|permission|unauthorized|forbidden/i.test(errorMessage)) return 'permission_error';
  return 'tracking_request_failed';
}

function pruneDeadLetters(record: Record<string, FunnelDeadLetter[]>): number {
  const now = Date.now();
  const expiresBefore = now - TRACKING_DEAD_LETTER_TTL_MS;
  const originalCount = Object.values(record)
    .reduce((total, items) => total + (Array.isArray(items) ? items.length : 1), 0);
  const retained = Object.values(record)
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter(isDeadLetter)
    .filter((item) => {
      const deadLetteredAt = Date.parse(item.deadLetteredAt);
      return Number.isFinite(deadLetteredAt)
        && deadLetteredAt >= expiresBefore
        && deadLetteredAt <= now + 5 * 60_000;
    })
    .sort((left, right) => Date.parse(left.deadLetteredAt) - Date.parse(right.deadLetteredAt))
    .slice(-MAX_TRACKING_DEAD_LETTERS);

  for (const scope of Object.keys(record)) delete record[scope];
  for (const item of retained) {
    (record[item.scope] ??= []).push(item);
  }
  return originalCount - retained.length;
}

function appendDeadLetters(
  scope: string,
  deadLetters: FunnelDeadLetter[],
): boolean {
  if (deadLetters.length === 0) return true;
  const record = readRecord<FunnelDeadLetter[]>(DEAD_LETTERS_KEY);
  const expiredCount = pruneDeadLetters(record);
  record[scope] = [...(record[scope] ?? []), ...deadLetters];
  const capacityPruned = pruneDeadLetters(record);
  const persisted = writeRecord(DEAD_LETTERS_KEY, record);

  for (const deadLetter of deadLetters) {
    const diagnostic = {
      event_id: deadLetter.eventId,
      event_name: deadLetter.eventName,
      scope: deadLetter.scope,
      reason: deadLetter.reason,
      retry_count: deadLetter.retryCount,
      timestamp: deadLetter.deadLetteredAt,
    };
    console.error('[funnel-tracking] Event moved to dead letter', diagnostic);
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('funnel:dead-letter', { detail: diagnostic }));
      } catch {
        // Redacted diagnostics must never interfere with capture.
      }
    }
  }

  if (expiredCount + capacityPruned > 0) {
    // Deliberately excludes the stored payload, which can contain lead PII.
    console.warn('[funnel-tracking] Dead letters expired by retention limit', {
      scope,
      pruned_count: expiredCount + capacityPruned,
    });
  }
  return persisted;
}

function toDeadLetter<TPayload extends FunnelQueuePayload>(
  scope: string,
  item: PendingFunnelEvent<TPayload>,
  reason: FunnelDeadLetterReason,
): FunnelDeadLetter {
  return {
    eventId: item.payload.event_id,
    eventName: item.payload.event_name,
    scope,
    retryCount: item.retryCount,
    queuedAt: item.queuedAt,
    nextAttemptAt: item.nextAttemptAt,
    lastError: sanitizeDiagnosticError(item.lastError),
    reason,
    deadLetteredAt: new Date().toISOString(),
  };
}

function prunePendingQueueScopes<TPayload extends FunnelQueuePayload>(
  now = Date.now(),
): Record<string, PendingFunnelEvent<TPayload>[]> {
  const queues = readQueueMap<TPayload>();
  const expiredByScope: Record<string, FunnelDeadLetter[]> = {};

  for (const [scope, items] of Object.entries(queues)) {
    const active: PendingFunnelEvent<TPayload>[] = [];
    for (const item of items) {
      const queuedAt = Date.parse(item.queuedAt);
      if (
        !Number.isFinite(queuedAt)
        || queuedAt > now + 5 * 60_000
        || now - queuedAt >= TRACKING_PENDING_EVENT_TTL_MS
      ) {
        (expiredByScope[scope] ??= []).push(toDeadLetter(scope, item, 'expired'));
        removePendingItem(scope, item.payload.event_id);
      } else {
        active.push(item);
      }
    }
    active.sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
    while (active.length > MAX_PENDING_TRACKING_EVENTS) {
      const oldest = active.shift();
      if (!oldest) break;
      (expiredByScope[scope] ??= []).push(toDeadLetter(scope, oldest, 'queue_capacity'));
      removePendingItem(scope, oldest.payload.event_id);
    }
    if (active.length > 0) queues[scope] = active;
    else delete queues[scope];
  }

  const scopesByActivity = Object.entries(queues)
    .map(([scope, items]) => ({
      scope,
      lastActivity: Math.max(...items.map((item) => Date.parse(item.queuedAt) || 0)),
    }))
    .sort((left, right) => left.lastActivity - right.lastActivity);
  const excessScopeCount = Math.max(0, scopesByActivity.length - MAX_TRACKING_COMPANY_SCOPES);
  for (const { scope } of scopesByActivity.slice(0, excessScopeCount)) {
    for (const item of queues[scope] ?? []) {
      (expiredByScope[scope] ??= []).push(toDeadLetter(scope, item, 'scope_capacity'));
      removePendingItem(scope, item.payload.event_id);
    }
    delete queues[scope];
  }

  for (const [scope, deadLetters] of Object.entries(expiredByScope)) {
    appendDeadLetters(scope, deadLetters);
  }
  // Each expired payload was removed by its own key before diagnostics were
  // written, so a dead-letter storage failure cannot extend PII retention.
  return queues;
}

export function getFunnelTrackingScope(companyId?: string, companySlug?: string): string | null {
  const normalizedSlug = companySlug?.trim().toLowerCase();
  if (normalizedSlug) return `slug:${normalizedSlug}`;

  const normalizedId = companyId?.trim();
  return normalizedId ? `id:${normalizedId}` : null;
}

export function getPersistedVisitorId(): string {
  if (memoryVisitorId) return memoryVisitorId;

  const stored = readRaw(TRACKING_ANONYMOUS_KEY);
  if (stored) {
    memoryVisitorId = stored;
    return stored;
  }

  memoryVisitorId = crypto.randomUUID();
  writeRaw(TRACKING_ANONYMOUS_KEY, memoryVisitorId);
  return memoryVisitorId;
}

function trackingStateStorageKey(scope: string) {
  return `${TRACKING_STATE_KEY_PREFIX}${encodeURIComponent(scope)}`;
}

export function readTrackingState(scope: string): PersistedTrackingState | null {
  const stateKey = trackingStateStorageKey(scope);
  let raw = readRaw(stateKey);
  if (!raw) {
    const legacyStates = readRecord<unknown>(TRACKING_STATES_KEY);
    const legacyState = legacyStates[scope];
    if (legacyState && typeof legacyState === 'object') {
      const persisted = writeRaw(stateKey, JSON.stringify(legacyState));
      if (persisted) {
        delete legacyStates[scope];
        if (Object.keys(legacyStates).length > 0) writeRecord(TRACKING_STATES_KEY, legacyStates);
        else removeRaw(TRACKING_STATES_KEY);
      }
      raw = JSON.stringify(legacyState);
    }
  }
  if (!raw) return null;
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    removeRaw(stateKey);
    return null;
  }
  if (!state || typeof state !== 'object') return null;
  const parsed = state as PersistedTrackingState;
  return typeof parsed.anonymous_id === 'string' ? parsed : null;
}

export function writeTrackingState(scope: string, state: PersistedTrackingState): void {
  writeRaw(trackingStateStorageKey(scope), JSON.stringify(state));
  const states = listRawKeys(TRACKING_STATE_KEY_PREFIX)
    .map((key) => {
      try {
        const parsed = JSON.parse(readRaw(key) ?? 'null') as PersistedTrackingState | null;
        const touchedAt = Date.parse(parsed?.touched_at ?? '');
        return { key, touchedAt: Number.isFinite(touchedAt) ? touchedAt : 0 };
      } catch {
        return { key, touchedAt: 0 };
      }
    })
    .sort((left, right) => right.touchedAt - left.touchedAt);
  for (const expired of states.slice(MAX_TRACKING_COMPANY_SCOPES)) removeRaw(expired.key);
}

export function mergeTrackingState(
  scope: string,
  next: Partial<PersistedTrackingState>,
): PersistedTrackingState {
  const previous = readTrackingState(scope) ?? { anonymous_id: getPersistedVisitorId() };
  const merged: PersistedTrackingState = {
    ...previous,
    ...next,
    anonymous_id: next.anonymous_id ?? previous.anonymous_id ?? getPersistedVisitorId(),
    touched_at: new Date().toISOString(),
  };
  writeTrackingState(scope, merged);
  return merged;
}

export function migrateLegacyTrackingStorage(
  fallbackScope: string,
  companyId?: string,
  companySlug?: string,
  getDedupeKey?: (payload: FunnelQueuePayload) => string,
): void {
  const deadLetters = readRecord<FunnelDeadLetter[]>(DEAD_LETTERS_KEY);
  if (pruneDeadLetters(deadLetters) > 0) writeRecord(DEAD_LETTERS_KEY, deadLetters);

  if (!readTrackingState(fallbackScope)) {
    try {
      const parsed = JSON.parse(readRaw(LEGACY_TRACKING_STATE_KEY) ?? 'null') as PersistedTrackingState | null;
      if (typeof parsed?.anonymous_id === 'string' && !readRaw(TRACKING_ANONYMOUS_KEY)) {
        memoryVisitorId = parsed.anonymous_id;
        writeRaw(TRACKING_ANONYMOUS_KEY, parsed.anonymous_id);
      }

      const normalizedLegacySlug = parsed?.company_slug?.trim().toLowerCase();
      const normalizedCurrentSlug = companySlug?.trim().toLowerCase();
      const sameCompany = !!parsed && (
        (!!companyId && parsed.company_id === companyId)
        || (!!normalizedCurrentSlug && normalizedLegacySlug === normalizedCurrentSlug)
      );
      if (sameCompany && typeof parsed?.anonymous_id === 'string') {
        writeTrackingState(fallbackScope, parsed);
      }
    } catch {
      // Invalid legacy state is ignored without affecting the new store.
    }
  }

  try {
    const parsed = JSON.parse(readRaw(LEGACY_PENDING_EVENTS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return;
    const unmigratedEvents: FunnelQueuePayload[] = [];

    for (const rawPayload of parsed) {
      if (!isQueuePayload(rawPayload)) continue;
      const legacyPayload = { ...rawPayload } as FunnelQueuePayload & { retryCount?: number };
      const retryCount = typeof legacyPayload.retryCount === 'number' ? legacyPayload.retryCount : 0;
      delete legacyPayload.retryCount;
      const redactedLegacyPayload = redactDurablePayload(legacyPayload);
      const scope = getFunnelTrackingScope(legacyPayload.company_id, legacyPayload.slug);
      if (!scope) {
        // Never guess a company for a legacy event: keep it isolated for inspection.
        unmigratedEvents.push(redactedLegacyPayload);
        continue;
      }
      const migration = enqueueFunnelEvent(
        scope,
        redactedLegacyPayload,
        getDedupeKey?.(redactedLegacyPayload) ?? redactedLegacyPayload.event_id,
        retryCount,
      );
      if (!migration.persisted) {
        unmigratedEvents.push({ ...redactedLegacyPayload, retryCount });
      }
    }
    if (unmigratedEvents.length > 0) {
      writeRaw(LEGACY_PENDING_EVENTS_KEY, JSON.stringify(unmigratedEvents));
    } else {
      removeRaw(LEGACY_PENDING_EVENTS_KEY);
    }
  } catch {
    // The legacy queue stays available for a future migration attempt.
  }
}

export function readPendingFunnelEvents<TPayload extends FunnelQueuePayload>(
  scope: string,
  now = Date.now(),
): PendingFunnelEvent<TPayload>[] {
  return prunePendingQueueScopes<TPayload>(now)[scope] ?? [];
}

export function readFunnelDeadLetters(scope: string): FunnelDeadLetter[] {
  const record = readRecord<FunnelDeadLetter[]>(DEAD_LETTERS_KEY);
  const prunedCount = pruneDeadLetters(record);
  if (prunedCount > 0) writeRecord(DEAD_LETTERS_KEY, record);
  const items = record[scope];
  return Array.isArray(items)
    ? items.filter(isDeadLetter)
    : [];
}

export function enqueueFunnelEvent<TPayload extends FunnelQueuePayload>(
  scope: string,
  payload: TPayload,
  dedupeKey: string,
  retryCount = 0,
): EnqueueResult<TPayload> {
  const queues = prunePendingQueueScopes<TPayload>();
  const current = queues[scope] ?? [];

  const duplicate = current.find((item) => item.dedupeKey === dedupeKey);
  if (duplicate) {
    const storageKey = pendingEventStorageKey(scope, duplicate.payload.event_id);
    const persisted = isDurablyStored(storageKey)
      || writePendingItem(scope, duplicate);
    return {
      queued: false,
      overflow: [],
      persisted,
    };
  }

  const overflow: FunnelDeadLetter[] = [];
  while (current.length >= MAX_PENDING_TRACKING_EVENTS) {
    const oldest = current.shift();
    if (oldest) {
      overflow.push(toDeadLetter(scope, oldest, 'queue_capacity'));
      removePendingItem(scope, oldest.payload.event_id);
    }
  }

  const item: PendingFunnelEvent<TPayload> = {
    // Lead PII is used only by the in-memory overlay in the active tab. The
    // durable retry preserves the funnel/Meta event without retaining personal
    // data in localStorage after a reload or browser restart.
    payload: redactDurablePayload(payload),
    dedupeKey,
    retryCount,
    nextAttemptAt: 0,
    queuedAt: new Date().toISOString(),
  };
  current.push(item);
  queues[scope] = current;
  const otherScopesByActivity = Object.entries(queues)
    .filter(([candidateScope]) => candidateScope !== scope)
    .map(([candidateScope, items]) => ({
      scope: candidateScope,
      lastActivity: Math.max(...items.map((item) => Date.parse(item.queuedAt) || 0)),
    }))
    .sort((left, right) => left.lastActivity - right.lastActivity);
  const scopeOverflowCount = Math.max(0, Object.keys(queues).length - MAX_TRACKING_COMPANY_SCOPES);
  for (const candidate of otherScopesByActivity.slice(0, scopeOverflowCount)) {
    for (const item of queues[candidate.scope] ?? []) {
      overflow.push(toDeadLetter(candidate.scope, item, 'scope_capacity'));
      removePendingItem(candidate.scope, item.payload.event_id);
    }
    delete queues[candidate.scope];
  }
  appendDeadLetters(scope, overflow);
  const persisted = writePendingItem(scope, item);

  return { queued: true, overflow, persisted };
}

export function acknowledgeFunnelEvent(scope: string, eventId: string): void {
  removePendingItem(scope, eventId);
}

export function recordFunnelEventFailure<TPayload extends FunnelQueuePayload>(
  scope: string,
  eventId: string,
  errorMessage: string,
  options: FailureOptions = {},
): FailureResult {
  const queues = readQueueMap<TPayload>();
  const current = queues[scope] ?? [];
  const index = current.findIndex((item) => item.payload.event_id === eventId);
  if (index < 0) return { retryCount: 0, deadLetter: null };

  const now = options.now ?? Date.now();
  const retryCount = current[index].retryCount + 1;
  const updated: PendingFunnelEvent<TPayload> = {
    ...current[index],
    retryCount,
    lastError: errorMessage,
    nextAttemptAt: now + getFunnelRetryDelayMsForEvent(retryCount, eventId),
  };

  const queuedAt = Date.parse(current[index].queuedAt);
  const expired = !Number.isFinite(queuedAt)
    || queuedAt > now + 5 * 60_000
    || now - queuedAt >= TRACKING_PENDING_EVENT_TTL_MS;
  if (options.permanent || expired) {
    const deadLetter = toDeadLetter(
      scope,
      updated,
      options.permanent ? 'permanent_error' : 'expired',
    );
    appendDeadLetters(scope, [deadLetter]);
    removePendingItem(scope, eventId);
    return { retryCount, deadLetter };
  }

  writePendingItem(scope, updated);
  return { retryCount, deadLetter: null };
}

export function getFunnelRetryDelayMs(retryCount: number): number {
  return getFunnelRetryDelayMsForEvent(retryCount, 'default');
}

export function getFunnelRetryDelayMsForEvent(retryCount: number, eventId: string): number {
  const baseDelay = Math.min(1_000 * 2 ** Math.max(0, retryCount - 1), 5 * 60_000);
  const hash = [...eventId].reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 0);
  const jitterFactor = 0.85 + (hash % 31) / 100;
  return Math.round(baseDelay * jitterFactor);
}

export function makePendingFunnelEventsDue(scope: string): void {
  const queues = readQueueMap();
  const current = queues[scope] ?? [];
  if (current.length === 0) return;
  for (const item of current) writePendingItem(scope, { ...item, nextAttemptAt: 0 });
}

export function makeSessionDependentFunnelEventsDue(scope: string): void {
  const queues = readQueueMap();
  const current = queues[scope] ?? [];
  if (current.length === 0) return;
  for (const item of current) {
    if (item.payload.event_name !== 'session_ping') {
      writePendingItem(scope, { ...item, nextAttemptAt: 0 });
    }
  }
}

export function makeJourneyDependentFunnelEventsDue(scope: string): void {
  const queues = readQueueMap();
  const current = queues[scope] ?? [];
  if (current.length === 0) return;
  for (const item of current) {
    if (!['session_ping', 'page_view', 'booking_started'].includes(item.payload.event_name)) {
      writePendingItem(scope, { ...item, nextAttemptAt: 0 });
    }
  }
}

export function removePendingJourneyEvents(scope: string, journeyId: string): void {
  const queues = readQueueMap();
  const current = queues[scope] ?? [];
  if (current.length === 0) return;
  for (const item of current) {
    if (item.payload.journey_id === journeyId) {
      removePendingItem(scope, item.payload.event_id);
    }
  }
}

function deadLetterMatchingPendingEvents(
  scope: string,
  predicate: (item: PendingFunnelEvent) => boolean,
  errorMessage: string,
): void {
  const queues = readQueueMap();
  const current = queues[scope] ?? [];
  const failed = current.filter(predicate);
  if (failed.length === 0) return;
  appendDeadLetters(scope, failed.map((item) => toDeadLetter(
    scope,
    { ...item, lastError: errorMessage },
    'permanent_error',
  )));
  for (const item of failed) removePendingItem(scope, item.payload.event_id);
}

export function deadLetterSessionDependentFunnelEvents(
  scope: string,
  errorMessage: string,
): void {
  deadLetterMatchingPendingEvents(
    scope,
    (item) => item.payload.event_name !== 'session_ping',
    errorMessage,
  );
}

export function deadLetterJourneyDependentFunnelEvents(
  scope: string,
  journeyId: string,
  errorMessage: string,
): void {
  deadLetterMatchingPendingEvents(
    scope,
    (item) => (
      item.payload.journey_id === journeyId
      && item.payload.event_name !== 'booking_started'
    ),
    errorMessage,
  );
}

export function remapPendingJourneyEvents(
  scope: string,
  previousJourneyId: string,
  confirmedJourneyId: string,
): void {
  if (previousJourneyId === confirmedJourneyId) return;
  const queues = readQueueMap();
  const current = queues[scope] ?? [];
  if (current.length === 0) return;
  for (const item of current) {
    if (item.payload.journey_id !== previousJourneyId) continue;
    writePendingItem(scope, {
      ...item,
      payload: {
        ...item.payload,
        journey_id: confirmedJourneyId,
      },
    });
  }
}

export function deferFunnelEvent(scope: string, eventId: string, nextAttemptAt: number): void {
  const queues = readQueueMap();
  const current = queues[scope] ?? [];
  const item = current.find((candidate) => candidate.payload.event_id === eventId);
  if (!item) return;
  writePendingItem(scope, {
    ...item,
    nextAttemptAt: Math.max(item.nextAttemptAt, nextAttemptAt),
  });
}

export function getNextFunnelAttemptDelay(scope: string, now = Date.now()): number | null {
  const pending = readPendingFunnelEvents(scope);
  if (pending.length === 0) return null;
  return Math.max(0, Math.min(...pending.map((item) => item.nextAttemptAt)) - now);
}

export function resetFunnelTrackingPersistenceForTests(): void {
  const partitionedKeys = [
    ...listRawKeys(TRACKING_STATE_KEY_PREFIX),
    ...listRawKeys(PENDING_EVENT_KEY_PREFIX),
  ];
  memoryStorage.clear();
  volatileStorageKeys.clear();
  memoryVisitorId = null;
  for (const key of [
    TRACKING_ANONYMOUS_KEY,
    TRACKING_STATES_KEY,
    PENDING_EVENTS_KEY,
    DEAD_LETTERS_KEY,
    LEGACY_TRACKING_STATE_KEY,
    LEGACY_PENDING_EVENTS_KEY,
    ...partitionedKeys,
  ]) {
    removeRaw(key);
  }
}
