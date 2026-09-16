import { createDatabase, runMigrations } from '@agor/core/db';

const db = createDatabase({ dialect: 'sqlite', url: `file:${process.env.HOME}/.agor/agor.db` });
await runMigrations(db as never, { allowOfflineCutover: true });
console.log('migrated');
