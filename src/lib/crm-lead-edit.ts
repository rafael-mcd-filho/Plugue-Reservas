import { normalizePhoneE164, isValidPhone } from '@/lib/phone';
import {
  isValidEmail,
  normalizeEmail,
} from '@/lib/validation';

export interface CrmLeadEditValues {
  fullName: string;
  phone: string;
  email: string;
  birthdate: string;
}

export type CrmLeadEditErrors = Partial<Record<keyof CrmLeadEditValues | 'contact', string>>;

export function normalizeCrmLeadEditValues(values: CrmLeadEditValues): CrmLeadEditValues {
  return {
    fullName: values.fullName.trim(),
    phone: normalizePhoneE164(values.phone) || values.phone.trim(),
    email: normalizeEmail(values.email),
    birthdate: values.birthdate.trim(),
  };
}

export function validateCrmLeadEditValues(
  values: CrmLeadEditValues,
  today = new Date().toISOString().slice(0, 10),
) {
  const normalized = normalizeCrmLeadEditValues(values);
  const errors: CrmLeadEditErrors = {};

  if (!normalized.fullName) {
    errors.fullName = 'Informe o nome do lead.';
  } else if (normalized.fullName.length > 160) {
    errors.fullName = 'O nome pode ter no máximo 160 caracteres.';
  }

  if (normalized.phone && !isValidPhone(normalized.phone)) {
    errors.phone = 'Informe um telefone válido com DDI e número completo.';
  }

  if (normalized.email && !isValidEmail(normalized.email)) {
    errors.email = 'Informe um e-mail válido.';
  } else if (normalized.email.length > 320) {
    errors.email = 'O e-mail pode ter no máximo 320 caracteres.';
  }

  if (!normalized.phone && !normalized.email) {
    errors.contact = 'Informe pelo menos um telefone ou e-mail.';
  }

  if (normalized.birthdate && normalized.birthdate > today) {
    errors.birthdate = 'A data de nascimento não pode estar no futuro.';
  }

  return { normalized, errors };
}

