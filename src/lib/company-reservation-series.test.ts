import { describe, expect, it } from 'vitest';
import { buildCompanyReservationSeries, type CompanyReservationFact } from './company-reservation-series';

const companies = [{ id: 'a' }, { id: 'b' }];
const fact = (company_id: string, date: string, status = 'confirmed', party_size = 3): CompanyReservationFact => ({ company_id, date, status, party_size });
const reservations = [
  fact('a', '2026-08-30'), fact('a', '2026-08-31', 'completed', 5),
  fact('b', '2026-09-01', 'checked_in'), fact('a', '2026-09-02'),
  fact('a', '2026-09-02', 'cancelled'), fact('b', '2026-09-02', 'no_show'),
  fact('b', '2026-09-02', 'pending_payment'), fact('inactive', '2026-09-01'),
  fact('a', '2026-08-29'), fact('a', '2026-09-04'),
];

describe('company reservation series', () => {
  it('separates active companies, filters losses and payment states, and fills empty days', () => {
    const series = buildCompanyReservationSeries(companies, reservations, '2026-08-30', '2026-09-03', 'day', 'reservations');
    expect(series).toHaveLength(5);
    expect(series[0]).toEqual({ period: '2026-08-30', values: { a: 1, b: 0 } });
    expect(series[2]).toEqual({ period: '2026-09-01', values: { a: 0, b: 1 } });
    expect(series[4]).toEqual({ period: '2026-09-03', values: { a: 0, b: 0 } });
  });

  it('sums months by visit date, including partial months without extending the range', () => {
    expect(buildCompanyReservationSeries(companies, reservations, '2026-08-30', '2026-09-03', 'month', 'reservations')).toEqual([
      { period: '2026-08-01', values: { a: 2, b: 0 } },
      { period: '2026-09-01', values: { a: 1, b: 1 } },
    ]);
  });

  it('starts weeks on Monday and sums reserved people separately per company', () => {
    expect(buildCompanyReservationSeries(companies, reservations, '2026-08-30', '2026-09-03', 'week', 'people')).toEqual([
      { period: '2026-08-24', values: { a: 3, b: 0 } },
      { period: '2026-08-31', values: { a: 8, b: 3 } },
    ]);
  });
});
