/**
 * `agor db migrate` - Run pending database migrations
 */

import { checkMigrationStatus, createDatabase, runMigrations } from '@agor/core/db';
import { expandPath, extractDbFilePath } from '@agor/core/utils/path';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

export default class DbMigrate extends Command {
  static description = 'Run pending database migrations';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt (for non-interactive environments)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DbMigrate);

    try {
      // Determine database URL (same logic as daemon)
      // Priority: DATABASE_URL > AGOR_DB_PATH > default SQLite path
      const dbUrl =
        process.env.DATABASE_URL || expandPath(process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db');
      const dbFilePath = extractDbFilePath(dbUrl);

      this.log(chalk.bold('🔍 Checking database migration status...'));
      this.log('');

      const db = createDatabase({ url: dbUrl });
      const status = await checkMigrationStatus(db);

      if (!status.hasPending) {
        this.log(`${chalk.green('✓')} Database is already up to date!`);
        this.log('');
        this.log(`Applied migrations (${status.applied.length}):`);
        status.applied.forEach((tag) => {
          this.log(`  ${chalk.dim('•')} ${tag}`);
        });
        return;
      }

      // Show pending migrations
      this.log(chalk.yellow('⚠️  Found pending migrations:'));
      this.log('');
      status.pending.forEach((tag) => {
        this.log(`  ${chalk.yellow('+')} ${tag}`);
      });
      this.log('');

      // Warn about backup
      this.log(chalk.bold('⚠️  IMPORTANT: Backup your database before proceeding!'));
      this.log('');
      this.log(`Run this command to create a backup:`);
      this.log(chalk.cyan(`  cp ${dbFilePath} ${dbFilePath}.backup-$(date +%s)`));
      this.log('');

      // Skip confirmation if --yes flag is set
      if (!flags.yes) {
        this.log('Press Ctrl+C to cancel, or any key to continue...');
        this.log('');

        // Wait for user confirmation (only in TTY mode)
        if (process.stdin.isTTY) {
          await new Promise<void>((resolve) => {
            process.stdin.once('data', () => resolve());
            process.stdin.setRawMode(true);
            process.stdin.resume();
          });

          // Restore terminal
          process.stdin.setRawMode(false);
          process.stdin.pause();
        } else {
          // In non-TTY mode, wait for a newline
          await new Promise<void>((resolve) => {
            process.stdin.once('data', () => resolve());
            process.stdin.resume();
          });
          process.stdin.pause();
        }
      } else {
        this.log(chalk.dim('(Skipping confirmation due to --yes flag)'));
        this.log('');
      }

      this.log(chalk.bold('🔄 Running migrations...'));
      this.log('');

      await runMigrations(db);

      // Verify all migrations applied
      const afterStatus = await checkMigrationStatus(db);
      if (afterStatus.hasPending) {
        this.log('');
        this.log(chalk.red('✗ Migration verification failed!'));
        this.log('');
        this.log(`Still have ${afterStatus.pending.length} pending migration(s):`);
        afterStatus.pending.forEach((tag) => {
          this.log(`  ${chalk.red('•')} ${tag}`);
        });
        this.log('');
        this.log(chalk.bold('Possible causes:'));
        this.log('  1. Migration SQL file was modified after being applied');
        this.log('  2. Package build cache is stale');
        this.log('  3. Schema changes were made manually outside migrations');
        this.log('');
        this.log(chalk.bold('Diagnostic steps:'));
        this.log('  1. Check if columns already exist:');
        this.log(chalk.cyan(`     sqlite3 ${dbFilePath} "PRAGMA table_info(worktrees)"`));
        this.log('  2. Rebuild core package:');
        this.log(chalk.cyan('     cd packages/core && pnpm build'));
        this.log('  3. Check migration hashes:');
        this.log(chalk.cyan(`     sqlite3 ${dbFilePath} "SELECT hash FROM __drizzle_migrations"`));
        this.log('');
        this.error(`Migration verification failed`);
      }

      this.log('');
      this.log(`${chalk.green('✓')} All migrations completed successfully!`);
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
