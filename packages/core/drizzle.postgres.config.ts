/**
 * Drizzle Config for PostgreSQL
 *
 * Generates migrations for PostgreSQL in ./drizzle/postgres/ folder.
 * Points to schema.postgres.ts which uses pgTable and native PostgreSQL types.
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.postgres.ts',
  out: './drizzle/postgres',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://agor:secret@localhost:5432/agor',
  },
});
