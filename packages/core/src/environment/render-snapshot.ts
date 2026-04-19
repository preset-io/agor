/**
 * Render a worktree "environment snapshot" from a repo's v2 environment config.
 *
 * A snapshot is the set of concrete command strings (start / stop / nuke /
 * logs / health URL / app URL) that get written onto a worktree at creation
 * time or when an admin re-renders against a different variant.
 *
 * Precedence (lowest → highest, per design doc §5):
 *   1. Handlebars built-in helpers + `buildWorktreeContext` defaults
 *      (worktree.*, repo.*, host.*, custom.*)
 *   2. `repo.environment.template_overrides` deep-merged in
 *   3. Per-worktree `custom_context` (already in the base context)
 *
 * See docs/designs/env-command-variants.md.
 */

import { resolveVariantOrThrow } from '../config/agor-yml';
import { buildWorktreeContext, renderTemplate } from '../templates/handlebars-helpers';
import type { RepoEnvironment } from '../types/worktree';

/**
 * Rendered snapshot — the concrete command strings a worktree should hold.
 *
 * Fields are present (possibly empty string) when the corresponding variant
 * field was defined; fields not provided by the variant are omitted.
 */
export interface RenderedEnvironmentSnapshot {
  /** Name of the variant that was rendered (for provenance / UI). */
  variant: string;
  start: string;
  stop: string;
  nuke?: string;
  logs?: string;
  health?: string;
  app?: string;
}

/**
 * Minimal repo shape needed for rendering.
 *
 * We do NOT depend on the full {@link import('../types/repo').Repo} type so
 * this helper can be called from contexts (e.g. executor) that only hold a
 * thin projection.
 */
export interface RenderRepoInput {
  slug?: string;
  environment?: RepoEnvironment;
}

/**
 * Minimal worktree shape needed for rendering (matches the inputs that
 * {@link buildWorktreeContext} already accepts).
 */
export interface RenderWorktreeInput {
  worktree_unique_id: number;
  name: string;
  path: string;
  custom_context?: Record<string, unknown>;
  unix_gid?: number;
  host_ip_address?: string;
}

/**
 * Deep-merge `overrides` onto `base`. Plain objects are merged recursively;
 * all other values (arrays, primitives, nulls) are replaced wholesale.
 *
 * Does NOT mutate inputs.
 */
function deepMergeContext(
  base: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!overrides) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMergeContext(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Render a single worktree's environment snapshot from a repo's v2
 * environment, optionally overriding the variant name.
 *
 * Behavior:
 * - If `repo.environment` is undefined → returns null.
 * - If `variantName` is omitted → uses `repo.environment.default`.
 * - If the named variant is missing → throws.
 * - If the variant `extends` another → fields are merged (single-level)
 *   before templating.
 *
 * @param repo       Repo projection with v2 environment config
 * @param worktree   Worktree projection used for template context
 * @param variantName Optional variant name override (defaults to `environment.default`)
 */
export function renderWorktreeSnapshot(
  repo: RenderRepoInput,
  worktree: RenderWorktreeInput,
  variantName?: string
): RenderedEnvironmentSnapshot | null {
  const env = repo.environment;
  if (!env) return null;

  const chosen = variantName ?? env.default;
  if (!env.variants[chosen]) {
    throw new Error(`Unknown environment variant "${chosen}" for repo "${repo.slug ?? ''}"`);
  }

  // Resolve single-level extends to a fully-materialized variant. Uses the
  // throwing variant because `env.variants[chosen]` is already guaranteed to
  // exist above; any remaining miss is a hard schema error, not a recoverable
  // fallback.
  const resolved = resolveVariantOrThrow(env, chosen);
  if (!resolved.start || !resolved.stop) {
    throw new Error(
      `Variant "${chosen}" must define both "start" and "stop" (directly or via extends)`
    );
  }

  // Build base template context (built-ins), then deep-merge
  // template_overrides INTO the context, preserving `custom.*` from the
  // worktree by merging custom context LAST.
  const baseContext = buildWorktreeContext({
    worktree_unique_id: worktree.worktree_unique_id,
    name: worktree.name,
    path: worktree.path,
    repo_slug: repo.slug,
    custom_context: worktree.custom_context,
    unix_gid: worktree.unix_gid,
    host_ip_address: worktree.host_ip_address,
  });

  // Per §5 of the design: defaults → template_overrides → custom.
  // `buildWorktreeContext` already places custom under `custom.*`, so we
  // need to merge overrides in BEFORE custom. Easiest way: rebuild with
  // override'd base entities, then reattach `custom`.
  const { custom, ...nonCustomBase } = baseContext as {
    custom: Record<string, unknown>;
  } & Record<string, unknown>;
  const overridden = deepMergeContext(
    nonCustomBase,
    env.template_overrides as Record<string, unknown> | undefined
  );
  const context: Record<string, unknown> = { ...overridden, custom };

  const snapshot: RenderedEnvironmentSnapshot = {
    variant: chosen,
    start: renderTemplate(resolved.start, context),
    stop: renderTemplate(resolved.stop, context),
  };
  if (resolved.nuke) snapshot.nuke = renderTemplate(resolved.nuke, context);
  if (resolved.logs) snapshot.logs = renderTemplate(resolved.logs, context);
  if (resolved.health) snapshot.health = renderTemplate(resolved.health, context);
  if (resolved.app) snapshot.app = renderTemplate(resolved.app, context);

  return snapshot;
}
