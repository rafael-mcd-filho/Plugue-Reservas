export const MIN_PASSWORD_LENGTH = 12;
export const MAX_WAITLIST_NAME_LENGTH = 120;
export const MAX_WAITLIST_NOTES_LENGTH = 500;
export const PASSWORD_REQUIREMENTS_TEXT = `Use ao menos ${MIN_PASSWORD_LENGTH} caracteres com letra maiuscula, minuscula e numero.`;

export const COMPANY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BRAZIL_WHATSAPP_PATTERN = /^(55)?[1-9][0-9](?:9?[0-9]{8})$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidCompanySlug(value: string | null | undefined) {
  return COMPANY_SLUG_PATTERN.test((value || '').trim());
}

export function normalizePhoneDigits(value: string | null | undefined) {
  return (value || '').replace(/\D/g, '');
}

export function normalizeBrazilPhoneDigits(value: string | null | undefined) {
  const digits = normalizePhoneDigits(value);

  if (digits.length > 11 && digits.startsWith('55')) {
    return digits.slice(2, 13);
  }

  return digits.slice(0, 11);
}

export function formatBrazilPhone(value: string | null | undefined) {
  const digits = normalizeBrazilPhoneDigits(value);

  if (!digits) return '';

  if (digits.length < 3) {
    return `(${digits}`;
  }

  const ddd = digits.slice(0, 2);
  const localNumber = digits.slice(2);

  if (!localNumber) {
    return `(${ddd})`;
  }

  if (localNumber.length <= 4) {
    return `(${ddd}) ${localNumber}`;
  }

  const prefixLength = localNumber.length > 8 ? 5 : 4;
  const prefix = localNumber.slice(0, prefixLength);
  const suffix = localNumber.slice(prefixLength);

  return suffix
    ? `(${ddd}) ${prefix}-${suffix}`
    : `(${ddd}) ${prefix}`;
}

export function isValidBrazilPhone(value: string | null | undefined) {
  return BRAZIL_WHATSAPP_PATTERN.test(normalizePhoneDigits(value));
}

export function isValidBrazilWhatsApp(value: string | null | undefined) {
  return isValidBrazilPhone(value);
}

export function toBrazilWhatsAppNumber(value: string | null | undefined) {
  const digits = normalizeBrazilPhoneDigits(value);

  if (!digits) return '';

  return `55${digits}`;
}

export function normalizeEmail(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function isValidEmail(value: string | null | undefined) {
  const normalized = normalizeEmail(value);
  return normalized.length > 0 && EMAIL_PATTERN.test(normalized);
}

export function isStrongPassword(value: string | null | undefined) {
  const password = value || '';
  return password.length >= MIN_PASSWORD_LENGTH
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password);
}

export function normalizeCnpjDigits(value: string | null | undefined) {
  return (value || '').replace(/\D/g, '').slice(0, 14);
}

export function formatCnpj(value: string | null | undefined) {
  const digits = normalizeCnpjDigits(value);

  if (!digits) return '';

  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  if (digits.length <= 8) return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}`;
  if (digits.length <= 12) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8)}`;
  }

  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

export function isValidCnpj(value: string | null | undefined) {
  const digits = normalizeCnpjDigits(value);

  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) {
    return false;
  }

  const calculateCheckDigit = (baseDigits: string, factor: number) => {
    let total = 0;

    for (const digit of baseDigits) {
      total += Number(digit) * factor;
      factor = factor === 2 ? 9 : factor - 1;
    }

    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const base = digits.slice(0, 12);
  const firstCheckDigit = calculateCheckDigit(base, 5);
  const secondCheckDigit = calculateCheckDigit(`${base}${firstCheckDigit}`, 6);

  return digits === `${base}${firstCheckDigit}${secondCheckDigit}`;
}

export function getEmailValidationMessage(value: string | null | undefined, label: string, required = false) {
  const normalized = normalizeEmail(value);

  if (!normalized) {
    return required ? `Informe ${label}.` : null;
  }

  return isValidEmail(normalized) ? null : `Informe ${label} valido.`;
}

export function getPhoneValidationMessage(value: string | null | undefined, label: string, required = false) {
  const formatted = formatBrazilPhone(value);

  if (!formatted) {
    return required ? `Informe ${label}.` : null;
  }

  return isValidBrazilPhone(formatted) ? null : `Informe ${label} valido com DDD.`;
}

export function getCnpjValidationMessage(value: string | null | undefined, label = 'um CNPJ', required = false) {
  const formatted = formatCnpj(value);

  if (!formatted) {
    return required ? `Informe ${label}.` : null;
  }

  return isValidCnpj(formatted) ? null : `Informe ${label} valido.`;
}

export function getPasswordValidationMessage(value: string | null | undefined, label = 'uma senha', required = true) {
  const password = value || '';

  if (!password) {
    return required ? `Informe ${label}.` : null;
  }

  return isStrongPassword(password) ? null : PASSWORD_REQUIREMENTS_TEXT;
}
