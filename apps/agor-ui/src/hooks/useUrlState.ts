/**
 * URL State Hook
 *
 * Provides bidirectional synchronization between URL and React state
 * for board / session selection, plus URL→state recenter side effects
 * for shareable worktree links.
 *
 * URL shapes (all Django-style trailing slash):
 * - `/b/:boardParam/`                  — board only
 * - `/b/:boardParam/:sessionShortId/`  — board + open session conversation
 * - `/b/:boardParam/w/:worktreeShortId/` — board + recenter on a worktree
 *   (shareable deep link; state→URL self-heal does not preserve this
 *   beyond first resolution — the URL bar reverts to `/b/<board>/` once
 *   the recenter fires, but the original link still works for anyone
 *   visiting it fresh)
 *
 * `boardParam` can be a slug (my-board) or short ID (550e8400).
 *
 * Examples:
 * - /b/main-board/
 * - /b/main-board/a1b2c3d4/
 * - /b/main-board/w/9f3a72bc/
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
  /** Map of worktree ID to worktree (for resolving worktree-share URLs to
   *  full UUIDs so we can recenter the canvas on visit). */
  worktreeById: Map<string, { worktree_id: string }>;
  /** Map of artifact ID to artifact (for resolving artifact-share URLs).
   *  Same pattern as `worktreeById` — the canvas's recenter implementation
   *  falls back to a `data.artifactId` scan when looking up by the
   *  logical artifact id (artifact nodes' React Flow id is the board
   *  object id, not the artifact id). */
  artifactById: Map<string, { artifact_id: string }>;
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
 * Build a worktree-focus path (`/b/<board>/w/<worktreeShortId>/`).
 *
 * Shareable deep link: visiting the URL navigates to the board (switching
 * if needed) and recenters the canvas on the worktree. State→URL
 * self-heal preserves the path while no session is open (see the
 * `updateUrlFromState` gate); opening a session transitions the URL to
 * `/b/<board>/<session>/` as expected.
 */
export function buildWorktreePath(
  boardId: string,
  worktreeId: string,
  boardById: Map<string, { board_id: string; slug?: string }>
): string {
  return `${buildBoardPath(boardId, boardById)}w/${urlShortId(worktreeId)}/`;
}

/**
 * Build an artifact-focus path (`/b/<board>/a/<artifactShortId>/`).
 *
 * Mirrors `buildWorktreePath` for artifact share links. Same sticky-URL
 * semantics: the `/a/...` shape persists in the address bar while no
 * session is open.
 */
export function buildArtifactPath(
  boardId: string,
  artifactId: string,
  boardById: Map<string, { board_id: string; slug?: string }>
): string {
  return `${buildBoardPath(boardId, boardById)}a/${urlShortId(artifactId)}/`;
}

/**
 * Pure resolver: short-ID prefix → entity ID. Ambiguity is treated as
 * not-found (we'd rather 404 a deep link than mis-route it to the wrong
 * entity). Historically the session resolver routed to the
 * lexicographically-greatest match (newest by UUIDv7) as a "don't 500
 * the page" hack when 8-char URLs were collision-prone; with
 * `SHORT_ID_LENGTH` now 24 (~290K same-ms IDs before 1% collision),
 * realistic URLs are unambiguous and silent mis-routing is the worse
 * failure mode.
 */
