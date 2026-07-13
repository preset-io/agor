/**
 * `agor config` - Show all configuration
 */

import { getConfigPath, getDefaultConfig, loadConfig } from '@agor/core/config';
import { getDatabaseUrl } from '@agor/core/db';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class ConfigIndex extends Command {
  static description = 'Show current configuration';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    try {
      const config = await loadConfig();
      const defaults = getDefaultConfig();

      this.log(chalk.bold('\nCurrent Configuration'));
      this.log(chalk.dim('─'.repeat(50)));

      // Database Settings
      // Use the same centralized database URL resolution as the daemon
      const databaseUrl = getDatabaseUrl();
      const dialect = process.env.AGOR_DB_DIALECT === 'postgresql' ? 'postgresql' : 'sqlite';

      this.log(chalk.bold('\nDatabase Settings:'));
      this.log(`  dialect:       ${chalk.gray(dialect)}`);

      if (dialect === 'postgresql') {
        // Mask password in PostgreSQL URL (same pattern as daemon)
        const maskedUrl = databaseUrl.replace(/:([^:@]+)@/, ':****@');
        this.log(`  connection:    ${chalk.gray(maskedUrl)}`);
      } else {
        this.log(`  database file: ${chalk.gray(databaseUrl)}`);
      }

      this.log(
        chalk.dim(
          '  (Configure via AGOR_DB_DIALECT, DATABASE_URL, or AGOR_DB_PATH environment variables)'
        )
      );

      // Daemon Settings (merge with defaults to show effective values)
      const daemonConfig = { ...defaults.daemon, ...config.daemon };

      if (daemonConfig) {
        this.log(chalk.bold('\nDaemon Settings:'));
        if (daemonConfig.port !== undefined) {
          this.log(`  port:          ${chalk.gray(String(daemonConfig.port))}`);
        }
        if (daemonConfig.host) {
          this.log(`  host:          ${chalk.gray(daemonConfig.host)}`);
        }
        if (daemonConfig.jwtSecret) {
          this.log(
            `  JWT secret:    ${chalk.gray(`***${daemonConfig.jwtSecret.slice(-8)}`)} ${chalk.dim('(saved)')}`
          );
        }
      }

      // Config File Path
      this.log(chalk.bold('\nConfig File:'));
      this.log(`  ${chalk.dim(getConfigPath())}`);

      // Available Configuration Keys
      this.log(chalk.bold('\nAvailable Configuration Keys:'));
      this.log(chalk.dim('  Use `agor config set <key> <value>` to set any of these:'));
      this.log('');
      this.log(chalk.cyan('  Daemon:'));
      this.log('    daemon.port, daemon.host');
      this.log('    daemon.jwtSecret (auto-generated if not set)');

      this.log('');
    } catch (error) {
      this.error(
        `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
