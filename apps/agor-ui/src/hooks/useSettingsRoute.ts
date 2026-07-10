import { useCallback, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Valid settings sections that can be routed to.
 * Single source of truth — the type is derived from this array.
 */
export const SETTINGS_SECTIONS = [
  'boards',
  'repos',
  'branches',
  'teammates',
  'cards',
  'artifacts',
  'mcp',
  'agentic-tools',
  'gateway',
  'groups',
  'users',
  'about',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Settings route state parsed from URL
 */
export interface SettingsRouteState {
  /** Whether settings modal should be open */
  isOpen: boolean;
  /** The current settings section (tab) */
  section: SettingsSection;
  /** Optional item ID for nested modals (e.g., user ID, MCP server ID) */
  itemId: string | null;
}

/**
 * Hook to manage settings modal state via URL routing
 *
 * URL patterns:
 * - /settings/ → Settings modal open at default section (boards)
 * - /settings/users/ → Settings modal open at Users section
 * - /settings/users/:userId/ → Settings modal + User edit modal for specific user
 * - /settings/mcp/:serverId/ → Settings modal + MCP server edit modal
 *
 * The settings routes work as overlays on top of the current board view.
 * When navigating to /settings/*, the board remains visible behind the modal.
 */
export function useSettingsRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const settingsBackgroundPath =
    (location.state as { settingsBackgroundPath?: string } | null)?.settingsBackgroundPath ?? null;

  // Parse the current location to extract settings state
  const routeState = useMemo<SettingsRouteState>(() => {
    const pathname = location.pathname;

    // Check if we're on a settings route
    // Match patterns like /settings/, /settings/users/, /settings/users/abc123/
    const settingsMatch = pathname.match(/\/settings(?:\/([^/]+))?(?:\/([^/]+))?\/?$/);

    if (!settingsMatch) {
      return {
        isOpen: false,
        section: 'boards',
        itemId: null,
      };
    }

    const [, rawSection, itemId] = settingsMatch;
    const section = rawSection === 'assistants' ? 'teammates' : rawSection;

    // Validate and normalize section
    const normalizedSection: SettingsSection = SETTINGS_SECTIONS.includes(
      section as SettingsSection
    )
      ? (section as SettingsSection)
      : 'boards';

    return {
      isOpen: true,
      section: normalizedSection,
      itemId: itemId || null,
    };
  }, [location.pathname]);

  useEffect(() => {
    const canonicalPath = location.pathname.replace(
      /\/settings\/assistants(?=\/|$)/,
      '/settings/teammates'
    );
    if (canonicalPath !== location.pathname) {
      navigate(`${canonicalPath}${location.search}${location.hash}`, {
        replace: true,
        state: location.state,
      });
    }
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  /**
   * Open the settings modal to a specific section
   */
  const openSettings = useCallback(
    (section: SettingsSection = 'boards', itemId?: string) => {
      const path = itemId ? `/settings/${section}/${itemId}/` : `/settings/${section}/`;
      const backgroundPath = location.pathname.startsWith('/settings')
        ? settingsBackgroundPath || '/'
        : `${location.pathname}${location.search}${location.hash}`;
      navigate(path, { state: { settingsBackgroundPath: backgroundPath } });
    },
    [location.hash, location.pathname, location.search, navigate, settingsBackgroundPath]
  );

  /**
   * Close the settings modal (navigate back or to root)
   */
  const closeSettings = useCallback(() => {
    navigate(settingsBackgroundPath || '/');
  }, [navigate, settingsBackgroundPath]);

  /**
   * Change the current settings section
   */
  const setSection = useCallback(
    (section: SettingsSection) => {
      navigate(`/settings/${section}/`, {
        state: settingsBackgroundPath ? { settingsBackgroundPath } : undefined,
      });
    },
    [navigate, settingsBackgroundPath]
  );

  /**
   * Open a specific item within the current section
   */
  const openItem = useCallback(
    (itemId: string) => {
      navigate(`/settings/${routeState.section}/${itemId}/`, {
        state: settingsBackgroundPath ? { settingsBackgroundPath } : undefined,
      });
    },
    [navigate, routeState.section, settingsBackgroundPath]
  );

  /**
   * Close the item modal but stay in the section
   */
  const closeItem = useCallback(() => {
    navigate(`/settings/${routeState.section}/`, {
      state: settingsBackgroundPath ? { settingsBackgroundPath } : undefined,
    });
  }, [navigate, routeState.section, settingsBackgroundPath]);

  return {
    ...routeState,
    openSettings,
    closeSettings,
    setSection,
    openItem,
    closeItem,
  };
}
