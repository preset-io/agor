#!/usr/bin/env node

/**
 * Database Setup Script
 *
 * Initializes the Agor database with tables and seed data.
 * Run this once to set up a new database or reset an existing one.
 *
 * Usage:
 *   npm run db:setup                    # Use default path (~/.agor/sessions.db)
 *   npm run db:setup -- --path ./test.db # Use custom path
 *   npm run db:setup -- --reset          # Drop and recreate tables
 */

import { sql } from 'drizzle-orm';
import { createDatabase, DEFAULT_DB_PATH } from '../client';
import { isSQLiteDatabase } from '../database-wrapper';
import { initializeDatabase, seedInitialData } from '../migrate';

interface SetupOptions {
  path?: string;
  reset?: boolean;
}

async function parseArgs(): Promise<SetupOptions> {
  const args = process.argv.slice(2);
  const options: SetupOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path' && i + 1 < args.length) {
      options.path = args[i + 1];
      i++;
    } else if (arg === '--reset') {
      options.reset = true;
    }
  }

  return options;
}

async function dropTables(db: ReturnType<typeof createDatabase>): Promise<void> {
  console.log('Dropping existing tables...');

  // Execute raw SQL based on database type
  if (isSQLiteDatabase(db)) {
    await db.run(sql`DROP TABLE IF EXISTS board_comments`);
    await db.run(sql`DROP TABLE IF EXISTS session_mcp_servers`);
    await db.run(sql`DROP TABLE IF EXISTS mcp_servers`);
    await db.run(sql`DROP TABLE IF EXISTS board_objects`);
    await db.run(sql`DROP TABLE IF EXISTS messages`);
    await db.run(sql`DROP TABLE IF EXISTS tasks`);
    await db.run(sql`DROP TABLE IF EXISTS sessions`);
    await db.run(sql`DROP TABLE IF EXISTS worktrees`);
    await db.run(sql`DROP TABLE IF EXISTS boards`);
    await db.run(sql`DROP TABLE IF EXISTS repos`);
    await db.run(sql`DROP TABLE IF EXISTS users`);
  } else {
    await db.execute(sql`DROP TABLE IF EXISTS board_comments`);
    await db.execute(sql`DROP TABLE IF EXISTS session_mcp_servers`);
    await db.execute(sql`DROP TABLE IF EXISTS mcp_servers`);
    await db.execute(sql`DROP TABLE IF EXISTS board_objects`);
    await db.execute(sql`DROP TABLE IF EXISTS messages`);
    await db.execute(sql`DROP TABLE IF EXISTS tasks`);
    await db.execute(sql`DROP TABLE IF EXISTS sessions`);
    await db.execute(sql`DROP TABLE IF EXISTS worktrees`);
    await db.execute(sql`DROP TABLE IF EXISTS boards`);
    await db.execute(sql`DROP TABLE IF EXISTS repos`);
    await db.execute(sql`DROP TABLE IF EXISTS users`);
  }

  console.log('Tables dropped');
}

async function main() {
  try {
    const options = await parseArgs();
    const dbPath = options.path ?? DEFAULT_DB_PATH;

    console.log(`Setting up database at: ${dbPath}`);
    console.log('');

    // Create database connection
    const db = createDatabase({ url: dbPath });

    // Reset if requested
    if (options.reset) {
      await dropTables(db);
      console.log('');
    }

    // Initialize schema
    await initializeDatabase(db);
    console.log('');

    // Seed initial data
    await seedInitialData(db);
    console.log('');

    console.log('✅ Database setup complete!');
    console.log('');
    console.log('Next steps:');
    console.log('  - Run `npm run db:studio` to open Drizzle Studio');
    console.log('  - Import repositories from @agor/core/db');
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('❌ Setup failed:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('');
      console.error('Stack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
