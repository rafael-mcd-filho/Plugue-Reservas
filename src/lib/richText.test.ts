import { describe, expect, it } from 'vitest';
import { sanitizeRichTextHtml, toSafeRichTextHtml } from './richText';

describe('rich text alignment', () => {
  it('preserves alignment on only the chosen paragraph through saving and rendering', () => {
    const html = '<p>Primeira frase</p><p style="text-align: center;">Última frase</p>';
    expect(toSafeRichTextHtml(sanitizeRichTextHtml(html))).toBe(html);
  });

  it('normalizes browser divs and legacy alignment attributes', () => {
    expect(sanitizeRichTextHtml('<div style="text-align: right;">Direita</div><h2 align="justify">Título</h2>'))
      .toBe('<p style="text-align: right;">Direita</p><h2 style="text-align: justify;">Título</h2>');
  });

  it('keeps only supported alignment and strips other styles and event handlers', () => {
    expect(sanitizeRichTextHtml('<p style="text-align: center; color: red; background: url(https://example.com);" onclick="alert(1)">Texto</p><p style="text-align: inherit;">Outro</p>'))
      .toBe('<p style="text-align: center;">Texto</p><p>Outro</p>');
  });
});
