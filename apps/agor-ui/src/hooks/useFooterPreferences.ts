import React from 'react';

const DEFAULTS = {
  showToolsChip: true,
  showStatsChip: true,
  showForkInBar: true,
  showUploadInBar: true,
  pinnedItems: [] as string[],
};

export type FooterPreferences = typeof DEFAULTS;

const KEY = 'agor-footer-prefs';

export function useFooterPreferences(): [
  FooterPreferences,
  (patch: Partial<FooterPreferences>) => void,
] {
  const [prefs, setPrefs] = React.useState<FooterPreferences>(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) return { ...DEFAULTS, ...JSON.parse(stored) };
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
