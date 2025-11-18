/**
 * `agor db status` - Show applied database migrations
 */

import { createDatabase, isSQLiteDatabase, sql } from '@agor/core/db';
import { expandPath } from '@agor/core/utils/path';
import { Command } from '@oclif/core';
import chalk from 'chalk';

/**
 * Database query result type with rows
 */
interface QueryResult {
  rows: unknown[];
  rowCount?: number;
}

/**
 * Migration row from __drizzle_migrations table
 */
interface MigrationRow {
  hash: string;
  created_at: number;
}

export default class DbStatus extends Command {
  static description = 'Show applied database migrations';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    try {
      // Determine database URL (same logic as daemon)
      // Priority: DATABASE_URL > AGOR_DB_PATH > default SQLite path
      const dbUrl =
        process.env.DATABASE_URL || expandPath(process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db');

      const db = createDatabase({ url: dbUrl });

      // Check if migrations table exists
      const tableCheck = isSQLiteDatabase(db)
        ? await db.run(
            sql`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`
          )
        : await db.execute(
            sql`SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`
          );

      const tableCheckResult = tableCheck as QueryResult;
      if (tableCheckResult.rows.length === 0) {
        this.log(
          `${chalk.yellow('⚠')} No migrations table found. Run ${chalk.cyan('agor db migrate')} to initialize.`
        );
        return;
      }

      // Query Drizzle's tracking table
      const result = isSQLiteDatabase(db)
        ? await db.run(
            sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`
          )
        : await db.execute(
            sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC`
          );

      const queryResult = result as QueryResult;
      if (queryResult.rows.length === 0) {
        this.log('No migrations applied yet');
        return;
      }

      this.log(chalk.bold('\nApplied migrations:\n'));
      queryResult.rows.forEach((row: unknown) => {
        const migration = row as MigrationRow;
        const date = new Date(migration.created_at);
        const formattedDate = date.toLocaleString();
        this.log(
          `  ${chalk.green('✓')} ${chalk.cyan(migration.hash)} ${chalk.dim(`(${formattedDate})`)}`
        );
      });

      this.log(`\n${chalk.bold(`Total: ${queryResult.rows.length} migration(s)`)}`);
    } catch (error) {
      this.error(
        `Failed to get migration status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
