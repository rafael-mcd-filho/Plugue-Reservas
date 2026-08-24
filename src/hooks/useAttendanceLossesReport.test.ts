import { describe, expect, it, vi } from 'vitest';
import {
  AttendanceLossesValidationError,
  buildAttendanceLossesQueryKey,
} from '@/lib/attendance-losses-report';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: rpcMock },
}));

import {
  isSameAttendanceLossesDataset,
  shouldRetryAttendanceLosses,
} from '@/hooks/useAttendanceLossesReport';

describe('attendance losses query privacy and retry policy', () => {
  const base = {
    companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-20',
    outcome: 'all' as const,
    entryMethod: 'all' as const,
    page: 1,
    pageSize: 20,
    search: '',
  };

  it('preserves a previous page only inside the exact same company and dataset', () => {
    const firstPage = buildAttendanceLossesQueryKey(base);
    expect(isSameAttendanceLossesDataset(
      firstPage,
      buildAttendanceLossesQueryKey({ ...base, page: 2 }),
    )).toBe(true);
    expect(isSameAttendanceLossesDataset(
      firstPage,
      buildAttendanceLossesQueryKey({ ...base, companyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', page: 2 }),
    )).toBe(false);
    expect(isSameAttendanceLossesDataset(
      firstPage,
      buildAttendanceLossesQueryKey({ ...base, search: 'Ana', page: 2 }),
    )).toBe(false);
    expect(isSameAttendanceLossesDataset(
      firstPage,
      buildAttendanceLossesQueryKey({ ...base, comparisonEnabled: false, page: 2 }),
    )).toBe(false);
  });

  it('retries at most once and never retries ACL, cancellation, or invalid-contract errors', () => {
    expect(shouldRetryAttendanceLosses(0, new Error('network'))).toBe(true);
    expect(shouldRetryAttendanceLosses(1, new Error('network'))).toBe(false);
    expect(shouldRetryAttendanceLosses(0, { code: '42501' })).toBe(false);
    expect(shouldRetryAttendanceLosses(0, { code: '57014' })).toBe(false);
    expect(shouldRetryAttendanceLosses(0, { name: 'AbortError' })).toBe(false);
    expect(shouldRetryAttendanceLosses(
      0,
      new AttendanceLossesValidationError('invalid'),
    )).toBe(false);
  });
});
