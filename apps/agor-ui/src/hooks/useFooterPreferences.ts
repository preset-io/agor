import React from 'react';

/** Phones fit this many pinned actions in the composer row. */
export const COMPACT_PIN_LIMIT = 2;

const DEFAULTS = {
  showToolsChip: true,
  showStatsChip: true,
  showForkInBar: true,
  showUploadInBar: true,
  pinnedItems: ['fork', 'upload'] as string[],
  /** Phone pins are separate from desktop pins and start empty. */
  pinnedItemsCompact: [] as string[],
  pinnedChips: ['timer', 'tools', 'tokens', 'context'] as string[],
};

export type FooterPreferences = typeof DEFAULTS;

const KEY = 'agor-footer-prefs';

const stringList = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : fallback;

export function useFooterPreferences(): [
  FooterPreferences,
  (patch: Partial<FooterPreferences>) => void,
] {
  const [prefs, setPrefs] = React.useState<FooterPreferences>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (stored && typeof stored === 'object') {
        return {
          ...DEFAULTS,
          ...stored,
          pinnedItems: stringList(stored.pinnedItems, DEFAULTS.pinnedItems),
          pinnedItemsCompact: stringList(
            stored.pinnedItemsCompact,
            DEFAULTS.pinnedItemsCompact
          ).slice(0, COMPACT_PIN_LIMIT),
          pinnedChips: stringList(stored.pinnedChips, DEFAULTS.pinnedChips),
        };
      }
    } catch {
      // ignore
    }
    return DEFAULTS;
  });

  const setPref = React.useCallback((patch: Partial<FooterPreferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return [prefs, setPref];
}
