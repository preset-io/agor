/**
 * Real 0095 -> 0096 upgrade proof under the same non-superuser/NOBYPASSRLS
 * contract as the PostgreSQL integration runner.
 *
 * Run through the root PostgreSQL integration lane; the canonical runner gives
 * every PostgreSQL suite its own temporary database.
 */

import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, insert, isPostgresDatabase } from './database-wrapper';
import { runMigrations } from './migrate';
import * as pg from './schema.postgres';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

interface Fixture {
  tenantId: string;
  userId: string;
  repairedServerId: string;
  cleanServerId: string;
  remoteServerId: string;
  repairedAttemptId: string;
  cleanAttemptId: string;
  remoteAttemptId: string;
  hashPrefix: string;
}

const FIXTURES: Fixture[] = [
  {
    tenantId: 'default',
    userId: '019fdd52-0000-7000-8000-000000000101',
    repairedServerId: '019fdd52-0000-7000-8000-000000000102',
    cleanServerId: '019fdd52-0000-7000-8000-000000000103',
    remoteServerId: '019fdd52-0000-7000-8000-000000000104',
    repairedAttemptId: '019fdd52-0000-7000-8000-000000000105',
    cleanAttemptId: '019fdd52-0000-7000-8000-000000000106',
    remoteAttemptId: '019fdd52-0000-7000-8000-000000000107',
    hashPrefix: 'a',
  },
  {
    tenantId: 'stdio-repair-non-default',
    userId: '019fdd52-0000-7000-8000-000000000201',
    repairedServerId: '019fdd52-0000-7000-8000-000000000202',
    cleanServerId: '019fdd52-0000-7000-8000-000000000203',
    remoteServerId: '019fdd52-0000-7000-8000-000000000204',
    repairedAttemptId: '019fdd52-0000-7000-8000-000000000205',
    cleanAttemptId: '019fdd52-0000-7000-8000-000000000206',
    remoteAttemptId: '019fdd52-0000-7000-8000-000000000207',
    hashPrefix: 'b',
  },
];

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function firstRow(result: unknown): Record<string, unknown> {
  return rowsOf(result)[0] ?? {};
}

