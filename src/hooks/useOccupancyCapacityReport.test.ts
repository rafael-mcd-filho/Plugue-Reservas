import { describe, expect, it, vi } from 'vitest';
import {
  OccupancyCapacityValidationError,
  buildOccupancyCapacityQueryKey,
} from '@/lib/occupancy-capacity-report';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

import {
  isSameOccupancyCapacityDataset,
  shouldRetryOccupancyCapacity,
} from '@/hooks/useOccupancyCapacityReport';

describe('occupancy capacity query privacy and retry policy', () => {
  const base = {
    companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-20',
    granularity: 'day' as const,
    page: 1,
    pageSize: 20,
    availabilityMode: 'all' as const,
    outcome: 'all' as const,
  };

  it('preserves a previous page only inside the exact same tenant and dataset', () => {
    const firstPage = buildOccupancyCapacityQueryKey(base);
    expect(isSameOccupancyCapacityDataset(
      firstPage,
      buildOccupancyCapacityQueryKey({ ...base, page: 2 }),
    )).toBe(true);
    expect(isSameOccupancyCapacityDataset(
      firstPage,
      buildOccupancyCapacityQueryKey({
        ...base,
        companyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        page: 2,
      }),
    )).toBe(false);
    expect(isSameOccupancyCapacityDataset(
      firstPage,
      buildOccupancyCapacityQueryKey({ ...base, availabilityMode: 'tables', page: 2 }),
    )).toBe(false);
  });

  it('retries at most once and never retries ACL, cancellation, or invalid contracts', () => {
    expect(shouldRetryOccupancyCapacity(0, new Error('network'))).toBe(true);
    expect(shouldRetryOccupancyCapacity(1, new Error('network'))).toBe(false);
    expect(shouldRetryOccupancyCapacity(0, { code: '42501' })).toBe(false);
    expect(shouldRetryOccupancyCapacity(0, { code: '57014' })).toBe(false);
    expect(shouldRetryOccupancyCapacity(0, { status: 403 })).toBe(false);
    expect(shouldRetryOccupancyCapacity(0, { name: 'AbortError' })).toBe(false);
    expect(shouldRetryOccupancyCapacity(
      0,
      new OccupancyCapacityValidationError('invalid'),
    )).toBe(false);
  });
});
