import type { ThemeConfig } from 'antd';
import { theme } from 'antd';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const { darkAlgorithm, defaultAlgorithm } = theme;

export type ThemeMode = 'light' | 'dark' | 'custom';

export interface ThemeContextValue {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  customTheme: ThemeConfig | null;
  setCustomTheme: (theme: ThemeConfig | null) => void;
  getCurrentThemeConfig: () => ThemeConfig;
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

  // Get the current theme config based on mode
  const getCurrentThemeConfig = useCallback((): ThemeConfig => {
    const baseTheme: ThemeConfig = {
      // Enable CSS variables for dynamic theming
      cssVar: true,
      token: {
        colorPrimary: '#2e9a92', // Agor teal
        colorSuccess: '#52c41a',
        colorWarning: '#faad14',
        colorError: '#ff4d4f',
        colorInfo: '#2e9a92',
        colorLink: '#2e9a92',
        borderRadius: 8,
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

    return {
      ...baseTheme,
      algorithm: themeMode === 'dark' ? darkAlgorithm : defaultAlgorithm,
    };
  }, [themeMode, customTheme]);

  // Update document background color and theme class when theme changes
  useEffect(() => {
    const config = getCurrentThemeConfig();
    const isDark =
      themeMode === 'dark' || (themeMode === 'custom' && customTheme?.algorithm === darkAlgorithm);

    console.log('Theme update:', { themeMode, isDark, customTheme: !!customTheme });

    // Set background color on document body
    document.body.style.backgroundColor = isDark ? '#141414' : '#f0f2f5';

    // Set 'dark' class for Tailwind dark mode (used by Streamdown)
    if (isDark) {
      document.documentElement.classList.add('dark');
      console.log('Added dark class to html element');
    } else {
      document.documentElement.classList.remove('dark');
      console.log('Removed dark class from html element');
    }
  }, [themeMode, customTheme, getCurrentThemeConfig]);

  return (
    <ThemeContext.Provider
      value={{
        themeMode,
        setThemeMode,
        customTheme,
        setCustomTheme,
        getCurrentThemeConfig,
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
