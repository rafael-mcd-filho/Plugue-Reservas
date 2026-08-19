import { describe, expect, it } from 'vitest';
import { toCompanyBillingTarget } from '@/lib/company-billing-dialog';

describe('company-billing-dialog', () => {
  it('adapts a paused Financeiro overview company to the lightweight dialog target', () => {
    expect(toCompanyBillingTarget({
      companyId: 'company-id',
      companyName: 'Empresa teste',
      companyStatus: 'paused',
    })).toEqual({
      id: 'company-id',
      name: 'Empresa teste',
      status: 'paused',
    });
  });

  it.each([null, 'active', 'unexpected'])('uses active as the safe status for %s', (companyStatus) => {
    expect(toCompanyBillingTarget({
      companyId: 'company-id',
      companyName: 'Empresa teste',
      companyStatus,
    }).status).toBe('active');
  });
});
