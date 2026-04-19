/**
 * `.agor.yml` Environment — shared, browser-safe logic.
 *
 * This module is the single source of truth for:
 *   - v2 schema validation (`environment.variants`, `default`, `extends`).
 *   - v1 → v2 legacy wrapping.
 *   - Single-level `extends` resolution.
 *   - Parsing from a YAML string (via `@agor/core/yaml`).
 *
 * Deliberately has **no** `node:fs` / `node:path` imports so it can be used
 * from the browser. The file-reading `parseAgorYml(path)` entrypoint lives in
 * `agor-yml.ts` and is a thin wrapper over {@link parseAgorYmlString}.
 *
 * Daemon, CLI, repository layer, and UI all go through this module — see
 * `docs/designs/env-command-variants.md`.
 */

import type {
  RepoEnvironment,
  RepoEnvironmentConfigV1,
  RepoEnvironmentVariant,
} from '../types/worktree.js';
import * as yaml from '../yaml/index.js';

/**
 * v2 variant as it appears in `.agor.yml` (YAML-level shape; keys match
 * the in-memory {@link RepoEnvironmentVariant} exactly).
 */
export interface YamlVariant {
  description?: string;
  extends?: string;
  start?: string;
  stop?: string;
  nuke?: string;
  logs?: string;
  health?: string;
  app?: string;
}

/**
 * v2 flat environment block — same fields as {@link YamlVariant}, used only
 * when the file has no `variants` key (legacy compatibility path).
 */
export interface YamlFlatEnvironment extends YamlVariant {
  // v2 block may also contain these keys; if it does, we treat the file as v2
  // and ignore any flat top-level command fields.
  default?: string;
  variants?: Record<string, YamlVariant>;
}

/**
 * Full `.agor.yml` schema (union of v1 flat and v2 variant forms).
 */
export interface AgorYmlSchema {
  environment?: YamlFlatEnvironment;
  // `template_overrides` is NEVER a valid input — presence causes rejection.
  // Typed here only so the reject-on-import check can see it without `any`.
  template_overrides?: unknown;
}

/**
 * Build a {@link RepoEnvironmentVariant} from the YAML-level variant shape.
 *
 * When the variant declares `extends`, `start`/`stop` may be omitted and will
 * be inherited from the parent. Without `extends`, both are required. The
 * cross-variant check that extended variants ultimately resolve to a
 * variant with `start` and `stop` happens in {@link validateExtends}.
 */
export function toVariant(name: string, y: YamlVariant): RepoEnvironmentVariant {
  const inheritsFromParent = typeof y.extends === 'string' && y.extends.length > 0;
  if (!inheritsFromParent) {
    if (!y.start || typeof y.start !== 'string') {
      throw new Error(`.agor.yml: variant "${name}" is missing required "start" command`);
    }
    if (!y.stop || typeof y.stop !== 'string') {
      throw new Error(`.agor.yml: variant "${name}" is missing required "stop" command`);
    }
  }
  const variant: RepoEnvironmentVariant = {};
  if (typeof y.start === 'string') variant.start = y.start;
  if (typeof y.stop === 'string') variant.stop = y.stop;
  if (y.description) variant.description = y.description;
  if (y.extends) variant.extends = y.extends;
  if (y.nuke) variant.nuke = y.nuke;
  if (y.logs) variant.logs = y.logs;
  if (y.health) variant.health = y.health;
  if (y.app) variant.app = y.app;
  return variant;
}

/**
 * Validate that `extends` references across all variants are:
 *   - Single-level only (target variant must not itself extend).
 *   - Never self-referential.
 *   - Always point to an existing variant in this environment.
 *   - The resolved pair child⊕parent defines both `start` and `stop`.
 *
 * Throws on violation.
 */
