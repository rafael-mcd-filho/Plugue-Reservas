import { describe, expect, it } from 'vitest';
import {
  normalizePasswordValidationMessage,
  PASSWORD_POLICY_REJECTED_TEXT,
  PASSWORD_REQUIREMENTS_TEXT,
} from '@/lib/validation';

describe('normalizePasswordValidationMessage', () => {
  it('normalizes stricter password policy messages to the local 8-character rule', () => {
    const message = 'A senha deve ter pelo menos 12 caracteres e incluir letra maiuscula, minuscula e numero';

    expect(normalizePasswordValidationMessage(message)).toBe(PASSWORD_REQUIREMENTS_TEXT);
  });

  it('preserves unrelated auth errors', () => {
    expect(normalizePasswordValidationMessage('Email ou senha incorretos')).toBe('Email ou senha incorretos');
  });

  it('does not collapse generic weak password errors into the minimum length message', () => {
    expect(normalizePasswordValidationMessage('weak_password')).toBe(PASSWORD_POLICY_REJECTED_TEXT);
  });

  it('preserves specific password-policy errors unrelated to length', () => {
    const message = 'Password should not contain your email address';

    expect(normalizePasswordValidationMessage(message)).toBe(message);
  });
});
