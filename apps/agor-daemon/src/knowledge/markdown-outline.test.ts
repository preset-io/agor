import { describe, expect, it } from 'vitest';
import { markdownOutline, resolveHeadingRange, resolveSectionRefRange } from './markdown-outline';

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
      { occurrence: 1, sectionRef: 'root.h1[1].h2[1]', startLine: 3, endLine: 4 },
      { occurrence: 2, sectionRef: 'root.h1[1].h2[2]', startLine: 5, endLine: 6 },
    ]);
    expect(resolveHeadingRange(headings, 'Doc > Repeat', 2)).toMatchObject({ startLine: 5 });
    expect(resolveSectionRefRange(headings, 'root.h1[1].h2[2]')).toMatchObject({ startLine: 5 });
  });

  it('extracts heading text recursively through inline markdown and links', () => {
    const headings = markdownOutline('# Welcome *brave* [reader](https://example.com)');

    expect(headings[0]).toMatchObject({
      title: 'Welcome brave reader',
      headingPath: 'Welcome brave reader',
      chars: '# Welcome *brave* [reader](https://example.com)'.length,
    });
  });

  it('builds title-independent structural section refs', () => {
    const headings = markdownOutline(
      ['# First', '## A', '### Deep', '## B', '# Second', '### Skipped level'].join('\n')
    );

    expect(headings.map((heading) => heading.sectionRef)).toEqual([
      'root.h1[1]',
      'root.h1[1].h2[1]',
      'root.h1[1].h2[1].h3[1]',
      'root.h1[1].h2[2]',
      'root.h1[2]',
      'root.h1[2].h3[1]',
    ]);
  });

  it('uses heading depth rather than stack length when skipped levels return upward', () => {
    const headings = markdownOutline(['# A', '#### D', '### C', '## B'].join('\n'));

    expect(headings.map((heading) => heading.headingPath)).toEqual([
      'A',
      'A > D',
      'A > C',
      'A > B',
    ]);
    expect(headings.map((heading) => heading.sectionRef)).toEqual([
      'root.h1[1]',
      'root.h1[1].h4[1]',
      'root.h1[1].h3[1]',
      'root.h1[1].h2[1]',
    ]);
  });
});
