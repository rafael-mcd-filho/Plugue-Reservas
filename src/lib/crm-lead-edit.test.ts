import { describe, expect, it } from 'vitest';
import { normalizeCrmLeadEditValues, validateCrmLeadEditValues } from '@/lib/crm-lead-edit';

describe('edição de lead', () => {
  it('normaliza os campos antes de salvar', () => {
    expect(normalizeCrmLeadEditValues({
      fullName: '  Maria da Silva  ',
      phone: '55 (11) 99876-5432',
      email: '  MARIA@EXAMPLE.COM ',
      birthdate: '1992-04-18',
    })).toEqual({
      fullName: 'Maria da Silva',
      phone: '+5511998765432',
      email: 'maria@example.com',
      birthdate: '1992-04-18',
    });
  });

  it.each(['+14072641934', '+351912345678'])('preserva o DDI internacional de %s', (phone) => {
    const result = validateCrmLeadEditValues({ fullName: 'Lead', phone, email: '', birthdate: '' });
    expect(result.errors).toEqual({});
    expect(result.normalized.phone).toBe(phone);
  });

  it('exige nome e ao menos uma forma de contato', () => {
    const { errors } = validateCrmLeadEditValues({
      fullName: ' ',
      phone: '',
      email: '',
      birthdate: '',
    }, '2026-10-07');

    expect(errors.fullName).toBeTruthy();
    expect(errors.contact).toBeTruthy();
  });

  it('rejeita telefone, e-mail e nascimento inválidos', () => {
    const { errors } = validateCrmLeadEditValues({
      fullName: 'Maria',
      phone: '123',
      email: 'maria@',
      birthdate: '2026-10-08',
    }, '2026-10-07');

    expect(errors.phone).toBeTruthy();
    expect(errors.email).toBeTruthy();
    expect(errors.birthdate).toBeTruthy();
  });
});

