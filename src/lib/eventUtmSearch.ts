export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export function parseEventUtmSearch(input: string): { term: string; filters: Record<string, string> } {
  const term = input.trim();
  const filters: Record<string, string> = {};
  const query = term.includes('?') ? term.slice(term.indexOf('?') + 1) : term.replace(/^\?/, '');
  const params = new URLSearchParams(query.split('#')[0]);
  for (const key of UTM_KEYS) {
    const value = params.get(key)?.trim();
    if (value) filters[key] = value;
  }
  return { term: Object.keys(filters).length ? '' : term, filters };
}
