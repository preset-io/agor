import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useSettingsRoute } from './useSettingsRoute';

function wrapper(initialEntry: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
  );
}

function useRouteWithLocation() {
  const settings = useSettingsRoute();
  const location = useLocation();
  return { settings, pathname: location.pathname };
}

describe('useSettingsRoute', () => {
  it('uses /settings/teammates/ as the canonical teammate settings route', () => {
    const { result } = renderHook(() => useRouteWithLocation(), {
      wrapper: wrapper('/settings/teammates/'),
    });

    expect(result.current.settings.isOpen).toBe(true);
    expect(result.current.settings.section).toBe('teammates');
    expect(result.current.pathname).toBe('/settings/teammates/');
  });

  it('replaces legacy /settings/assistants/ URLs with /settings/teammates/', async () => {
    const { result } = renderHook(() => useRouteWithLocation(), {
      wrapper: wrapper('/settings/assistants/'),
    });

    expect(result.current.settings.section).toBe('teammates');

    await waitFor(() => {
      expect(result.current.pathname).toBe('/settings/teammates/');
    });
  });
});
