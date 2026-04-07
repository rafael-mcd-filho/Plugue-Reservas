export const MIN_PASSWORD_LENGTH = 12;
export const MAX_WAITLIST_NAME_LENGTH = 120;
export const MAX_WAITLIST_NOTES_LENGTH = 500;

export const COMPANY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BRAZIL_WHATSAPP_PATTERN = /^(55)?[1-9][0-9](?:9?[0-9]{8})$/;

export function isValidCompanySlug(value: string | null | undefined) {
  return COMPANY_SLUG_PATTERN.test((value || '').trim());
}

export function normalizePhoneDigits(value: string | null | undefined) {
  return (value || '').replace(/\D/g, '');
}

export function isValidBrazilWhatsApp(value: string | null | undefined) {
  return BRAZIL_WHATSAPP_PATTERN.test(normalizePhoneDigits(value));
}
