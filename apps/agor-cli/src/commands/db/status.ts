/**
 * `agor db status` - Show applied database migrations
 */

import {
  checkMigrationStatus,
  createDatabase,
  formatSanitizedDbError,
  getDatabaseUrl,
  introspectMigrationStatus,
  isSQLiteDatabase,
  sanitizeDbError,
  sql,
} from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

/**
 * Database query result type with rows
 */
interface QueryResult {
  rows: unknown[];
  rowCount?: number;
}

async function withoutConsoleOutput<T>(operation: () => Promise<T>): Promise<T> {
  const methods = ['log', 'info', 'warn', 'error'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) console[method] = () => undefined;
  try {
    return await operation();
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
}

export default class DbStatus extends Command {
  static description = 'Show applied database migrations';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed migration information including hashes and pending migrations',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Output the versioned machine-readable migration status as JSON',
      default: false,
      exclusive: ['verbose'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DbStatus);

    try {
      // Determine database URL using centralized logic
      // Priority: If AGOR_DB_DIALECT=postgresql, use DATABASE_URL; otherwise AGOR_DB_PATH
      if (flags.json) {
        // Database clients and probes may emit setup diagnostics. JSON mode is
        // deliberately a single-document stdout contract, so contain those
        // implementation details while the runtime builds the report.
        const status = await withoutConsoleOutput(async () => {
          const db = createDatabase({ url: getDatabaseUrl() });
          return { db, status: await checkMigrationStatus(db) };
        });
        this.log(
          JSON.stringify(
            introspectMigrationStatus(
              isSQLiteDatabase(status.db) ? 'sqlite' : 'postgresql',
              status.status
            )
          )
        );
        process.exit(0);
      }

      const dbUrl = getDatabaseUrl();
      const db = createDatabase({ url: dbUrl });

      // Use comprehensive migration status check
      const status = await checkMigrationStatus(db);

      if (status.applied.length === 0 && status.pending.length === 0) {
        this.log(
          `${chalk.yellow('⚠')} No migrations table found. Run ${chalk.cyan('agor db migrate')} to initialize.`
        );
        process.exit(0);
      }

      // Show applied migrations
      if (status.applied.length > 0) {
        this.log(chalk.bold('\nApplied migrations:\n'));
        for (const tag of status.applied) {
          this.log(`  ${chalk.green('✓')} ${tag}`);
        }
        this.log(`\n${chalk.bold(`Total: ${status.applied.length} migration(s)`)}`);
      } else {
        this.log(chalk.yellow('No migrations applied yet'));
      }

      // Show pending migrations
      if (status.hasPending) {
        this.log('');
        this.log(chalk.yellow(chalk.bold('⚠️  Pending migrations:\n')));
        for (const tag of status.pending) {
          this.log(`  ${chalk.yellow('•')} ${tag}`);
        }
        this.log('');
        this.log(chalk.dim(`Run ${chalk.cyan('agor db migrate')} to apply pending migrations.`));
      }

      // Verbose mode: show hashes and detailed info
      if (flags.verbose) {
        this.log('');
        this.log(chalk.bold('Detailed information:'));
        this.log('');

        // Query Drizzle's tracking table for hash details
        const result = isSQLiteDatabase(db)
          ? await db.run(sql`SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id ASC`)
          : await db.execute(
              sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC`
            );

        const rows = isSQLiteDatabase(db) ? (result as QueryResult).rows : (result as unknown[]);

        this.log(
          `${chalk.dim('Database contains')} ${rows.length} ${chalk.dim('migration record(s)')}`
        );
        this.log(
          `${chalk.dim('Journal expects')} ${status.applied.length + status.pending.length} ${chalk.dim('migration(s)')}`
        );
        this.log('');

        if (rows.length > 0) {
          this.log(chalk.dim('Migration hashes in database:'));
          rows.forEach((row: unknown, index: number) => {
            const migration = row as { id: number; hash: string; created_at: number };
            const date = new Date(Number(migration.created_at));
            const formattedDate = date.toLocaleString();
            this.log(
              `  ${chalk.dim(`#${migration.id}:`)} ${migration.hash.substring(0, 12)}... ${chalk.dim(`(${formattedDate})`)}`
            );
          });
        }
      }

      // Force exit to close database connections (postgres-js keeps connections open)
      process.exit(0);
    } catch (error) {
      const safeError = sanitizeDbError(error);
      this.error(`Failed to get migration status: ${formatSanitizedDbError(safeError)}`);
    }
  }
}
