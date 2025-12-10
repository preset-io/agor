/**
 * URL State Hook
 *
 * Provides bidirectional synchronization between URL and React state
 * for board and session selection.
 *
 * URL format: /b/:boardParam/:sessionParam?
 * - boardParam can be a slug (my-board) or short ID (550e8400)
 * - sessionParam uses short ID (optional)
 *
 * Examples:
 * - /b/main-board
 * - /b/main-board/a1b2c3d4
 * - /b/550e8400/a1b2c3d4
 */

import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

export interface UrlState {
  boardParam: string | null;
  sessionId: string | null;
}

export interface UseUrlStateOptions {
  /** Current board ID (full UUID) */
  currentBoardId: string | null;
  /** Current session ID (full UUID) */
  currentSessionId: string | null;
  /** Map of board ID to board object (for slug lookup) */
  boardById: Map<string, { board_id: string; slug?: string }>;
  /** Map of session ID to session object (for short ID resolution) */
  sessionById: Map<string, { session_id: string }>;
  /** Callback when URL indicates a different board */
  onBoardChange: (boardIdOrSlug: string) => void;
  /** Callback when URL indicates a different session */
  onSessionChange: (sessionId: string | null) => void;
}

/**
 * Extract short ID (first 8 chars without hyphens) from a UUID
 */
function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8);
}

/**
 * Hook for bidirectional URL state synchronization
 */
