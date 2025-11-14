/**
 * .agor.yml Configuration Parser
 *
 * Parses and writes `.agor.yml` files from repository roots.
 * Supports environment configuration with template variables.
 */

import fs from 'node:fs';
import yaml from 'js-yaml';
import type { RepoEnvironmentConfig } from '../types/worktree';

/**
 * .agor.yml file schema
 *
 * Example:
 * ```yaml
 * environment:
 *   start: "docker compose -p {{worktree.name}} up -d"
 *   stop: "docker compose -p {{worktree.name}} down"
 *   health: "http://localhost:{{add 9000 worktree.unique_id}}/health"
 *   app: "http://localhost:{{add 5000 worktree.unique_id}}"
 *   logs: "docker compose -p {{worktree.name}} logs --tail=100"
 * ```
 */
export interface AgorYmlSchema {
  environment?: {
    start?: string;
    stop?: string;
    health?: string;
    app?: string;
    logs?: string;
  };
}

/**
 * Parse .agor.yml from a file path
 *
 * @param filePath - Absolute path to .agor.yml file
 * @returns Parsed RepoEnvironmentConfig or null if file doesn't exist
 * @throws Error if file exists but has invalid YAML or schema
 */
export function parseAgorYml(filePath: string): RepoEnvironmentConfig | null {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return null;
  }

  // Read file
  const content = fs.readFileSync(filePath, 'utf-8');

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    throw new Error(
      `Invalid YAML syntax in .agor.yml: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Validate schema
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('.agor.yml must contain an object');
  }

  const schema = parsed as AgorYmlSchema;

  // No environment config = return null
  if (!schema.environment) {
    return null;
  }

  const env = schema.environment;

  // Validate required fields
  if (!env.start || !env.stop) {
    throw new Error('.agor.yml environment config must have "start" and "stop" commands');
  }

  // Build RepoEnvironmentConfig
  const config: RepoEnvironmentConfig = {
    up_command: env.start,
    down_command: env.stop,
  };

  // Add optional fields
  if (env.health) {
    config.health_check = {
      type: 'http',
      url_template: env.health,
    };
  }

  if (env.app) {
    config.app_url_template = env.app;
  }

  if (env.logs) {
    config.logs_command = env.logs;
  }

  return config;
}

/**
 * Write RepoEnvironmentConfig to .agor.yml file
 *
 * @param filePath - Absolute path to .agor.yml file
 * @param config - Repository environment configuration
 * @throws Error if unable to write file
 */
export function writeAgorYml(filePath: string, config: RepoEnvironmentConfig): void {
  const schema: AgorYmlSchema = {
    environment: {
      start: config.up_command,
      stop: config.down_command,
      health: config.health_check?.url_template,
      app: config.app_url_template,
      logs: config.logs_command,
    },
  };

  // Remove undefined fields for cleaner output
  if (schema.environment) {
    if (!schema.environment.health) delete schema.environment.health;
    if (!schema.environment.app) delete schema.environment.app;
    if (!schema.environment.logs) delete schema.environment.logs;
  }

  // Convert to YAML
  const yamlContent = yaml.dump(schema, {
    indent: 2,
    lineWidth: 100,
    quotingType: '"',
    forceQuotes: false,
  });

  // Write to file
  try {
    fs.writeFileSync(filePath, yamlContent, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to write .agor.yml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
