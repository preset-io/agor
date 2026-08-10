import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { pendingOfflineCutoverMigrations } from './migrate';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

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

  it('enforces the structurally incompatible MCP OAuth migration as an offline cutover', () => {
    expect(
      pendingOfflineCutoverMigrations({
        applied: ['0076_executor_session_token_session_binding'],
        pending: ['0078_mcp_oauth_pending_flows'],
      })
    ).toEqual(['0078_mcp_oauth_pending_flows']);
    expect(
      pendingOfflineCutoverMigrations({
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0078_mcp_oauth_pending_flows'],
      })
    ).toEqual([]);
  });

  it('enforces the GitHub callback authority migration as an offline cutover', () => {
    expect(
      pendingOfflineCutoverMigrations({
        applied: ['0078_mcp_oauth_pending_flows'],
        pending: ['0082_github_install_state'],
      })
    ).toEqual(['0082_github_install_state']);
    expect(
      pendingOfflineCutoverMigrations({
        applied: [],
        pending: ['0000_pretty_mac_gargan', '0082_github_install_state'],
      })
    ).toEqual([]);
  });

  it('assigns GitHub install state unique post-HA migration watermarks', async () => {
    const [postgresJournal, sqliteJournal] = await Promise.all(
      [
        new URL('../../drizzle/postgres/meta/_journal.json', import.meta.url),
        new URL('../../drizzle/sqlite/meta/_journal.json', import.meta.url),
      ].map(async (url) => JSON.parse(await readFile(url, 'utf8')) as { entries: JournalEntry[] })
    );

    for (const [journal, expectedTag, expectedIndex] of [
      [postgresJournal, '0082_github_install_state', 82],
      [sqliteJournal, '0085_github_install_state', 85],
    ] as const) {
      const entry = journal.entries.at(-1);
      const predecessor = journal.entries.at(-2);
      expect(entry).toMatchObject({ idx: expectedIndex, tag: expectedTag });
      expect(entry?.when).toBeGreaterThan(predecessor?.when ?? 0);
    }
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

  it('stores MCP OAuth pending flow capabilities without raw codes or tokens', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0078_mcp_oauth_pending_flows.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"state_hash" varchar(64) NOT NULL');
    expect(migration).toContain('"sealed_material" text');
    expect(migration).not.toMatch(/"(?:raw_)?state"\s/);
    expect(migration).not.toMatch(/"(?:authorization_)?code"\s/);
    expect(migration).not.toMatch(/"(?:access|refresh|bearer)_token"\s/);
    expect(migration).toContain('ALTER TABLE "mcp_oauth_pending_flows" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration).toContain("COALESCE(current_setting('agor.system_scope', true), '') = ''");
    expect(migration).toContain("= 'mcp_oauth_callback'");
    expect(migration).toContain('"state_hash" = current_setting(\'agor.oauth_state_hash\', true)');
    expect(migration).toContain("= 'mcp_oauth_maintenance'");
    expect(migration).toContain('DELETE FROM "user_mcp_oauth_tokens"');
    expect(migration).toContain('"grant_binding_fingerprint" varchar(64)');
    expect(migration).toContain('"refresh_generation" bigint');
    expect(migration).toContain('"refresh_success_generation" bigint');
    expect(migration).toContain('"oauth_metadata_uri" text');
    expect(migration).toContain('"user_mcp_oauth_tokens_tenant_user_fk"');
    expect(migration).toContain('"user_mcp_oauth_tokens_tenant_server_fk"');
    expect(migration).toContain('"mcp_oauth_pending_flows_current_user_grant_uq"');
    expect(migration).toContain('"mcp_oauth_pending_flows_current_shared_grant_uq"');
    expect(migration).not.toMatch(/CHECK\s*\([^)]*"status"/i);
    expect(migration).not.toMatch(/CHECK\s*\([^)]*"oauth_mode"/i);
  });

  it('persists only a GitHub install state hash behind forced tenant RLS', async () => {
    const migration = await readFile(
      new URL('../../drizzle/postgres/0082_github_install_state.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('"state_hash" varchar(64) PRIMARY KEY NOT NULL');
    expect(migration).toContain('"tenant_id" text');
    expect(migration).toContain('"user_id" varchar(36) NOT NULL');
    expect(migration).toContain('"intent" text NOT NULL');
    expect(migration).toContain('ALTER TABLE "github_install_states" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain(
      "\"tenant_id\" = NULLIF(current_setting('agor.tenant_id', true), '')"
    );
    expect(migration).not.toContain("COALESCE(NULLIF(current_setting('agor.tenant_id'");
    expect(migration).not.toContain('"tenant_id" text DEFAULT');
    expect(migration).toContain(
      'CREATE INDEX "github_install_states_expires_idx"\n\tON "github_install_states" ("expires_at")'
    );
    expect(migration).not.toMatch(/["`]state["`]\s/);
    expect(migration).not.toContain('raw_state');
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

describe('MCP OAuth pending-flow migrations', () => {
  it('keeps SQLite schema-compatible while standalone flow authority stays local', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-mcp-oauth-flow-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0081_mcp_oauth_pending_flows.sql', import.meta.url),
        'utf8'
      );
      await client.execute('PRAGMA foreign_keys = OFF');
      await client.execute(`
        CREATE TABLE user_mcp_oauth_tokens (
          user_id text,
          mcp_server_id text NOT NULL,
          oauth_access_token text NOT NULL,
          oauth_token_expires_at integer,
          oauth_refresh_token text,
          oauth_client_id text,
          oauth_client_secret text,
          created_at integer NOT NULL,
          updated_at integer
        )
      `);
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(mcp_oauth_pending_flows)');
      const columnNames = columns.rows.map((column) => column.name);
      expect(columnNames).toContain('state_hash');
      expect(columnNames).toContain('sealed_material');
      expect(columnNames).toContain('grant_generation');
      expect(columnNames).toContain('config_fingerprint');
      expect(columnNames).toContain('is_current');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('state');
      expect(columnNames).not.toContain('code');
      expect(columnNames).not.toContain('access_token');
      expect(columnNames).not.toContain('refresh_token');

      const tokenColumns = await client.execute('PRAGMA table_info(user_mcp_oauth_tokens)');
      const tokenColumnNames = tokenColumns.rows.map((column) => column.name);
      expect(tokenColumnNames).toContain('grant_binding_fingerprint');
      expect(tokenColumnNames).toContain('oauth_metadata_uri');
      expect(tokenColumnNames).toContain('refresh_generation');
      expect(tokenColumnNames).toContain('refresh_success_generation');

      const tableSql = await client.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_oauth_pending_flows'"
      );
      expect(String(tableSql.rows[0]?.sql)).not.toMatch(/CHECK\s*\(/i);
    } finally {
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('GitHub install state migrations', () => {
  it('keeps standalone SQLite schema-compatible without a raw state column', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-github-state-migration-'));
    const client = createClient({ url: `file:${join(directory, 'migration.db')}` });

    try {
      const migration = await readFile(
        new URL('../../drizzle/sqlite/0085_github_install_state.sql', import.meta.url),
        'utf8'
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.execute(statement);
      }

      const columns = await client.execute('PRAGMA table_info(github_install_states)');
      const columnNames = columns.rows.map((column) => column.name);
      expect(columnNames).toContain('state_hash');
      expect(columnNames).not.toContain('tenant_id');
      expect(columnNames).not.toContain('state');
      expect(columnNames).not.toContain('raw_state');
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
