// biome-ignore-all lint/plugin/noHardcodedColorLiteral: application theme seed definitions and document fallbacks
import type { ThemeConfig } from 'antd';
import { theme } from 'antd';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const { darkAlgorithm, defaultAlgorithm } = theme;

export type ThemeMode = 'light' | 'dark' | 'system' | 'custom';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_SCHEME_QUERY).matches
    : true;
}

export interface ThemeContextValue {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  customTheme: ThemeConfig | null;
  setCustomTheme: (theme: ThemeConfig | null) => void;
  getCurrentThemeConfig: () => ThemeConfig;
  /**
   * Whether the current theme resolves to a dark palette. Canonical source
   * for components that need to pick dark/light variants of a non-antd asset
   * (e.g. CodeMirror's `oneDark`). Derived from the rendered `algorithm`, so
   * consumers don't have to repeat the `themeMode === 'custom'` logic.
   */
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const THEME_MODE_KEY = 'agor:themeMode';
const CUSTOM_THEME_KEY = 'agor:customTheme';

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Initialize theme mode from localStorage (default to 'dark')
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(THEME_MODE_KEY);
    return (stored as ThemeMode) || 'dark';
  });

  // Initialize custom theme from localStorage
  const [customTheme, setCustomThemeState] = useState<ThemeConfig | null>(() => {
    const stored = localStorage.getItem(CUSTOM_THEME_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (error) {
        console.error('Failed to parse custom theme from localStorage:', error);
        return null;
      }
    }
    return null;
  });

  // Track the OS colour scheme so `system` mode can follow it and live-update
  // when the user flips their OS theme (no reload). Subscribed unconditionally
  // (cheap); only consulted while `themeMode === 'system'`.
  const [osPrefersDark, setOsPrefersDark] = useState<boolean>(systemPrefersDark);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DARK_SCHEME_QUERY);
    const onChange = (event: MediaQueryListEvent) => setOsPrefersDark(event.matches);
    setOsPrefersDark(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Persist theme mode to localStorage
  const setThemeMode = (mode: ThemeMode) => {
    setThemeModeState(mode);
    localStorage.setItem(THEME_MODE_KEY, mode);
  };

  // Persist custom theme to localStorage
  const setCustomTheme = (theme: ThemeConfig | null) => {
    if (theme) {
      // Remove algorithm function before stringifying (can't serialize functions)
      // We'll restore it in getCurrentThemeConfig based on a string indicator
      const { algorithm, ...serializableTheme } = theme;
      setCustomThemeState(serializableTheme);
      localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(serializableTheme));
    } else {
      setCustomThemeState(null);
      localStorage.removeItem(CUSTOM_THEME_KEY);
    }
  };

  // Memoize the theme config so every <ConfigProvider theme={...}> in the
  // tree receives a stable object reference. Without this, each render
  // produces a new ThemeConfig object and AntD's cssinjs cache invalidates +
  // re-injects styles, which manifests as a brief unstyled flicker whenever
  // anything mounts/unmounts (drawers opening, task expand/collapse, etc).
  const currentThemeConfig = useMemo<ThemeConfig>(() => {
    const baseTheme: ThemeConfig = {
      // CSS variables are enabled by default in antd v6
      token: {
        colorPrimary: '#2e9a92', // Agor teal
        colorSuccess: '#52c41a',
        colorWarning: '#faad14',
        colorError: '#ff4d4f',
        colorInfo: '#2e9a92',
        colorLink: '#2e9a92',
        borderRadius: 8,
        // Use Inter font from Bunny Fonts CDN with system font fallbacks
        fontFamily:
          "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
      },
    };

    if (themeMode === 'custom' && customTheme) {
      // Custom themes don't include algorithm - users should use dark/light mode
      // If they want a custom algorithm, they can set it via components
      return {
        ...baseTheme,
        ...customTheme,
        token: {
          ...baseTheme.token,
          ...customTheme.token,
        },
        // Default to dark algorithm for custom themes
        algorithm: darkAlgorithm,
      };
    }

    const resolvedDark = themeMode === 'system' ? osPrefersDark : themeMode === 'dark';
    return {
      ...baseTheme,
      algorithm: resolvedDark ? darkAlgorithm : defaultAlgorithm,
    };
  }, [themeMode, customTheme, osPrefersDark]);

  const getCurrentThemeConfig = useCallback(
    (): ThemeConfig => currentThemeConfig,
    [currentThemeConfig]
  );

  // Mirror the rendered algorithm: `custom` always renders dark, `system`
  // follows the OS, `light` is light, everything else is dark.
  const isDark = themeMode === 'light' ? false : themeMode === 'system' ? osPrefersDark : true;

  // Update document background color and theme class when theme changes
  useEffect(() => {
    const _config = getCurrentThemeConfig();

    // Set background color on document body
    document.body.style.backgroundColor = isDark ? '#141414' : '#f0f2f5';

    // Set 'dark' class for Tailwind dark mode (used by Streamdown)
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark, getCurrentThemeConfig]);

  return (
    <ThemeContext.Provider
      value={{
        themeMode,
        setThemeMode,
        customTheme,
        setCustomTheme,
        getCurrentThemeConfig,
        isDark,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
