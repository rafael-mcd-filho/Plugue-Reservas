import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSpreadsheet } from '@/lib/export-utils';

describe('downloadSpreadsheet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a formatted xlsx workbook with separated columns and a frozen header', async () => {
    let downloadedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlob = blob;
      return 'blob:spreadsheet-test';
    });
    const revokeObjectURL = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const anchor = originalCreateElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) =>
      tagName === 'a' ? anchor : originalCreateElement(tagName, options));

    await downloadSpreadsheet({
      filename: 'leads.xlsx',
      sheetName: 'Leads',
      columns: [
        { header: 'Nome', width: 30 },
        { header: 'Nascimento', width: 15, align: 'center', format: 'dd/mm/yyyy' },
        { header: 'Visitas', width: 12, align: 'center', format: '0' },
      ],
      rows: [
        ['Maria', new Date('1990-06-20T12:00:00'), 3],
        ['Dado\u0000 inválido', new Date('invalid'), Number.POSITIVE_INFINITY],
      ],
    });

    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('leads.xlsx');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:spreadsheet-test');
    expect(downloadedBlob).not.toBeNull();

    const workbookBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(downloadedBlob!);
    });
    const files = unzipSync(new Uint8Array(workbookBuffer));
    const worksheetXml = strFromU8(files['xl/worksheets/sheet1.xml']);
    const stylesXml = strFromU8(files['xl/styles.xml']);
    const workbookText = Object.entries(files)
      .filter(([name]) => name.endsWith('.xml'))
      .map(([, contents]) => strFromU8(contents))
      .join('\n');

    expect(worksheetXml).toContain('<cols>');
    expect(worksheetXml).toContain('width="30"');
    expect(worksheetXml).toContain('<pane');
    expect(stylesXml).toContain('9A5A27');
    expect(workbookText).toContain('Nome');
    expect(workbookText).toContain('Maria');
    expect(workbookText).toContain('Dado inválido');
    expect(workbookText).not.toContain('\u0000');
    expect(workbookText).not.toContain('Invalid Date');
    expect(workbookText).not.toContain('Infinity');
  });
});
