import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';

/** Controllable matchMedia so `system` mode can be driven and flipped live. */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initialDark;
  window.matchMedia = ((query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
        listeners.add(cb),
      removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
        listeners.delete(cb),
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return {
    flip(nextDark: boolean) {
      matches = nextDark;
      for (const cb of listeners) cb({ matches: nextDark } as MediaQueryListEvent);
    },
  };
}

function Probe() {
  const { themeMode, setThemeMode, isDark } = useTheme();
  return (
    <div>
      <span data-testid="mode">{themeMode}</span>
      <span data-testid="isDark">{String(isDark)}</span>
      <button type="button" onClick={() => setThemeMode('system')}>
        system
      </button>
      <button type="button" onClick={() => setThemeMode('light')}>
        light
      </button>
    </div>
  );
}

describe('ThemeContext system mode', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('follows the OS scheme when mode is system', () => {
    installMatchMedia(false); // OS prefers light
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    act(() => screen.getByText('system').click());
    expect(screen.getByTestId('mode')).toHaveTextContent('system');
    expect(screen.getByTestId('isDark')).toHaveTextContent('false');
  });

  it('live-updates isDark when the OS scheme flips (no reload)', () => {
    const media = installMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    act(() => screen.getByText('system').click());
    expect(screen.getByTestId('isDark')).toHaveTextContent('false');
    act(() => media.flip(true));
    expect(screen.getByTestId('isDark')).toHaveTextContent('true');
  });

  it('persists the selected mode to localStorage', () => {
    installMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    act(() => screen.getByText('system').click());
    expect(localStorage.getItem('agor:themeMode')).toBe('system');
  });
});
