import { describe, expect, it } from 'vitest';

import {
  discordAllowedMentionsNone,
  discordMessageNonce,
  discordUnicodeLength,
  formatDiscordMarkdown,
  normalizeDiscordTables,
} from './discord-format';

describe('Discord formatting', () => {
  it('uses an empty allowed-mentions policy suitable for creates and edits', () => {
    expect(discordAllowedMentionsNone()).toEqual({
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    });
  });

  it("derives stable distinct nonces within Discord's 25-character limit", () => {
    const first = discordMessageNonce('message-1', 0);
    expect(first).toBe(discordMessageNonce('message-1', 0));
    expect(first).not.toBe(discordMessageNonce('message-1', 1));
    expect(first.length).toBeLessThanOrEqual(25);
  });

  it('renders narrow GFM tables as fenced monospace without touching fenced examples', () => {
    const table = '| Name | State |\n| --- | --- |\n| Agor | Ready |';
    expect(normalizeDiscordTables(table)).toBe(`\`\`\`text\n${table}\n\`\`\``);
    const alreadyFenced = `\`\`\`md\n${table}\n\`\`\``;
    expect(normalizeDiscordTables(alreadyFenced)).toBe(alreadyFenced);
  });

  it('splits Unicode safely and keeps every fenced-code chunk balanced', () => {
    const body = Array.from({ length: 80 }, (_, index) => `console.log("😀-${index}");`).join('\n');
    const formatted = formatDiscordMarkdown(`Before\n\n\`\`\`ts\n${body}\n\`\`\`\n\nAfter`, {
      maxCharacters: 160,
      maxChunks: 100,
    });

    expect(formatted.chunks.length).toBeGreaterThan(2);
    for (const chunk of formatted.chunks) {
      expect(discordUnicodeLength(chunk)).toBeLessThanOrEqual(160);
      expect((chunk.match(/^```/gm)?.length ?? 0) % 2).toBe(0);
      expect(chunk).not.toContain('\uFFFD');
    }
  });

  it('returns complete Markdown overflow instead of silently exceeding the chat chunk cap', () => {
    const markdown = Array.from(
      { length: 30 },
      (_, index) => `Paragraph ${index}: ${'x'.repeat(80)}`
    ).join('\n\n');
    const formatted = formatDiscordMarkdown(markdown, { maxCharacters: 100, maxChunks: 3 });
    expect(formatted.chunks).toHaveLength(3);
    expect(formatted.chunks[2]).toMatch(/attached Markdown file/);
    expect(formatted.overflowMarkdown).toBe(markdown);
  });
});
