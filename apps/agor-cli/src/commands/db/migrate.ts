/**
 * `agor db migrate` - Run pending database migrations
 */

import {
  checkMigrationStatus,
  createDatabase,
  formatSanitizedDbError,
  isSQLiteDatabase,
  pendingOfflineCutoverMigrations,
  sanitizeDbError,
} from '@agor/core/db';
import { expandPath, extractDbFilePath } from '@agor/core/utils/path';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  requireOfflineCutoverAcknowledgement,
  runConfirmedMigrations,
} from '../../lib/offline-migration-cutover.js';

export default class DbMigrate extends Command {
  static description = 'Run pending database migrations';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt (for non-interactive environments)',
      default: false,
    }),
    'offline-cutover': Flags.boolean({
      description:
        'Acknowledge every daemon using this existing database is stopped for a non-rolling migration',
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
        process.exit(0);
      }

      // Show pending migrations
      this.log(chalk.yellow('⚠️  Found pending migrations:'));
      this.log('');
      status.pending.forEach((tag) => {
        this.log(`  ${chalk.yellow('+')} ${tag}`);
      });
      this.log('');

      const offlineCutovers = pendingOfflineCutoverMigrations(
        isSQLiteDatabase(db) ? 'sqlite' : 'postgresql',
        status
      );
      if (offlineCutovers.length > 0) {
        this.log(chalk.red.bold('⛔ OFFLINE CUTOVER REQUIRED'));
        this.log('');
        this.log(
          `${offlineCutovers.join(', ')} includes migration work that is not safe while existing daemons are writing.`
        );
        this.log('Old and new daemons must not index this database concurrently.');
        this.log('');
        this.log('Required order:');
        this.log('  1. Stop every daemon connected to this database.');
        this.log(
          `  2. Run ${chalk.cyan('agor db migrate --offline-cutover')} from the new release.`
        );
        this.log('  3. Start only daemons running the new release.');
        this.log('');
        requireOfflineCutoverAcknowledgement(db, status, flags['offline-cutover']);
      }

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

      await runConfirmedMigrations(db, flags['offline-cutover']);

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
        this.log(chalk.cyan(`     sqlite3 ${dbFilePath} "PRAGMA table_info(branches)"`));
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

      // Force exit to close database connections (postgres-js keeps connections open)
      process.exit(0);
    } catch (error) {
      const safeError = sanitizeDbError(error);
      this.error(`Failed to run migrations: ${formatSanitizedDbError(safeError)}`);
    }
  }
}
