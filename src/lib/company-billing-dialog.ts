import type { PlatformBillingCompanyOverview } from '@/lib/platform-billing-contracts';

export type CompanyBillingTargetStatus = 'active' | 'paused';

export interface CompanyBillingTarget {
  id: string;
  name: string;
  status: CompanyBillingTargetStatus;
}

type CompanyBillingTargetSource = Pick<
  PlatformBillingCompanyOverview,
  'companyId' | 'companyName' | 'companyStatus'
>;

export function toCompanyBillingTarget(company: CompanyBillingTargetSource): CompanyBillingTarget {
  return {
    id: company.companyId,
    name: company.companyName,
    status: company.companyStatus === 'paused' ? 'paused' : 'active',
  };
}
