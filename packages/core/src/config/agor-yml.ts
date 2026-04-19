/**
 * .agor.yml Configuration Parser
 *
 * Parses and writes `.agor.yml` files from repository roots.
 *
 * Schema support:
 *   - v2 (preferred): named `environment.variants.<name>` with a `default`.
 *   - v1 (legacy): flat `environment.{start,stop,...}` — wrapped into
 *     `variants.default` at parse time so callers always get v2.
 *
 * Single-level `extends` between variants is supported. Multi-level chains,
 * missing targets, and self-extends are rejected. `template_overrides` is
 * DB-only and is rejected on import / stripped on export.
 *
 * See `docs/designs/env-command-variants.md`.
 */

import fs from 'node:fs';
import yaml from 'js-yaml';
import type {
  RepoEnvironment,
  RepoEnvironmentConfigV1,
  RepoEnvironmentVariant,
} from '../types/worktree';

/**
 * v2 variant as it appears in `.agor.yml` (YAML-level shape; keys match
 * the in-memory {@link RepoEnvironmentVariant} exactly).
 */
interface YamlVariant {
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
interface YamlFlatEnvironment extends YamlVariant {
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
function toVariant(name: string, y: YamlVariant): RepoEnvironmentVariant {
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
 *
 * Throws on violation.
 */
function validateExtends(env: RepoEnvironment): void {
  for (const [name, variant] of Object.entries(env.variants)) {
    const target = variant.extends;
    if (!target) continue;
    if (target === name) {
      throw new Error(`.agor.yml: variant "${name}" cannot extend itself`);
    }
    const parent = env.variants[target];
    if (!parent) {
      throw new Error(
        `.agor.yml: variant "${name}" extends unknown variant "${target}"`
      );
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
 * Does NOT validate — call {@link validateExtends} before resolving.
 */
export function resolveVariant(
  env: RepoEnvironment,
  variantName: string
): RepoEnvironmentVariant {
  const variant = env.variants[variantName];
  if (!variant) {
    throw new Error(`Unknown variant "${variantName}"`);
  }
  if (!variant.extends) {
    // Shallow clone so callers can mutate safely.
    const { extends: _drop, ...rest } = variant;
    return rest as RepoEnvironmentVariant;
  }
  const parent = env.variants[variant.extends];
  if (!parent) {
    throw new Error(
      `Variant "${variantName}" extends unknown variant "${variant.extends}"`
    );
  }
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
 * Parse `.agor.yml` from a file path into a v2 {@link RepoEnvironment}.
 *
 * @param filePath - Absolute path to `.agor.yml` file
 * @returns Parsed v2 environment, or null if file doesn't exist / has no
 *          `environment:` block
 * @throws Error if file exists but has invalid YAML, invalid schema,
 *         `template_overrides:` at any level, or broken `extends` references.
 */
export function parseAgorYml(filePath: string): RepoEnvironment | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    throw new Error(
      `Invalid YAML syntax in .agor.yml: ${error instanceof Error ? error.message : String(error)}`
    );
  }

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
      throw new Error(
        `.agor.yml: default variant "${defaultName}" is not defined in variants`
      );
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
 * Serialize a v2 {@link RepoEnvironment} to a v2 `.agor.yml` file.
 *
 * - Always writes v2 (named variants + `default`).
 * - `template_overrides` is always stripped (it is DB-only).
 * - Undefined per-variant fields are omitted for cleaner output.
 *
 * Accepts either a v2 environment or the legacy v1 config; v1 is wrapped
 * as `variants.default` before writing.
 */
export function writeAgorYml(
  filePath: string,
  config: RepoEnvironment | RepoEnvironmentConfigV1
): void {
  const env = isV2(config) ? config : wrapV1(config);

  const variantsYaml: Record<string, YamlVariant> = {};
  for (const [name, v] of Object.entries(env.variants)) {
    const entry: YamlVariant = {
      start: v.start,
      stop: v.stop,
    };
    if (v.description) entry.description = v.description;
    if (v.extends) entry.extends = v.extends;
    if (v.nuke) entry.nuke = v.nuke;
    if (v.logs) entry.logs = v.logs;
    if (v.health) entry.health = v.health;
    if (v.app) entry.app = v.app;
    variantsYaml[name] = entry;
  }

  const schema: AgorYmlSchema = {
    environment: {
      default: env.default,
      variants: variantsYaml,
    },
  };

  const yamlContent = yaml.dump(schema, {
    indent: 2,
    lineWidth: 100,
    quotingType: '"',
    forceQuotes: false,
  });

  try {
    fs.writeFileSync(filePath, yamlContent, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to write .agor.yml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isV2(c: RepoEnvironment | RepoEnvironmentConfigV1): c is RepoEnvironment {
  return (c as RepoEnvironment).version === 2 && (c as RepoEnvironment).variants !== undefined;
}

function wrapV1(v1: RepoEnvironmentConfigV1): RepoEnvironment {
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
