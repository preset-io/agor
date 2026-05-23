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

import { findByShortIdPrefix, shortId } from '@agor-live/client';
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useRecenterMap } from '../contexts/CanvasNavigationContext';

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
  /** Map of session ID to session object (for short ID resolution and
   *  recenter target lookup). `worktree_id` is read on URL→state sync to
   *  recenter the canvas on the session's worktree. */
  sessionById: Map<string, { session_id: string; worktree_id?: string }>;
  /** Callback when URL indicates a different board */
  onBoardChange: (boardIdOrSlug: string) => void;
  /** Callback when URL indicates a different session */
  onSessionChange: (sessionId: string | null) => void;
}

/**
 * Extract the canonical short ID for use in URLs.
 *
 * Same `SHORT_ID_LENGTH` (24-char) shape used everywhere else — URLs use the
 * same display length as notifications/pills so users can copy-paste between
 * surfaces and have the prefix round-trip via `findByShortIdPrefix`.
 */
const urlShortId = (uuid: string) => shortId(uuid);

/**
 * Build a board-only path (`/b/<slug|shortId>/`). Prefers slug if available
 * so URLs are human-readable; falls back to short ID. Includes the trailing
 * slash to match the canonical Django-style form used throughout the app.
 *
 * Exported so the central navigation hook (`useAppNavigation`) and any
 * other deliberate-nav site can build URLs identically to the state→URL
 * self-heal here.
 */
export function buildBoardPath(
  boardId: string,
  boardById: Map<string, { board_id: string; slug?: string }>
): string {
  const board = boardById.get(boardId);
  const param = board?.slug || urlShortId(boardId);
  return `/b/${param}/`;
}

/** Build a session path under a board (`/b/<board>/<sessionShortId>/`). */
export function buildSessionPath(
  boardId: string,
  sessionId: string,
  boardById: Map<string, { board_id: string; slug?: string }>
): string {
  return `${buildBoardPath(boardId, boardById)}${urlShortId(sessionId)}/`;
}

/**
 * Pure resolver: short-ID prefix → board ID, with ambiguity treated as
 * not-found. Extracted from the hook closure so it can be unit-tested
 * directly. See the doc on `resolveSessionFromShortIdPure` for why we
 * refuse to guess on ambiguous matches.
 */
export function resolveBoardFromUrlPure(
  boardParam: string,
  boardById: Map<string, { board_id: string; slug?: string }>,
  onAmbiguous?: (param: string, matchCount: number) => void
): string | null {
  for (const board of boardById.values()) {
    if (board.slug === boardParam) {
      return board.board_id;
    }
  }
  const matches = findByShortIdPrefix(
    boardParam,
    Array.from(boardById.values(), (b) => ({ id: b.board_id }))
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;
  onAmbiguous?.(boardParam, matches.length);
  return null;
}

/**
 * Pure resolver: short-ID prefix → session ID, with ambiguity treated as
 * not-found. Previously this silently routed to the lexicographically-
 * greatest match (newest by UUIDv7's time ordering); that was a deliberate
 * "don't 500 the page" choice when 8-char URLs were collision-prone, but
 * it could silently land a stale deep link on the *wrong* session. With
 * `SHORT_ID_LENGTH` now 24 (~290K same-ms IDs before 1% collision),
 * realistic new URLs are unambiguous, so we'd rather surface the failure
 * than mis-route.
 */
export function resolveSessionFromShortIdPure(
  sessionShortId: string,
  sessionById: Map<string, { session_id: string }>,
  onAmbiguous?: (shortId: string, matchCount: number) => void
): string | null {
  const matches = findByShortIdPrefix(
    sessionShortId,
    Array.from(sessionById.values(), (s) => ({ id: s.session_id }))
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;
  onAmbiguous?.(sessionShortId, matches.length);
  return null;
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
  const recenterMap = useRecenterMap();

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
      return sessionId
        ? buildSessionPath(boardId, sessionId, boardById)
        : buildBoardPath(boardId, boardById);
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

  // Dev-only warning on ambiguous URL prefixes — see `resolveSessionFromShortIdPure`
  // for the rationale. Returning `null` (not-found) is the production behavior.
  const warnAmbiguous = useCallback((kind: 'board' | 'session', param: string, n: number) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[useUrlState] ${kind === 'board' ? 'Board' : 'Session'} short ID "${param}" matched ${n} ` +
          `${kind === 'board' ? 'boards' : 'sessions'}; treating as not-found ` +
          `(URL must use full UUID or unambiguous prefix).`
      );
    }
  }, []);

  const resolveBoardFromUrl = useCallback(
    (boardParam: string) =>
      resolveBoardFromUrlPure(boardParam, boardById, (p, n) => warnAmbiguous('board', p, n)),
    [boardById, warnAmbiguous]
  );

  const resolveSessionFromShortId = useCallback(
    (sessionShortId: string) =>
      resolveSessionFromShortIdPure(sessionShortId, sessionById, (p, n) =>
        warnAmbiguous('session', p, n)
      ),
    [sessionById, warnAmbiguous]
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

    // Skip if URL hasn't changed AND we've already resolved everything.
    //
    // Invariant: URL→State only re-asserts state when the URL itself changes.
    // State clears (e.g. user closes panel → `selectedSessionId = null`) are
    // intentional until State→URL catches up — do NOT "self-heal" state from
    // a stale URL param here, or you'll fight intentional clears and the panel
    // will reopen itself. Wipe-on-disconnect is prevented at source (App.tsx
    // passes `client` directly; missing-board fallback is `connected`-gated).
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

      // URL is now the single source of truth for camera target: when a
      // session URL resolves, recenter the canvas on its worktree. Covers
      // deep links, back/forward, and any deliberate goToSession() push.
      // recenterMap handles both same-board (sync) and cross-board (stash
      // + idempotent switch — board state is already updating from
      // onBoardChange above, so the redundant switcher call is a no-op).
      if (resolvedSessionId) {
        const resolvedSession = sessionById.get(resolvedSessionId);
        const worktreeId = resolvedSession?.worktree_id;
        if (worktreeId && resolvedBoardId) {
          recenterMap(worktreeId, { boardId: resolvedBoardId });
        }
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
    sessionById,
    resolveBoardFromUrl,
    resolveSessionFromShortId,
    onBoardChange,
    onSessionChange,
    updateUrlFromState,
    isSettingsRoute,
    recenterMap,
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
