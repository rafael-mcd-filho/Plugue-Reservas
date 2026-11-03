import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { createPhoneTools, type PhoneParser } from '../../supabase/functions/_shared/phone-core';

export const {
  parsePhone,
  normalizePhoneE164,
  toWhatsAppNumber,
  normalizeStoredPhoneE164,
  toStoredWhatsAppNumber,
  formatPhone,
  isValidPhone,
  getPhoneLookupVariants,
} = createPhoneTools(parsePhoneNumberFromString as PhoneParser);
