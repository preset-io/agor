/**
 * Helpers for reading v2 `Repo.environment` with v1 `environment_config`
 * fallback during the migration window.
 *
 * Callers should prefer {@link getEffectiveEnv} instead of hand-dereferencing
 * `repo.environment_config.*` so that the UI works whether the backend has
 * populated v2 yet or not.
 *
 * Variant resolution is delegated to `@agor-live/client` (re-exported from
 * `@agor/core/config/browser`) — the same module the daemon / repository
 * layer uses, so there's a single source of truth for `extends` semantics.
 */

import { type Repo, resolveVariant } from '@agor-live/client';

/**
 * Normalized view of the *default* environment commands for a repo — the ones
 * a fresh worktree would render against. Fields mirror v2 variant keys.
 */
export interface EffectiveEnv {
  start?: string;
  stop?: string;
  nuke?: string;
  logs?: string;
  health?: string;
  app?: string;
  /** True iff any field is populated (i.e. the repo has ANY env config). */
  hasConfig: boolean;
}

export { resolveVariant };

/**
 * Return the "default" effective environment for a repo — v2 default variant
 * resolved, with a v1 `environment_config` fallback for rollout safety.
 *
 * Prefer this over reading `environment_config.up_command` directly so a repo
 * migrated to v2 still displays correctly even if the v1 view lags.
 */
export function getEffectiveEnv(repo: Repo): EffectiveEnv {
  if (repo.environment) {
    const resolved = resolveVariant(repo.environment, repo.environment.default);
    if (resolved) {
      return {
        start: resolved.start,
        stop: resolved.stop,
        nuke: resolved.nuke,
        logs: resolved.logs,
        health: resolved.health,
        app: resolved.app,
        hasConfig: !!(resolved.start || resolved.stop),
      };
    }
  }
  // v1 fallback: kept alive during the migration window for UIs that still
  // read `environment_config`. Removed once all readers are on v2 for a bake.
  const v1 = repo.environment_config;
  if (v1) {
    return {
      start: v1.up_command,
      stop: v1.down_command,
      nuke: v1.nuke_command,
      logs: v1.logs_command,
      health: v1.health_check?.url_template,
      app: v1.app_url_template,
      hasConfig: !!(v1.up_command || v1.down_command),
    };
  }
  return { hasConfig: false };
}

/**
 * True iff the repo has any environment config (v2 variants OR legacy v1).
 * Convenience wrapper for pill / badge components that only care about the
 * config's existence and not the specific commands.
 */
export function hasEnvironmentConfig(repo: Repo): boolean {
  return getEffectiveEnv(repo).hasConfig;
}
