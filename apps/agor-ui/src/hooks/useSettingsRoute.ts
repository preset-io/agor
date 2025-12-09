import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Valid settings sections that can be routed to
 */
export type SettingsSection =
  | 'boards'
  | 'repos'
  | 'worktrees'
  | 'mcp'
  | 'agentic-tools'
  | 'users'
  | 'about';

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

    const [, section, itemId] = settingsMatch;

    // Validate and normalize section
    const validSections: SettingsSection[] = [
      'boards',
      'repos',
      'worktrees',
      'mcp',
      'agentic-tools',
      'users',
      'about',
    ];

    const normalizedSection: SettingsSection = validSections.includes(section as SettingsSection)
      ? (section as SettingsSection)
      : 'boards';

    return {
      isOpen: true,
      section: normalizedSection,
      itemId: itemId || null,
    };
  }, [location.pathname]);

  /**
   * Open the settings modal to a specific section
   */
  const openSettings = useCallback(
    (section: SettingsSection = 'boards', itemId?: string) => {
      const path = itemId ? `/settings/${section}/${itemId}/` : `/settings/${section}/`;
      navigate(path);
    },
    [navigate]
  );

  /**
   * Close the settings modal (navigate back or to root)
   */
  const closeSettings = useCallback(() => {
    // Navigate to root or previous non-settings route
    // For now, just go to root. Could be improved to remember previous location.
    navigate('/');
  }, [navigate]);

  /**
   * Change the current settings section
   */
  const setSection = useCallback(
    (section: SettingsSection) => {
      navigate(`/settings/${section}/`);
    },
    [navigate]
  );

  /**
   * Open a specific item within the current section
   */
  const openItem = useCallback(
    (itemId: string) => {
      navigate(`/settings/${routeState.section}/${itemId}/`);
    },
    [navigate, routeState.section]
  );

  /**
   * Close the item modal but stay in the section
   */
  const closeItem = useCallback(() => {
    navigate(`/settings/${routeState.section}/`);
  }, [navigate, routeState.section]);

  return {
    ...routeState,
    openSettings,
    closeSettings,
    setSection,
    openItem,
    closeItem,
  };
}
