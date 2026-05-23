/**
 * useAppNavigation
 *
 * Centralized navigation API. Every deliberate "go to X" intent in the app
 * funnels through this hook so:
 *   - URL is the single source of truth for board/session selection.
 *   - History push/replace decisions live in one place (push for
 *     deliberate navs → back button restores prior board+session+camera).
 *   - Cross-board hops + canvas recenter cascade automatically via the
 *     URL→state effect in useUrlState (which calls recenterMap when a
 *     session resolves).
 *
 * Consumers should prefer these over `setSelectedSessionId` /
 * `setCurrentBoardId` directly — the imperative setters bypass the URL and
 * break back-button intent.
 *
 * Identity stability: live data maps (`sessionById`, `worktreeById`) flip
 * reference on every socket event. The returned functions read them via
 * refs so their identities stay stable — important because they're held
 * by memoized children (WorktreeCard, SessionCanvas) and a flipping
 * identity would defeat the memoization, cascading re-renders on every
 * stream patch.
 */
import type { Session, Worktree } from '@agor-live/client';
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useRecenterMap } from '../contexts/CanvasNavigationContext';
import { buildBoardPath, buildSessionPath, buildWorktreePath } from './useUrlState';

interface UseAppNavigationOptions {
  /** Boards aren't exposed via AppDataContext yet — App.tsx passes its
   *  local `boardById` so URL building can prefer slugs. */
  boardById: Map<string, { board_id: string; slug?: string }>;
  /** Sessions and worktrees are passed in (rather than read from
   *  `useAppLiveData`) because this hook is called from App's own body,
   *  which renders the AppLiveDataProvider — so the provider isn't yet
   *  mounted when the hook runs. Matches `useUrlState`'s arg-passing
   *  pattern. */
  sessionById: Map<string, Session>;
  worktreeById: Map<string, Worktree>;
}

export interface NavigationOpts {
  /** Use history.replace instead of push. Defaults to false (push) since
   *  the typical use is a deliberate user navigation that should land in
   *  the back stack. */
  replace?: boolean;
}

export interface AppNavigation {
  /** Navigate to a session's conversation view, switching boards if its
   *  worktree lives elsewhere. Same-URL clicks just recenter the camera. */
  goToSession: (sessionId: string, opts?: NavigationOpts) => void;
  /** Navigate to a worktree's board and recenter on its card. Closes any
   *  open session panel (the URL drops the session segment). */
  goToWorktree: (worktreeId: string, opts?: NavigationOpts) => void;
  /** Navigate to a board (no session). */
  goToBoard: (boardId: string, opts?: NavigationOpts) => void;
  /** Close the open session panel by pushing the board-only URL. */
  closeSession: (opts?: NavigationOpts) => void;
}

/** Normalize a path to its trailing-slash canonical form so equality checks
 *  ignore the optional trailing slash. */
function canonical(path: string): string {
  return `${path.replace(/\/$/, '')}/`;
}

export function useAppNavigation({
  boardById,
  sessionById,
  worktreeById,
}: UseAppNavigationOptions): AppNavigation {
  const navigate = useNavigate();
  const location = useLocation();
  const recenterMap = useRecenterMap();

  // Mirror the latest live data + location into refs so the navigation
  // functions can have stable identities across socket churn.
  const sessionByIdRef = useRef(sessionById);
  sessionByIdRef.current = sessionById;
  const worktreeByIdRef = useRef(worktreeById);
  worktreeByIdRef.current = worktreeById;
  const boardByIdRef = useRef(boardById);
  boardByIdRef.current = boardById;
  const locationPathnameRef = useRef(location.pathname);
  locationPathnameRef.current = location.pathname;

  /** Navigate to a target path (push by default, replace on opts). Returns
   *  `true` if the URL changed, `false` when target === current path. */
  const pushPath = useCallback(
    (target: string, opts?: NavigationOpts): boolean => {
      if (canonical(target) === canonical(locationPathnameRef.current)) return false;
      navigate(target, { replace: opts?.replace ?? false });
      return true;
    },
    [navigate]
  );

  const goToBoard = useCallback(
    (boardId: string, opts?: NavigationOpts) => {
      pushPath(buildBoardPath(boardId, boardByIdRef.current), opts);
    },
    [pushPath]
  );

  const goToSession = useCallback(
    (sessionId: string, opts?: NavigationOpts) => {
      const session = sessionByIdRef.current.get(sessionId);
      if (!session) return;
      const worktree: Worktree | undefined = worktreeByIdRef.current.get(session.worktree_id);
      if (!worktree?.board_id) return;
      const target = buildSessionPath(worktree.board_id, sessionId, boardByIdRef.current);
      // pushPath returns false when target === current path — in that case
      // no history transition fires, so the URL→state recenter effect
      // won't run. Fall back to a direct recenter.
      if (!pushPath(target, opts)) {
        recenterMap(worktree.worktree_id, { boardId: worktree.board_id });
      }
    },
    [pushPath, recenterMap]
  );

  const goToWorktree = useCallback(
    (worktreeId: string, opts?: NavigationOpts) => {
      const worktree = worktreeByIdRef.current.get(worktreeId);
      if (!worktree?.board_id) return;
      // Push the shareable worktree URL — useUrlState's URL→state effect
      // resolves it and fires recenterMap. We also call recenterMap
      // directly as a same-tick fallback for the no-URL-change case (the
      // effect won't re-fire). The redundant call for the cross-board
      // case is idempotent.
      const target = buildWorktreePath(worktree.board_id, worktreeId, boardByIdRef.current);
      recenterMap(worktreeId, { boardId: worktree.board_id });
      pushPath(target, opts);
    },
    [pushPath, recenterMap]
  );

  const closeSession = useCallback(
    (opts?: NavigationOpts) => {
      // Drop the session segment by re-pushing only the board path. If
      // the URL doesn't match `/b/:board/...` there's no session to close.
      const match = locationPathnameRef.current.match(/^\/b\/([^/]+)/);
      if (!match) return;
      pushPath(`/b/${match[1]}/`, opts);
    },
    [pushPath]
  );

  return useMemo(
    () => ({ goToSession, goToWorktree, goToBoard, closeSession }),
    [goToSession, goToWorktree, goToBoard, closeSession]
  );
}
