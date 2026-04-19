import {
  formatBrazilPhone,
  getEmailValidationMessage,
  getPhoneValidationMessage,
  normalizeBrazilPhoneDigits,
  normalizeEmail,
} from '@/lib/validation';

export interface ParsedLeadImportRow {
  key: string;
  rowNumber: number;
  name: string;
  phone: string;
  phoneNormalized: string;
  email: string;
  emailNormalized: string;
  birthdate: string | null;
  notes: string | null;
}

export interface ParsedLeadImportResult {
  rows: ParsedLeadImportRow[];
  errors: string[];
  duplicateCount: number;
  delimiter: ',' | ';';
}

const HEADER_ALIASES = {
  name: ['nome', 'name', 'lead', 'lead_name', 'cliente', 'contato'],
  phone: ['telefone', 'phone', 'celular', 'whatsapp', 'fone'],
  email: ['email', 'e_mail', 'mail'],
  birthdate: ['nascimento', 'birthdate', 'data_nascimento', 'aniversario'],
  notes: ['observacoes', 'observacao', 'notes', 'nota', 'notas'],
} as const;

function normalizeHeader(value: string) {
  return value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function detectDelimiter(text: string): ',' | ';' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

function parseCsvMatrix(text: string, delimiter: ',' | ';') {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  const normalizedText = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < normalizedText.length; index += 1) {
    const char = normalizedText[index];
    const nextChar = normalizedText[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && nextChar === '\n') {
        index += 1;
      }

      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some((cell) => cell.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

function getColumnIndex(headers: string[], aliases: readonly string[]) {
  return headers.findIndex((header) => aliases.includes(header as (typeof aliases)[number]));
}

function parseBirthdate(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split('/');
    return `${year}-${month}-${day}`;
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed) || /^\d{2}-\d{2}-\d{4}$/.test(trimmed)) {
    const separator = trimmed.includes('/') ? '/' : '-';
    const [day, month, year] = trimmed.split(separator);
    return `${year}-${month}-${day}`;
  }

  return null;
}

function deriveLeadName(name: string, email: string, phone: string) {
  const trimmedName = name.trim();
  if (trimmedName) {
    return trimmedName;
  }

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    return normalizedEmail.split('@')[0] || normalizedEmail;
  }

  const formattedPhone = formatBrazilPhone(phone);
  if (formattedPhone) {
    return formattedPhone;
  }

  return 'Lead sem nome';
}

function mergeNotes(currentNotes: string | null, nextNotes: string | null) {
  if (!currentNotes) return nextNotes;
  if (!nextNotes || nextNotes === currentNotes) return currentNotes;
  return `${currentNotes}\n${nextNotes}`;
}

function mergeDuplicateRows(current: ParsedLeadImportRow, next: ParsedLeadImportRow): ParsedLeadImportRow {
  return {
    ...current,
    name: current.name !== 'Lead sem nome' ? current.name : next.name,
    phone: current.phone || next.phone,
    phoneNormalized: current.phoneNormalized || next.phoneNormalized,
    email: current.email || next.email,
    emailNormalized: current.emailNormalized || next.emailNormalized,
    birthdate: current.birthdate || next.birthdate,
    notes: mergeNotes(current.notes, next.notes),
  };
}

export function parseLeadImportCsv(text: string): ParsedLeadImportResult {
  const delimiter = detectDelimiter(text);
  const matrix = parseCsvMatrix(text, delimiter);

  if (matrix.length === 0) {
    return {
      rows: [],
      errors: ['O arquivo CSV está vazio.'],
      duplicateCount: 0,
      delimiter,
    };
  }

  const normalizedHeaders = matrix[0].map(normalizeHeader);
  const nameIndex = getColumnIndex(normalizedHeaders, HEADER_ALIASES.name);
  const phoneIndex = getColumnIndex(normalizedHeaders, HEADER_ALIASES.phone);
  const emailIndex = getColumnIndex(normalizedHeaders, HEADER_ALIASES.email);
  const birthdateIndex = getColumnIndex(normalizedHeaders, HEADER_ALIASES.birthdate);
  const notesIndex = getColumnIndex(normalizedHeaders, HEADER_ALIASES.notes);

  if (phoneIndex === -1 && emailIndex === -1) {
    return {
      rows: [],
      errors: ['O CSV precisa ter ao menos uma coluna de telefone ou email.'],
      duplicateCount: 0,
      delimiter,
    };
  }

  const dedupedRows = new Map<string, ParsedLeadImportRow>();
  const errors: string[] = [];
  let duplicateCount = 0;

  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex];
    const rowNumber = rowIndex + 1;

    const rawName = nameIndex >= 0 ? row[nameIndex] ?? '' : '';
    const rawPhone = phoneIndex >= 0 ? row[phoneIndex] ?? '' : '';
    const rawEmail = emailIndex >= 0 ? row[emailIndex] ?? '' : '';
    const rawBirthdate = birthdateIndex >= 0 ? row[birthdateIndex] ?? '' : '';
    const rawNotes = notesIndex >= 0 ? row[notesIndex] ?? '' : '';

    const isCompletelyEmpty = [rawName, rawPhone, rawEmail, rawBirthdate, rawNotes].every(
      (value) => value.trim().length === 0,
    );

    if (isCompletelyEmpty) {
      continue;
    }

    const phoneError = rawPhone ? getPhoneValidationMessage(rawPhone, 'um telefone') : null;
    const emailError = rawEmail ? getEmailValidationMessage(rawEmail, 'um email') : null;

    if (phoneError) {
      errors.push(`Linha ${rowNumber}: ${phoneError}`);
      continue;
    }

    if (emailError) {
      errors.push(`Linha ${rowNumber}: ${emailError}`);
      continue;
    }

    const phoneNormalized = rawPhone ? normalizeBrazilPhoneDigits(rawPhone) : '';
    const emailNormalized = rawEmail ? normalizeEmail(rawEmail) : '';

    if (!phoneNormalized && !emailNormalized) {
      errors.push(`Linha ${rowNumber}: informe ao menos um telefone ou email valido.`);
      continue;
    }

    const birthdate = parseBirthdate(rawBirthdate);
    if (rawBirthdate.trim() && !birthdate) {
      errors.push(`Linha ${rowNumber}: a data de nascimento deve estar em yyyy-mm-dd ou dd/mm/yyyy.`);
      continue;
    }

    const parsedRow: ParsedLeadImportRow = {
      key: phoneNormalized || emailNormalized,
      rowNumber,
      name: deriveLeadName(rawName, rawEmail, rawPhone),
      phone: rawPhone.trim(),
      phoneNormalized,
      email: rawEmail.trim(),
      emailNormalized,
      birthdate,
      notes: rawNotes.trim() || null,
    };

    const current = dedupedRows.get(parsedRow.key);
    if (current) {
      duplicateCount += 1;
      dedupedRows.set(parsedRow.key, mergeDuplicateRows(current, parsedRow));
      continue;
    }

    dedupedRows.set(parsedRow.key, parsedRow);
  }

  return {
    rows: Array.from(dedupedRows.values()),
    errors,
    duplicateCount,
    delimiter,
  };
}