async function seedFixture(db: Database, fixture: Fixture): Promise<void> {
  const now = new Date('2026-08-28T12:00:00.000Z');
  const servers = [
    {
      tenant_id: fixture.tenantId,
      mcp_server_id: fixture.repairedServerId,
      name: `legacy-stdio-${fixture.tenantId}`,
      transport: 'stdio' as const,
      scope: 'global' as const,
      enabled: true,
      source: 'user' as const,
      data: {
        command: 'mcp-server-shortcut',
        args: [''],
        env: { SHORTCUT_API_TOKEN: '{{ user.env.SHORTCUT_API_TOKEN }}' },
        auth: { type: 'oauth' },
        url: 'https://unused.example/mcp',
        headers: { 'X-Unused': 'obsolete' },
        config_version: 7,
      },
      created_at: now,
    },
    {
      tenant_id: fixture.tenantId,
      mcp_server_id: fixture.cleanServerId,
      name: `clean-stdio-${fixture.tenantId}`,
      transport: 'stdio' as const,
      scope: 'global' as const,
      enabled: true,
      source: 'user' as const,
      data: { command: 'other-server', config_version: 3 },
      created_at: now,
    },
    {
      tenant_id: fixture.tenantId,
      mcp_server_id: fixture.remoteServerId,
      name: `remote-${fixture.tenantId}`,
      transport: 'http' as const,
      scope: 'global' as const,
      enabled: true,
      source: 'user' as const,
      data: {
        url: 'https://mcp.example.test/mcp',
        headers: { 'X-Key': 'kept' },
        auth: { type: 'oauth' },
        config_version: 11,
      },
      created_at: now,
    },
  ];

  await runWithTenantDatabaseScope(db, fixture.tenantId, async (scoped) => {
    await insert(scoped, pg.users)
      .values({
        tenant_id: fixture.tenantId,
        user_id: fixture.userId,
        created_at: now,
        email: `stdio-repair-${fixture.tenantId}@example.invalid`,
        password: 'not-a-real-password-hash',
        role: 'member',
        onboarding_completed: true,
        must_change_password: false,
        credential_generation: 0,
        data: {},
      })
      .run();
    await insert(scoped, pg.mcpServers).values(servers).run();

    for (const server of servers) {
      await insert(scoped, pg.userMcpOauthTokens)
        .values({
          tenant_id: fixture.tenantId,
          user_id: fixture.userId,
          mcp_server_id: server.mcp_server_id,
          oauth_access_token: `sealed-test-grant-${server.mcp_server_id}`,
          created_at: now,
        })
        .run();
    }

    const flowServerIds = [
      [fixture.repairedAttemptId, fixture.repairedServerId, '1'],
      [fixture.cleanAttemptId, fixture.cleanServerId, '2'],
      [fixture.remoteAttemptId, fixture.remoteServerId, '3'],
    ] as const;
    for (const [attemptId, serverId, hashSuffix] of flowServerIds) {
      await insert(scoped, pg.mcpOauthPendingFlows)
        .values({
          tenant_id: fixture.tenantId,
          attempt_id: attemptId,
          state_hash: `${fixture.hashPrefix}${hashSuffix}`.padEnd(64, fixture.hashPrefix),
          user_id: fixture.userId,
          mcp_server_id: serverId,
          oauth_mode: 'per_user',
          subject_user_id: fixture.userId,
          grant_generation: 1,
          config_fingerprint_version: 1,
          config_fingerprint: fixture.hashPrefix.repeat(64),
          envelope_version: 1,
          is_current: true,
          status: 'pending',
          sealed_material: `sealed-test-flow-${serverId}`,
          created_at: now,
          updated_at: now,
          expires_at: new Date(now.getTime() + 60_000),
        })
        .run();
    }
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP stdio 0095 -> 0096 repair migration (PostgreSQL)',
  () => {
    let db: Database | null = null;
    let pre0096Folder: string | null = null;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');

      const role = firstRow(
        await executeRaw(
          db,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);

      pre0096Folder = await mkdtemp(join(tmpdir(), 'agor-pg-migrations-through-0095-'));
      await cp(migrationsFolder, pre0096Folder, { recursive: true });
      await unlink(join(pre0096Folder, '0096_strip_stdio_remote_fields.sql'));
      const journalPath = join(pre0096Folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number }>;
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 95);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

      await migratePostgres(db as never, { migrationsFolder: pre0096Folder });
      for (const fixture of FIXTURES) await seedFixture(db, fixture);
    });

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
      if (pre0096Folder) await rm(pre0096Folder, { recursive: true, force: true });
    });

    it('repairs every tenant, removes stdio OAuth state, and preserves remote state', async () => {
      if (!db) throw new Error('PostgreSQL test database was not initialized');

      // This upgrade proof deliberately advances from 0095 through the full
      // current journal, which now includes the coordinated sharing-model
      // cutover. The test database is isolated and has no concurrent daemon.
      await runMigrations(db, { allowOfflineCutover: true });

      for (const fixture of FIXTURES) {
        await runWithTenantDatabaseScope(db, fixture.tenantId, async (scoped) => {
          const serverRows = rowsOf(
            await executeRaw(
              scoped,
              sql`SELECT mcp_server_id, transport, data
                  FROM mcp_servers
                  ORDER BY mcp_server_id`
            )
          );
          const serverById = new Map(serverRows.map((row) => [row.mcp_server_id, row]));
          expect(serverById.get(fixture.repairedServerId)?.data).toEqual({
            command: 'mcp-server-shortcut',
            args: [''],
            env: { SHORTCUT_API_TOKEN: '{{ user.env.SHORTCUT_API_TOKEN }}' },
            config_version: 7,
          });
          expect(serverById.get(fixture.cleanServerId)?.data).toEqual({
            command: 'other-server',
            config_version: 3,
          });
          expect(serverById.get(fixture.remoteServerId)?.data).toEqual({
            url: 'https://mcp.example.test/mcp',
            headers: { 'X-Key': 'kept' },
            auth: { type: 'oauth' },
            config_version: 11,
          });

          const grants = rowsOf(
            await executeRaw(
              scoped,
              sql`SELECT mcp_server_id
                  FROM user_mcp_oauth_tokens
                  ORDER BY mcp_server_id`
            )
          );
          expect(grants.map((row) => row.mcp_server_id)).toEqual([fixture.remoteServerId]);

          const flows = rowsOf(
            await executeRaw(
              scoped,
              sql`SELECT mcp_server_id, sealed_material
                  FROM mcp_oauth_pending_flows
                  ORDER BY mcp_server_id`
            )
          );
          expect(flows).toEqual([
            {
              mcp_server_id: fixture.remoteServerId,
              sealed_material: `sealed-test-flow-${fixture.remoteServerId}`,
            },
          ]);
        });
      }

      const temporaryPolicies = rowsOf(
        await executeRaw(
          db,
          sql`SELECT tablename, policyname
              FROM pg_policies
              WHERE policyname LIKE 'stdio_repair_0096_%'`
        )
      );
      expect(temporaryPolicies).toEqual([]);
    });
  }
);
