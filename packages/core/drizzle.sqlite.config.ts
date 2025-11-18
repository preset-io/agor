/**
 * Drizzle Config for SQLite
 *
 * Generates migrations for SQLite in ./drizzle/sqlite/ folder.
 * Points to schema.sqlite.ts which uses sqliteTable and integer-based types.
 */

import { defineConfig } from 'drizzle-kit';
import { expandPath } from './dist/utils/path.js';

export default defineConfig({
  schema: './src/db/schema.sqlite.ts',
  out: './drizzle/sqlite',
  dialect: 'sqlite',
  dbCredentials: {
    url: expandPath(process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db'),
  },
});
