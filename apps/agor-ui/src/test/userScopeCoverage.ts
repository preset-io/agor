import { agorStore } from '../store/agorStore';
import { nextPartitionGeneration } from '../store/boardPartitions';
import { captureLoadLifetime, type LoadLifetime } from '../store/loadLifetime';
import {
  boardScopeKey,
  type ScopeCoverage,
  type ScopeKey,
  USER_SCOPE_KEYS,
} from '../store/scopeMerge';

type Piece = keyof typeof USER_SCOPE_KEYS;

const FIXTURE_LIFETIME: LoadLifetime = { authorityScope: 'fixture', loadEpoch: 0 };

/**
 * A `coverage` map whose listed user-scope pieces are loaded (`'capped'`:
 * loaded from a capped read), for tests that seed the store directly.
 */
export function userScopeCoverage(
  pieces: Partial<Record<Piece, boolean | 'capped'>>
): Map<ScopeKey, ScopeCoverage> {
  const coverage = new Map<ScopeKey, ScopeCoverage>();
  for (const [piece, state] of Object.entries(pieces) as [Piece, boolean | 'capped'][]) {
    if (!state) continue;
    coverage.set(USER_SCOPE_KEYS[piece], {
      status: 'loaded',
      ...FIXTURE_LIFETIME,
      generation: 0,
      members: {},
      complete: state !== 'capped',
    });
  }
  return coverage;
}

/** A board partition entry of a new load (a new generation); a loaded one is complete. */
export function boardCoverage(
  status: ScopeCoverage['status'] = 'loaded',
  lifetime: LoadLifetime = FIXTURE_LIFETIME
): ScopeCoverage {
  return {
    status,
    ...lifetime,
    generation: nextPartitionGeneration(),
    // A partition read returns all four collections (here: none of each).
    ...(status === 'loaded'
      ? {
          members: {
            branches: new Set<string>(),
            sessions: new Set<string>(),
            boardObjects: new Set<string>(),
            cards: new Set<string>(),
          },
          complete: true,
        }
      : {}),
  };
}

/** Seed `boardId`'s partition as loaded by a new load, under the current lifetime by default. */
export function markBoardLoaded(
  boardId: string,
  lifetime: LoadLifetime = captureLoadLifetime() ?? FIXTURE_LIFETIME
): void {
  agorStore.getState().setCoverage(boardScopeKey(boardId), boardCoverage('loaded', lifetime));
}
