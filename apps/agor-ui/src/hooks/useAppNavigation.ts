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
 * Identity stability: live data maps (`sessionById`, `branchById`)
 * flip reference on every socket event. The returned functions read
 * them via refs so their identities stay stable — important because
 * they're held by memoized children (BranchCard, SessionCanvas) and
 * a flipping identity would defeat the memoization, cascading
 * re-renders on every stream patch.
 */
import type { Artifact, ArtifactID, Branch, BranchID, Session, SessionID } from '@agor-live/client';
import { artifactPath, branchPath, sessionPath } from '@agor-live/client';
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useRecenterMap } from '../contexts/CanvasNavigationContext';
import { buildBoardPath } from './useUrlState';

interface UseAppNavigationOptions {
  /** Boards aren't exposed via AppDataContext yet — App.tsx passes its
   *  local `boardById` so URL building can prefer slugs. */
  boardById: Map<string, { board_id: string; slug?: string }>;
  /** Sessions, branches, and artifacts are passed in (rather than read
   *  from `useAppLiveData`) because this hook is called from App's own
   *  body, which renders the AppLiveDataProvider — so the provider
   *  isn't yet mounted when the hook runs. Matches `useUrlState`'s
   *  arg-passing pattern.
   *
   *  Each map is optional: callers only pass what their methods need
   *  (e.g. a Settings table that only uses `goToBranch` can omit
   *  `sessionById` and `artifactById`). The unused maps fall back to
   *  empty Maps. URL pushes work from the ID alone — the lookups are
   *  only needed for the same-URL recenter fallback (re-click on the
   *  entity that's already focused), which silently no-ops when the
   *  map is empty. */
  sessionById?: Map<string, Session>;
  branchById?: Map<string, Branch>;
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
  /** Navigate to a branch. Pushes `/w/<short>/` — useUrlState
   *  resolves the branch, switches boards if needed, and recenters. */
  goToBranch: (branchId: string, opts?: NavigationOpts) => void;
  /** Navigate to an artifact. Pushes `/a/<short>/`. */
  goToArtifact: (artifactId: string, opts?: NavigationOpts) => void;
  /** Navigate to a board (no session). Pushes `/b/<slug-or-short>/`. */
  goToBoard: (boardId: string, opts?: NavigationOpts) => void;
  /** Navigate to Home (`/`) with no board selected. */
  goHome: (opts?: NavigationOpts) => void;
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
  branchById,
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
  // Missing optional maps fall back to a shared empty map. URL pushes
  // work from the ID alone; the lookups are only consulted for the
  // same-URL recenter fallback, which silently no-ops on miss.
  const sessionByIdRef = useRef(sessionById ?? (EMPTY_MAP as Map<string, Session>));
  sessionByIdRef.current = sessionById ?? (EMPTY_MAP as Map<string, Session>);
  const branchByIdRef = useRef(branchById ?? (EMPTY_MAP as Map<string, Branch>));
  branchByIdRef.current = branchById ?? (EMPTY_MAP as Map<string, Branch>);
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

  const goHome = useCallback(
    (opts?: NavigationOpts) => {
      pushPath('/', opts);
    },
    [pushPath]
  );

  const goToSession = useCallback(
    (sessionId: string, opts?: NavigationOpts) => {
      // Push unconditionally: a just-created session may not be in
      // `sessionById` yet (socket `created` event still in flight), and
      // bailing here on lookup miss would silently strand the caller on
      // the prior URL. useUrlState's URL→state effect re-runs when the
      // session arrives in the map and drives selection from there.
      if (!pushPath(sessionPath(sessionId as SessionID), opts)) {
        // Same-URL click on the already-open session — no history
        // transition, so the URL→state recenter effect won't run. Fall
        // back to a direct recenter via the branch when we have it.
        const session = sessionByIdRef.current.get(sessionId);
        const branch = session?.branch_id
          ? branchByIdRef.current.get(session.branch_id)
          : undefined;
        if (branch?.board_id) {
          recenterMap(branch.branch_id, { boardId: branch.board_id });
        }
      }
    },
    [pushPath, recenterMap]
  );

  const goToBranch = useCallback(
    (branchId: string, opts?: NavigationOpts) => {
      // Push unconditionally — same rationale as goToSession: the URL
      // can be built from the ID alone, and bailing on a missing local
      // entity would silently strand future "create branch then
      // navigate immediately" flows on the prior URL. useUrlState's
      // URL→state effect resolves the branch when it lands in the map.
      if (!pushPath(branchPath(branchId as BranchID), opts)) {
        // Same-URL fallback: no history transition, so the URL→state
        // recenter effect won't run — recenter directly when we know
        // the board.
        const branch = branchByIdRef.current.get(branchId);
        if (branch?.board_id) {
          recenterMap(branchId, { boardId: branch.board_id });
        }
      }
    },
    [pushPath, recenterMap]
  );

  const goToArtifact = useCallback(
    (artifactId: string, opts?: NavigationOpts) => {
      // Parallel to goToBranch / goToSession. The canvas's recenter
      // impl handles the artifact-id-vs-board-object-id mismatch via
      // a data.artifactId fallback scan, so callers stay logical-id-only.
      if (!pushPath(artifactPath(artifactId as ArtifactID), opts)) {
        const artifact = artifactByIdRef.current.get(artifactId);
        if (artifact?.board_id) {
          recenterMap(artifactId, { boardId: artifact.board_id });
        }
      }
    },
    [pushPath, recenterMap]
  );

  return useMemo(
    () => ({ goToSession, goToBranch, goToArtifact, goToBoard, goHome }),
    [goToSession, goToBranch, goToArtifact, goToBoard, goHome]
  );
}
