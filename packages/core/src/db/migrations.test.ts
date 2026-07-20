import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Postgres migrations', () => {
  it('keeps Knowledge pgvector storage out of required base migrations', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0043_kb_embeddings.sql', import.meta.url),
      'utf8'
    );

    expect(migration).not.toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector/i);
    expect(migration).not.toContain('kb_unit_embeddings');
    expect(migration).not.toMatch(/\bembedding\s+vector\b/i);
    expect(migration).toContain('kb_embedding_spaces');
  });

  it('stores executor connection timestamps as UTC-safe instants', async () => {
    const [connectionMigration, heartbeatMigration] = await Promise.all([
      readFile(
        new URL('../../drizzle/postgres/0064_task_dispatching.sql', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../../drizzle/postgres/0065_executor_heartbeat_timezone.sql', import.meta.url),
        'utf8'
      ),
    ]);

    expect(connectionMigration).toMatch(
      /ADD COLUMN "executor_connected_at" timestamp with time zone/i
    );
    expect(heartbeatMigration).toMatch(
      /ALTER COLUMN "last_executor_heartbeat_at" TYPE timestamp with time zone/i
    );
    expect(heartbeatMigration).toMatch(/AT TIME ZONE 'UTC'/i);
  });
});
