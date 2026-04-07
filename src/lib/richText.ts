const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'h1',
  'h2',
  'ul',
  'ol',
  'li',
]);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function looksLikeHtml(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function plainTextToRichTextHtml(value: string) {
  return value
    .split(/\n{2,}/)
    .map((block) => {
      const content = block
        .split(/\n/)
        .map((line) => escapeHtml(line))
        .join('<br>');
      return `<p>${content || '<br>'}</p>`;
    })
    .join('');
}

function sanitizeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent ?? '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const children = Array.from(element.childNodes).map(sanitizeNode).join('');

  if (tag === 'div') {
    return `<p>${children || '<br>'}</p>`;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    return children;
  }

  if (tag === 'br') {
    return '<br>';
  }

  const normalizedTag = tag === 'b' ? 'strong' : tag === 'i' ? 'em' : tag;
  return `<${normalizedTag}>${children}</${normalizedTag}>`;
}

export function sanitizeRichTextHtml(value: string | null | undefined) {
  const source = value?.trim() ?? '';
  if (!source) return '';

  if (typeof DOMParser === 'undefined' || typeof Node === 'undefined') {
    return looksLikeHtml(source) ? escapeHtml(source) : plainTextToRichTextHtml(source);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(source, 'text/html');
  return Array.from(doc.body.childNodes).map(sanitizeNode).join('').trim();
}

export function toSafeRichTextHtml(value: string | null | undefined) {
  const source = value?.trim() ?? '';
  if (!source) return '';

  return sanitizeRichTextHtml(looksLikeHtml(source) ? source : plainTextToRichTextHtml(source));
}

export function richTextHasContent(value: string | null | undefined) {
  const html = toSafeRichTextHtml(value);
  if (!html) return false;

  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

  return text.length > 0;
}
