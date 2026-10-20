import React from 'react';

/** Phones fit this many pinned actions in the composer row. */
export const COMPACT_PIN_LIMIT = 2;

const DEFAULTS = {
  showToolsChip: true,
  showStatsChip: true,
  showForkInBar: true,
  showUploadInBar: true,
  /** Desktop row pins. MCP tools is pinned by default, as main showed its chip by default. */
  pinnedItems: ['fork', 'upload', 'mcp'] as string[],
  /** Phone pins are separate from desktop pins. Attach stays one tap, as on main. */
  pinnedItemsCompact: ['upload'] as string[],
  pinnedChips: ['timer', 'tokens', 'context'] as string[],
  pinsVersion: 2,
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
        let pinnedItems = stringList(stored.pinnedItems, DEFAULTS.pinnedItems);
        let pinnedChips = stringList(stored.pinnedChips, DEFAULTS.pinnedChips);
        // Once: an MCP chip shown in the info bar becomes the MCP button in the row.
        if (stored.pinsVersion !== DEFAULTS.pinsVersion) {
          if (pinnedChips.includes('tools') && !pinnedItems.includes('mcp')) {
            pinnedItems = [...pinnedItems, 'mcp'];
          }
          pinnedChips = pinnedChips.filter((chip) => chip !== 'tools');
        }
        return {
          ...DEFAULTS,
          ...stored,
          pinsVersion: DEFAULTS.pinsVersion,
          pinnedItems,
          pinnedItemsCompact: stringList(
            stored.pinnedItemsCompact,
            DEFAULTS.pinnedItemsCompact
          ).slice(0, COMPACT_PIN_LIMIT),
          pinnedChips,
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
