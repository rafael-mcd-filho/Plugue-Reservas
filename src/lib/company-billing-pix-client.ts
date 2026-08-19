import {
  getCompanyBillingInvoicePixQrCode,
  getPlatformBillingRetryAfterSeconds,
} from '@/lib/platform-billing-api';
import type { CompanyBillingInvoicePixQrCode } from '@/lib/platform-billing-contracts';

export interface CompanyBillingPixRequestInput {
  companyId: string;
  invoiceId: string;
}

type CompanyBillingPixFetcher = (
  input: CompanyBillingPixRequestInput,
) => Promise<CompanyBillingInvoicePixQrCode>;

const EXPIRATION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_TIMEOUT_MS = 2_147_483_647;
export const COMPANY_BILLING_PIX_CLIENT_COOLDOWN_MS = 10_000;

export class CompanyBillingPixRequestError extends Error {
  readonly retryAt: number | null;
  readonly originalError: unknown;

  constructor(message: string, retryAt: number | null, originalError?: unknown) {
    super(message);
    this.name = 'CompanyBillingPixRequestError';
    this.retryAt = retryAt;
    this.originalError = originalError;
  }
}

function requestKey(input: CompanyBillingPixRequestInput) {
  return `${input.companyId}:${input.invoiceId}`;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Não foi possível gerar o Pix desta fatura.';
}

export function getCompanyBillingPixExpirationTimestamp(value: string | null | undefined) {
  const expirationDate = typeof value === 'string' ? value.trim() : '';
  if (!EXPIRATION_DATE_PATTERN.test(expirationDate)) return null;

  const normalizedDate = expirationDate.replace(' ', 'T');
  const timestamp = Date.parse(normalizedDate);
  if (!Number.isFinite(timestamp)) return null;

  const [year, month, day] = expirationDate.slice(0, 10).split('-').map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    parsedDate.getUTCFullYear() !== year
    || parsedDate.getUTCMonth() !== month - 1
    || parsedDate.getUTCDate() !== day
  ) {
    return null;
  }

  return timestamp;
}

export function isCompanyBillingPixQrCodeValid(
  data: CompanyBillingInvoicePixQrCode | null | undefined,
  now = Date.now(),
) {
  if (!data) return false;
  const expirationTimestamp = getCompanyBillingPixExpirationTimestamp(data.expirationDate);
  return expirationTimestamp !== null && expirationTimestamp > now;
}

export function getCompanyBillingPixRetryAt(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const retryAt = Number((error as { retryAt?: unknown }).retryAt);
  return Number.isFinite(retryAt) && retryAt > 0 ? retryAt : null;
}

export function getCompanyBillingPixRemainingSeconds(error: unknown, now = Date.now()) {
  const retryAt = getCompanyBillingPixRetryAt(error);
  if (!retryAt || retryAt <= now) return 0;
  return Math.max(1, Math.ceil((retryAt - now) / 1000));
}

export class CompanyBillingPixRequestCoordinator {
  private readonly fetcher: CompanyBillingPixFetcher;
  private readonly now: () => number;
  private readonly minimumCooldownMs: number;
  private readonly cache = new Map<string, CompanyBillingInvoicePixQrCode>();
  private readonly cacheTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<CompanyBillingInvoicePixQrCode>>();
  private cooldownUntil = 0;
  private generation = 0;
  private disposed = false;

  constructor(options: {
    fetcher?: CompanyBillingPixFetcher;
    now?: () => number;
    minimumCooldownMs?: number;
  } = {}) {
    this.fetcher = options.fetcher ?? getCompanyBillingInvoicePixQrCode;
    this.now = options.now ?? Date.now;
    this.minimumCooldownMs = options.minimumCooldownMs ?? COMPANY_BILLING_PIX_CLIENT_COOLDOWN_MS;
  }

  get isDisposed() {
    return this.disposed;
  }

