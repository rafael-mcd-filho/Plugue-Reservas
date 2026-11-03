// The same contract is used by the browser and the Edge Functions. The parser
// is injected so Deno and Vite can use their own package resolution.
export interface ParsedPhone {
  number: string;
  country?: string;
  countryCallingCode: string;
  nationalNumber: string;
  ext?: string;
  isValid(): boolean;
  formatNational(): string;
  formatInternational(): string;
}

export type PhoneParser = (value: string, options: { defaultCountry: string; extract: false }) => ParsedPhone | undefined;

export function createPhoneTools(parser: PhoneParser) {
  function parsePhone(value: string | null | undefined, country = 'BR'): ParsedPhone | undefined {
    let text = value?.trim() ?? '';
    if (!text || !/^[+\d\s().-]+$/.test(text)) return undefined;
    const digits = text.replace(/\D/g, '');
    if (text.startsWith('00')) text = `+${digits.slice(2)}`;
    // Legacy BR records can already contain the calling code without '+'.
    // New international writes always carry '+', including NANP's 11 digits.
    else if (!text.startsWith('+') && country === 'BR' && digits.startsWith('55') && [12, 13].includes(digits.length)) text = `+${digits}`;
    try {
      const phone = parser(text, { defaultCountry: country, extract: false });
      return phone && !phone.ext ? phone : undefined;
    } catch {
      return undefined;
    }
  }

  function normalizePhoneE164(value: string | null | undefined, country = 'BR'): string {
    const phone = parsePhone(value, country);
    return phone?.isValid() ? phone.number : '';
  }

  function toWhatsAppNumber(value: string | null | undefined, country = 'BR'): string {
    return normalizePhoneE164(value, country).replace(/^\+/, '');
  }

  // Existing BR contacts passed the former DDD + 8/9-digit validation. Keep
  // their original destination usable without relaxing validation for writes.
  function normalizeStoredPhoneE164(value: string | null | undefined, country = 'BR'): string {
    const normalized = normalizePhoneE164(value, country);
    if (normalized) return normalized;

    const text = value?.trim() ?? '';
    if (country !== 'BR' || !/^\+?[\d\s().-]+$/.test(text)) return '';
    const digits = text.replace(/\D/g, '');
    const legacyNationalPattern = /^[1-9][0-9](?:9?[0-9]{8})$/;

    // DDD 55 belongs to the national number when it has 10 or 11 digits.
    if (!text.startsWith('+') && legacyNationalPattern.test(digits)) {
      return `+55${digits}`;
    }
    if (digits.startsWith('55') && [12, 13].includes(digits.length)) {
      const nationalNumber = digits.slice(2);
      if (legacyNationalPattern.test(nationalNumber)) return `+55${nationalNumber}`;
    }
    return '';
  }

  function toStoredWhatsAppNumber(value: string | null | undefined, country = 'BR'): string {
    return normalizeStoredPhoneE164(value, country).replace(/^\+/, '');
  }

  function formatPhone(value: string | null | undefined, country = 'BR'): string {
    const phone = parsePhone(value, country);
    if (!phone?.isValid()) return value?.trim() ?? '';
    return phone.country === 'BR' ? phone.formatNational() : phone.formatInternational();
  }

  function getPhoneLookupVariants(value: string | null | undefined): string[] {
    const phone = parsePhone(value);
    if (!phone?.isValid()) return [];
    return [...new Set([
      phone.number,
      phone.number.slice(1),
      ...(phone.country === 'BR' ? [phone.nationalNumber, phone.formatNational()] : []),
    ])];
  }

  return {
    parsePhone,
    normalizePhoneE164,
    toWhatsAppNumber,
    normalizeStoredPhoneE164,
    toStoredWhatsAppNumber,
    formatPhone,
    getPhoneLookupVariants,
    isValidPhone: (value: string | null | undefined, country = 'BR') => Boolean(normalizePhoneE164(value, country)),
  };
}
