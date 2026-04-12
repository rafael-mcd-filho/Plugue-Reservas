import { describe, expect, it } from 'vitest';
import { normalizePasswordValidationMessage, PASSWORD_REQUIREMENTS_TEXT } from '@/lib/validation';

describe('normalizePasswordValidationMessage', () => {
  it('normalizes stricter password policy messages to the local 8-character rule', () => {
    const message = 'A senha deve ter pelo menos 12 caracteres e incluir letra maiuscula, minuscula e numero';

    expect(normalizePasswordValidationMessage(message)).toBe(PASSWORD_REQUIREMENTS_TEXT);
  });

  it('preserves unrelated auth errors', () => {
    expect(normalizePasswordValidationMessage('Email ou senha incorretos')).toBe('Email ou senha incorretos');
  });
});