export function useUrlState(options: UseUrlStateOptions) {
  const {
    currentBoardId,
    currentSessionId,
    boardById,
    sessionById,
    onBoardChange,
    onSessionChange,
  } = options;

  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ boardParam?: string; sessionParam?: string }>();

  // Track if we're currently syncing to prevent loops
  const syncingRef = useRef(false);
  // Track the last URL we navigated to
  const lastNavigatedRef = useRef<string | null>(null);
  // Track current state in refs to avoid dependency issues
  const currentBoardIdRef = useRef(currentBoardId);
  const currentSessionIdRef = useRef(currentSessionId);
  // Track the last URL params we processed to avoid re-processing
  const lastUrlBoardParamRef = useRef<string | null>(null);
  const lastUrlSessionParamRef = useRef<string | null>(null);
  // Track whether we successfully resolved URL params (for retry logic)
  const urlParamsResolvedRef = useRef<{ board: boolean; session: boolean }>({
    board: false,
    session: false,
  });

  // Keep refs in sync with state
  useEffect(() => {
    currentBoardIdRef.current = currentBoardId;
    currentSessionIdRef.current = currentSessionId;
  }, [currentBoardId, currentSessionId]);

  // Parse URL state
  const urlBoardParam = params.boardParam || null;
  const urlSessionParam = params.sessionParam || null;

  // Check if we're on a settings route (should not interfere with board URL state)
  const isSettingsRoute = location.pathname.startsWith('/settings');

  /**
   * Build URL from state (Django-style with trailing slash)
   */
  const buildUrl = useCallback(
    (boardId: string | null, sessionId: string | null): string => {
      if (!boardId) return '/';

      // Prefer slug over short ID for beautiful URLs
      const board = boardById.get(boardId);
      const boardParam = board?.slug || shortId(boardId);

      let url = `/b/${boardParam}`;
      if (sessionId) {
        url += `/${shortId(sessionId)}`;
      }
      return `${url}/`; // Django-style trailing slash
    },
    [boardById]
  );

  /**
   * Update URL from state (state -> URL)
   */
  const updateUrlFromState = useCallback(() => {
    if (syncingRef.current) {
      return;
    }

    const newUrl = buildUrl(currentBoardId, currentSessionId);
    // Normalize current path (add trailing slash if missing)
    const currentPath = `${(location.pathname + location.search).replace(/\/$/, '')}/`;
    const normalizedNewUrl = `${newUrl.replace(/\/$/, '')}/`;

    // Only navigate if URL actually changed
    if (normalizedNewUrl !== currentPath && newUrl !== lastNavigatedRef.current) {
      lastNavigatedRef.current = newUrl;
      navigate(newUrl, { replace: true });
    }
  }, [currentBoardId, currentSessionId, buildUrl, location.pathname, location.search, navigate]);

  /**
   * Resolve URL param to board ID
   */
  const resolveBoardFromUrl = useCallback(
    (boardParam: string): string | null => {
      // First, try to find by slug
      for (const board of boardById.values()) {
        if (board.slug === boardParam) {
          return board.board_id;
        }
      }

      // Then, try to find by short ID prefix
      const normalizedParam = boardParam.toLowerCase();
      for (const board of boardById.values()) {
        const boardShortId = shortId(board.board_id).toLowerCase();
        if (boardShortId.startsWith(normalizedParam) || normalizedParam.startsWith(boardShortId)) {
          return board.board_id;
        }
      }

      return null;
    },
    [boardById]
  );

  /**
   * Resolve session ID from short ID
   */
  const resolveSessionFromShortId = useCallback(
    (sessionShortId: string): string | null => {
      // Normalize the short ID (remove hyphens, lowercase)
      const normalizedShortId = sessionShortId.replace(/-/g, '').toLowerCase();

      // Find session whose ID starts with this short ID
      for (const session of sessionById.values()) {
        const sessionShortIdNormalized = shortId(session.session_id).toLowerCase();
        if (
          sessionShortIdNormalized.startsWith(normalizedShortId) ||
          normalizedShortId.startsWith(sessionShortIdNormalized)
        ) {
          return session.session_id;
        }
      }

      return null;
    },
    [sessionById]
  );

  // Sync URL -> State on mount and URL changes
  // Retries resolution when data becomes available (for deep links)
  useEffect(() => {
    // Check if URL params actually changed
    const urlParamsChanged =
      urlBoardParam !== lastUrlBoardParamRef.current ||
      urlSessionParam !== lastUrlSessionParamRef.current;

    // Reset resolution tracking when URL params change
    if (urlParamsChanged) {
      urlParamsResolvedRef.current = { board: false, session: false };
      lastUrlBoardParamRef.current = urlBoardParam;
      lastUrlSessionParamRef.current = urlSessionParam;
    }

    // Skip if URL hasn't changed AND we've already successfully resolved everything
    // For board+session URLs, we need both to be resolved before stopping retries
    const fullyResolved =
      urlParamsResolvedRef.current.board && urlParamsResolvedRef.current.session;
    if (!urlParamsChanged && fullyResolved) {
      return;
    }

    if (!urlBoardParam) {
      // No board in URL - if we have a current board, update URL
      // But skip if we're on a settings route (settings modal overlays the board)
      if (currentBoardIdRef.current && boardById.size > 0 && !isSettingsRoute) {
        updateUrlFromState();
      }
      return;
    }

    // Only try to resolve if we have boards loaded
    if (boardById.size === 0) {
      return;
    }

    // If we have a session param, also wait for sessions to load
    if (urlSessionParam && sessionById.size === 0) {
      return;
    }

    // Only sync from URL if the URL actually represents a different board/session
    const resolvedBoardId = resolveBoardFromUrl(urlBoardParam);
    const resolvedSessionId = urlSessionParam ? resolveSessionFromShortId(urlSessionParam) : null;

    // Track resolution status
    if (resolvedBoardId) {
      urlParamsResolvedRef.current.board = true;
    }
    if (!urlSessionParam || resolvedSessionId) {
      urlParamsResolvedRef.current.session = true;
    }

    // Check if URL is different from current state (using refs)
    const boardChanged = resolvedBoardId && resolvedBoardId !== currentBoardIdRef.current;
    const sessionChanged = resolvedSessionId !== currentSessionIdRef.current;

    if (boardChanged || sessionChanged) {
      syncingRef.current = true;

      if (boardChanged) {
        onBoardChange(resolvedBoardId);
      }

      if (sessionChanged) {
        onSessionChange(resolvedSessionId);
      }

      // Reset sync flag after a tick to allow state updates
      setTimeout(() => {
        syncingRef.current = false;
      }, 0);
    }
  }, [
    urlBoardParam,
    urlSessionParam,
    boardById.size,
    sessionById.size,
    resolveBoardFromUrl,
    resolveSessionFromShortId,
    onBoardChange,
    onSessionChange,
    updateUrlFromState,
    isSettingsRoute,
  ]);

  // Sync State -> URL when state changes
  useEffect(() => {
    if (syncingRef.current) {
      return;
    }

    // Skip if we're on a settings route (settings modal overlays the board)
    if (isSettingsRoute) {
      return;
    }

    // Only sync if we have boards loaded
    if (boardById.size === 0) {
      return;
    }

    // Don't overwrite URL if we're still trying to resolve incoming URL params
    // This prevents the race where we redirect before data is loaded
    // For board+session URLs, wait for both to be resolved
    if (urlBoardParam && !urlParamsResolvedRef.current.board) {
      return;
    }
    if (urlSessionParam && !urlParamsResolvedRef.current.session) {
      return;
    }

    updateUrlFromState();
  }, [boardById.size, urlBoardParam, urlSessionParam, updateUrlFromState, isSettingsRoute]);

  return {
    urlBoardParam,
    urlSessionParam,
    buildUrl,
  };
}
