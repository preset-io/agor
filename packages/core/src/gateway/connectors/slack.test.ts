import { describe, expect, it } from 'vitest';
import { markdownToMrkdwn } from './slack';

describe('markdownToMrkdwn', () => {
  it('converts bold', () => {
    expect(markdownToMrkdwn('**bold**')).toBe('*bold*');
    expect(markdownToMrkdwn('__bold__')).toBe('*bold*');
  });

  it('converts italic', () => {
    expect(markdownToMrkdwn('_italic_')).toBe('_italic_');
    expect(markdownToMrkdwn('*italic*')).toBe('_italic_');
  });

  it('converts strikethrough', () => {
    expect(markdownToMrkdwn('~~strike~~')).toBe('~strike~');
  });

  it('converts links', () => {
    expect(markdownToMrkdwn('[click here](https://example.com)')).toBe(
      '<https://example.com|click here>'
    );
  });

  it('converts bare URLs to Slack link format', () => {
    expect(markdownToMrkdwn('https://example.com')).toBe('<https://example.com>');
  });

  it('strips images (Slack cannot render inline images)', () => {
    expect(markdownToMrkdwn('![alt text](https://img.png)')).toBe('');
    expect(markdownToMrkdwn('![](https://img.png)')).toBe('');
  });

  it('converts headings to plain text', () => {
    expect(markdownToMrkdwn('# Heading 1')).toBe('Heading 1');
    expect(markdownToMrkdwn('## Heading 2')).toBe('Heading 2');
    expect(markdownToMrkdwn('### Heading 3')).toBe('Heading 3');
  });

  it('preserves horizontal rules', () => {
    expect(markdownToMrkdwn('---')).toBe('---');
    expect(markdownToMrkdwn('***')).toBe('***');
  });

  it('preserves code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToMrkdwn(input)).toBe('```js\nconst x = 1;\n```');
  });

  it('preserves inline code', () => {
    expect(markdownToMrkdwn('use `**not bold**` here')).toBe('use `**not bold**` here');
  });

  it('converts unordered lists', () => {
    const input = '- item 1\n- item 2\n- item 3';
    expect(markdownToMrkdwn(input)).toBe('- item 1\n- item 2\n- item 3');
  });

  it('converts ordered lists', () => {
    const input = '1. first\n2. second\n3. third';
    expect(markdownToMrkdwn(input)).toBe('1. first\n2. second\n3. third');
  });

  it('preserves blockquotes', () => {
    expect(markdownToMrkdwn('> quoted text')).toBe('> quoted text');
  });

  it('strips tables (md-to-slack limitation)', () => {
    const input = '| Col1 | Col2 |\n|------|------|\n| A    | B    |';
    const output = markdownToMrkdwn(input);
    expect(output).toBe('');
  });

  it('handles a realistic agent response', () => {
    const input = [
      '## Summary',
      '',
      'I made the following changes:',
      '',
      '- **Fixed** the login bug in `auth.ts`',
      '- Updated the [documentation](https://docs.example.com)',
      '- ~~Removed~~ deprecated API calls',
      '',
      '### Code change',
      '',
      '```typescript',
      'const user = await authenticate(token);',
      '```',
      '',
      '> Note: This requires a restart.',
    ].join('\n');

    const output = markdownToMrkdwn(input);

    // Headings rendered as plain text
    expect(output).toContain('Summary');
    expect(output).toContain('Code change');
    // Bold text
    expect(output).toContain('*Fixed*');
    // Links
    expect(output).toContain('<https://docs.example.com|documentation>');
    // Strikethrough
    expect(output).toContain('~Removed~');
    // Code block preserved
    expect(output).toContain('```typescript\nconst user = await authenticate(token);\n```');
    // Inline code preserved
    expect(output).toContain('`auth.ts`');
    // Blockquote
    expect(output).toContain('> Note: This requires a restart.');
    // No raw markdown artifacts
    expect(output).not.toContain('##');
    expect(output).not.toContain('**');
    expect(output).not.toContain('~~');
    expect(output).not.toContain('](');
  });

  it('escapes Slack special characters in text', () => {
    expect(markdownToMrkdwn('a & b')).toBe('a &amp; b');
    expect(markdownToMrkdwn('a < b')).toBe('a &lt; b');
    expect(markdownToMrkdwn('a > b')).toContain('&gt;');
  });

  it('does not double-convert already-valid mrkdwn', () => {
    // If someone sends *already bold* it should pass through
    expect(markdownToMrkdwn('*already bold*')).toBe('_already bold_');
  });

  it('separates multiple paragraphs', () => {
    const output = markdownToMrkdwn('First paragraph.\n\nSecond paragraph.');
    expect(output).toContain('First paragraph.');
    expect(output).toContain('Second paragraph.');
    // Should not run together
    expect(output).not.toBe('First paragraph.Second paragraph.');
  });

  it('handles inline formatting inside headings', () => {
    // md-to-slack renders headings as plain text without processing inline tokens
    const output = markdownToMrkdwn('## Fix for **critical** bug');
    expect(output).toContain('Fix for');
    expect(output).toContain('critical');
    expect(output).toContain('bug');
  });

  it('handles empty input', () => {
    expect(markdownToMrkdwn('')).toBe('');
  });

  it('does not escape special chars inside code blocks', () => {
    const input = '```\nif (a < b && c > d) {}\n```';
    const output = markdownToMrkdwn(input);
    expect(output).toContain('a < b && c > d');
    expect(output).not.toContain('&lt;');
    expect(output).not.toContain('&amp;');
  });

  it('handles nested lists', () => {
    const input = '- item 1\n  - subitem\n- item 2';
    const output = markdownToMrkdwn(input);
    expect(output).toContain('item 1');
    expect(output).toContain('subitem');
    expect(output).toContain('item 2');
  });
});
