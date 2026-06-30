import { describe, expect, it } from 'vitest';
import { createHeadingSlugger, extractHastText, slugifyHeadingText } from './headingAnchors';

describe('heading anchor helpers', () => {
  it('creates stable slugs from heading text', () => {
    expect(slugifyHeadingText('Hello, World!')).toBe('hello-world');
    expect(slugifyHeadingText(' Crème brûlée & API_v2 ')).toBe('creme-brulee-api-v2');
    expect(slugifyHeadingText('!!!')).toBe('heading');
  });

  it('deduplicates duplicate headings in source order', () => {
    const slug = createHeadingSlugger();
    expect([slug('Foo'), slug('Foo!'), slug('Foo')]).toEqual(['foo', 'foo-1', 'foo-2']);
  });

  it('extracts nested heading text from hast nodes', () => {
    expect(
      extractHastText({
        type: 'element',
        tagName: 'h2',
        children: [
          { type: 'text', value: 'Use ' },
          { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'agor' }] },
        ],
      })
    ).toBe('Use agor');
  });
});