  request(input: CompanyBillingPixRequestInput): Promise<CompanyBillingInvoicePixQrCode> {
    if (this.disposed) {
      return Promise.reject(new CompanyBillingPixRequestError(
        'A solicitação de Pix foi encerrada.',
        null,
      ));
    }

    const key = requestKey(input);
    const now = this.now();
    const requestGeneration = this.generation;
    const cached = this.cache.get(key);
    if (cached) {
      if (isCompanyBillingPixQrCodeValid(cached, now)) return Promise.resolve(cached);
      this.removeCached(key);
    }

    const pendingRequest = this.inFlight.get(key);
    if (pendingRequest) return pendingRequest;

    if (this.cooldownUntil > now) {
      const remainingSeconds = Math.ceil((this.cooldownUntil - now) / 1000);
      return Promise.reject(new CompanyBillingPixRequestError(
        `Aguarde ${remainingSeconds} ${remainingSeconds === 1 ? 'segundo' : 'segundos'} antes de gerar outro Pix.`,
        this.cooldownUntil,
      ));
    }

    this.cooldownUntil = Math.max(this.cooldownUntil, now + this.minimumCooldownMs);

    const request = Promise.resolve()
      .then(() => this.fetcher(input))
      .then((data) => {
        if (this.disposed || requestGeneration !== this.generation) {
          throw new CompanyBillingPixRequestError('A solicitação de Pix foi encerrada.', null);
        }
        if (data.invoiceId !== input.invoiceId) {
          throw new Error('O backend retornou o Pix de outra fatura.');
        }
        if (!isCompanyBillingPixQrCodeValid(data, this.now())) {
          throw new Error('O código Pix retornado já expirou. Gere um novo código.');
        }

        this.storeCached(key, data);
        return data;
      })
      .catch((error: unknown) => {
        if (this.disposed || requestGeneration !== this.generation) {
          throw error instanceof CompanyBillingPixRequestError
            ? error
            : new CompanyBillingPixRequestError('A solicitação de Pix foi encerrada.', null, error);
        }
        const retryAfterSeconds = getPlatformBillingRetryAfterSeconds(error);
        if (retryAfterSeconds) {
          this.cooldownUntil = Math.max(
            this.cooldownUntil,
            this.now() + retryAfterSeconds * 1000,
          );
        }

        const retryAt = this.cooldownUntil > this.now() ? this.cooldownUntil : null;
        throw new CompanyBillingPixRequestError(errorMessage(error), retryAt, error);
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  clear() {
    this.generation += 1;
    for (const timer of this.cacheTimers.values()) clearTimeout(timer);
    this.cache.clear();
    this.cacheTimers.clear();
    this.inFlight.clear();
    this.cooldownUntil = 0;
  }

  dispose() {
    this.disposed = true;
    this.clear();
  }

  private storeCached(key: string, data: CompanyBillingInvoicePixQrCode) {
    this.removeCached(key);
    this.cache.set(key, data);
    this.scheduleCacheExpiry(key, data);
  }

  private removeCached(key: string) {
    const timer = this.cacheTimers.get(key);
    if (timer) clearTimeout(timer);
    this.cacheTimers.delete(key);
    this.cache.delete(key);
  }

  private scheduleCacheExpiry(key: string, data: CompanyBillingInvoicePixQrCode) {
    const expirationTimestamp = getCompanyBillingPixExpirationTimestamp(data.expirationDate);
    if (expirationTimestamp === null) {
      this.removeCached(key);
      return;
    }

    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(0, expirationTimestamp - this.now() + 1),
    );
    const timer = setTimeout(() => {
      this.cacheTimers.delete(key);
      if (this.cache.get(key) !== data) return;
      if (isCompanyBillingPixQrCodeValid(data, this.now())) {
        this.scheduleCacheExpiry(key, data);
      } else {
        this.cache.delete(key);
      }
    }, delay);
    this.cacheTimers.set(key, timer);
  }
}
