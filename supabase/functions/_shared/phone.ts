import { parsePhoneNumberFromString } from 'npm:libphonenumber-js@1.13.15/max';
import { createPhoneTools, type PhoneParser } from './phone-core.ts';

export const {
  parsePhone,
  normalizePhoneE164,
  normalizeStoredPhoneE164,
  toWhatsAppNumber,
  toStoredWhatsAppNumber,
  formatPhone,
  isValidPhone,
  getPhoneLookupVariants,
} = createPhoneTools(parsePhoneNumberFromString as PhoneParser);

// Use only for columns explicitly documented as international digits. Unlike
// user/legacy input, an 11-digit canonical number must never default to BR.
export function canonicalPhone(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  return text ? normalizeStoredPhoneE164(text.startsWith('+') ? text : `+${text}`) : '';
}

export function contactPhone(contact: Record<string, unknown>, guest = false): string {
  const prefix = guest ? 'guest_phone' : 'phone';
  return normalizeStoredPhoneE164(
    String(contact[`${prefix}_e164`] ?? contact[prefix] ?? ''),
    String(contact[`${prefix}_country`] ?? 'BR'),
  );
}

export function matchesCanonicalPhone(contact: Record<string, unknown>, expected: string): boolean {
  const canonical = normalizeStoredPhoneE164(expected);
  return Boolean(canonical && contactPhone(contact) === canonical);
}

// Queue/log reconciliation also needs the historical national BR spelling,
// including numbers accepted before full numbering-plan validation existed.
export function getStoredPhoneLookupVariants(value: string | null | undefined): string[] {
  const canonical = normalizeStoredPhoneE164(value);
  if (!canonical) return [];
  const validatedVariants = getPhoneLookupVariants(canonical);
  if (validatedVariants.length) return validatedVariants;
  const phone = parsePhone(canonical);
  const national = phone?.country === 'BR' ? phone.nationalNumber : '';
  return [...new Set([
    canonical,
    canonical.slice(1),
    ...(national ? [national, `(${national.slice(0, 2)}) ${national.slice(2, -4)}-${national.slice(-4)}`] : []),
  ])];
}

// Asaas customer phone fields currently use the national BR format. Phone is
// optional on customer creation: do not send a foreign number as a BR mobile.
export function asaasCustomerPhone(value: string | null | undefined): string | undefined {
  const phone = parsePhone(value);
  return phone?.isValid() && phone.country === 'BR' ? phone.nationalNumber : undefined;
}