export function resolveByShortIdPure<T>(
  prefix: string,
  entries: Iterable<T>,
  getId: (entry: T) => string,
  onAmbiguous?: (prefix: string, matchCount: number) => void
): string | null {
  const matches = findByShortIdPrefix(
    prefix,
    Array.from(entries, (e) => ({ id: getId(e) }))
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;
  onAmbiguous?.(prefix, matches.length);
  return null;
}

/**
 * Pure resolver: board param (slug or short-ID prefix) → board ID. Slug
 * match wins (exact match on `board.slug`); short-ID match falls back to
 * `resolveByShortIdPure`. Same ambiguity policy: refuse to guess.
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
  return resolveByShortIdPure(boardParam, boardById.values(), (b) => b.board_id, onAmbiguous);
}

/** Pure resolver: short-ID prefix → session ID. Convenience wrapper. */
export function resolveSessionFromShortIdPure(
  sessionShortId: string,
  sessionById: Map<string, { session_id: string }>,
  onAmbiguous?: (shortId: string, matchCount: number) => void
): string | null {
  return resolveByShortIdPure(
    sessionShortId,
    sessionById.values(),
    (s) => s.session_id,
    onAmbiguous
  );
}

/** Pure resolver: short-ID prefix → worktree ID. Convenience wrapper. */
export function resolveWorktreeFromShortIdPure(
  worktreeShortId: string,
  worktreeById: Map<string, { worktree_id: string }>,
  onAmbiguous?: (shortId: string, matchCount: number) => void
): string | null {
  return resolveByShortIdPure(
    worktreeShortId,
    worktreeById.values(),
    (w) => w.worktree_id,
    onAmbiguous
  );
}

/** Pure resolver: short-ID prefix → artifact ID. Convenience wrapper. */
export function resolveArtifactFromShortIdPure(
  artifactShortId: string,
  artifactById: Map<string, { artifact_id: string }>,
  onAmbiguous?: (shortId: string, matchCount: number) => void
): string | null {
  return resolveByShortIdPure(
    artifactShortId,
    artifactById.values(),
    (a) => a.artifact_id,
    onAmbiguous
  );
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
    worktreeById,
    artifactById,
    onBoardChange,
    onSessionChange,
  } = options;

  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{
    boardParam?: string;
    sessionParam?: string;
    worktreeShortId?: string;
    artifactShortId?: string;
  }>();
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
  const lastUrlWorktreeShortIdRef = useRef<string | null>(null);
  const lastUrlArtifactShortIdRef = useRef<string | null>(null);
  // Track whether we successfully resolved URL params (for retry logic)
  const urlParamsResolvedRef = useRef<{
    board: boolean;
    session: boolean;
    worktree: boolean;
    artifact: boolean;
  }>({
    board: false,
    session: false,
    worktree: false,
    artifact: false,
  });

  // Keep refs in sync with state
  useEffect(() => {
    currentBoardIdRef.current = currentBoardId;
    currentSessionIdRef.current = currentSessionId;
  }, [currentBoardId, currentSessionId]);

  // Parse URL state
  const urlBoardParam = params.boardParam || null;
  const urlSessionParam = params.sessionParam || null;
  const urlWorktreeShortId = params.worktreeShortId || null;
  const urlArtifactShortId = params.artifactShortId || null;

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

    // Sticky focus URLs: if we're already on `/b/<board>/w/<...>/` or
    // `/b/<board>/a/<...>/` for the current board AND no session is open,
    // the URL is "more specific" than the (boardId, sessionId) state
    // vector — preserve it so share links stay in the address bar
    // instead of being rewritten to `/b/<board>/`. The URL→state recenter
    // has already fired by the time this effect runs, so suppressing the
    // rewrite is safe.
    if (currentBoardId && currentSessionId === null) {
      const boardPrefix = buildBoardPath(currentBoardId, boardById).replace(/\/$/, '');
      if (
        location.pathname.startsWith(`${boardPrefix}/w/`) ||
        location.pathname.startsWith(`${boardPrefix}/a/`)
      ) {
        return;
      }
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
  }, [
    currentBoardId,
    currentSessionId,
    boardById,
    buildUrl,
    location.pathname,
    location.search,
    navigate,
  ]);

  // Dev-only warning on ambiguous URL prefixes — see `resolveByShortIdPure`
  // for the rationale. Returning `null` (not-found) is the production behavior.
  const warnAmbiguous = useCallback(
    (kind: 'board' | 'session' | 'worktree' | 'artifact', param: string, n: number) => {
      if (import.meta.env.DEV) {
        const plural = `${kind}s`;
        const capitalized = kind.charAt(0).toUpperCase() + kind.slice(1);
        // eslint-disable-next-line no-console
        console.warn(
          `[useUrlState] ${capitalized} short ID "${param}" matched ${n} ${plural}; ` +
            `treating as not-found (URL must use full UUID or unambiguous prefix).`
        );
      }
    },
    []
  );

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

  const resolveWorktreeFromShortId = useCallback(
    (worktreeShortId: string) =>
      resolveWorktreeFromShortIdPure(worktreeShortId, worktreeById, (p, n) =>
        warnAmbiguous('worktree', p, n)
      ),
    [worktreeById, warnAmbiguous]
  );

  const resolveArtifactFromShortId = useCallback(
    (artifactShortId: string) =>
      resolveArtifactFromShortIdPure(artifactShortId, artifactById, (p, n) =>
        warnAmbiguous('artifact', p, n)
      ),
    [artifactById, warnAmbiguous]
  );

  // Sync URL -> State on mount and URL changes
  // Retries resolution when data becomes available (for deep links)
  useEffect(() => {
    // Check if URL params actually changed
    const urlParamsChanged =
      urlBoardParam !== lastUrlBoardParamRef.current ||
      urlSessionParam !== lastUrlSessionParamRef.current ||
      urlWorktreeShortId !== lastUrlWorktreeShortIdRef.current ||
      urlArtifactShortId !== lastUrlArtifactShortIdRef.current;

    // Reset resolution tracking when URL params change
    if (urlParamsChanged) {
      urlParamsResolvedRef.current = {
        board: false,
        session: false,
        worktree: false,
        artifact: false,
      };
      lastUrlBoardParamRef.current = urlBoardParam;
      lastUrlSessionParamRef.current = urlSessionParam;
      lastUrlWorktreeShortIdRef.current = urlWorktreeShortId;
      lastUrlArtifactShortIdRef.current = urlArtifactShortId;
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
      urlParamsResolvedRef.current.board &&
      urlParamsResolvedRef.current.session &&
      urlParamsResolvedRef.current.worktree &&
      urlParamsResolvedRef.current.artifact;
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

    // If we have a worktree param, also wait for worktrees to load
    if (urlWorktreeShortId && worktreeById.size === 0) {
      return;
    }

    // If we have an artifact param, also wait for artifacts to load
    if (urlArtifactShortId && artifactById.size === 0) {
      return;
    }

    // Only sync from URL if the URL actually represents a different board/session
    const resolvedBoardId = resolveBoardFromUrl(urlBoardParam);
    const resolvedSessionId = urlSessionParam ? resolveSessionFromShortId(urlSessionParam) : null;
    const resolvedWorktreeId = urlWorktreeShortId
      ? resolveWorktreeFromShortId(urlWorktreeShortId)
      : null;
    const resolvedArtifactId = urlArtifactShortId
      ? resolveArtifactFromShortId(urlArtifactShortId)
      : null;

    // Track resolution status
    if (resolvedBoardId) {
      urlParamsResolvedRef.current.board = true;
    }
    if (!urlSessionParam || resolvedSessionId) {
      urlParamsResolvedRef.current.session = true;
    }
    if (!urlWorktreeShortId || resolvedWorktreeId) {
      urlParamsResolvedRef.current.worktree = true;
    }
    if (!urlArtifactShortId || resolvedArtifactId) {
      urlParamsResolvedRef.current.artifact = true;
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

    // Share URLs (/w/ and /a/): recenter on the target node. Independent
    // of board/session change gates above because /b/main/w/abc/ may not
    // change board or session state (e.g. user already on /b/main/), but
    // we still want to recenter. Guarded by urlParamsChanged so we fire
    // exactly once per URL transition, not on every effect re-run. The
    // canvas's recenter impl falls back to a data.artifactId scan when
    // looking up the artifact node (id mismatch — artifact nodes use
    // board_object.object_id as their RF id).
    if (urlParamsChanged && resolvedBoardId) {
      if (resolvedWorktreeId) {
        recenterMap(resolvedWorktreeId, { boardId: resolvedBoardId });
      } else if (resolvedArtifactId) {
        recenterMap(resolvedArtifactId, { boardId: resolvedBoardId });
      }
    }
  }, [
    urlBoardParam,
    urlSessionParam,
    urlWorktreeShortId,
    urlArtifactShortId,
    boardById.size,
    sessionById,
    worktreeById.size,
    artifactById.size,
    resolveBoardFromUrl,
    resolveSessionFromShortId,
    resolveWorktreeFromShortId,
    resolveArtifactFromShortId,
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
