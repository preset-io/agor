/**
 * URL State Hook
 *
 * Bidirectional sync between URL and React state for board/session
 * selection, plus URL→state recenter side effects for entity deep
 * links (worktrees, artifacts).
 *
 * URL shape — flat entity URLs. Boards are addressable in their own
 * right; sub-entities (session/worktree/artifact) are keyed by their
 * short ID with no board prefix. The app resolves the entity, looks
 * up its current board, and switches if needed. This keeps shared
 * links stable across board moves.
 *
 *   /                              — root (redirects to first board)
 *   /b/<boardSlugOrShort>/         — board view
 *   /s/<sessionShort>/             — session conversation
 *   /w/<worktreeShort>/            — worktree (board switch + recenter)
 *   /a/<artifactShort>/            — artifact (board switch + recenter)
 *
 * Path shapes are defined in `@agor/core/utils/url` and consumed both
 * here (relative paths, no `/ui` — react-router prepends it via
 * basename) and in the server-side URL builders (`getXUrl`, which
 * compose `baseUrl + UI_MOUNT_PATH + path`).
 */

import type { BoardID, SessionID } from '@agor-live/client';
import { boardPath, ENTITY_PATH_SEGMENTS, sessionPath } from '@agor-live/client';
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useRecenterMap } from '../contexts/CanvasNavigationContext';
import {
  resolveArtifactFromShortIdPure,
  resolveBoardFromUrlPure,
  resolveSessionFromShortIdPure,
  resolveWorktreeFromShortIdPure,
} from '../utils/urlResolution';

export interface UseUrlStateOptions {
  /** Current board ID (full UUID) */
  currentBoardId: string | null;
  /** Current session ID (full UUID) */
  currentSessionId: string | null;
  /** Map of board ID to board object (for slug lookup) */
  boardById: Map<string, { board_id: string; slug?: string }>;
  /** Map of session ID to session object — used to resolve session
   *  share URLs and to chain through to the session's worktree/board. */
  sessionById: Map<string, { session_id: string; worktree_id?: string }>;
  /** Map of worktree ID to worktree — used to resolve worktree share
   *  URLs (and to look up `worktree.board_id` for session URLs). */
  worktreeById: Map<string, { worktree_id: string; board_id?: string | null }>;
  /** Map of artifact ID to artifact — used to resolve artifact share
   *  URLs and look up `artifact.board_id`. */
  artifactById: Map<string, { artifact_id: string; board_id?: string | null }>;
  /** Callback when URL indicates a different board */
  onBoardChange: (boardIdOrSlug: string) => void;
  /** Callback when URL indicates a different session */
  onSessionChange: (sessionId: string | null) => void;
}

/** Slug lookup helper — the core `boardPath` builder takes a slug
 *  directly; client call sites pass the boardById map and we extract
 *  here. */
function slugOf(
  boardId: string,
  boardById: Map<string, { board_id: string; slug?: string }>
): string | null | undefined {
  return boardById.get(boardId)?.slug;
}

/** `/b/<slug-or-short>/` — slug-aware client wrapper around `boardPath`.
 *  Exported so deliberate-nav sites (`useAppNavigation.goToBoard`) build
 *  URLs identically to the state→URL self-heal here. */
export function buildBoardPath(
  boardId: string,
  boardById: Map<string, { board_id: string; slug?: string }>
): string {
  return boardPath(boardId as BoardID, slugOf(boardId, boardById));
}

