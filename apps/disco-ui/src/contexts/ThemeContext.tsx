// biome-ignore-all lint/plugin/noHardcodedColorLiteral: application theme seed definitions and document fallbacks
import type { ThemeConfig } from 'antd';
import { theme } from 'antd';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const { darkAlgorithm, defaultAlgorithm } = theme;

export type ThemeMode = 'light' | 'dark' | 'custom';

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

const THEME_MODE_KEY = 'disco:themeMode';
const CUSTOM_THEME_KEY = 'disco:customTheme';

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

  // Memoize the theme config so every <ConfigProvider theme={...}> in the
  // tree receives a stable object reference. Without this, each render
  // produces a new ThemeConfig object and AntD's cssinjs cache invalidates +
  // re-injects styles, which manifests as a brief unstyled flicker whenever
  // anything mounts/unmounts (drawers opening, task expand/collapse, etc).
  const currentThemeConfig = useMemo<ThemeConfig>(() => {
    const dark = themeMode !== 'light';
    const baseTheme: ThemeConfig = {
      // CSS variables are enabled by default in antd v6
      token: {
        colorPrimary: dark ? '#d9bd86' : '#9b6d2e',
        colorSuccess: dark ? '#65b741' : '#3f8f2c',
        colorWarning: '#e7833c',
        colorError: dark ? '#ef6b73' : '#cf3945',
        colorInfo: dark ? '#c1c4ca' : '#686a70',
        colorLink: dark ? '#e2c998' : '#8f6429',
        colorBgBase: dark ? '#23242a' : '#f7f7f6',
        colorBgLayout: dark ? '#2a2b31' : '#efefed',
        colorBgContainer: dark ? '#26272d' : '#ffffff',
        colorBgElevated: dark ? '#2e3036' : '#ffffff',
        colorBorder: dark ? '#505158' : '#d8d9d6',
        colorBorderSecondary: dark ? '#3b3c43' : '#e6e7e4',
        colorTextBase: dark ? '#e9ebef' : '#202124',
        lineWidth: 1,
        borderRadius: 9,
        borderRadiusLG: 12,
        controlHeight: 34,
        fontSize: 14,
        lineHeight: 1.5,
        fontFamily:
          "'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif",
      },
      components: {
        Button: {
          defaultShadow: 'none',
          primaryShadow: 'none',
          dangerShadow: 'none',
        },
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
        components: {
          ...baseTheme.components,
          ...customTheme.components,
          Button: {
            ...baseTheme.components?.Button,
            ...customTheme.components?.Button,
            defaultShadow: 'none',
            primaryShadow: 'none',
            dangerShadow: 'none',
          },
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

  const getCurrentThemeConfig = useCallback(
    (): ThemeConfig => currentThemeConfig,
    [currentThemeConfig]
  );

  // Custom themes always render with darkAlgorithm (see `getCurrentThemeConfig`),
  // so `custom` implies dark. Anything non-`light` is considered dark.
  const isDark = themeMode !== 'light';

  // Update document background color and theme class when theme changes
  useEffect(() => {
    const _config = getCurrentThemeConfig();

    // Set background color on document body
    document.body.style.backgroundColor = isDark ? '#23242a' : '#f7f7f6';

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

/** Optional variant for lightweight surfaces that also render in isolated tests. */
export const useOptionalTheme = () => useContext(ThemeContext);
