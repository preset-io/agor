import { describe, expect, it } from 'vitest';
import { markdownOutline, resolveHeadingRange } from './markdown-outline';

describe('markdownOutline', () => {
  it('ignores heading-looking lines inside fenced code blocks', () => {
    const content = ['# Real', '', '```ts', '# Not a heading', '```', '', '## Child'].join('\n');

    expect(markdownOutline(content).map((heading) => heading.headingPath)).toEqual([
      'Real',
      'Real > Child',
    ]);
  });

  it('tracks duplicate heading occurrences separately', () => {
    const headings = markdownOutline(['# Doc', '', '## Repeat', 'a', '## Repeat', 'b'].join('\n'));

    expect(headings.filter((heading) => heading.headingPath === 'Doc > Repeat')).toMatchObject([
      { occurrence: 1, startLine: 3, endLine: 4 },
      { occurrence: 2, startLine: 5, endLine: 6 },
    ]);
    expect(resolveHeadingRange(headings, 'Doc > Repeat', 2)).toMatchObject({ startLine: 5 });
  });

  it('extracts heading text recursively through inline markdown and links', () => {
    const headings = markdownOutline('# Welcome *brave* [reader](https://example.com)');

    expect(headings[0]).toMatchObject({
      title: 'Welcome brave reader',
      headingPath: 'Welcome brave reader',
    });
  });
});
