import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { pendingOfflineCutoverMigrations } from './migrate';

describe('Postgres migrations', () => {
  it('requires the Knowledge claim protocol migration to be an offline existing-db cutover', () => {
    expect(
      pendingOfflineCutoverMigrations({
        applied: ['0073_task_runtime_reconciliation'],
        pending: ['0074_knowledge_embedding_claims'],
      })
    ).toEqual(['0074_knowledge_embedding_claims']);
    expect(
      pendingOfflineCutoverMigrations({
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0074_knowledge_embedding_claims'],
      })
    ).toEqual([]);
  });

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

  it('persists only an executor bearer fingerprint behind forced tenant RLS', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0075_executor_session_token_authority.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"token_fingerprint" varchar(64) PRIMARY KEY NOT NULL');
    expect(migration).not.toMatch(/"(?:raw_)?token"\s/);
    expect(migration).toContain(
      'ALTER TABLE "executor_session_token_authorities" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain('"tenant_id" = COALESCE');
  });
});

describe('Executor session token authority migrations', () => {
  it('keeps the SQLite schema compatible without enabling shared authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-token-authority-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0078_executor_session_token_authority.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(executor_session_token_authorities)');
      const columnNames = columns.rows.map((column) => column.name);

      expect(columnNames).toContain('token_fingerprint');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('token');
      expect(columnNames).not.toContain('raw_token');
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('SDK session storage retirement migrations', () => {
  it('discards SQLite snapshot payloads while preserving task data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-session-storage-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      await client.execute(`
        CREATE TABLE tasks (
          task_id text PRIMARY KEY NOT NULL,
          session_md5 text,
          data text NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE serialized_sessions (
          id text PRIMARY KEY NOT NULL,
          payload blob
        )
      `);
      await client.execute(
        `INSERT INTO tasks (task_id, session_md5, data)
         VALUES ('task-1', 'legacy-hash', '{"preserved":true}')`
      );
      await client.execute(
        `INSERT INTO serialized_sessions (id, payload)
         VALUES ('snapshot-1', X'1F8B0800')`
      );

      const migration = await readFile(
        new URL('../../drizzle/sqlite/0072_drop_serialized_sessions.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const legacyTable = await client.execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'serialized_sessions'`
      );
      const taskColumns = await client.execute('PRAGMA table_info(tasks)');
      const task = await client.execute('SELECT task_id, data FROM tasks');

      expect(legacyTable.rows).toHaveLength(0);
      expect(taskColumns.rows.map((column) => column.name)).not.toContain('session_md5');
      expect(task.rows).toEqual([{ task_id: 'task-1', data: '{"preserved":true}' }]);
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('explicitly drops the legacy table and task hash column in Postgres', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0067_drop_serialized_sessions.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('DROP TABLE "serialized_sessions"');
    expect(migration).toContain('ALTER TABLE "tasks" DROP COLUMN "session_md5"');
    expect(migration).toContain('payloads are intentionally discarded');
  });
});
