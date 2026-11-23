import { describe, expect, it, vi } from 'vitest';
import { buildNpsCohortReport, loadCompleteNpsCohort, type NpsCohortRow } from './nps-report';
import { computeRatingDistribution, computeWeeklyNps } from './nps-reviews';

function row(index: number, patch: Partial<NpsCohortRow> = {}): NpsCohortRow {
  return {
    id: 'review-' + index, status: 'submitted', invited_at: '2026-09-18T12:00:00Z',
    expires_at: '2026-10-18T12:00:00Z', submitted_at: '2026-09-20T12:00:00Z',
    recommend_score: 10, nps_category: 'promoter', comment: null, ambiance_rating: 5,
    food_rating: 5, service_rating: 5, return_score: 10, reservations: { date: '2026-09-18' }, ...patch,
  };
}

describe('complete NPS cohort', () => {
  it('reads more than 1,000 responses and uses the full population for every aggregate', async () => {
    const source = Array.from({ length: 1501 }, (_, index) => row(index, index >= 1000
      ? { recommend_score: 2, nps_category: 'detractor', food_rating: 1 } : {}));
    const fetchPage = vi.fn(async (offset: number, size: number) => ({ rows: source.slice(offset, offset + size), total: source.length }));
    const loaded = await loadCompleteNpsCohort(fetchPage);
    expect(fetchPage.mock.calls.map(call => call[0])).toEqual([0, 500, 1000, 1500]);
    const result = buildNpsCohortReport(loaded);
    expect(result.summary).toMatchObject({ total_invited: 1501, total_submitted: 1501, promoters: 1000, detractors: 501, nps_score: 33 });
    expect(computeRatingDistribution(result.submitted, 'food_rating')).toMatchObject({ total: 1501, counts: [501, 0, 0, 0, 1000] });
    expect(computeWeeklyNps(result.submitted, '2026-09-01', '2026-09-30').reduce((sum, point) => sum + point.responses, 0)).toBe(1501);
  });

  it('does not resolve partial results if a later page fails', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ rows: Array.from({ length: 500 }, (_, index) => row(index)), total: 1200 })
      .mockRejectedValueOnce(new Error('Conexão interrompida'));
    await expect(loadCompleteNpsCohort(fetchPage)).rejects.toThrow('Conexão interrompida');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it.each([
    { rows: [], total: null },
    { rows: [], total: 1 },
    { rows: [row(1), row(1)], total: 2 },
  ])('rejects unconfirmed, truncated or duplicate data: %j', async page => {
    await expect(loadCompleteNpsCohort(async () => page)).rejects.toThrow();
  });

  it('rejects a changing count instead of reporting the loaded rows as complete', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ rows: [row(1)], total: 2 })
      .mockResolvedValueOnce({ rows: [row(2), row(3)], total: 3 });
    await expect(loadCompleteNpsCohort(fetchPage)).rejects.toThrow('mudaram');
  });

  it('counts effective expired invitations and excludes non-submitted ratings from NPS', () => {
    const result = buildNpsCohortReport([
      row(1), row(2, { status: 'pending', expires_at: '2026-09-01T00:00:00Z' }),
      row(3, { status: 'pending', expires_at: '2026-10-01T00:00:00Z' }),
      row(4, { status: 'expired' }),
    ], new Date('2026-09-26T12:00:00Z'));
    expect(result.summary).toMatchObject({ total_invited: 4, total_submitted: 1, total_pending: 1, total_expired: 2, response_rate: 25, promoters: 1, nps_score: 100 });
  });
});
