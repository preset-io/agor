/**
 * Render a branch "environment snapshot" from a repo's v2 environment config.
 *
 * A snapshot is the set of concrete command strings (start / stop / nuke /
 * logs / health URL / app URL) that get written onto a branch at creation
 * time or when an admin re-renders against a different variant.
 *
 * Precedence (lowest → highest, per design doc §5):
 *   1. Handlebars built-in helpers + `buildBranchContext` defaults
 *      (branch.*, repo.*, host.*, custom.*)
 *   2. `repo.environment.template_overrides` deep-merged in
 *   3. Per-branch `custom_context` (already in the base context)
 *
 * See docs/designs/env-command-variants.md.
 */

import { extractGitHubSlugFromUrl } from '../config/repo-reference';
import { resolveVariantOrThrow } from '../config/variant-resolver';
import { buildBranchContext, renderTemplate } from '../templates/handlebars-helpers';
import type { RepoEnvironment } from '../types/branch';
import { resolveEnvironmentStartupTimeoutMs } from './health-transition';

/**
 * Rendered snapshot — the concrete command strings a branch should hold.
 *
 * Fields are present (possibly empty string) when the corresponding variant
 * field was defined; fields not provided by the variant are omitted.
 */
export interface RenderedEnvironmentSnapshot {
  /** Name of the variant that was rendered (for provenance / UI). */
  variant: string;
  startup_timeout_ms: number;
  start: string;
  stop: string;
  sync?: string;
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
  /** Sanitized registered remote; only a derived GitHub identity is rendered. */
  remote_url?: string;
  environment?: RepoEnvironment;
}

/**
 * Minimal branch shape needed for rendering (matches the inputs that
 * {@link buildBranchContext} already accepts).
 */
export interface RenderBranchInput {
  branch_id?: string;
  branch_unique_id: number;
  name: string;
  ref?: string;
  path: string;
  custom_context?: Record<string, unknown>;
  host_ip_address?: string;
  base_ref?: string;
  ref_type?: 'branch' | 'tag';
  /**
   * Post-start facts reported by a lifecycle command
   * (`BranchEnvironmentInstance.facts`). Exposed to templates as `{{env.*}}`.
   * Undefined at branch-creation render time (the environment has not started),
   * so `{{env.url}}` renders to '' then and to the real value on a re-render
   * performed while the environment is running.
   */
  facts?: Record<string, string>;
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
 * Render a single branch's environment snapshot from a repo's v2
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
 * @param branch   Branch projection used for template context
 * @param variantName Optional variant name override (defaults to `environment.default`)
 */
export function renderBranchSnapshot(
  repo: RenderRepoInput,
  branch: RenderBranchInput,
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
  // branch by merging custom context LAST.
  const baseContext = buildBranchContext({
    branch_id: branch.branch_id,
    branch_unique_id: branch.branch_unique_id,
    name: branch.name,
    ref: branch.ref,
    path: branch.path,
    repo_slug: repo.slug,
    repo_github_slug: repo.remote_url ? extractGitHubSlugFromUrl(repo.remote_url) : undefined,
    custom_context: branch.custom_context,
    host_ip_address: branch.host_ip_address,
    base_ref: branch.base_ref,
    ref_type: branch.ref_type,
    env_facts: branch.facts,
  });

  // Per §5 of the design: defaults → template_overrides → custom.
  // `buildBranchContext` already places custom under `custom.*`, so we
  // need to merge overrides in BEFORE custom. Easiest way: rebuild with
  // override'd base entities, then reattach `custom`.
  //
  // `env` (post-start facts) is destructured out alongside `custom` so both are
  // immune to `template_overrides` deep-merge: facts are runtime truth reported
  // by the environment itself and must not be shadowed by static config.
  const {
    custom,
    env: envFacts,
    ...nonCustomBase
  } = baseContext as {
    custom: Record<string, unknown>;
    env: Record<string, unknown>;
  } & Record<string, unknown>;
  const overridden = deepMergeContext(
    nonCustomBase,
    env.template_overrides as Record<string, unknown> | undefined
  );
  const context: Record<string, unknown> = { ...overridden, custom, env: envFacts };

  const snapshot: RenderedEnvironmentSnapshot = {
    variant: chosen,
    startup_timeout_ms: resolveEnvironmentStartupTimeoutMs(resolved.startup_timeout_ms),
    start: renderTemplate(resolved.start, context),
    stop: renderTemplate(resolved.stop, context),
  };
  if (resolved.sync) snapshot.sync = renderTemplate(resolved.sync, context);
  if (resolved.nuke) snapshot.nuke = renderTemplate(resolved.nuke, context);
  if (resolved.logs) snapshot.logs = renderTemplate(resolved.logs, context);
  if (resolved.health) snapshot.health = renderTemplate(resolved.health, context);
  if (resolved.app) snapshot.app = renderTemplate(resolved.app, context);

  return snapshot;
}
