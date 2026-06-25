import { describe, expect, it } from 'vitest';
import {
  isChannelAllowedByWhitelist,
  markdownToMrkdwn,
  markdownToSlackPayload,
  SlackConnector,
  wrapTablesInCodeBlocks,
} from './slack';

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

  it('renders tables as monospace code blocks', () => {
    const input = '| Col1 | Col2 |\n|------|------|\n| A    | B    |';
    const output = markdownToMrkdwn(input);
    // Table content is preserved inside a code block
    expect(output).toContain('```');
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

describe('wrapTablesInCodeBlocks', () => {
  it('wraps a GFM table in code fences', () => {
    const input = '| Col1 | Col2 |\n|------|------|\n| A    | B    |';
    const output = wrapTablesInCodeBlocks(input);
    expect(output).toBe('```\n| Col1 | Col2 |\n|------|------|\n| A    | B    |\n```');
  });

  it('does not wrap tables already inside code blocks', () => {
    const input = '```\n| Col1 | Col2 |\n|------|------|\n| A    | B    |\n```';
    expect(wrapTablesInCodeBlocks(input)).toBe(input);
  });

  it('does not wrap pipe lines without a separator row', () => {
    const input = '| not a table |\n| just pipes |';
    expect(wrapTablesInCodeBlocks(input)).toBe(input);
  });

  it('handles multiple tables separated by text', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |\n\nText\n\n| C | D |\n|---|---|\n| 3 | 4 |';
    const output = wrapTablesInCodeBlocks(input);
    expect(output).toContain('```\n| A | B |');
    expect(output).toContain('```\n| C | D |');
    // Should have 2 pairs of code fences (4 total)
    expect(output.match(/```/g)?.length).toBe(4);
  });

  it('preserves surrounding text', () => {
    const input = 'Before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter';
    const output = wrapTablesInCodeBlocks(input);
    expect(output).toContain('Before');
    expect(output).toContain('After');
    expect(output).toContain('```\n| A | B |');
  });

  it('handles empty input', () => {
    expect(wrapTablesInCodeBlocks('')).toBe('');
  });

  it('does not wrap tables inside tilde-fenced code blocks', () => {
    const input = '~~~\n| Col1 | Col2 |\n|------|------|\n| A    | B    |\n~~~';
    expect(wrapTablesInCodeBlocks(input)).toBe(input);
  });

  it('does not wrap tables inside 4+ backtick fences', () => {
    const input = '````\n| Col1 | Col2 |\n|------|------|\n| A    | B    |\n````';
    expect(wrapTablesInCodeBlocks(input)).toBe(input);
  });
});

describe('markdownToSlackPayload', () => {
  it('returns text-only payload when there is no table', () => {
    const payload = markdownToSlackPayload('Hello **world**');
    expect(payload.blocks).toBeUndefined();
    expect(payload.text).toContain('Hello');
    expect(payload.text).toContain('*world*');
  });

  it('preserves the mrkdwn fallback identical to markdownToMrkdwn for non-table content', () => {
    const md = '## Heading\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```';
    expect(markdownToSlackPayload(md).text).toBe(markdownToMrkdwn(md));
  });

  it('emits a native Block Kit table block for a simple GFM table', () => {
    const md = '| Col1 | Col2 |\n|------|------|\n| A    | B    |';
    const payload = markdownToSlackPayload(md);
    expect(payload.blocks).toBeDefined();
    const blocks = payload.blocks!;
    const table = blocks.find((b) => (b as { type: string }).type === 'table') as {
      type: 'table';
      rows: { type: string; text: string }[][];
    };
    expect(table).toBeDefined();
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual([
      { type: 'raw_text', text: 'Col1' },
      { type: 'raw_text', text: 'Col2' },
    ]);
    expect(table.rows[1]).toEqual([
      { type: 'raw_text', text: 'A' },
      { type: 'raw_text', text: 'B' },
    ]);
  });

  it('keeps an mrkdwn `text` field alongside structured blocks (notification fallback)', () => {
    const md = 'Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const payload = markdownToSlackPayload(md);
    expect(payload.text).toContain('Intro');
    expect(payload.text).toContain('```'); // legacy monospace fallback in text
    expect(payload.blocks).toBeDefined();
  });

  it('substitutes a single space for empty cells (Slack requires text length ≥ 1)', () => {
    const md = '| A | B |\n|---|---|\n|   | x |';
    const payload = markdownToSlackPayload(md);
    const table = payload.blocks!.find((b) => (b as { type: string }).type === 'table') as {
      rows: { text: string }[][];
    };
    expect(table.rows[1][0].text).toBe(' ');
    expect(table.rows[1][1].text).toBe('x');
  });

  it('normalizes row widths to the header width', () => {
    // Row 1 has 3 cells, row 2 has 2 (malformed); header has 3.
    const md = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 |';
    const payload = markdownToSlackPayload(md);
    const table = payload.blocks!.find((b) => (b as { type: string }).type === 'table') as {
      rows: { text: string }[][];
    };
    expect(table.rows[0]).toHaveLength(3);
    expect(table.rows[1]).toHaveLength(3);
    expect(table.rows[2]).toHaveLength(3);
    expect(table.rows[2][2].text).toBe(' '); // padded
  });

  it('falls back to a monospace section block when the table exceeds 20 columns', () => {
    const cols = Array.from({ length: 21 }, (_, i) => `c${i}`).join(' | ');
    const sep = Array.from({ length: 21 }, () => '---').join(' | ');
    const data = Array.from({ length: 21 }, (_, i) => `v${i}`).join(' | ');
    const md = `| ${cols} |\n| ${sep} |\n| ${data} |`;
    const payload = markdownToSlackPayload(md);
    expect(payload.blocks).toBeDefined();
    // No native table block — fell back to a section with a code block
    expect(payload.blocks!.some((b) => (b as { type: string }).type === 'table')).toBe(false);
    const section = payload.blocks!.find((b) => (b as { type: string }).type === 'section') as {
      text: { text: string };
    };
    expect(section.text.text).toContain('```');
    expect(section.text.text).toContain('c0');
  });

  it('falls back to a monospace section block when the table exceeds 100 rows', () => {
    const header = '| a | b |';
    const sep = '|---|---|';
    const rows = Array.from({ length: 101 }, (_, i) => `| ${i} | x |`).join('\n');
    const md = `${header}\n${sep}\n${rows}`;
    const payload = markdownToSlackPayload(md);
    expect(payload.blocks!.some((b) => (b as { type: string }).type === 'table')).toBe(false);
    const section = payload.blocks!.find((b) => (b as { type: string }).type === 'section') as {
      text: { text: string };
    };
    expect(section.text.text).toContain('```');
  });

  it('uses Slack native markdown block when a message contains multiple tables', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\nText\n\n| C | D |\n|---|---|\n| 3 | 4 |';
    const payload = markdownToSlackPayload(md);
    expect(payload.blocks).toEqual([{ type: 'markdown', text: md }]);
  });

  it('preserves intro/outro prose as section blocks around a table', () => {
    const md = 'Before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter';
    const payload = markdownToSlackPayload(md);
    const blockTypes = payload.blocks!.map((b) => (b as { type: string }).type);
    expect(blockTypes).toContain('section');
    expect(blockTypes).toContain('table');
    // The first block should be the "Before" text and the last should be "After"
    const firstSection = payload.blocks!.find((b) => (b as { type: string }).type === 'section') as
      | { text: { text: string } }
      | undefined;
    expect(firstSection?.text.text).toContain('Before');
  });

  it('uses Slack native markdown block for a table with markdown inside cells', () => {
    const md = '| Item | Notes |\n|---|---|\n| API cleanup | **Keep compatibility** |';
    const payload = markdownToSlackPayload(md);
    expect(payload.blocks).toEqual([{ type: 'markdown', text: md }]);
    expect(payload.text).toContain('```');
  });

  it('handles empty input', () => {
    const payload = markdownToSlackPayload('');
    expect(payload.text).toBe('');
    expect(payload.blocks).toBeUndefined();
  });

  it('does not emit a native table for pipe tables inside fenced code blocks', () => {
    const md = '```\n| Col1 | Col2 |\n|------|------|\n| A    | B    |\n```';
    const payload = markdownToSlackPayload(md);
    // No table block — content stays inside a fenced code block, which
    // slackify-markdown preserves verbatim in the text fallback path.
    expect(payload.blocks).toBeUndefined();
    expect(payload.text).toContain('```');
    expect(payload.text).toContain('| Col1 | Col2 |');
  });

  it('uses Slack native markdown block for three tables', () => {
    const md = [
      '| A | B |\n|---|---|\n| 1 | 2 |',
      '| C | D |\n|---|---|\n| 3 | 4 |',
      '| E | F |\n|---|---|\n| 5 | 6 |',
    ].join('\n\nText\n\n');
    const payload = markdownToSlackPayload(md);
    expect(payload.blocks).toEqual([{ type: 'markdown', text: md }]);
  });

  it('drops blocks entirely (text-only) when an oversize table would not fit even monospace', () => {
    // 200 rows × 4 cols of fat cells → exceeds both the native cap and the
    // monospace section text cap; we should fall back to text-only.
    const header = '| a | b | c | d |';
    const sep = '|---|---|---|---|';
    const fat = 'x'.repeat(200);
    const rows = Array.from({ length: 200 }, () => `| ${fat} | ${fat} | ${fat} | ${fat} |`).join(
      '\n'
    );
    const md = `${header}\n${sep}\n${rows}`;
    const payload = markdownToSlackPayload(md);
    expect(payload.blocks).toBeUndefined();
    // Content is not silently truncated — the legacy mrkdwn fallback still
    // contains the table inside its code fence.
    expect(payload.text).toContain('```');
    expect(payload.text.length).toBeGreaterThan(SECTION_MAX_CHARS_TEST);
  });

  it('normalizes CRLF line endings', () => {
    const md = '| A | B |\r\n|---|---|\r\n| 1 | 2 |';
    const payload = markdownToSlackPayload(md);
    const table = payload.blocks!.find((b) => (b as { type: string }).type === 'table') as {
      rows: { text: string }[][];
    };
    expect(table.rows[0]).toEqual([
      { type: 'raw_text', text: 'A' },
      { type: 'raw_text', text: 'B' },
    ]);
    expect(table.rows[1]).toEqual([
      { type: 'raw_text', text: '1' },
      { type: 'raw_text', text: '2' },
    ]);
  });

  it('treats escaped pipes (\\|) as literal pipe characters inside cells', () => {
    const md = '| key | value |\n|---|---|\n| or | a \\| b |';
    const payload = markdownToSlackPayload(md);
    const table = payload.blocks!.find((b) => (b as { type: string }).type === 'table') as {
      rows: { text: string }[][];
    };
    expect(table.rows[1][0].text).toBe('or');
    expect(table.rows[1][1].text).toBe('a | b');
  });

  it('emits column_settings reflecting GFM alignment markers', () => {
    const md = '| L | C | R |\n|:---|:---:|---:|\n| 1 | 2 | 3 |';
    const payload = markdownToSlackPayload(md);
    const table = payload.blocks!.find((b) => (b as { type: string }).type === 'table') as {
      column_settings?: { align: string }[];
    };
    expect(table.column_settings).toEqual([
      { align: 'left' },
      { align: 'center' },
      { align: 'right' },
    ]);
  });

  it('omits column_settings when every column is default-aligned', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const payload = markdownToSlackPayload(md);
    const table = payload.blocks!.find((b) => (b as { type: string }).type === 'table') as {
      column_settings?: unknown;
    };
    expect(table.column_settings).toBeUndefined();
  });
});

describe('SlackConnector outbound target resolution', () => {
  it('resolves channel names via conversations.list', async () => {
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    const calls: unknown[] = [];
    (connector as unknown as { web: unknown }).web = {
      conversations: {
        list: async (args: unknown) => {
          calls.push(args);
          return {
            ok: true,
            channels: [
              { id: 'C111', name: 'random' },
              { id: 'C222', name: 'project-updates', name_normalized: 'project-updates' },
            ],
            response_metadata: {},
          };
        },
      },
    };

    const resolved = await connector.resolveChannelByName('#project-updates');

    expect(resolved).toEqual({ channel: 'C222', name: 'project-updates' });
    expect(calls).toEqual([{ types: 'public_channel,private_channel', limit: 1000 }]);
  });

  it('opens a DM by Slack user email', async () => {
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    const calls: Array<{ method: string; args: unknown }> = [];
    (connector as unknown as { web: unknown }).web = {
      users: {
        lookupByEmail: async (args: unknown) => {
          calls.push({ method: 'lookupByEmail', args });
          return { ok: true, user: { id: 'U123' } };
        },
      },
      conversations: {
        open: async (args: unknown) => {
          calls.push({ method: 'open', args });
          return { ok: true, channel: { id: 'D123' } };
        },
      },
    };

    const resolved = await connector.openDmByEmail('User@Example.com');

    expect(resolved).toEqual({ channel: 'D123', user_id: 'U123' });
    expect(calls).toEqual([
      { method: 'lookupByEmail', args: { email: 'user@example.com' } },
      { method: 'open', args: { users: 'U123' } },
    ]);
  });
});

describe('SlackConnector.fetchThreadHistory', () => {
  it('normalizes Slack thread replies and filters bot messages by default', async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { botUserId: string }).botUserId = 'U_BOT';
    (connector as unknown as { web: unknown }).web = {
      conversations: {
        replies: async (args: unknown) => {
          calls.push({ method: 'replies', args });
          return {
            ok: true,
            has_more: true,
            messages: [
              { ts: '1700000000.000000', user: 'U1', text: 'hello' },
              { ts: '1700000001.000000', bot_id: 'B1', text: 'bot output' },
              { ts: '1700000002.000000', user: 'U2', text: '<@U_BOT> help' },
            ],
          };
        },
      },
      users: {
        info: async ({ user }: { user: string }) => {
          calls.push({ method: 'users.info', args: { user } });
          return {
            ok: true,
            user: {
              real_name: user,
              profile: {
                display_name: user === 'U1' ? 'Alice' : 'Bob',
                email: `${user.toLowerCase()}@example.com`,
              },
            },
          };
        },
      },
    };

    const history = await connector.fetchThreadHistory({
      threadId: 'C123-1700000000.000000',
      oldestTs: '1699999999.000000',
      latestTs: '1700000002.000000',
      inclusive: true,
      triggerTs: '1700000002.000000',
      limit: 999,
    });

    expect(calls[0]).toEqual({
      method: 'replies',
      args: {
        channel: 'C123',
        ts: '1700000000.000000',
        limit: 200,
        oldest: '1699999999.000000',
        latest: '1700000002.000000',
        inclusive: true,
      },
    });
    expect(history).toMatchObject({
      threadId: 'C123-1700000000.000000',
      channel: 'C123',
      thread_ts: '1700000000.000000',
      has_more: true,
      messages: [
        {
          ts: '1700000000.000000',
          iso_time: '2023-11-14T22:13:20.000Z',
          user_id: 'U1',
          user_name: 'Alice',
          actor_label: 'Alice',
          text: 'hello',
          is_bot: false,
          is_trigger: false,
          is_mention: false,
        },
        {
          ts: '1700000002.000000',
          iso_time: '2023-11-14T22:13:22.000Z',
          user_id: 'U2',
          user_name: 'Bob',
          actor_label: 'Bob',
          text: '<@U_BOT> help',
          is_bot: false,
          is_trigger: true,
          is_mention: true,
        },
      ],
    });
  });

  it('applies the requested limit after bot-message filtering when possible', async () => {
    const calls: unknown[] = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: unknown }).web = {
      conversations: {
        replies: async (args: unknown) => {
          calls.push(args);
          return {
            ok: true,
            has_more: false,
            messages: [
              { ts: '1700000000.000000', bot_id: 'B1', text: 'lifecycle' },
              { ts: '1700000001.000000', bot_id: 'B1', text: 'still lifecycle' },
              { ts: '1700000002.000000', user: 'U1', text: 'human one' },
              { ts: '1700000003.000000', bot_id: 'B1', text: 'bot output' },
              { ts: '1700000004.000000', user: 'U2', text: 'human two' },
            ],
          };
        },
      },
      users: {
        info: async ({ user }: { user: string }) => ({
          ok: true,
          user: { profile: { display_name: user } },
        }),
      },
    };

    const history = await connector.fetchThreadHistory({
      threadId: 'C123-1700000000.000000',
      limit: 2,
      includeBotMessages: false,
    });

    expect(calls[0]).toMatchObject({ limit: 8 });
    expect(history.messages.map((message) => message.text)).toEqual(['human one', 'human two']);
    expect(history.has_more).toBe(false);
  });
});

