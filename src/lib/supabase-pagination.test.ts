import { describe, expect, it, vi } from 'vitest';
import { fetchAllSupabasePages } from '@/lib/supabase-pagination';

describe('fetchAllSupabasePages', () => {
  it('carrega resultados alem do limite padrao de 1000 linhas', async () => {
    const source = Array.from({ length: 2_005 }, (_, index) => ({ id: index + 1 }));
    const getPage = vi.fn((from: number, to: number) => Promise.resolve({
      data: source.slice(from, to + 1),
      error: null,
    }));

    const result = await fetchAllSupabasePages(getPage);

    expect(result).toEqual(source);
    expect(getPage).toHaveBeenCalledTimes(4);
    expect(getPage).toHaveBeenNthCalledWith(1, 0, 999);
    expect(getPage).toHaveBeenNthCalledWith(2, 1_000, 1_999);
    expect(getPage).toHaveBeenNthCalledWith(3, 2_000, 2_999);
    expect(getPage).toHaveBeenNthCalledWith(4, 2_005, 3_004);
  });

  it('continua quando o servidor aplica um limite menor que o solicitado', async () => {
    const source = Array.from({ length: 1_205 }, (_, index) => ({ id: index + 1 }));
    const serverLimit = 500;
    const getPage = vi.fn((from: number, to: number) => Promise.resolve({
      data: source.slice(from, Math.min(to + 1, from + serverLimit)),
      error: null,
    }));

    const result = await fetchAllSupabasePages(getPage);

    expect(result).toEqual(source);
    expect(getPage.mock.calls.map(([from]) => from)).toEqual([0, 500, 1_000, 1_205]);
  });
});
