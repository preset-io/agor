import type { Branch } from '@agor/core/types';
import { BRANCH_REVOCATION_SCOPE } from '../realtime/routing.js';

/**
 * Request-local proof, stamped by BranchesService once it has compared the
 * stored board with the requested one, of whether a `board_id` patch actually
 * moved the branch. Symbol-keyed so callers cannot forge it through params.
 */
const BRANCH_BOARD_CHANGED = Symbol('agor.branchBoardChanged');

type BranchBoardMoveParams = { [BRANCH_BOARD_CHANGED]?: boolean };

export function markBranchBoardChanged(params: object | undefined, changed: boolean): void {
  if (params) (params as BranchBoardMoveParams)[BRANCH_BOARD_CHANGED] = changed;
}

/** `undefined` means the service never proved the outcome; callers must fail closed. */
export function branchBoardChanged(params: object | undefined): boolean | undefined {
  return params ? (params as BranchBoardMoveParams)[BRANCH_BOARD_CHANGED] : undefined;
}

/**
 * Realtime invalidation required after a single-branch `board_id` write.
 *
 * - `none`: the stored board did not change, so no ACL or audience changed.
 * - `cache`: an `override` branch's ACL is its own config and ignores the
 *   board; only board-derived audiences (placement rows, counts) moved.
 * - `branch`: an `inherit` branch now takes the destination board's ACL. Only
 *   this branch's capabilities can be stale; see `revocationScope`.
 */
export function classifyBranchBoardMoveInvalidation(
  params: object | undefined,
  result: unknown
): 'none' | 'cache' | typeof BRANCH_REVOCATION_SCOPE {
  if (branchBoardChanged(params) === false) return 'none';
  const branch =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Partial<Branch>)
      : undefined;
  return branch?.permission_binding === 'override' ? 'cache' : BRANCH_REVOCATION_SCOPE;
}
