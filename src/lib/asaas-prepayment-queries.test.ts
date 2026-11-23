import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCompanyReservationPayments, fetchCompanyReservationPaymentUsage } from '@/lib/asaas-prepayment-queries';

const { fromTable } = vi.hoisted(() => ({ fromTable: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: fromTable } }));

function mockPaymentPages(source: Array<Record<string, unknown>>, { serverLimit = 1000, failFrom = Infinity } = {}) {
  const pageQueries: Array<{ calls: Array<[string, ...unknown[]]>; from: number; to: number }> = [];
  fromTable.mockImplementation(() => {
    const calls: Array<[string, ...unknown[]]> = [];
    const query: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ['select', 'eq', 'or', 'order', 'in']) {
      query[method] = (...args) => { calls.push([method, ...args]); return query; };
    }
    query.range = (from: number, to: number) => {
      pageQueries.push({ calls, from, to });
      return Promise.resolve(from >= failFrom
        ? { data: null, error: new Error('Falha de leitura') }
        : { data: source.slice(from, Math.min(to + 1, from + serverLimit)), error: null });
    };
    return query;
  });
  return pageQueries;
}

const period = { companyId: 'company-a', from: new Date(2026, 10, 1), to: new Date(2026, 10, 7) };
beforeEach(() => vi.clearAllMocks());

describe('company prepayment queries', () => {
  it('includes all payments beyond the PostgREST limit and keeps tenant, dates and stable order on every page', async () => {
    const source = Array.from({ length: 1205 }, (_, index) => ({ id: `payment-${index}`, charged_amount: 10 }));
    const pages = mockPaymentPages(source, { serverLimit: 500 });
    const rows = await fetchCompanyReservationPayments(period);
    expect(rows).toEqual(source);
    expect(rows.reduce((sum, row) => sum + Number(row.charged_amount), 0)).toBe(12050);
    expect(pages.map((page) => page.from)).toEqual([0, 500, 1000, 1205]);
    for (const page of pages) {
      expect(page.calls).toContainEqual(['eq', 'company_id', 'company-a']);
      expect(page.calls).toContainEqual(['order', 'created_at', { ascending: false }]);
      expect(page.calls).toContainEqual(['order', 'id', { ascending: false }]);
      expect(page.calls.find(([method]) => method === 'or')?.[1]).toContain('paid_at.gte.');
      expect(page.calls.find(([method]) => method === 'select')?.[1]).toContain('asaas_payment_id');
    }
  });

  it('keeps awaiting-method payments in the pending filter across pages', async () => {
    const pages = mockPaymentPages([{ id: 'p1' }, { id: 'p2' }], { serverLimit: 1 });
    await fetchCompanyReservationPayments({ ...period, status: 'pending' });
    expect(pages.every((page) => page.calls.some((call) => JSON.stringify(call) === JSON.stringify(['in', 'status', ['pending', 'awaiting_method']])))).toBe(true);
  });

  it('applies a specific status on every page', async () => {
    const pages = mockPaymentPages([{ id: 'cancelled-payment' }]);
    await fetchCompanyReservationPayments({ ...period, status: 'cancelled' });
    expect(pages.every((page) => page.calls.some((call) => JSON.stringify(call) === JSON.stringify(['eq', 'status', 'cancelled'])))).toBe(true);
  });

  it('rejects a later-page error instead of returning incomplete financial totals', async () => {
    mockPaymentPages([{ id: 'p1' }, { id: 'p2' }], { serverLimit: 1, failFrom: 1 });
    await expect(fetchCompanyReservationPayments(period)).rejects.toThrow('Falha de leitura');
  });

  it('counts rule usage on every page within the company', async () => {
    const source = Array.from({ length: 1005 }, (_, id) => ({ id, rule_id: 'rule-a' }));
    const pages = mockPaymentPages(source);
    expect(await fetchCompanyReservationPaymentUsage('company-a', ['rule-a'])).toHaveLength(1005);
    for (const page of pages) {
      expect(page.calls).toContainEqual(['eq', 'company_id', 'company-a']);
      expect(page.calls).toContainEqual(['in', 'rule_id', ['rule-a']]);
    }
  });

  it('does not query payments without a company or rule IDs', async () => {
    await expect(fetchCompanyReservationPayments({ ...period, companyId: '' })).rejects.toThrow('Empresa');
    expect(await fetchCompanyReservationPaymentUsage('company-a', [])).toEqual([]);
    expect(fromTable).not.toHaveBeenCalled();
  });
});
