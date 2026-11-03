import { describe, expect, it } from 'vitest';
import { createImportedLeadMatcher, parseLeadImportCsv } from '@/lib/lead-import';

describe('stored lead matching during import', () => {
  it('updates the existing normalized-only BR record before backfill, preserving its ID', () => {
    const existing = { id: 'legacy-br-id', phone: null, phone_e164: null, phone_normalized: '85999993456', notes: 'Historical CRM data' };
    const parsed = parseLeadImportCsv('nome,telefone\nMaria,+5585999993456');
    expect(parsed.errors).toEqual([]);

    const match = createImportedLeadMatcher([existing])(parsed.rows[0]);
    expect(match.conflict).toBe(false);
    // Leads uses this returned record's ID for upsert, never an anonymous insert.
    expect(match.lead).toBe(existing);
    expect(match.lead?.id).toBe('legacy-br-id');
    expect(existing.phone_normalized).toBe('85999993456');
  });

  it('matches legacy DDD 55 and canonical US numbers without merging a BR contact', () => {
    const stored = [
      { id: 'legacy-ddd55', phone: null, phone_e164: null, phone_normalized: '55999887766' },
      { id: 'us', phone: '+14072641934', phone_e164: null, phone_normalized: '14072641934' },
      { id: 'pt', phone: null, phone_e164: '+351912345678', phone_normalized: '351912345678' },
    ];
    const match = createImportedLeadMatcher(stored);
    const parsed = parseLeadImportCsv('nome,telefone\nBR,+5555999887766\nUS,+14072641934\nPT,+351912345678');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((row) => match(row).lead?.id)).toEqual(['legacy-ddd55', 'us', 'pt']);

    const newBrazilian = parseLeadImportCsv('nome,telefone\nNovo,(14) 99876-5432').rows[0];
    expect(match(newBrazilian)).toEqual({ lead: null, conflict: false });
  });

  it('keeps a phone/email collision between different existing IDs out of the update', () => {
    const match = createImportedLeadMatcher([
      { id: 'phone-owner', phone: null, phone_normalized: '85999993456', email_normalized: null },
      { id: 'email-owner', phone: null, phone_normalized: null, email_normalized: 'other@example.com' },
    ]);
    const row = parseLeadImportCsv('nome,telefone,email\nConflito,+5585999993456,other@example.com').rows[0];
    expect(match(row)).toEqual({ lead: null, conflict: true });
  });
});

describe('international lead CSV import', () => {
  it('defaults legacy national numbers to Brazil and merges equivalent international representations', () => {
    const result = parseLeadImportCsv([
      'nome;telefone;email',
      'Maria;(11) 99876-5432;maria@example.com',
      'Maria;+55 11 99876-5432;maria@example.com',
      'DDD 55;(55) 99988-7766;',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.duplicateCount).toBe(1);
    expect(result.rows.map((row) => [row.phone, row.phoneNormalized])).toEqual([
      ['+5511998765432', '5511998765432'],
      ['+5555999887766', '5555999887766'],
    ]);
  });

  it('uses an optional ISO country for national numbers and preserves an explicit calling code', () => {
    const result = parseLeadImportCsv([
      'nome,telefone,pais',
      'John,4072641934,us',
      'Ana,912345678,PT',
      'Maria,+5511998765432,US',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => row.phone)).toEqual([
      '+14072641934',
      '+351912345678',
      '+5511998765432',
    ]);
  });

  it('does not merge different countries sharing their last eleven digits', () => {
    const result = parseLeadImportCsv([
      'nome,telefone',
      'Portugal,+351912345678',
      'Brasil,+5551912345678',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.duplicateCount).toBe(0);
    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map((row) => row.key)).size).toBe(2);
  });

  it('rejects an unknown country and invalid numbers without losing the valid rows', () => {
    const result = parseLeadImportCsv([
      'nome;telefone;pais;email',
      'Invalid country;4072641934;ZZ;',
      'Invalid phone;123;PT;',
      'Wrong country;11998765432;PT;wrong-country@example.com',
      'Email only;;;CLIENTE@EXAMPLE.COM',
    ].join('\n'));

    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain('Linha 2:');
    expect(result.errors[1]).toContain('Linha 3:');
    expect(result.errors[2]).toContain('Linha 4:');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ phone: '', key: 'cliente@example.com' });
  });
});
