import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
  },
}));

import { getCompanyBillingOverdueWarning } from '@/lib/platform-billing-api';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

describe('company billing overdue warning API', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests only the restricted warning for the selected company', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ billing_enabled: true, show_overdue_warning: true }],
      error: null,
    });

    await expect(getCompanyBillingOverdueWarning(COMPANY_ID)).resolves.toEqual({
      companyId: COMPANY_ID,
      billingEnabled: true,
      showOverdueWarning: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      'get_company_billing_overdue_warning',
      { _company_id: COMPANY_ID },
    );
  });

  it('fails closed when the RPC returns no usable state', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    await expect(getCompanyBillingOverdueWarning(COMPANY_ID)).resolves.toMatchObject({
      billingEnabled: false,
      showOverdueWarning: false,
    });
  });

  it('does not hide authorization or database failures', async () => {
    const error = new Error('Sem permissão');
    mocks.rpc.mockResolvedValue({ data: null, error });

    await expect(getCompanyBillingOverdueWarning(COMPANY_ID)).rejects.toBe(error);
  });
});
