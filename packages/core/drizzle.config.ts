import { defineConfig } from 'drizzle-kit';
import { expandPath } from './dist/utils/path.js';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: expandPath(process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db'),
  },
});
