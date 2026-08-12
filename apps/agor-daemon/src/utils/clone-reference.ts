import type { AgorConfig } from '@agor/core/config';
import type { DeepReadonly } from '@agor/core/types';

/**
 * Decide whether clone-mode branch creation should borrow objects from the
 * managed base clone via `git clone --reference`.
 *
 * In strict mode, agent processes run as the requesting Unix user. A clone
 * whose `.git/objects/info/alternates` points back at the daemon-managed repo
 * can then fail normal in-session git commands when that user cannot traverse
 * the base clone's object store. Prefer a fully self-standing clone there.
 *
 * Simple/insulated deployments keep the disk-saving reference behavior: git
 * commands run as the daemon/executor identity that owns the managed object
 * cache.
 */
export function shouldUseCloneReferencePath(config: DeepReadonly<AgorConfig>): boolean {
  return (config.execution?.unix_user_mode ?? 'simple') !== 'strict';
}
