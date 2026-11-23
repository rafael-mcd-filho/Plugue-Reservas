export interface ReportReservationRecord {
  id: string;
  guest_name: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  note?: string;
}

interface CompleteReportRecordsOptions<T extends { id: string }> {
  fetchPage: (page: number) => Promise<{ rows: T[]; total: number }>;
  signal?: AbortSignal;
}

/** Read every authorized page; a partial result is never presented as complete. */
export async function loadCompleteReportRecords<T extends { id: string }>({
  fetchPage,
  signal,
}: CompleteReportRecordsOptions<T>): Promise<T[]> {
  const records: T[] = [];
  const ids = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 1; ; page += 1) {
    if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
    const result = await fetchPage(page);
    if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
    if (!Number.isInteger(result.total) || result.total < 0 || !Array.isArray(result.rows)) {
      throw new Error('A consulta retornou uma contagem inválida. Atualize os registros.');
    }
    expectedTotal ??= result.total;
    if (result.total !== expectedTotal) throw new Error('Os registros mudaram durante a consulta. Tente novamente.');
    for (const row of result.rows) {
      if (!row.id || ids.has(row.id)) throw new Error('A paginação mudou durante a consulta. Tente novamente.');
      ids.add(row.id);
      records.push(row);
    }
    if (records.length === expectedTotal) return records;
    if (records.length > expectedTotal || result.rows.length === 0) {
      throw new Error('Não foi possível carregar a base completa. Tente novamente.');
    }
  }
}