// Mirrors SECTION_MAX_CHARS in slack.ts; kept in the test as a lower-bound
// sanity check (we expect the legacy mrkdwn fallback to carry more than this).
const SECTION_MAX_CHARS_TEST = 3000;

describe('SlackConnector.sendMessage', () => {
  it('updates an existing Slack message when slack_update_ts metadata is present', async () => {
    const calls: unknown[] = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: unknown }).web = {
      chat: {
        update: async (args: unknown) => {
          calls.push(args);
          return { ok: true, ts: '1700000000.000001' };
        },
        postMessage: async () => {
          throw new Error('postMessage should not be called for status updates');
        },
      },
    };

    const ts = await connector.sendMessage({
      threadId: 'C123-1700000000.000000',
      text: 'still working',
      metadata: { slack_update_ts: '1700000000.000001' },
    });

    expect(ts).toBe('1700000000.000001');
    expect(calls).toEqual([
      {
        channel: 'C123',
        ts: '1700000000.000001',
        text: 'still working',
        unfurl_links: false,
        unfurl_media: false,
      },
    ]);
  });

  it('falls back to text when Slack rejects newer block types', async () => {
    const calls: unknown[] = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: unknown }).web = {
      chat: {
        postMessage: async (args: unknown) => {
          calls.push(args);
          if ((args as { blocks?: unknown[] }).blocks) {
            return { ok: false, error: 'unsupported_block_type' };
          }
          return { ok: true, ts: '1700000000.000004' };
        },
      },
    };

    const ts = await connector.sendMessage({
      threadId: 'C123-1700000000.000000',
      text: '*Plan*\n○ Test\n⏳ Still working',
      blocks: [{ type: 'plan', tasks: [] }],
    });

    expect(ts).toBe('1700000000.000004');
    expect(calls).toHaveLength(2);
    expect((calls[0] as { blocks?: unknown[] }).blocks).toBeDefined();
    expect((calls[1] as { blocks?: unknown[] }).blocks).toBeUndefined();
  });

  it('mirrors message streams with Slack chat stream methods', async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: unknown }).web = {
      chat: {
        startStream: async (args: unknown) => {
          calls.push({ method: 'startStream', args });
          return { ok: true, ts: '1700000000.000002' };
        },
        appendStream: async (args: unknown) => {
          calls.push({ method: 'appendStream', args });
          return { ok: true };
        },
        stopStream: async (args: unknown) => {
          calls.push({ method: 'stopStream', args });
          return { ok: true };
        },
      },
    };

    const ts = await connector.startStream({ threadId: 'C123-1700000000.000000' });
    await connector.appendStream({
      threadId: 'C123-1700000000.000000',
      ts,
      text: 'hello',
    });
    await connector.stopStream({ threadId: 'C123-1700000000.000000', ts });

    expect(calls).toEqual([
      {
        method: 'startStream',
        args: {
          channel: 'C123',
          thread_ts: '1700000000.000000',
          markdown_text: ' ',
        },
      },
      {
        method: 'appendStream',
        args: {
          channel: 'C123',
          ts: '1700000000.000002',
          markdown_text: 'hello',
        },
      },
      {
        method: 'stopStream',
        args: {
          channel: 'C123',
          ts: '1700000000.000002',
        },
      },
    ]);
  });

  it('passes Slack stream recipient ids when provided', async () => {
    const calls: unknown[] = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: unknown }).web = {
      chat: {
        startStream: async (args: unknown) => {
          calls.push(args);
          return { ok: true, ts: '1700000000.000005' };
        },
      },
    };

    await connector.startStream({
      threadId: 'C123-1700000000.000000',
      text: 'hello',
      recipientUserId: 'U123',
      recipientTeamId: 'T123',
    });

    expect(calls).toEqual([
      {
        channel: 'C123',
        thread_ts: '1700000000.000000',
        markdown_text: 'hello',
        recipient_user_id: 'U123',
        recipient_team_id: 'T123',
      },
    ]);
  });

  it('sets Slack assistant thread status', async () => {
    const calls: unknown[] = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: unknown }).web = {
      assistant: {
        threads: {
          setStatus: async (args: unknown) => {
            calls.push(args);
            return { ok: true };
          },
        },
      },
    };

    await connector.setThreadStatus?.({
      threadId: 'C123-1700000000.000000',
      status: 'is working on your request.',
      loadingMessages: ['Reading context…'],
      iconEmoji: ':hourglass_flowing_sand:',
    });

    expect(calls).toEqual([
      {
        channel_id: 'C123',
        thread_ts: '1700000000.000000',
        status: 'is working on your request.',
        loading_messages: ['Reading context…'],
        icon_emoji: ':hourglass_flowing_sand:',
      },
    ]);
  });

  it('deletes a previously sent Slack message', async () => {
    const calls: unknown[] = [];
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: unknown }).web = {
      chat: {
        delete: async (args: unknown) => {
          calls.push(args);
          return { ok: true };
        },
      },
    };

    await connector.deleteMessage({
      threadId: 'C123-1700000000.000000',
      messageId: '1700000000.000003',
    });

    expect(calls).toEqual([
      {
        channel: 'C123',
        ts: '1700000000.000003',
      },
    ]);
  });
});

