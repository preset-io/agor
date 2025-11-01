/**
 * `agor db status` - Show applied database migrations
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, sql } from '@agor/core/db';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class DbStatus extends Command {
  static description = 'Show applied database migrations';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    try {
      // Determine database path (same logic as daemon)
      const dbPath = process.env.AGOR_DB_PATH || `file:${join(homedir(), '.agor', 'agor.db')}`;

      const db = createDatabase({ url: dbPath });

      // Check if migrations table exists
      const tableCheck = await db.run(sql`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='__drizzle_migrations'
      `);

      if (tableCheck.rows.length === 0) {
        this.log(
          `${chalk.yellow('⚠')} No migrations table found. Run ${chalk.cyan('agor db migrate')} to initialize.`
        );
        return;
      }

      // Query Drizzle's tracking table
      const result = await db.run(sql`
        SELECT hash, created_at FROM __drizzle_migrations
        ORDER BY created_at ASC
      `);

      if (result.rows.length === 0) {
        this.log('No migrations applied yet');
        return;
      }

      this.log(chalk.bold('\nApplied migrations:\n'));
      result.rows.forEach(row => {
        const migration = row as unknown as { hash: string; created_at: number };
        const date = new Date(migration.created_at);
        const formattedDate = date.toLocaleString();
        this.log(
          `  ${chalk.green('✓')} ${chalk.cyan(migration.hash)} ${chalk.dim(`(${formattedDate})`)}`
        );
      });

      this.log(`\n${chalk.bold(`Total: ${result.rows.length} migration(s)`)}`);
    } catch (error) {
      this.error(
        `Failed to get migration status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
