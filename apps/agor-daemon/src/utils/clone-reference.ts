import type { AgorConfig } from '@agor/core/config';
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
 * When those two contexts differ — containerized / templated executors that
 * only mount the branch workspace — every git command in the branch dies:
 *
 * ```
 * error: unable to normalize alternate object path: /…/.agor/repos/<org>/<repo>/.git/objects
 * error: Could not read <sha>
 * fatal: Failed to traverse parents of commit <sha>
 * ```
 *
 * `createBranchAsClone`'s `referencePath` probe cannot defend against this:
 * it runs in the process performing the clone, where the path *is* visible,
 * while the alternates are consumed later somewhere it is not. Hence an
 * operator-level decision rather than a runtime probe.
 *
 * Borrowing is disabled when either:
 *  - `execution.branch_storage.borrow_base_objects: false` — explicit opt-out.
 *  - `execution.executor_storage.base_repository: 'unavailable'` — the
 *    operator has already declared the base checkout invisible to executors,
 *    which is exactly the topology where alternates cannot resolve.
 *
 * Default stays `true`, preserving the behavior every existing install has.
 */
export function shouldUseCloneReferencePath(config: DeepReadonly<AgorConfig>): boolean {
  if (config.execution?.branch_storage?.borrow_base_objects === false) {
    return false;
  }
  if (config.execution?.executor_storage?.base_repository === 'unavailable') {
    return false;
  }
  return true;
}
