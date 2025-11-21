import data from 'emojibase-data/en/compact.json';
import shortcodes from 'emojibase-data/en/shortcodes/emojibase.json';
import { useMemo } from 'react';

/**
 * Emoji shortcode data for autocomplete
 */
export interface EmojiOption {
  shortcode: string;
  emoji: string;
  keywords?: string[];
}

/**
 * Hook that provides emoji autocomplete functionality using emojibase data
 * Uses comprehensive emojibase shortcodes for maximum emoji coverage
 */
export const useEmojiAutocomplete = () => {
  // Build emoji lookup from emojibase data
  const allEmojis = useMemo<EmojiOption[]>(() => {
    const emojiMap = new Map<string, { emoji: string; tags?: string[] }>();

    // Build map of hexcode -> emoji data
    for (const emoji of data) {
      if (emoji.unicode) {
        emojiMap.set(emoji.hexcode, {
          emoji: emoji.unicode,
          tags: emoji.tags || [],
        });
      }
    }

    // Map shortcodes to emoji options
    const options: EmojiOption[] = [];
    for (const [hexcode, codes] of Object.entries(shortcodes)) {
      const emojiData = emojiMap.get(hexcode);
      if (!emojiData) continue;

      // Shortcodes can be either a string or an array of strings
      const codeArray = Array.isArray(codes) ? codes : [codes];
      for (const code of codeArray) {
        options.push({
          shortcode: code,
          emoji: emojiData.emoji,
          keywords: emojiData.tags,
        });
      }
    }

    return options;
  }, []);

  const searchEmojis = useMemo(
    () =>
      (query: string): EmojiOption[] => {
        if (!query) {
          return allEmojis.slice(0, 20);
        }

        const lowerQuery = query.toLowerCase();

        // Filter emojis by shortcode or keyword match
        const matches = allEmojis.filter((emoji) => {
          const shortcodeMatch = emoji.shortcode.toLowerCase().includes(lowerQuery);
          const keywordMatch =
            emoji.keywords?.some((kw) => kw.toLowerCase().includes(lowerQuery)) || false;
          return shortcodeMatch || keywordMatch;
        });

        // Sort by relevance:
        // 1. Exact shortcode match
        // 2. Shortcode starts with query
        // 3. Shortcode contains query
        // 4. Keyword matches
        return matches
          .sort((a, b) => {
            const aShortcode = a.shortcode.toLowerCase();
            const bShortcode = b.shortcode.toLowerCase();

            // Exact match
            if (aShortcode === lowerQuery) return -1;
            if (bShortcode === lowerQuery) return 1;

            // Starts with
            const aStarts = aShortcode.startsWith(lowerQuery);
            const bStarts = bShortcode.startsWith(lowerQuery);
            if (aStarts && !bStarts) return -1;
            if (!aStarts && bStarts) return 1;

            // Contains
            const aContains = aShortcode.includes(lowerQuery);
            const bContains = bShortcode.includes(lowerQuery);
            if (aContains && !bContains) return -1;
            if (!aContains && bContains) return 1;

            // Alphabetical for same relevance
            return aShortcode.localeCompare(bShortcode);
          })
          .slice(0, 20);
      },
    [allEmojis]
  );

  return { searchEmojis, allEmojis };
};
