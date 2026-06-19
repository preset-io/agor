/**
 * URL State Hook
 *
 * Bidirectional sync between URL and React state for board/session
 * selection, plus URL→state recenter side effects for entity deep
 * links (branches, artifacts).
 *
 * URL shape — flat entity URLs. Boards are addressable in their own
 * right; sub-entities (session/branch/artifact) are keyed by their
 * short ID with no board prefix. The app resolves the entity, looks
 * up its current board, and switches if needed. This keeps shared
 * links stable across board moves.
 *
 *   /                              — Home (no board selected)
 *   /b/<boardSlugOrShort>/         — board view
 *   /s/<sessionShort>/             — session conversation
 *   /w/<branchShort>/            — branch (board switch + recenter)
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
  resolveBranchFromShortIdPure,
  resolveSessionFromShortIdPure,
} from '../utils/urlResolution';

/**
 * The entity the current URL is targeting for deep-link focus. Sessions
 * are intentionally excluded — opening a session already drives the
 * `isFocused` ring on the owning branch card (via `selectedSessionId`),
 * and stacking a second ring on top of that would just be visual noise.
 * Branch and artifact URLs have no such existing signal, so this is
 * where the "active URL target" highlight earns its keep.
 */
export type ActiveUrlTarget = { kind: 'branch'; id: string } | { kind: 'artifact'; id: string };

