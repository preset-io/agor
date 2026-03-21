import { describe, expect, it } from 'vitest';
import { markdownToMrkdwn } from './slack';

/**
 * slackify-markdown uses zero-width spaces (\u200B) around inline formatting
 * to prevent Slack from misinterpreting mid-word emphasis markers.
 * Tests use toContain for inline formatting to stay resilient to this.
 */
describe('markdownToMrkdwn', () => {
  it('converts bold', () => {
    expect(markdownToMrkdwn('**bold**')).toContain('*bold*');
    expect(markdownToMrkdwn('__bold__')).toContain('*bold*');
  });

  it('converts italic', () => {
    expect(markdownToMrkdwn('_italic_')).toContain('_italic_');
    expect(markdownToMrkdwn('*italic*')).toContain('_italic_');
  });

  it('converts strikethrough', () => {
    expect(markdownToMrkdwn('~~strike~~')).toContain('~strike~');
  });

  it('converts links', () => {
    expect(markdownToMrkdwn('[click here](https://example.com)')).toBe(
      '<https://example.com|click here>'
    );
  });

  it('converts bare URLs to Slack link format', () => {
    expect(markdownToMrkdwn('https://example.com')).toContain('https://example.com');
  });

  it('converts images to links (Slack cannot render inline images)', () => {
    expect(markdownToMrkdwn('![alt text](https://img.png)')).toBe('<https://img.png|alt text>');
    expect(markdownToMrkdwn('![](https://img.png)')).toBe('<https://img.png>');
  });

  it('converts headings to bold text', () => {
    expect(markdownToMrkdwn('# Heading 1')).toBe('*Heading 1*');
    expect(markdownToMrkdwn('## Heading 2')).toBe('*Heading 2*');
    expect(markdownToMrkdwn('### Heading 3')).toBe('*Heading 3*');
  });

  it('converts horizontal rules', () => {
    expect(markdownToMrkdwn('---')).toBe('***');
    expect(markdownToMrkdwn('***')).toBe('***');
  });

  it('preserves code blocks and strips language identifier', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToMrkdwn(input)).toBe('```\nconst x = 1;\n```');
  });

  it('preserves inline code', () => {
    expect(markdownToMrkdwn('use `**not bold**` here')).toBe('use `**not bold**` here');
  });

  it('converts unordered lists', () => {
    const input = '- item 1\n- item 2\n- item 3';
    const output = markdownToMrkdwn(input);
    expect(output).toContain('item 1');
    expect(output).toContain('item 2');
    expect(output).toContain('item 3');
  });

  it('converts ordered lists', () => {
    const input = '1. first\n2. second\n3. third';
    const output = markdownToMrkdwn(input);
    expect(output).toContain('1.');
    expect(output).toContain('first');
    expect(output).toContain('2.');
    expect(output).toContain('second');
  });

  it('preserves blockquotes', () => {
    expect(markdownToMrkdwn('> quoted text')).toBe('> quoted text');
  });

  it('preserves tables', () => {
    const input = '| Col1 | Col2 |\n|------|------|\n| A    | B    |';
    const output = markdownToMrkdwn(input);
    expect(output).toContain('Col1');
    expect(output).toContain('Col2');
    expect(output).toContain('A');
    expect(output).toContain('B');
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

    // Bold headings
    expect(output).toContain('*Summary*');
    expect(output).toContain('*Code change*');
    // Bold text
    expect(output).toContain('*Fixed*');
    // Links
    expect(output).toContain('<https://docs.example.com|documentation>');
    // Strikethrough
    expect(output).toContain('~Removed~');
    // Code block preserved (lang stripped)
    expect(output).toContain('```\nconst user = await authenticate(token);\n```');
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

  it('treats single asterisk as italic (markdown spec)', () => {
    // In markdown, *text* is italic — slackify-markdown converts to _text_
    expect(markdownToMrkdwn('*already bold*')).toContain('_already bold_');
  });

  it('separates multiple paragraphs', () => {
    const output = markdownToMrkdwn('First paragraph.\n\nSecond paragraph.');
    expect(output).toContain('First paragraph.');
    expect(output).toContain('Second paragraph.');
    expect(output).not.toBe('First paragraph.Second paragraph.');
  });

  it('handles inline formatting inside headings', () => {
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

  it('handles nested lists with proper indentation', () => {
    const input = '- item 1\n  - subitem\n- item 2';
    const output = markdownToMrkdwn(input);
    expect(output).toContain('item 1');
    expect(output).toContain('subitem');
    expect(output).toContain('item 2');
    // Nested items should be indented
    expect(output).toMatch(/\n\s+.*subitem/);
  });
});
