import {
  type AgorConfig,
  type BranchStorageHealthConfig,
  resolveBranchStorageConfig,
  SANDBOX_HOME_MODE_DEFAULT,
} from '@agor/core/config';
import type { DeepReadonly } from '@agor/core/types';

/**
 * Decide whether clone-mode branch creation should borrow objects from the
 * managed base clone via `git clone --reference`.
 *
 * The borrow replaces the new clone's `.git/objects` with an `alternates`
 * pointer at `<data_home>/repos/<slug>/.git/objects`. That is a large disk
 * win, but it is also a *durable* dependency: the pointer is baked in at
 * create time and re-read by every later git command in that branch. So the
 * base clone has to be readable from wherever sessions run, not merely from
 * wherever the branch happened to be materialized.
 *
 * When those two contexts differ, every git command in the branch dies:
 *
 * ```
 * error: unable to normalize alternate object path: /…/.agor/repos/<org>/<repo>/.git/objects
 * error: Could not read <sha>
 * fatal: Failed to traverse parents of commit <sha>
 * ```
 *
 * `createBranchAsClone`'s `referencePath` probe cannot defend against this: it
 * runs in the process performing the clone, where the path *is* visible, while
 * the alternates are consumed later somewhere it is not. `git.branch.add` in
 * particular is a daemon-internal command spawn and is NEVER sandbox-wrapped
 * (`utils/sandbox-wrap.ts`), whereas the `prompt` / `zellij.attach` spawns that
 * later run git inside the branch always are. Hence a decision made from
 * configuration rather than from a runtime probe.
 *
 * Resolution order (first match wins):
 *  1. `execution.branch_storage.borrow_base_objects: false` — explicit opt-out.
 *  2. `execution.executor_storage.base_repository: 'unavailable'` — the
 *     operator has already declared the base checkout absent for executors.
 *     No other setting can conjure it back, so this outranks an explicit `true`.
 *  3. `execution.branch_storage.borrow_base_objects: true` — explicit opt-in.
 *     The operator owns making the path reachable from sandboxed sessions (for
 *     example `execution.sandbox.extra_allow_write: [<data_home>/repos]`).
 *  4. `execution.sandbox.enabled` + `home_mode: per_user` (or the
 *     `unix_user_mode: sandbox` named mode that forces exactly that) —
 *     inferred opt-out. That overlay hides the entire daemon `.agor` tree,
 *     `repos/` included, and re-exposes only the branch, the managed
 *     agentic-tools dir, and (for worktree-mode branches only) the base repo's
 *     `.git`. A clone-mode branch with an alternates pointer is therefore
 *     permanently broken inside it. `home_mode: shared` keeps `--ro-bind / /`,
 *     so the base clone stays readable there and the borrow is safe.
 *  5. Otherwise borrow — the behavior every existing install has.
 *
 * Case 4 is the regression this function was reintroduced to cover. It used to
 * be spelled `unix_user_mode !== 'strict'`; `915c8b1cd` replaced strict mode
 * with the bubblewrap sandbox without updating this gate, and `0a077e6c2`
 * ("remove Unix impersonation machinery") then collapsed the whole function to
 * `return true`, removing the last way to turn the borrow off.
 */
export function shouldUseCloneReferencePath(config: DeepReadonly<AgorConfig>): boolean {
  const borrowBaseObjects = config.execution?.branch_storage?.borrow_base_objects;
  if (borrowBaseObjects === false) {
    return false;
  }
  if (config.execution?.executor_storage?.base_repository === 'unavailable') {
    return false;
  }
  if (borrowBaseObjects === true) {
    return true;
  }
  return !executorSandboxHidesBaseClone(config);
}

/**
 * Public branch-storage health facts. Keep the borrowing fact coupled to the
 * exact predicate used by branch creation so health cannot drift from runtime.
 */
export function resolveBranchStorageHealthConfig(config: AgorConfig): BranchStorageHealthConfig {
  return {
    ...resolveBranchStorageConfig(config),
    borrowBaseObjects: shouldUseCloneReferencePath(config),
  };
}

/**
 * True when the configured executor sandbox will mask `<data_home>/repos` from
 * the sessions that run git inside the branch.
 *
 * Mirrors `resolveBwrapArgs`' per-user branch (`@agor/core/config/sandbox-policy`):
 * the owner-home overlay hides the daemon data root by construction and only
 * re-exposes the branch, agentic-tools, and worktree-mode base `.git`. Shared
 * home mode keeps the read-only root bind, so the base clone stays readable.
 *
 * `unix_user_mode: sandbox` is checked directly as well as via the folded
 * `execution.sandbox` block. The core config loader normally projects that
 * named mode into `{ enabled: true, home_mode: 'per_user',
 * fail_if_unavailable: true }`, but a daemon started with a caller-supplied
 * `DaemonStartOptions.config` skips that projection, and this predicate must
 * not silently weaken there.
 */
function executorSandboxHidesBaseClone(config: DeepReadonly<AgorConfig>): boolean {
  if (config.execution?.unix_user_mode === 'sandbox') return true;
  const sandbox = config.execution?.sandbox;
  if (sandbox?.enabled !== true) return false;
  return (sandbox.home_mode ?? SANDBOX_HOME_MODE_DEFAULT) === 'per_user';
}