describe('SlackConnector.lookupUserAvatarByEmail', () => {
  it('treats Slack users_not_found platform errors as a skipped lookup', async () => {
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: { users: { lookupByEmail: unknown } } }).web = {
      users: {
        lookupByEmail: async () => {
          const error = new Error('users_not_found') as Error & { data?: { error?: string } };
          error.data = { error: 'users_not_found' };
          throw error;
        },
      },
    };

    await expect(connector.lookupUserAvatarByEmail('missing@example.com')).resolves.toBeNull();
  });
});

describe('isChannelAllowedByWhitelist', () => {
  const whitelist = ['C123'];

  it('always accepts DMs even when a channel whitelist is configured', () => {
    expect(isChannelAllowedByWhitelist('im', 'D999', whitelist)).toBe(true);
  });

  it('rejects a channel-like surface not in the whitelist', () => {
    expect(isChannelAllowedByWhitelist('channel', 'C999', whitelist)).toBe(false);
  });

  it('accepts a channel-like surface that is in the whitelist', () => {
    expect(isChannelAllowedByWhitelist('channel', 'C123', whitelist)).toBe(true);
  });

  it('applies the whitelist to private channels and group DMs', () => {
    expect(isChannelAllowedByWhitelist('group', 'C999', whitelist)).toBe(false);
    expect(isChannelAllowedByWhitelist('mpim', 'C999', whitelist)).toBe(false);
  });

  it('accepts everything when no whitelist is configured', () => {
    expect(isChannelAllowedByWhitelist('channel', 'C999', undefined)).toBe(true);
    expect(isChannelAllowedByWhitelist('channel', 'C999', [])).toBe(true);
  });
});
