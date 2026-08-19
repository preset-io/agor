import type { AgorConfig } from '@agor/core/config';
import type { DeepReadonly } from '@agor/core/types';

/**
 * Decide whether clone-mode branch creation should borrow objects from the
 * managed base clone via `git clone --reference`.
 *
 * Local execution no longer impersonates host Unix users, so every supported
 * mode can use the daemon-managed object cache.
 */
export function shouldUseCloneReferencePath(config: DeepReadonly<AgorConfig>): boolean {
  void config;
  return true;
}
