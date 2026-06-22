import { useEffect, useMemo, useState } from 'react';

/**
 * Emoji shortcode data for autocomplete
 */
export interface EmojiOption {
  shortcode: string;
  emoji: string;
  keywords?: string[];
}

/**
 * Shapes of the raw emojibase JSON we consume. Typed locally so the dynamic
 * `import()` below doesn't fall back to `any`.
 */
interface CompactEmoji {
  hexcode: string;
  unicode?: string;
  tags?: string[];
}
type ShortcodeMap = Record<string, string | string[]>;

/**
 * Module-level cache shared by every hook instance. The emojibase data
 * (`emojibase-data/en/compact.json` + shortcodes, ~1.2MB raw) used to be a
 * static import that landed in the initial bundle and was parsed on first
 * render of the always-mounted AutocompleteTextarea. We now pull it in via a
 * dynamic `import()` gated on first need (idle warm-up or first `:` trigger),
 * memoizing the built option list so it's parsed at most once.
 */
let emojiOptionsCache: EmojiOption[] | null = null;
let emojiOptionsPromise: Promise<EmojiOption[]> | null = null;

const loadEmojiOptions = (): Promise<EmojiOption[]> => {
  if (emojiOptionsCache) return Promise.resolve(emojiOptionsCache);
  if (emojiOptionsPromise) return emojiOptionsPromise;

  emojiOptionsPromise = (async () => {
    try {
      const [compactModule, shortcodesModule] = await Promise.all([
        import('emojibase-data/en/compact.json'),
        import('emojibase-data/en/shortcodes/emojibase.json'),
      ]);
      const data = compactModule.default as CompactEmoji[];
      const shortcodes = shortcodesModule.default as ShortcodeMap;

      // Build map of hexcode -> emoji data
      const emojiMap = new Map<string, { emoji: string; tags?: string[] }>();
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

      emojiOptionsCache = options;
      return options;
    } catch (error) {
      console.error('Failed to load emoji autocomplete data.', error);
      // Don't poison the success cache on a transient chunk-load failure:
      // leave `emojiOptionsCache` null and clear the in-flight promise so a
      // later search / idle warm-up can retry the import.
      emojiOptionsPromise = null;
      return [];
    }
  })();

  return emojiOptionsPromise;
};

/**
 * Hook that provides emoji autocomplete functionality using emojibase data
 * Uses comprehensive emojibase shortcodes for maximum emoji coverage
 *
 * The underlying dataset loads lazily: `allEmojis` is `[]` and `searchEmojis`
 * returns `[]` until the data resolves. We warm the load during idle time so
 * the first `:` trigger is instant in practice; a first `searchEmojis` call
 * also kicks off the load as a fallback. The hook's external API is unchanged.
 */
export const useEmojiAutocomplete = () => {
  const [allEmojis, setAllEmojis] = useState<EmojiOption[]>(() => emojiOptionsCache ?? []);

  // Warm the dataset during idle time so it's ready before the user types `:`.
  // When the cache is already populated, the useState initializer above has
  // it, so this effect only needs to handle the cold-load case.
  useEffect(() => {
    if (emojiOptionsCache) return;

    let cancelled = false;
    const warm = () => {
      loadEmojiOptions().then((opts) => {
        if (!cancelled) setAllEmojis(opts);
      });
    };

    const ric = window.requestIdleCallback;
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof ric === 'function') {
      idleId = ric(warm);
    } else {
      timeoutId = setTimeout(warm, 1500);
    }

    return () => {
      cancelled = true;
      if (idleId !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, []);

  const searchEmojis = useMemo(
    () =>
      (query: string): EmojiOption[] => {
        // Fallback trigger: if idle warm-up hasn't fired yet, start the load so
        // results appear on a subsequent keystroke once the data resolves.
        if (allEmojis.length === 0) {
          if (!emojiOptionsCache) {
            loadEmojiOptions().then(setAllEmojis);
          }
          return [];
        }

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
