import type React from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * UI density mode. `classic` is the default experience; `slim` is a
 * progressive-disclosure variant: contextual controls over always-visible
 * ones, drawers over modals, initials over emoji, and a minimal homepage.
 * Stored per browser (like the theme), not on the user record.
 */
export type UIMode = 'classic' | 'slim';

export interface UIModeContextValue {
  uiMode: UIMode;
  setUIMode: (mode: UIMode) => void;
  /** Convenience flag — most call sites only ask "is slim on?". */
  isSlim: boolean;
}

// Default to classic so consumers rendered without a provider (tests,
// isolated portals) behave like the stock UI instead of throwing.
const DEFAULT_UI_MODE: UIModeContextValue = {
  uiMode: 'classic',
  setUIMode: () => {},
  isSlim: false,
};

const UIModeContext = createContext<UIModeContextValue>(DEFAULT_UI_MODE);

const UI_MODE_KEY = 'agor:uiMode';

export const UIModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [uiMode, setUIModeState] = useState<UIMode>(() => {
    const stored = localStorage.getItem(UI_MODE_KEY);
    return stored === 'slim' ? 'slim' : 'classic';
  });

  const setUIMode = useCallback((mode: UIMode) => {
    setUIModeState(mode);
    localStorage.setItem(UI_MODE_KEY, mode);
  }, []);

  const value = useMemo(
    () => ({ uiMode, setUIMode, isSlim: uiMode === 'slim' }),
    [uiMode, setUIMode]
  );

  return <UIModeContext.Provider value={value}>{children}</UIModeContext.Provider>;
};

export function useUIMode(): UIModeContextValue {
  return useContext(UIModeContext);
}
