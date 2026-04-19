/**
 * `.agor.yml` file I/O.
 *
 * Thin Node-only wrapper that reads/writes `.agor.yml` files from a
 * repository root and delegates all parsing, schema validation, and variant
 * resolution to the browser-safe `variant-resolver` module. Kept separate so
 * UI callers don't transitively pull in `node:fs`.
 *
 * Schema support (see `variant-resolver.ts`):
 *   - v2 (preferred): named `environment.variants.<name>` with a `default`.
 *   - v1 (legacy): flat `environment.{start,stop,...}` — wrapped into
 *     `variants.default` at parse time so callers always get v2.
 *
 * YAML parsing/emission goes through `@agor/core/yaml` (js-yaml re-export)
 * so the dep stays centralized in core.
 *
 * See `docs/designs/env-command-variants.md`.
 */

import fs from 'node:fs';
import type {
  RepoEnvironment,
  RepoEnvironmentConfigV1,
  RepoEnvironmentVariant,
} from '../types/worktree';
import * as yaml from '../yaml/index.js';
import {
  type AgorYmlSchema,
  parseAgorYmlString,
  resolveVariant,
  resolveVariantOrThrow,
  validateAgorYmlSchema,
  validateExtends,
  validateRepoEnvironment,
  type YamlVariant,
} from './variant-resolver.js';

// Re-export the canonical pure logic so existing imports from this module
// (daemon, CLI) keep working without touching call sites.
export {
  type AgorYmlSchema,
  type YamlVariant,
  parseAgorYmlString,
  resolveVariant,
  resolveVariantOrThrow,
  validateAgorYmlSchema,
  validateExtends,
  validateRepoEnvironment,
};

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
  return parseAgorYmlString(content);
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
