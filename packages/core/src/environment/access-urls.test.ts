import { describe, expect, it } from 'vitest';
import { environmentAccessUrlsSchema } from './access-urls';

describe('shared environment access URL contract', () => {
  it('accepts bounded named HTTP(S) links, including provider-local links', () => {
    expect(
      environmentAccessUrlsSchema.parse([
        { name: 'Preview', url: 'https://preview.example.test' },
        { name: 'Local', url: 'http://localhost:3000' },
      ])
    ).toHaveLength(2);
  });
  it.each([
    'javascript:alert(1)',
    '//example.test',
    '/preview',
    'https://user:password@example.test',
    'https:example.test',
  ])('rejects unsafe or nonabsolute URL %s', (url) => {
    expect(environmentAccessUrlsSchema.safeParse([{ name: 'Preview', url }]).success).toBe(false);
  });
  it('rejects extra properties and oversized entries/lists consistently', () => {
    const entry = { name: 'Preview', url: 'https://example.test' };
    for (const value of [
      [{ ...entry, extra: true }],
      [{ ...entry, name: 'x'.repeat(129) }],
      [{ ...entry, url: `https://example.test/${'x'.repeat(2048)}` }],
      Array(9).fill(entry),
    ]) {
      expect(environmentAccessUrlsSchema.safeParse(value).success).toBe(false);
    }
  });
});
