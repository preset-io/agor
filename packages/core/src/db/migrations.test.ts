import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';

describe('Postgres migrations', () => {
  it('adds durable task runtime ownership after the artifact consent migration', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0071_task_runtime_ownership.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"runtime_owner_daemon_id" varchar(36)');
    expect(migration).toContain('"runtime_owner_fence" varchar(36)');
    expect(migration).toContain('"runtime_lease_expires_at" timestamp with time zone');
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
});

describe('Task runtime ownership migrations', () => {
  it('upgrades an existing SQLite tasks table without changing existing rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-runtime-owner-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      await client.execute(`CREATE TABLE tasks (task_id text PRIMARY KEY NOT NULL, data text)`);
      await client.execute(`INSERT INTO tasks (task_id, data) VALUES ('legacy-task', '{}')`);
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0075_task_runtime_ownership.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(tasks)');
      expect(columns.rows.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'runtime_owner_daemon_id',
          'runtime_owner_fence',
          'runtime_lease_expires_at',
        ])
      );
      expect(await client.execute('SELECT * FROM tasks')).toMatchObject({
        rows: [
          {
            task_id: 'legacy-task',
            data: '{}',
            runtime_owner_daemon_id: null,
            runtime_owner_fence: null,
            runtime_lease_expires_at: null,
          },
        ],
      });
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