/**
 * Hook for bidirectional URL state synchronization.
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
    sessionShortId?: string;
    worktreeShortId?: string;
    artifactShortId?: string;
  }>();
  const recenterMap = useRecenterMap();

  // Anti-loop / state-mirroring refs
  const syncingRef = useRef(false);
  const lastNavigatedRef = useRef<string | null>(null);
  const currentBoardIdRef = useRef(currentBoardId);
  const currentSessionIdRef = useRef(currentSessionId);
  const lastUrlBoardParamRef = useRef<string | null>(null);
  const lastUrlSessionShortIdRef = useRef<string | null>(null);
  const lastUrlWorktreeShortIdRef = useRef<string | null>(null);
  const lastUrlArtifactShortIdRef = useRef<string | null>(null);
  const urlParamsResolvedRef = useRef({
    board: false,
    session: false,
    worktree: false,
    artifact: false,
  });
  // Pending deferred-recenter timer. Cleared before scheduling a new
  // one so rapid URL changes don't fire a stale recenter after a newer
  // navigation has already settled.
  const deferredRecenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    currentBoardIdRef.current = currentBoardId;
    currentSessionIdRef.current = currentSessionId;
  }, [currentBoardId, currentSessionId]);

  // Clear any pending deferred-recenter timer on unmount so it can't
  // fire after the consumer is gone.
  useEffect(() => {
    return () => {
      if (deferredRecenterTimerRef.current) {
        clearTimeout(deferredRecenterTimerRef.current);
        deferredRecenterTimerRef.current = null;
      }
    };
  }, []);

  // Parse URL params (only one of session/worktree/artifact is non-null
  // for any given URL — they're mutually exclusive paths)
  const urlBoardParam = params.boardParam || null;
  const urlSessionShortId = params.sessionShortId || null;
  const urlWorktreeShortId = params.worktreeShortId || null;
  const urlArtifactShortId = params.artifactShortId || null;

  // Settings modal overlays the board route — don't fight it
  const isSettingsRoute = location.pathname.startsWith('/settings');

  /** Build the canonical URL for the current state.
   *  - Session selected → `/s/<short>/` (board implicit)
   *  - Board only → `/b/<slug-or-short>/`
   *  - Neither → `/` */
  const buildUrl = useCallback(
    (boardId: string | null, sessionId: string | null): string => {
      if (sessionId) return sessionPath(sessionId as SessionID);
      if (boardId) return buildBoardPath(boardId, boardById);
      return '/';
    },
    [boardById]
  );

  /** State→URL self-heal. Skipped when on a sticky deep-link
   *  (`/w/<…>/` or `/a/<…>/`) so share URLs persist in the address bar. */
  const updateUrlFromState = useCallback(() => {
    if (syncingRef.current) return;

    // Sticky deep links: don't overwrite `/w/<…>/` or `/a/<…>/` when
    // no session is open. State (boardId, sessionId=null) can't
    // represent these URLs, so the rewrite would erase them. The
    // URL→state effect has already fired the recenter, so leaving the
    // URL alone is safe.
    if (currentSessionId === null) {
      const focusPrefixes = [ENTITY_PATH_SEGMENTS.worktree, ENTITY_PATH_SEGMENTS.artifact];
      if (focusPrefixes.some((seg) => location.pathname.startsWith(`/${seg}/`))) {
        return;
      }
    }

    const newUrl = buildUrl(currentBoardId, currentSessionId);
    const currentPath = `${(location.pathname + location.search).replace(/\/$/, '')}/`;
    const normalizedNewUrl = `${newUrl.replace(/\/$/, '')}/`;

    if (normalizedNewUrl !== currentPath && newUrl !== lastNavigatedRef.current) {
      lastNavigatedRef.current = newUrl;
      navigate(newUrl, { replace: true });
    }
  }, [currentBoardId, currentSessionId, buildUrl, location.pathname, location.search, navigate]);

  const warnAmbiguous = useCallback(
    (kind: 'board' | 'session' | 'worktree' | 'artifact', param: string, n: number) => {
      if (import.meta.env.DEV) {
        const capitalized = kind.charAt(0).toUpperCase() + kind.slice(1);
        // eslint-disable-next-line no-console
        console.warn(
          `[useUrlState] ${capitalized} short ID "${param}" matched ${n} ${kind}s; ` +
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
    (shortId: string) =>
      resolveSessionFromShortIdPure(shortId, sessionById, (p, n) => warnAmbiguous('session', p, n)),
    [sessionById, warnAmbiguous]
  );

  const resolveWorktreeFromShortId = useCallback(
    (shortId: string) =>
      resolveWorktreeFromShortIdPure(shortId, worktreeById, (p, n) =>
        warnAmbiguous('worktree', p, n)
      ),
    [worktreeById, warnAmbiguous]
  );

  const resolveArtifactFromShortId = useCallback(
    (shortId: string) =>
      resolveArtifactFromShortIdPure(shortId, artifactById, (p, n) =>
        warnAmbiguous('artifact', p, n)
      ),
    [artifactById, warnAmbiguous]
  );

  // URL → State sync
  useEffect(() => {
    const urlParamsChanged =
      urlBoardParam !== lastUrlBoardParamRef.current ||
      urlSessionShortId !== lastUrlSessionShortIdRef.current ||
      urlWorktreeShortId !== lastUrlWorktreeShortIdRef.current ||
      urlArtifactShortId !== lastUrlArtifactShortIdRef.current;

    if (urlParamsChanged) {
      urlParamsResolvedRef.current = {
        board: false,
        session: false,
        worktree: false,
        artifact: false,
      };
      lastUrlBoardParamRef.current = urlBoardParam;
      lastUrlSessionShortIdRef.current = urlSessionShortId;
      lastUrlWorktreeShortIdRef.current = urlWorktreeShortId;
      lastUrlArtifactShortIdRef.current = urlArtifactShortId;
      // Cancel any pending deferred recenter from the previous URL —
      // not just when scheduling a new one. Otherwise `/w/old → /b/board/`
      // within 50ms would let the old recenter fire after we've
      // navigated away.
      if (deferredRecenterTimerRef.current) {
        clearTimeout(deferredRecenterTimerRef.current);
        deferredRecenterTimerRef.current = null;
      }
    }

    const fullyResolved =
      urlParamsResolvedRef.current.board &&
      urlParamsResolvedRef.current.session &&
      urlParamsResolvedRef.current.worktree &&
      urlParamsResolvedRef.current.artifact;
    if (!urlParamsChanged && fullyResolved) return;

    // No URL params at all → fall back to state→URL
    if (!urlBoardParam && !urlSessionShortId && !urlWorktreeShortId && !urlArtifactShortId) {
      if (currentBoardIdRef.current && boardById.size > 0 && !isSettingsRoute) {
        updateUrlFromState();
      }
      return;
    }

    // Wait for required data to load before resolving
    if (urlBoardParam && boardById.size === 0) return;
    if (urlSessionShortId && (sessionById.size === 0 || worktreeById.size === 0)) return;
    if (urlWorktreeShortId && worktreeById.size === 0) return;
    if (urlArtifactShortId && artifactById.size === 0) return;

    // Resolve each URL form into a (board, session, recenterTarget) triple.
    // Only one of session/worktree/artifact is set per URL.
    let resolvedBoardId: string | null = null;
    let resolvedSessionId: string | null = null;
    let recenterTargetId: string | null = null;

    if (urlBoardParam) {
      resolvedBoardId = resolveBoardFromUrl(urlBoardParam);
      if (resolvedBoardId) urlParamsResolvedRef.current.board = true;
    }

    if (urlSessionShortId) {
      resolvedSessionId = resolveSessionFromShortId(urlSessionShortId);
      if (resolvedSessionId) {
        urlParamsResolvedRef.current.session = true;
        // Chain session → worktree → board to drive board switch + recenter
        const session = sessionById.get(resolvedSessionId);
        const wt = session?.worktree_id ? worktreeById.get(session.worktree_id) : undefined;
        if (wt?.board_id) {
          resolvedBoardId = wt.board_id;
          recenterTargetId = wt.worktree_id;
        }
      }
    } else {
      urlParamsResolvedRef.current.session = true; // no session param → trivially "resolved"
    }

    if (urlWorktreeShortId) {
      const worktreeId = resolveWorktreeFromShortId(urlWorktreeShortId);
      if (worktreeId) {
        urlParamsResolvedRef.current.worktree = true;
        const wt = worktreeById.get(worktreeId);
        if (wt?.board_id) {
          resolvedBoardId = wt.board_id;
          recenterTargetId = worktreeId;
        }
      }
    } else {
      urlParamsResolvedRef.current.worktree = true;
    }

    if (urlArtifactShortId) {
      const artifactId = resolveArtifactFromShortId(urlArtifactShortId);
      if (artifactId) {
        urlParamsResolvedRef.current.artifact = true;
        const art = artifactById.get(artifactId);
        if (art?.board_id) {
          resolvedBoardId = art.board_id;
          recenterTargetId = artifactId;
        }
      }
    } else {
      urlParamsResolvedRef.current.artifact = true;
    }

    const boardChanged = resolvedBoardId && resolvedBoardId !== currentBoardIdRef.current;
    // Session URLs imply opening the panel; non-session URLs (board, worktree,
    // artifact) imply closing it.
    const targetSessionId = urlSessionShortId ? resolvedSessionId : null;
    const sessionChanged = targetSessionId !== currentSessionIdRef.current;

    if (boardChanged || sessionChanged) {
      syncingRef.current = true;
      if (boardChanged && resolvedBoardId) onBoardChange(resolvedBoardId);
      if (sessionChanged) onSessionChange(targetSessionId);
      setTimeout(() => {
        syncingRef.current = false;
      }, 0);
    }

    // Recenter on the deep-link target. Deferred so concurrent layout
    // changes (the most common one: session panel opening/closing as
    // the URL adds/drops the session segment) flush before we measure
    // the viewport. Without this, setCenter would use stale dimensions
    // and the target would land off-center. ~50ms covers React's
    // commit + ResizeObserver firing; invisible against the 400ms
    // recenter animation. Stored in a ref so a follow-up URL change
    // can cancel a stale pending recenter before it fires.
    if (urlParamsChanged && recenterTargetId && resolvedBoardId) {
      // Any pending timer was cleared at the top of this effect when
      // `urlParamsChanged` flipped — safe to schedule fresh.
      const target = recenterTargetId;
      const boardId = resolvedBoardId;
      deferredRecenterTimerRef.current = setTimeout(() => {
        deferredRecenterTimerRef.current = null;
        recenterMap(target, { boardId });
      }, 50);
    }
  }, [
    urlBoardParam,
    urlSessionShortId,
    urlWorktreeShortId,
    urlArtifactShortId,
    boardById.size,
    sessionById,
    worktreeById,
    artifactById,
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

  // State → URL self-heal
  useEffect(() => {
    if (syncingRef.current) return;
    if (isSettingsRoute) return;
    if (boardById.size === 0) return;

    // Don't overwrite URL while we're still trying to resolve incoming URL params
    if (urlBoardParam && !urlParamsResolvedRef.current.board) return;
    if (urlSessionShortId && !urlParamsResolvedRef.current.session) return;
    if (urlWorktreeShortId && !urlParamsResolvedRef.current.worktree) return;
    if (urlArtifactShortId && !urlParamsResolvedRef.current.artifact) return;

    updateUrlFromState();
  }, [
    boardById.size,
    urlBoardParam,
    urlSessionShortId,
    urlWorktreeShortId,
    urlArtifactShortId,
    updateUrlFromState,
    isSettingsRoute,
  ]);
}
