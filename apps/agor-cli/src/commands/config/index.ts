/**
 * `agor config` - Show the effective deployment configuration.
 */

import {
  type AgorConfig,
  formatConfigYaml,
  getConfigPath,
  loadConfig,
  resolveEffectiveConfig,
} from '@agor/core/config';
import { getDatabaseUrl } from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

const REDACTED = '<redacted>';

function redactSecrets(config: AgorConfig): AgorConfig {
  const copy = structuredClone(config);
  if (copy.daemon?.jwtSecret) copy.daemon.jwtSecret = REDACTED;
  if (copy.daemon?.masterSecret) copy.daemon.masterSecret = REDACTED;
  if (copy.database?.postgresql?.password) copy.database.postgresql.password = REDACTED;
  if (copy.database?.postgresql?.url) {
    copy.database.postgresql.url = copy.database.postgresql.url.replace(
      /(?<=:\/\/[^:/?#]+:)[^@/?#]+(?=@)/,
      REDACTED
    );
  }
  if (copy.telemetry?.write_key) copy.telemetry.write_key = REDACTED;
  return copy;
}

function materializeDatabaseEnvironment(config: AgorConfig): AgorConfig {
  const dialect = process.env.AGOR_DB_DIALECT;
  if (!dialect && !process.env.DATABASE_URL && !process.env.AGOR_DB_PATH) return config;
  if (dialect === 'postgresql' || process.env.DATABASE_URL) {
    return {
      ...config,
      database: { dialect: 'postgresql', postgresql: { url: getDatabaseUrl() } },
    };
  }
  return {
    ...config,
    database: { dialect: 'sqlite', sqlite: { path: getDatabaseUrl().replace(/^file:/, '') } },
  };
}

export default class ConfigIndex extends Command {
  static description =
    'Show the effective local deployment configuration (YAML + environment + defaults)';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --yaml',
    '<%= config.bin %> <%= command.id %> --yaml --show-secrets > config.materialized.yaml',
  ];

  static flags = {
    yaml: Flags.boolean({ description: 'Print only machine-readable YAML', default: false }),
    'show-secrets': Flags.boolean({
      description: 'Include secrets in output (required for a directly reusable materialization)',
      default: false,
      dependsOn: ['yaml'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ConfigIndex);
    try {
      const effective = materializeDatabaseEnvironment(resolveEffectiveConfig(await loadConfig()));
      const output = flags['show-secrets'] ? effective : redactSecrets(effective);

      if (flags.yaml) {
        if (!flags['show-secrets']) {
          this.warn(
            'Secrets are redacted. Use --show-secrets only when writing to a protected destination.'
          );
        }
        this.log(formatConfigYaml(output).trimEnd());
        return;
      }

      this.log(chalk.bold('\nCurrent Effective Configuration'));
      this.log(chalk.dim(`Source: ${getConfigPath()} + environment overrides + defaults`));
      this.log(chalk.dim('Secrets are redacted. Use --yaml for machine-readable output.\n'));
      this.log(formatConfigYaml(output).trimEnd());
    } catch (error) {
      this.error(
        `Failed to resolve effective config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