export function validateExtends(env: RepoEnvironment): void {
  for (const [name, variant] of Object.entries(env.variants)) {
    const target = variant.extends;
    if (!target) continue;
    if (target === name) {
      throw new Error(`.agor.yml: variant "${name}" cannot extend itself`);
    }
    const parent = env.variants[target];
    if (!parent) {
      throw new Error(`.agor.yml: variant "${name}" extends unknown variant "${target}"`);
    }
    if (parent.extends) {
      throw new Error(
        `.agor.yml: variant "${name}" extends "${target}" which also extends "${parent.extends}" — only single-level extends is supported`
      );
    }
    // Extended variant must resolve to start+stop (child or parent).
    if (!(variant.start ?? parent.start)) {
      throw new Error(
        `.agor.yml: variant "${name}" extends "${target}" but neither defines required "start" command`
      );
    }
    if (!(variant.stop ?? parent.stop)) {
      throw new Error(
        `.agor.yml: variant "${name}" extends "${target}" but neither defines required "stop" command`
      );
    }
  }
}

/**
 * Resolve a single variant into its fully-materialized form by applying its
 * (single-level) parent's fields, then overriding with the variant's own
 * fields. `extends` is stripped from the result.
 *
 * Does NOT validate the extends graph — call {@link validateExtends} first if
 * you need that guarantee. Returns `null` when the named variant doesn't
 * exist or its `extends` target is missing; callers that prefer to throw can
 * use {@link resolveVariantOrThrow}.
 */
export function resolveVariant(
  env: RepoEnvironment,
  variantName: string
): RepoEnvironmentVariant | null {
  const variant = env.variants[variantName];
  if (!variant) return null;
  if (!variant.extends) {
    // Shallow clone so callers can mutate safely.
    const { extends: _drop, ...rest } = variant;
    return rest;
  }
  const parent = env.variants[variant.extends];
  if (!parent) return null;
  // Field-by-field override: child wins where defined.
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
 * Throwing variant of {@link resolveVariant} — used by the parser where a
 * missing target is a hard schema error rather than a recoverable miss.
 */
export function resolveVariantOrThrow(
  env: RepoEnvironment,
  variantName: string
): RepoEnvironmentVariant {
  const resolved = resolveVariant(env, variantName);
  if (!resolved) {
    const variant = env.variants[variantName];
    if (!variant) throw new Error(`Unknown variant "${variantName}"`);
    throw new Error(
      `Variant "${variantName}" extends unknown variant "${variant.extends ?? '<none>'}"`
    );
  }
  return resolved;
}

/**
 * Wrap a legacy v1 environment_config as a v2 environment with a single
 * `default` variant. Used when callers still write the v1 shape.
 */
export function wrapV1AsV2(v1: RepoEnvironmentConfigV1 | undefined): RepoEnvironment | undefined {
  if (!v1) return undefined;
  const variant: RepoEnvironmentVariant = {
    start: v1.up_command,
    stop: v1.down_command,
  };
  if (v1.nuke_command) variant.nuke = v1.nuke_command;
  if (v1.logs_command) variant.logs = v1.logs_command;
  if (v1.app_url_template) variant.app = v1.app_url_template;
  if (v1.health_check?.url_template) variant.health = v1.health_check.url_template;
  return {
    version: 2,
    default: 'default',
    variants: { default: variant },
  };
}

/**
 * Validate an already-parsed YAML object against the `.agor.yml` schema and
 * return a normalized v2 {@link RepoEnvironment}.
 *
 * Rejects `template_overrides` at any level (DB-only field). Accepts v1 flat
 * form and transparently wraps it as `variants.default`.
 *
 * @returns v2 environment, or null if the object has no `environment:` block.
 */
export function validateAgorYmlSchema(parsed: unknown): RepoEnvironment | null {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('.agor.yml must contain an object');
  }

  const schema = parsed as AgorYmlSchema;

  // Reject `template_overrides` at any level — DB-only.
  if ('template_overrides' in schema && schema.template_overrides !== undefined) {
    throw new Error(
      '.agor.yml: `template_overrides` is not allowed in .agor.yml — it is a deployment-local, DB-only field'
    );
  }
  if (
    schema.environment &&
    typeof schema.environment === 'object' &&
    'template_overrides' in schema.environment &&
    (schema.environment as Record<string, unknown>).template_overrides !== undefined
  ) {
    throw new Error(
      '.agor.yml: `environment.template_overrides` is not allowed — it is a deployment-local, DB-only field'
    );
  }

  if (!schema.environment) {
    return null;
  }

  const env = schema.environment;

  // Distinguish v2 (has `variants`) from v1 (flat `start`/`stop` at top).
  const isV2 =
    env.variants !== undefined && typeof env.variants === 'object' && env.variants !== null;

  let variants: Record<string, RepoEnvironmentVariant>;
  let defaultName: string;

  if (isV2) {
    if (!env.default || typeof env.default !== 'string') {
      throw new Error('.agor.yml: v2 environment requires a top-level `default` variant name');
    }
    defaultName = env.default;
    variants = {};
    for (const [name, raw] of Object.entries(env.variants!)) {
      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`.agor.yml: variant "${name}" must be an object`);
      }
      variants[name] = toVariant(name, raw as YamlVariant);
    }
    if (!variants[defaultName]) {
      throw new Error(`.agor.yml: default variant "${defaultName}" is not defined in variants`);
    }
  } else {
    // v1 legacy flat form — wrap as variants.default.
    if (!env.start || !env.stop) {
      throw new Error(
        '.agor.yml environment config must have "start" and "stop" commands (or a `variants` block)'
      );
    }
    defaultName = 'default';
    variants = {
      default: toVariant('default', env),
    };
  }

  const result: RepoEnvironment = {
    version: 2,
    default: defaultName,
    variants,
  };

  validateExtends(result);
  return result;
}

