/**
 * Helpers for reading v2 `Repo.environment` with v1 `environment_config`
 * fallback during the migration window.
 *
 * Callers should prefer {@link getEffectiveEnv} instead of hand-dereferencing
 * `repo.environment_config.*` so that the UI works whether the backend has
 * populated v2 yet or not.
 */

import type { Repo, RepoEnvironment, RepoEnvironmentVariant } from '@agor-live/client';

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

/**
 * Resolve a variant by name, merging a single-level `extends` parent under it.
 *
 * Field-by-field: child wins where defined, parent fills gaps. `extends` is
 * stripped from the result. Mirrors `resolveVariant` in
 * `packages/core/src/config/agor-yml.ts` — intentionally inlined here to stay
 * browser-safe (that module imports `node:fs`).
 */
export function resolveVariant(
  env: RepoEnvironment,
  variantName: string
): RepoEnvironmentVariant | null {
  const variant = env.variants[variantName];
  if (!variant) return null;
  if (!variant.extends) {
    const { extends: _drop, ...rest } = variant;
    return rest;
  }
  const parent = env.variants[variant.extends];
  if (!parent) return null;
  const merged: RepoEnvironmentVariant = {
    start: variant.start ?? parent.start,
    stop: variant.stop ?? parent.stop,
  };
  if (variant.description ?? parent.description)
    merged.description = variant.description ?? parent.description;
  if (variant.nuke ?? parent.nuke) merged.nuke = variant.nuke ?? parent.nuke;
  if (variant.logs ?? parent.logs) merged.logs = variant.logs ?? parent.logs;
  if (variant.health ?? parent.health) merged.health = variant.health ?? parent.health;
  if (variant.app ?? parent.app) merged.app = variant.app ?? parent.app;
  return merged;
}

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
