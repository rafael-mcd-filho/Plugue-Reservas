import { describe, expect, it } from 'vitest';
import { buildWhatsAppMessageUrl } from './whatsapp-links';

describe('prefilled WhatsApp links', () => {
  it.each([
    '🚀 Olá, comandante! ⏰ Sua reserva está confirmada. 🍕',
    '👩🏽‍🍳 ❤️ Vamos comemorar com a família 👨‍👩‍👧‍👦!',
    'Olá, João! Ação & diversão + pizza = 100% 😋\nConfirmação às 19:45? #reserva',
  ])('preserves the exact Unicode text without the wa.me redirect: %s', (message) => {
    const url = new URL(buildWhatsAppMessageUrl('12025550123', message));

    expect(url.origin).toBe('https://api.whatsapp.com');
    expect(url.pathname).toBe('/send');
    expect(url.searchParams.get('phone')).toBe('12025550123');
    expect(url.searchParams.get('text')).toBe(message);
    expect(Array.from(url.searchParams.keys())).toEqual(['phone', 'text']);
  });

  it.each(['551199998888', '5511998765432', '14072641934', '351912345678'])(
    'keeps the validated international destination %s exactly as supplied',
    (phoneDigits) => {
      const url = new URL(buildWhatsAppMessageUrl(phoneDigits, 'Olá! 🚀'));
      expect(url.searchParams.get('phone')).toBe(phoneDigits);
    },
  );
});
