import { describe, expect, it } from 'vitest';
import { parseEventUtmSearch } from './eventUtmSearch';

describe('parseEventUtmSearch', () => {
  it('keeps a campaign term for partial search', () => {
    expect(parseEventUtmSearch(' gbp_goiania ')).toEqual({ term: 'gbp_goiania', filters: {} });
  });
  it('extracts all UTM constraints from a full link, decoding values', () => {
    expect(parseEventUtmSearch('https://pluguest.com.br/beco-magico-goiania/?utm_source=google&utm_medium=organic&utm_campaign=gbp_goiania&utm_content=a%20b#top')).toEqual({
      term: '', filters: { utm_source: 'google', utm_medium: 'organic', utm_campaign: 'gbp_goiania', utm_content: 'a b' },
    });
  });
  it('accepts query parameters alone and ignores unrelated ones', () => {
    expect(parseEventUtmSearch('utm_campaign=gbp_goiania&fbclid=abc')).toEqual({ term: '', filters: { utm_campaign: 'gbp_goiania' } });
  });
});
