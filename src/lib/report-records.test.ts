import { describe, expect, it, vi } from 'vitest';
import { loadCompleteReportRecords } from './report-records';

describe('leitura completa dos registros de relatório', () => {
  it('lê mais de mil registros sem usar a página visível como base completa', async () => {
    const all = Array.from({ length: 1207 }, (_, index) => ({ id: String(index) }));
    const fetchPage = vi.fn(async (page: number) => ({ rows: all.slice((page - 1) * 100, page * 100), total: all.length }));
    const result = await loadCompleteReportRecords({ fetchPage });
    expect(result).toEqual(all);
    expect(fetchPage).toHaveBeenCalledTimes(13);
  });
  it('não retorna registros parciais quando uma página falha', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'first' }], total: 2 }).mockRejectedValueOnce(new Error('conexão'));
    await expect(loadCompleteReportRecords({ fetchPage })).rejects.toThrow('conexão');
  });
  it.each([
    [{ rows: [{ id: 'a' }], total: 2 }, { rows: [{ id: 'a' }], total: 2 }],
    [{ rows: [{ id: 'a' }], total: 2 }, { rows: [{ id: 'b' }], total: 3 }],
    [{ rows: [{ id: 'a' }], total: 2 }, { rows: [], total: 2 }],
  ])('recusa uma base alterada ou incompleta durante a paginação', async (first, second) => {
    const fetchPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(loadCompleteReportRecords({ fetchPage })).rejects.toThrow();
  });
  it('para ao cancelar antes de buscar a próxima página', async () => {
    const abort = new AbortController();
    const fetchPage = vi.fn(async () => { abort.abort(); return { rows: [{ id: 'a' }], total: 2 }; });
    await expect(loadCompleteReportRecords({ fetchPage, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