/**
 * Validate an already-shaped {@link RepoEnvironment} (e.g. one constructed
 * by the UI editor or read from the DB row) and return a normalized copy.
 *
 * Mirrors the `version`/`default`/`variants` checks done on file import and
 * runs {@link validateExtends}. Unlike {@link validateAgorYmlSchema} this is
 * the DB-side validator: `template_overrides` is **preserved** (not
 * rejected) because it is a deployment-local field that lives only in the
 * database row and is allowed on the in-memory `repo.environment` object.
 *
 * Throws on violation.
 */
export function validateRepoEnvironment(obj: unknown): RepoEnvironment {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Expected a mapping (object)');
  }
  const env = obj as Partial<RepoEnvironment>;
  if (env.version !== 2) {
    throw new Error('`version` must be 2');
  }
  if (!env.default || typeof env.default !== 'string') {
    throw new Error('`default` must be a variant name string');
  }
  if (!env.variants || typeof env.variants !== 'object') {
    throw new Error('`variants` must be a map of variant-name → object');
  }
  if (!(env.default in env.variants)) {
    throw new Error(`\`default\` "${env.default}" is not defined in \`variants\``);
  }
  // Re-run per-variant field-shape validation so e.g. a non-extends variant
  // missing `start`/`stop` is caught the same way as on file import.
  const normalized: Record<string, RepoEnvironmentVariant> = {};
  for (const [name, v] of Object.entries(env.variants)) {
    if (typeof v !== 'object' || v === null) {
      throw new Error(`variant "${name}" must be an object`);
    }
    normalized[name] = toVariant(name, v as YamlVariant);
  }
  const result: RepoEnvironment = {
    version: 2,
    default: env.default,
    variants: normalized,
  };
  // Preserve `template_overrides` if present — it's DB-only but legitimately
  // lives on `repo.environment` and would silently disappear on save if we
  // rebuilt the object without it. Shape-guard: must be a plain object map.
  if (env.template_overrides !== undefined) {
    if (
      typeof env.template_overrides !== 'object' ||
      env.template_overrides === null ||
      Array.isArray(env.template_overrides)
    ) {
      throw new Error('`template_overrides` must be a mapping (object)');
    }
    result.template_overrides = env.template_overrides as Record<string, unknown>;
  }
  validateExtends(result);
  return result;
}

/**
 * Parse a `.agor.yml` YAML string into a validated v2 {@link RepoEnvironment}.
 *
 * @returns v2 environment, or null if the document has no `environment:` block
 * @throws Error on invalid YAML, invalid schema, `template_overrides` at any
 *         level, or broken `extends` references.
 */
export function parseAgorYmlString(content: string): RepoEnvironment | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    throw new Error(
      `Invalid YAML syntax in .agor.yml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateAgorYmlSchema(parsed);
}
