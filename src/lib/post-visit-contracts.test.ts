import { describe, expect, it } from 'vitest';
import { buildReservationParameters } from '../../supabase/functions/_shared/pluguechat.ts';
import {
  buildPlugueChatPostVisitParameters,
  getPostVisitReviewToken,
  renderPostVisitWhatsAppTemplate,
} from '../../supabase/functions/_shared/post-visit.ts';

const reviewToken = '7c32fb56386b4bc0ba62e76f19c03b67';
const reviewUrl = `https://plugguest.com.br/beco-magico-goiania/avaliacao/${reviewToken}`;
const reservation = {
  guest_name: '  Ana Maria Souza  ',
  date: '2026-09-09',
  time: '20:30:00',
  party_size: 4,
  guest_phone: '(85) 99999-0000',
};

describe('post-visit review token', () => {
  it.each([
    reviewToken,
    `  ${reviewToken}  `,
    reviewUrl,
    `${reviewUrl}/`,
    `${reviewUrl}?source=whatsapp#review`,
    `${reviewUrl}/?source=whatsapp#review`,
    reviewUrl.replace('https:', 'http:'),
  ])('extracts only the token from %s', (value) => {
    expect(getPostVisitReviewToken(value)).toBe(reviewToken);
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'not-a-review-token',
    'a'.repeat(31),
    'a'.repeat(33),
    'z'.repeat(32),
    `https://example.com/reserva/${reviewToken}`,
    'https://example.com/avaliacao/',
    `${reviewUrl}/other`,
    `ftp://example.com/avaliacao/${reviewToken}`,
    `javascript:alert('${reviewToken}')`,
    `/avaliacao/${reviewToken}`,
    `https://example.com/?link=/avaliacao/${reviewToken}`,
  ])('rejects malformed or unrelated values: %s', (value) => {
    expect(getPostVisitReviewToken(value)).toBe('');
  });
});

describe('PlugueChat post-visit parameters', () => {
  it('sends only name/date when the selected template has no review variable', () => {
    expect(buildPlugueChatPostVisitParameters(reservation, reviewUrl, false)).toEqual({
      nome: 'Ana',
      data: '09/09/2026',
    });
  });

  it('does not require a review token for a template without evaluation', () => {
    expect(buildPlugueChatPostVisitParameters(reservation, null, false)).toEqual({
      nome: 'Ana',
      data: '09/09/2026',
    });
  });

  it.each([reviewUrl, reviewToken])('sends only the token for a template with evaluation: %s', (value) => {
    expect(buildPlugueChatPostVisitParameters(reservation, value, true)).toEqual({
      nome: 'Ana',
      data: '09/09/2026',
      link_avaliacao: reviewToken,
    });
  });

  it.each([null, '', 'invalid-token', 'https://example.com/avaliacao/'])('does not create an incomplete required-link payload: %s', (value) => {
    expect(buildPlugueChatPostVisitParameters(reservation, value, true)).toBeNull();
  });

  it('keeps the old builder and complete URL for unreviewed templates', () => {
    expect(buildReservationParameters('post_visit', reservation, null, reviewUrl)).toEqual({
      nome: 'Ana',
      data: '09/09/2026',
      link_avaliacao: reviewUrl,
    });
  });

  it('preserves the legacy empty third parameter without inferring a template contract', () => {
    expect(buildReservationParameters('post_visit', reservation, null, null)).toEqual({
      nome: 'Ana',
      data: '09/09/2026',
      link_avaliacao: '',
    });
  });
});

describe('non-official WhatsApp post-visit template', () => {
  it('keeps the complete review URL and the existing reservation variables', () => {
    expect(renderPostVisitWhatsAppTemplate(
      'Olá, {nome}! Reserva para {pessoas} em {data} às {hora}. WhatsApp: {telefone}. Avalie: {link_avaliacao}',
      reservation,
      reviewUrl,
    )).toBe(`Olá, Ana! Reserva para 4 em 09/09/2026 às 20:30. WhatsApp: (85) 99999-0000. Avalie: ${reviewUrl}`);
  });

  it('does not append a link when the message has only name/date', () => {
    expect(renderPostVisitWhatsAppTemplate('Obrigado, {nome}, pela visita em {data}.', reservation, reviewUrl))
      .toBe('Obrigado, Ana, pela visita em 09/09/2026.');
  });

  it('keeps the existing behavior when no review URL is available', () => {
    expect(renderPostVisitWhatsAppTemplate('Obrigado, {nome}! {link_avaliacao}', reservation))
      .toBe('Obrigado, Ana! ');
  });

  it('replaces every occurrence of the full URL placeholder', () => {
    expect(renderPostVisitWhatsAppTemplate('{link_avaliacao} / {link_avaliacao}', reservation, reviewUrl))
      .toBe(`${reviewUrl} / ${reviewUrl}`);
  });
});
