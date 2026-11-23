// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalPhone, contactPhone, getStoredPhoneLookupVariants, matchesCanonicalPhone, normalizePhoneE164 } from '../../supabase/functions/_shared/phone';
import { buildPlugueChatPayload, enqueuePlugueChatMessage, normalizePhone } from '../../supabase/functions/_shared/pluguechat';
import { buildBirthdayDispatchKey, enqueueWhatsAppMessageOnce, formatPhoneForWhatsApp, sendWhatsAppMedia, sendWhatsAppText } from '../../supabase/functions/_shared/whatsapp';

afterEach(() => vi.restoreAllMocks());

describe('delivery compatibility for existing Brazilian contacts', () => {
  it.each([
    ['(11) 8888-7777', '+551188887777'],
    ['551188887777', '+551188887777'],
    ['+551188887777', '+551188887777'],
    ['(55) 8888-7777', '+555588887777'],
  ])('preserves the original legacy destination %s as %s', (raw, canonical) => {
    expect(normalizePhoneE164(raw)).toBe('');
    expect(normalizePhone(raw)).toBe(''); // New API recipients remain strict.
    expect(formatPhoneForWhatsApp(raw)).toBe(canonical);
    expect(contactPhone({ phone: raw })).toBe(canonical);
    expect(canonicalPhone(canonical.slice(1))).toBe(canonical);
    expect(matchesCanonicalPhone({ phone: raw }, canonical)).toBe(true);
    expect(buildBirthdayDispatchKey('company', '2026-10-19', raw)).toBe(`birthday:company:2026-10-19:${canonical.slice(1)}`);
  });

  it('finds historical national and formatted spellings without stripping the DDI for identity', () => {
    expect(getStoredPhoneLookupVariants('+551188887777')).toEqual([
      '+551188887777', '551188887777', '1188887777', '(11) 8888-7777',
    ]);
    expect(matchesCanonicalPhone({ phone: '1188887777' }, '+11188887777')).toBe(false);
    expect(getStoredPhoneLookupVariants('+9991234567')).toEqual([]);
  });

  it('enqueues existing legacy destinations with full DDI without changing idempotency keys', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const database = { from: vi.fn(() => ({ insert })) };
    await enqueueWhatsAppMessageOnce(database, {
      company_id: 'company', phone: '1188887777', message: 'Teste', type: 'confirmation',
    });
    await enqueuePlugueChatMessage(database, {
      company_id: 'company', phone: '(11) 8888-7777', type: 'birthday_message',
      template_id: 'template', parameters: {}, idempotency_key: 'existing-key',
    });
    expect(insert.mock.calls.map(([row]) => row.phone)).toEqual(['+551188887777', '+551188887777']);
    expect(insert.mock.calls[1][0].idempotency_key).toBe('existing-key');
  });

  it.each(['text', 'media'] as const)('sends the unchanged legacy BR digits for Evolution %s', async (kind) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const result = kind === 'text'
      ? await sendWhatsAppText('https://offline.invalid', 'offline', 'instance', '1188887777', 'Teste', { typing: false })
      : await sendWhatsAppMedia('https://offline.invalid', 'offline', 'instance', '+551188887777', 'https://offline.invalid/test.png', 'Teste', { typing: false });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).number).toBe('551188887777');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(buildPlugueChatPayload('+5511998765432', '1188887777', 'template', {}).to).toBe('551188887777');
  });

  it.each(['+9991234567', '+551188887777 ext. 1', '+55 abc 1188887777'])('rejects malformed input %s even for stored delivery', async (phone) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline only'));
    expect(formatPhoneForWhatsApp(phone)).toBe('');
    expect(buildPlugueChatPayload('+5511998765432', phone, 'template', {}).to).toBe('');
    expect((await sendWhatsAppText('https://offline.invalid', 'offline', 'instance', phone, 'Teste', { typing: false })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
