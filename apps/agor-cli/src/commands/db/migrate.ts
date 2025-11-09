/**
 * `agor db migrate` - Run pending database migrations
 */

import { checkMigrationStatus, createDatabase, runMigrations } from '@agor/core/db';
import { expandPath, extractDbFilePath } from '@agor/core/utils/path';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class DbMigrate extends Command {
  static description = 'Run pending database migrations';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    try {
      // Determine database path (same logic as daemon)
      const dbPath = expandPath(process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db');
      const dbFilePath = extractDbFilePath(dbPath);

      this.log(chalk.bold('🔍 Checking database migration status...'));
      this.log('');

      const db = createDatabase({ url: dbPath });
      const status = await checkMigrationStatus(db);

      if (!status.hasPending) {
        this.log(chalk.green('✓') + ' Database is already up to date!');
        this.log('');
        this.log(`Applied migrations (${status.applied.length}):`);
        status.applied.forEach(tag => {
          this.log(`  ${chalk.dim('•')} ${tag}`);
        });
        return;
      }

      // Show pending migrations
      this.log(chalk.yellow('⚠️  Found pending migrations:'));
      this.log('');
      status.pending.forEach(tag => {
        this.log(`  ${chalk.yellow('+')} ${tag}`);
      });
      this.log('');

      // Warn about backup
      this.log(chalk.bold('⚠️  IMPORTANT: Backup your database before proceeding!'));
      this.log('');
      this.log(`Run this command to create a backup:`);
      this.log(chalk.cyan(`  cp ${dbFilePath} ${dbFilePath}.backup-$(date +%s)`));
      this.log('');
      this.log('Press Ctrl+C to cancel, or any key to continue...');
      this.log('');

      // Wait for user confirmation (only in TTY mode)
      if (process.stdin.isTTY) {
        await new Promise<void>(resolve => {
          process.stdin.once('data', () => resolve());
          process.stdin.setRawMode(true);
          process.stdin.resume();
        });

        // Restore terminal
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } else {
        // In non-TTY mode, wait for a newline
        await new Promise<void>(resolve => {
          process.stdin.once('data', () => resolve());
          process.stdin.resume();
        });
        process.stdin.pause();
      }

      this.log(chalk.bold('🔄 Running migrations...'));
      this.log('');

      await runMigrations(db);

      // Verify all migrations applied
      const afterStatus = await checkMigrationStatus(db);
      if (afterStatus.hasPending) {
        this.error(
          `Migration verification failed! Still have ${afterStatus.pending.length} pending migration(s): ${afterStatus.pending.join(', ')}`
        );
      }

      this.log('');
      this.log(chalk.green('✓') + ' All migrations completed successfully!');
      this.log('');
      this.log('You can now start the daemon with:');
      this.log(chalk.cyan('  agor daemon start'));
    } catch (error) {
      this.error(
        `Failed to run migrations: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
