import { createRequire } from 'node:module';

interface EmojibaseCompactEmoji {
  hexcode: string;
  unicode?: string;
}

type EmojibaseShortcodes = Record<string, string | string[]>;

const requireJson = createRequire(import.meta.url);
const emojiData = requireJson('emojibase-data/en/compact.json') as EmojibaseCompactEmoji[];
const shortcodes = requireJson(
  'emojibase-data/en/shortcodes/emojibase.json'
) as EmojibaseShortcodes;

const emojiByHexcode = new Map<string, string>();
for (const emoji of emojiData) {
  if (emoji.unicode) {
    emojiByHexcode.set(emoji.hexcode, emoji.unicode);
  }
}

const emojiByShortcode = new Map<string, string>();
for (const [hexcode, codes] of Object.entries(shortcodes)) {
  const emoji = emojiByHexcode.get(hexcode);
  if (!emoji) continue;

  const codeList = Array.isArray(codes) ? codes : [codes];
  for (const code of codeList) {
    emojiByShortcode.set(code.toLowerCase(), emoji);
  }
}

/**
 * Normalize exact emoji shortcodes to Unicode while preserving arbitrary text.
 *
 * This intentionally only rewrites whole-field shortcodes such as `:compass:`.
 * It does not parse Markdown/content or replace shortcodes embedded in text.
 */
export function normalizeExactEmojiShortcode(value: undefined): undefined;
export function normalizeExactEmojiShortcode(value: null): null;
export function normalizeExactEmojiShortcode(value: string): string;
export function normalizeExactEmojiShortcode(value: string | undefined): string | undefined;
export function normalizeExactEmojiShortcode(value: string | null): string | null;
export function normalizeExactEmojiShortcode(
  value: string | null | undefined
): string | null | undefined;
export function normalizeExactEmojiShortcode(
  value: string | null | undefined
): string | null | undefined {
  if (value == null) return value;

  const trimmed = value.trim();
  const shortcodeMatch = trimmed.match(/^:([^:\s]+):$/);
  if (!shortcodeMatch) return trimmed;

  return emojiByShortcode.get(shortcodeMatch[1].toLowerCase()) ?? trimmed;
}
