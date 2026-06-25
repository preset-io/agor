import React from 'react';

const DEFAULTS = {
  showToolsChip: true,
  showStatsChip: true,
  showForkInBar: true,
  showUploadInBar: true,
  pinnedItems: ['fork', 'upload'] as string[],
  pinnedChips: ['timer', 'tools', 'model', 'tokens', 'context'] as string[],
};

export type FooterPreferences = typeof DEFAULTS;

const KEY = 'agor-footer-prefs';

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
          pinnedItems: Array.isArray(stored.pinnedItems)
            ? stored.pinnedItems
            : DEFAULTS.pinnedItems,
          pinnedChips: Array.isArray(stored.pinnedChips)
            ? stored.pinnedChips
            : DEFAULTS.pinnedChips,
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
