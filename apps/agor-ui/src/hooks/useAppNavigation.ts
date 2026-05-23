/**
 * useAppNavigation
 *
 * Centralized navigation API. Every deliberate "go to X" intent in the
 * app funnels through this hook so:
 *   - URL is the single source of truth for board / session selection.
 *   - History push/replace decisions live in one place (push for
 *     deliberate navs → back button restores prior board+session+camera).
 *   - Cross-board hops + canvas recenter cascade automatically via the
 *     URL→state effect in `useUrlState`.
 *
 * URLs use the flat entity scheme: `/s/<short>/`, `/w/<short>/`,
 * `/a/<short>/` — board is implicit and resolved at click time. Boards
 * themselves keep `/b/<slug-or-short>/`. See `packages/core/src/utils/url.ts`.
 *
 * Consumers should prefer these over `setSelectedSessionId` /
 * `setCurrentBoardId` directly — the imperative setters bypass the URL
 * and break back-button intent.
 *
 * Identity stability: live data maps (`sessionById`, `worktreeById`)
 * flip reference on every socket event. The returned functions read
 * them via refs so their identities stay stable — important because
 * they're held by memoized children (WorktreeCard, SessionCanvas) and
 * a flipping identity would defeat the memoization, cascading
 * re-renders on every stream patch.
 */
import type {
  Artifact,
  ArtifactID,
  Session,
  SessionID,
  Worktree,
  WorktreeID,
} from '@agor-live/client';
import { artifactPath, sessionPath, worktreePath } from '@agor-live/client';
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useRecenterMap } from '../contexts/CanvasNavigationContext';
import { buildBoardPath } from './useUrlState';

interface UseAppNavigationOptions {
  /** Boards aren't exposed via AppDataContext yet — App.tsx passes its
   *  local `boardById` so URL building can prefer slugs. */
  boardById: Map<string, { board_id: string; slug?: string }>;
  /** Sessions, worktrees, and artifacts are passed in (rather than read
   *  from `useAppLiveData`) because this hook is called from App's own
   *  body, which renders the AppLiveDataProvider — so the provider
   *  isn't yet mounted when the hook runs. Matches `useUrlState`'s
   *  arg-passing pattern.
   *
   *  Each map is optional: callers only pass what their methods need
   *  (e.g. a Settings table that only uses `goToWorktree` can omit
   *  `sessionById` and `artifactById`). The unused maps fall back to
   *  empty Maps; the corresponding goToX no-ops on lookup miss. */
  sessionById?: Map<string, Session>;
  worktreeById?: Map<string, Worktree>;
  artifactById?: Map<string, Artifact>;
}

export interface NavigationOpts {
  /** Use history.replace instead of push. Defaults to false (push)
   *  since the typical use is a deliberate user navigation that should
   *  land in the back stack. */
  replace?: boolean;
}

export interface AppNavigation {
  /** Navigate to a session's conversation view. Pushes `/s/<short>/`.
   *  Same-URL clicks (already on this session) just recenter the camera. */
  goToSession: (sessionId: string, opts?: NavigationOpts) => void;
  /** Navigate to a worktree. Pushes `/w/<short>/` — useUrlState
   *  resolves the worktree, switches boards if needed, and recenters. */
  goToWorktree: (worktreeId: string, opts?: NavigationOpts) => void;
  /** Navigate to an artifact. Pushes `/a/<short>/`. */
  goToArtifact: (artifactId: string, opts?: NavigationOpts) => void;
  /** Navigate to a board (no session). Pushes `/b/<slug-or-short>/`. */
  goToBoard: (boardId: string, opts?: NavigationOpts) => void;
}

/** Normalize a path to its trailing-slash canonical form so equality
 *  checks ignore the optional trailing slash. */
function canonical(path: string): string {
  return `${path.replace(/\/$/, '')}/`;
}

const EMPTY_MAP = new Map<string, never>();

export function useAppNavigation({
  boardById,
  sessionById,
  worktreeById,
  artifactById,
}: UseAppNavigationOptions): AppNavigation {
  const navigate = useNavigate();
  const location = useLocation();
  const recenterMap = useRecenterMap();

  // Mirror live data + location into refs so the navigation functions
  // have stable identities across socket churn. Inline `useRef(value);
  // ref.current = value` rather than going through a helper so biome's
  // `useExhaustiveDependencies` heuristic (which only recognizes refs
  // created from `useRef(...)` directly) doesn't falsely flag the
  // useCallback deps below.
  //
  // Missing optional maps fall back to a shared empty map — the goToX
  // method just no-ops on lookup miss, same as if the id wasn't found.
  const sessionByIdRef = useRef(sessionById ?? (EMPTY_MAP as Map<string, Session>));
  sessionByIdRef.current = sessionById ?? (EMPTY_MAP as Map<string, Session>);
  const worktreeByIdRef = useRef(worktreeById ?? (EMPTY_MAP as Map<string, Worktree>));
  worktreeByIdRef.current = worktreeById ?? (EMPTY_MAP as Map<string, Worktree>);
  const artifactByIdRef = useRef(artifactById ?? (EMPTY_MAP as Map<string, Artifact>));
  artifactByIdRef.current = artifactById ?? (EMPTY_MAP as Map<string, Artifact>);
  const boardByIdRef = useRef(boardById);
  boardByIdRef.current = boardById;
  const locationPathnameRef = useRef(location.pathname);
  locationPathnameRef.current = location.pathname;

  /** Navigate to a target path (push by default, replace on opts).
   *  Returns `true` if the URL changed, `false` when target === current path. */
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
      // pushPath returns false when the target equals current path — no
      // history transition fires, so the URL→state recenter effect
      // won't run. Fall back to a direct recenter via the worktree.
      if (!pushPath(sessionPath(sessionId as SessionID), opts)) {
        const worktree = worktreeByIdRef.current.get(session.worktree_id);
        if (worktree?.board_id) {
          recenterMap(worktree.worktree_id, { boardId: worktree.board_id });
        }
      }
    },
    [pushPath, recenterMap]
  );

  const goToWorktree = useCallback(
    (worktreeId: string, opts?: NavigationOpts) => {
      const worktree = worktreeByIdRef.current.get(worktreeId);
      if (!worktree?.board_id) return;
      // Push first; let useUrlState's URL→state effect fire the
      // recenter. Only fall back to a direct recenter when the URL
      // didn't actually change (no history transition, so the effect
      // won't re-run) — avoids the prior double-recenter animation.
      if (!pushPath(worktreePath(worktreeId as WorktreeID), opts)) {
        recenterMap(worktreeId, { boardId: worktree.board_id });
      }
    },
    [pushPath, recenterMap]
  );

  const goToArtifact = useCallback(
    (artifactId: string, opts?: NavigationOpts) => {
      const artifact = artifactByIdRef.current.get(artifactId);
      if (!artifact?.board_id) return;
      // Parallel to goToWorktree. The canvas's recenter impl handles
      // the artifact-id-vs-board-object-id mismatch via a
      // data.artifactId fallback scan, so callers stay logical-id-only.
      if (!pushPath(artifactPath(artifactId as ArtifactID), opts)) {
        recenterMap(artifactId, { boardId: artifact.board_id });
      }
    },
    [pushPath, recenterMap]
  );

  return useMemo(
    () => ({ goToSession, goToWorktree, goToArtifact, goToBoard }),
    [goToSession, goToWorktree, goToArtifact, goToBoard]
  );
}