export interface UseUrlStateOptions {
  /** Current board ID (full UUID) */
  currentBoardId: string | null;
  /** Current session ID (full UUID) */
  currentSessionId: string | null;
  /** Map of board ID to board object (for slug lookup) */
  boardById: Map<string, { board_id: string; slug?: string }>;
  /** Map of session ID to session object — used to resolve session
   *  share URLs and to chain through to the session's branch/board. */
  sessionById: Map<string, { session_id: string; branch_id?: string }>;
  /** Map of branch ID to branch — used to resolve branch share
   *  URLs (and to look up `branch.board_id` for session URLs). */
  branchById: Map<string, { branch_id: string; board_id?: string | null }>;
  /** Map of artifact ID to artifact — used to resolve artifact share
   *  URLs and look up `artifact.board_id`. */
  artifactById: Map<string, { artifact_id: string; board_id?: string | null }>;
  /** Callback when URL indicates a different board */
  onBoardChange: (boardIdOrSlug: string) => void;
  /** Callback when URL indicates a different session */
  onSessionChange: (sessionId: string | null) => void;
  /** Callback when the URL targets a deep-link entity (branch or
   *  artifact). Null when the URL has no such target. Fires only on
   *  transitions to keep downstream React state updates idempotent. */
  onActiveUrlTargetChange?: (target: ActiveUrlTarget | null) => void;
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
    branchById,
    artifactById,
    onBoardChange,
    onSessionChange,
    onActiveUrlTargetChange,
  } = options;

  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{
    boardParam?: string;
    sessionShortId?: string;
    branchShortId?: string;
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
  const lastUrlBranchShortIdRef = useRef<string | null>(null);
  const lastUrlArtifactShortIdRef = useRef<string | null>(null);
  const urlParamsResolvedRef = useRef({
    board: false,
    session: false,
    branch: false,
    artifact: false,
  });
  // Pending deferred-recenter timer. Cleared before scheduling a new
  // one so rapid URL changes don't fire a stale recenter after a newer
  // navigation has already settled.
  const deferredRecenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last emitted active URL target, so we only fire the callback on
  // actual transitions and don't churn parent state on every effect run.
  const lastEmittedTargetRef = useRef<ActiveUrlTarget | null>(null);

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

  // Parse URL params (only one of session/branch/artifact is non-null
  // for any given URL — they're mutually exclusive paths)
  const urlBoardParam = params.boardParam || null;
  const urlSessionShortId = params.sessionShortId || null;
  const urlBranchShortId = params.branchShortId || null;
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
      const focusPrefixes = [ENTITY_PATH_SEGMENTS.branch, ENTITY_PATH_SEGMENTS.artifact];
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
    (kind: 'board' | 'session' | 'branch' | 'artifact', param: string, n: number) => {
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

  const resolveBranchFromShortId = useCallback(
    (shortId: string) =>
      resolveBranchFromShortIdPure(shortId, branchById, (p, n) => warnAmbiguous('branch', p, n)),
    [branchById, warnAmbiguous]
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
      urlBranchShortId !== lastUrlBranchShortIdRef.current ||
      urlArtifactShortId !== lastUrlArtifactShortIdRef.current;

    if (urlParamsChanged) {
      urlParamsResolvedRef.current = {
        board: false,
        session: false,
        branch: false,
        artifact: false,
      };
      lastUrlBoardParamRef.current = urlBoardParam;
      lastUrlSessionShortIdRef.current = urlSessionShortId;
      lastUrlBranchShortIdRef.current = urlBranchShortId;
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
      urlParamsResolvedRef.current.branch &&
      urlParamsResolvedRef.current.artifact;
    if (!urlParamsChanged && fullyResolved) return;

    // No URL params at all → Home/no-board state. Do not self-heal back
    // to the last board; `/` is a valid workspace surface. Unknown non-root
    // paths also have no params, but should canonicalize to Home instead of
    // clearing board state and rendering a no-board canvas at that path.
    if (!urlBoardParam && !urlSessionShortId && !urlBranchShortId && !urlArtifactShortId) {
      const isHomePath = location.pathname === '/' || location.pathname === '';
      if (!isSettingsRoute && !isHomePath) {
        syncingRef.current = true;
        navigate('/', { replace: true });
        setTimeout(() => {
          syncingRef.current = false;
        }, 0);
        return;
      }

      if (!isSettingsRoute && currentBoardIdRef.current) {
        syncingRef.current = true;
        onBoardChange('');
        if (currentSessionIdRef.current) onSessionChange(null);
        setTimeout(() => {
          syncingRef.current = false;
        }, 0);
      }
      // Stale highlight cleanup: when the URL drops the deep-link
      // segment, drop the active target too so the previously-targeted
      // card stops glowing.
      if (onActiveUrlTargetChange && lastEmittedTargetRef.current !== null) {
        lastEmittedTargetRef.current = null;
        onActiveUrlTargetChange(null);
      }
      return;
    }

    // Wait for required data to load before resolving
    if (urlBoardParam && boardById.size === 0) return;
    // Session URLs only require the session itself to resolve. The branch is
    // best-effort metadata for board switching/recentering; direct links to
    // archived sessions intentionally do not hydrate archived branches into
    // the active `branchById` map, otherwise archived cards would reappear on
    // boards via board-object joins.
    if (urlSessionShortId && sessionById.size === 0) return;
    if (urlBranchShortId && branchById.size === 0) return;
    if (urlArtifactShortId && artifactById.size === 0) return;

    // Resolve each URL form into a (board, session, recenterTarget) triple.
    // Only one of session/branch/artifact is set per URL.
    let resolvedBoardId: string | null = null;
    let resolvedSessionId: string | null = null;
    let recenterTargetId: string | null = null;
    let activeUrlTarget: ActiveUrlTarget | null = null;

    if (urlBoardParam) {
      resolvedBoardId = resolveBoardFromUrl(urlBoardParam);
      if (resolvedBoardId) urlParamsResolvedRef.current.board = true;
    } else {
      urlParamsResolvedRef.current.board = true;
    }

    if (urlSessionShortId) {
      resolvedSessionId = resolveSessionFromShortId(urlSessionShortId);
      if (resolvedSessionId) {
        urlParamsResolvedRef.current.session = true;
        // Chain session → branch → board to drive board switch + recenter
        const session = sessionById.get(resolvedSessionId);
        const wt = session?.branch_id ? branchById.get(session.branch_id) : undefined;
        if (wt?.board_id) {
          resolvedBoardId = wt.board_id;
          recenterTargetId = wt.branch_id;
        }
      }
    } else {
      urlParamsResolvedRef.current.session = true; // no session param → trivially "resolved"
    }

    if (urlBranchShortId) {
      const branchId = resolveBranchFromShortId(urlBranchShortId);
      if (branchId) {
        urlParamsResolvedRef.current.branch = true;
        activeUrlTarget = { kind: 'branch', id: branchId };
        const wt = branchById.get(branchId);
        if (wt?.board_id) {
          resolvedBoardId = wt.board_id;
          recenterTargetId = branchId;
        }
      }
    } else {
      urlParamsResolvedRef.current.branch = true;
    }

    if (urlArtifactShortId) {
      const artifactId = resolveArtifactFromShortId(urlArtifactShortId);
      if (artifactId) {
        urlParamsResolvedRef.current.artifact = true;
        activeUrlTarget = { kind: 'artifact', id: artifactId };
        const art = artifactById.get(artifactId);
        if (art?.board_id) {
          resolvedBoardId = art.board_id;
          recenterTargetId = artifactId;
        }
      }
    } else {
      urlParamsResolvedRef.current.artifact = true;
    }

    // Emit the active URL target on transition. Session URLs are
    // deliberately excluded — the session drawer + branch focused-ring
    // already signal where the URL pointed. Comparing by kind+id keeps
    // identical targets idempotent across effect re-runs.
    if (onActiveUrlTargetChange) {
      const prev = lastEmittedTargetRef.current;
      const changed =
        (prev === null) !== (activeUrlTarget === null) ||
        (prev !== null &&
          activeUrlTarget !== null &&
          (prev.kind !== activeUrlTarget.kind || prev.id !== activeUrlTarget.id));
      if (changed) {
        lastEmittedTargetRef.current = activeUrlTarget;
        onActiveUrlTargetChange(activeUrlTarget);
      }
    }

    const boardChanged = resolvedBoardId && resolvedBoardId !== currentBoardIdRef.current;
    // Session URLs imply opening the panel; non-session URLs (board, branch,
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
    urlBranchShortId,
    urlArtifactShortId,
    boardById.size,
    sessionById,
    branchById,
    artifactById,
    resolveBoardFromUrl,
    resolveSessionFromShortId,
    resolveBranchFromShortId,
    resolveArtifactFromShortId,
    onBoardChange,
    onSessionChange,
    onActiveUrlTargetChange,
    isSettingsRoute,
    recenterMap,
    location.pathname,
    navigate,
  ]);

  // State → URL self-heal
  useEffect(() => {
    if (syncingRef.current) return;
    if (isSettingsRoute) return;

    // Unknown non-root paths have no entity params but are not the Home
    // route. The URL→state effect canonicalizes them to `/`; do not let
    // stale board/session state self-heal them back to `/b/<board>/` first.
    if (
      !urlBoardParam &&
      !urlSessionShortId &&
      !urlBranchShortId &&
      !urlArtifactShortId &&
      location.pathname !== '/' &&
      location.pathname !== ''
    ) {
      return;
    }

    if (boardById.size === 0) return;

    // Don't overwrite URL while we're still trying to resolve incoming URL params
    if (urlBoardParam && !urlParamsResolvedRef.current.board) return;
    if (urlSessionShortId && !urlParamsResolvedRef.current.session) return;
    if (urlBranchShortId && !urlParamsResolvedRef.current.branch) return;
    if (urlArtifactShortId && !urlParamsResolvedRef.current.artifact) return;

    updateUrlFromState();
  }, [
    boardById.size,
    urlBoardParam,
    urlSessionShortId,
    urlBranchShortId,
    urlArtifactShortId,
    isSettingsRoute,
    updateUrlFromState,
    location.pathname,
  ]);
}
