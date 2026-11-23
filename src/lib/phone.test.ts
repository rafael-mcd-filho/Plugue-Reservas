// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePhoneE164, toWhatsAppNumber, normalizeStoredPhoneE164, toStoredWhatsAppNumber, isValidPhone, getPhoneLookupVariants } from './phone';
import { canonicalPhone, asaasCustomerPhone, normalizePhoneE164 as edgeNormalize } from '../../supabase/functions/_shared/phone';
import { buildPlugueChatPayload, enqueuePlugueChatMessage, sendPlugueChatMessage } from '../../supabase/functions/_shared/pluguechat';
import { buildBirthdayDispatchKey, enqueueWhatsAppMessageOnce, formatPhoneForWhatsApp, sendWhatsAppText, sendWhatsAppMedia } from '../../supabase/functions/_shared/whatsapp';

afterEach(() => vi.restoreAllMocks());

describe('international phone contract in browser and Edge', () => {
  it.each([
    ['(11) 99876-5432', '+5511998765432'],
    ['5511998765432', '+5511998765432'],
    ['(55) 99876-5432', '+5555998765432'],
    ['+1 407 264 1934', '+14072641934'],
    ['+1 416 555 0123', '+14165550123'],
    ['+351 912 345 678', '+351912345678'],
    ['+44 20 7946 0018', '+442079460018'],
  ])('keeps %s as %s without country-code guessing', (input, expected) => {
    expect(normalizePhoneE164(input)).toBe(expected);
    expect(edgeNormalize(input)).toBe(expected);
    expect(formatPhoneForWhatsApp(input)).toBe(expected);
    expect(toWhatsAppNumber(input)).toBe(expected.slice(1));
  });

  it('uses the selected country when parsing a national number', () => {
    expect(normalizePhoneE164('020 7946 0018', 'GB')).toBe('+442079460018');
    expect(normalizePhoneE164('030 901820', 'DE')).toBe('+4930901820');
    expect(canonicalPhone('14072641934')).toBe('+14072641934');
    expect(normalizePhoneE164('14072641934')).toBe('');
  });

  it.each(['+9991234567', '1100000000', '+551100000000', '123', '+1 abc 4072641934', '+14072641934 ext. 1'])('rejects invalid input %s', (input) => {
    expect(isValidPhone(input)).toBe(false);
    expect(edgeNormalize(input)).toBe('');
  });

  it('only includes BR national variants in a legacy lookup', () => {
    expect(getPhoneLookupVariants('+14072641934')).toEqual(['+14072641934', '14072641934']);
    expect(getPhoneLookupVariants('+5511998765432')).toContain('11998765432');
  });

  it('keeps existing international-digit birthday keys stable', () => {
    expect(buildBirthdayDispatchKey('company', '2026-10-19', '(11) 99876-5432')).toBe('birthday:company:2026-10-19:5511998765432');
    expect(buildBirthdayDispatchKey('company', '2026-10-19', '+14072641934')).toBe('birthday:company:2026-10-19:14072641934');
  });

  it('adapts optional Asaas BR phone fields without mislabelling a foreign number', () => {
    expect(asaasCustomerPhone('+5511998765432')).toBe('11998765432');
    expect(asaasCustomerPhone('+14072641934')).toBeUndefined();
  });
});

describe('stored phone compatibility', () => {
  it.each([
    ['(11) 9999-8888', '+551199998888'],
    ['1199998888', '+551199998888'],
    ['551199998888', '+551199998888'],
    ['+55 (11) 9999-8888', '+551199998888'],
    ['(55) 9999-8888', '+555599998888'],
    ['555599998888', '+555599998888'],
    ['+55 55 9999-8888', '+555599998888'],
  ])('preserves the stored BR destination %s without accepting a new registration', (input, expected) => {
    expect(normalizeStoredPhoneE164(input)).toBe(expected);
    expect(toStoredWhatsAppNumber(input)).toBe(expected.slice(1));
    expect(isValidPhone(input)).toBe(false);
    expect(normalizePhoneE164(input)).toBe('');
    expect(toWhatsAppNumber(input)).toBe('');
  });

  it.each([
    ['(11) 99876-5432', '+5511998765432'],
    ['(55) 99876-5432', '+5555998765432'],
    ['+1 407 264 1934', '+14072641934'],
    ['+351 912 345 678', '+351912345678'],
  ])('preserves strict international parsing of %s', (input, expected) => {
    expect(normalizeStoredPhoneE164(input)).toBe(expected);
    expect(toStoredWhatsAppNumber(input)).toBe(expected.slice(1));
  });

  it.each([
    '+9991234567', '+999551199998888', '+1199998888', '00551199998888',
    '+551199998888 ext. 1', '55+1199998888', '++551199998888',
    '+55abc1199998888', '(01) 9999-8888', '11888888888', '123', '', null, undefined,
  ])('rejects nonlegacy or malformed stored input %s', (input) => {
    expect(normalizeStoredPhoneE164(input)).toBe('');
    expect(toStoredWhatsAppNumber(input)).toBe('');
  });

  it('does not reinterpret a foreign selected country through BR compatibility', () => {
    expect(normalizeStoredPhoneE164('020 7946 0018', 'GB')).toBe('+442079460018');
    expect(normalizeStoredPhoneE164('1199998888', 'US')).toBe('');
  });
});

describe('international automation payloads (offline)', () => {
  it('stores E164 in both queues, preserving an unambiguous +1', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const database = { from: vi.fn(() => ({ insert })) };
    await enqueueWhatsAppMessageOnce(database, { company_id: 'company', phone: '+1 407 264 1934', message: 'Teste', type: 'confirmation' });
    await enqueuePlugueChatMessage(database, { company_id: 'company', phone: '+1 407 264 1934', type: 'confirmation', template_id: 'template', parameters: {} });
    expect(insert).toHaveBeenCalledTimes(2);
    for (const [row] of insert.mock.calls) expect(row.phone).toBe('+14072641934');
    await expect(enqueueWhatsAppMessageOnce(database, { company_id: 'company', phone: '+9991234567', message: 'Teste', type: 'confirmation' })).rejects.toThrow('Telefone invalido');
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it.each(['text', 'media'] as const)('sends international digits for Evolution %s', async (kind) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'SENT' }), { status: 200 }));
    const result = kind === 'text'
      ? await sendWhatsAppText('https://offline.invalid', 'offline', 'instance', '+14072641934', 'Teste', { typing: false })
      : await sendWhatsAppMedia('https://offline.invalid', 'offline', 'instance', '+14072641934', 'https://offline.invalid/image.png', 'Teste', { typing: false });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).number).toBe('14072641934');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adapts PlugueChat sender and recipient only at the provider boundary', async () => {
    const payload = buildPlugueChatPayload('+5511998765432', '+14072641934', 'template', { nome: 'Teste' });
    expect(payload.from).toBe('5511998765432');
    expect(payload.to).toBe('14072641934');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    await sendPlugueChatMessage('https://offline.invalid', 'offline', { ...payload, to: '' });
    expect(fetchMock).not.toHaveBeenCalled();
    const failed = await sendWhatsAppText('https://offline.invalid', 'offline', 'instance', '+9991234567', 'Teste', { typing: false });
    expect(failed.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
