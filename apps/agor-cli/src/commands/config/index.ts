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

      // Global Defaults
      this.log(chalk.bold('\nGlobal Defaults:'));
      if (config.defaults?.board) {
        this.log(`  default board: ${chalk.gray(config.defaults.board)}`);
      }
      if (config.defaults?.agent) {
        this.log(`  default agent: ${chalk.gray(config.defaults.agent)}`);
      }

      // Display Settings
      this.log(chalk.bold('\nDisplay Settings:'));
      if (config.display?.tableStyle) {
        this.log(`  table style:   ${chalk.gray(config.display.tableStyle)}`);
      }
      if (config.display?.colorOutput !== undefined) {
        this.log(
          `  color output:  ${chalk.gray(config.display.colorOutput ? 'enabled' : 'disabled')}`
        );
      }
      if (config.display?.shortIdLength) {
        this.log(`  short ID len:  ${chalk.gray(String(config.display.shortIdLength))}`);
      }

      // Credentials (only show keys that are set)
      if (config.credentials && Object.keys(config.credentials).length > 0) {
        this.log(chalk.bold('\nCredentials:'));
        for (const [key, value] of Object.entries(config.credentials)) {
          if (value) {
            this.log(`  ${key.padEnd(20)}: ${chalk.gray(`***${value.slice(-4)}`)}`);
          }
        }
      }

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
        if (daemonConfig.allowAnonymous !== undefined) {
          this.log(
            `  allow anon:    ${chalk.gray(daemonConfig.allowAnonymous ? 'enabled' : 'disabled')}`
          );
        }
        if (daemonConfig.requireAuth !== undefined) {
          this.log(
            `  require auth:  ${chalk.gray(daemonConfig.requireAuth ? 'enabled' : 'disabled')}`
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
      this.log(chalk.cyan('  Defaults:'));
      this.log('    defaults.board, defaults.agent');
      this.log('');
      this.log(chalk.cyan('  Display:'));
      this.log('    display.tableStyle, display.colorOutput, display.shortIdLength');
      this.log('');
      this.log(chalk.cyan('  Credentials:'));
      this.log('    credentials.ANTHROPIC_API_KEY');
      this.log('    credentials.OPENAI_API_KEY');
      this.log('    credentials.GEMINI_API_KEY');
      this.log('');
      this.log(chalk.cyan('  Daemon:'));
      this.log('    daemon.port, daemon.host');
      this.log('    daemon.jwtSecret (auto-generated if not set)');
      this.log('    daemon.allowAnonymous, daemon.requireAuth');

      this.log('');
    } catch (error) {
      this.error(
        `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
