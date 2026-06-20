import { endOfDay, format, startOfDay } from 'date-fns';
import type { DateRange } from 'react-day-picker';

export type SpreadsheetCellValue = string | number | boolean | Date | null | undefined;

export interface SpreadsheetColumn {
  header: string;
  width: number;
  align?: 'left' | 'center' | 'right';
  format?: string;
  wrap?: boolean;
}

interface DownloadSpreadsheetOptions {
  filename: string;
  sheetName: string;
  columns: SpreadsheetColumn[];
  rows: SpreadsheetCellValue[][];
  getRowHeight?: (row: SpreadsheetCellValue[]) => number;
}

const SPREADSHEET_HEADER_BACKGROUND = '#9A5A27';
const SPREADSHEET_HEADER_TEXT = '#FFFFFF';
const SPREADSHEET_BODY_TEXT = '#2E251F';
const SPREADSHEET_ALT_ROW_BACKGROUND = '#FFF8F1';
const SPREADSHEET_BORDER = '#E7D9CC';

export function escapeCsvValue(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => escapeCsvValue(String(cell ?? ''))).join(','))
    .join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  URL.revokeObjectURL(url);
}

export async function downloadSpreadsheet({
  filename,
  sheetName,
  columns,
  rows,
  getRowHeight,
}: DownloadSpreadsheetOptions) {
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const borderStyle = 'thin' as const;
  const headerRow = columns.map((column) => ({
    value: column.header,
    type: String,
    format: '@',
    height: 30,
    align: column.align ?? 'left',
    alignVertical: 'center' as const,
    wrap: true,
    fontWeight: 'bold' as const,
    textColor: SPREADSHEET_HEADER_TEXT,
    backgroundColor: SPREADSHEET_HEADER_BACKGROUND,
    topBorderColor: SPREADSHEET_HEADER_BACKGROUND,
    topBorderStyle: borderStyle,
    rightBorderColor: '#B77A49',
    rightBorderStyle: borderStyle,
    bottomBorderColor: '#75401A',
    bottomBorderStyle: borderStyle,
    leftBorderColor: SPREADSHEET_HEADER_BACKGROUND,
    leftBorderStyle: borderStyle,
  }));

  const bodyRows = rows.map((row, rowIndex) => {
    const rowHeight = getRowHeight?.(row) ?? 22;
    const backgroundColor = rowIndex % 2 === 1 ? SPREADSHEET_ALT_ROW_BACKGROUND : '#FFFFFF';

    return columns.map((column, columnIndex) => {
      const rawValue = row[columnIndex];
      const value = rawValue ?? '';
      const type = value instanceof Date
        ? Date
        : typeof value === 'number'
          ? Number
          : typeof value === 'boolean'
            ? Boolean
            : String;

      return {
        value,
        type,
        format: column.format ?? (type === String ? '@' : undefined),
        height: rowHeight,
        align: column.align ?? 'left',
        alignVertical: column.wrap ? 'top' as const : 'center' as const,
        wrap: column.wrap ?? false,
        textColor: SPREADSHEET_BODY_TEXT,
        backgroundColor,
        topBorderColor: SPREADSHEET_BORDER,
        topBorderStyle: borderStyle,
        rightBorderColor: SPREADSHEET_BORDER,
        rightBorderStyle: borderStyle,
        bottomBorderColor: SPREADSHEET_BORDER,
        bottomBorderStyle: borderStyle,
        leftBorderColor: SPREADSHEET_BORDER,
        leftBorderStyle: borderStyle,
      };
    });
  });

  const blob = await writeExcelFile(
    [headerRow, ...bodyRows],
    {
      sheet: sheetName.slice(0, 31),
      columns: columns.map((column) => ({ width: column.width })),
      stickyRowsCount: 1,
      showGridLines: false,
      orientation: 'landscape',
      zoomScale: 0.9,
    },
    {
      fontFamily: 'Aptos',
      fontSize: 10,
    },
  ).toBlob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  URL.revokeObjectURL(url);
}

export function formatDateRangeLabel(range: DateRange | undefined, placeholder: string) {
  if (!range?.from) {
    return placeholder;
  }

  if (!range.to) {
    return `${format(range.from, 'dd/MM/yy')} - ...`;
  }

  return `${format(range.from, 'dd/MM/yy')} - ${format(range.to, 'dd/MM/yy')}`;
}

export function matchesTimestampRange(value: string | null | undefined, range: DateRange | undefined) {
  if (!range?.from) {
    return true;
  }

  if (!value) {
    return false;
  }

  const current = new Date(value);

  if (Number.isNaN(current.getTime())) {
    return false;
  }

  if (current < startOfDay(range.from)) {
    return false;
  }

  if (range.to && current > endOfDay(range.to)) {
    return false;
  }

  return true;
}

export function matchesLocalDateRange(value: string | null | undefined, range: DateRange | undefined) {
  if (!range?.from) {
    return true;
  }

  if (!value) {
    return false;
  }

  const current = new Date(`${value}T12:00:00`);

  if (Number.isNaN(current.getTime())) {
    return false;
  }

  if (current < startOfDay(range.from)) {
    return false;
  }

  if (range.to && current > endOfDay(range.to)) {
    return false;
  }

  return true;
}
