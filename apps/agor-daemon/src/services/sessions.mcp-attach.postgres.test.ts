import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  MCPServerRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  sql,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { NotFound } from '@agor/core/feathers';
import type { TenantID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionsService } from './sessions.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

interface EmittedEvent {
  path: string;
  event: string;
  data: unknown;
  tenantId?: string;
}

function appStub(events: EmittedEvent[]): Application {
  const config = { execution: { unix_user_mode: 'simple' } } as AgorConfig;
  return {
    get: (key: string) => (key === 'config' ? config : undefined),
    service: (path: string) => ({
      emit: (
        event: string,
        data: unknown,
        hook?: { params?: { tenant?: { tenant_id?: string } } }
      ) => events.push({ path, event, data, tenantId: hook?.params?.tenant?.tenant_id }),
    }),
  } as unknown as Application;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'SessionsService create-time MCP attachment (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      const [role] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('publishes one tenant-scoped event after commit and rejects a cross-tenant server atomically', async () => {
      const tenantA = `session-mcp-a-${generateId()}` as TenantID;
      const tenantB = `session-mcp-b-${generateId()}` as TenantID;
      const db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'sessions-mcp-attach-postgres-test',
      });
      const owner = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${tenantA}@example.test`,
          name: 'Tenant A session owner',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `session-mcp-${generateId()}`,
          name: 'Tenant A session repo',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/session-mcp.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          repo_id: repo.repo_id,
          name: `session-mcp-${generateId()}`,
          ref: 'main',
          branch_unique_id: Date.now() % 1_000_000_000,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id,
        });
        const server = await new MCPServerRepository(scoped).create({
          name: `tenant-a-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          args: ['tenant-a.js'],
          scope: 'global',
          source: 'user',
          enabled: true,
        });
        return { user, branch, server };
      });
      const foreignServer = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        new MCPServerRepository(scoped).create({
          name: `tenant-b-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          args: ['tenant-b.js'],
          scope: 'global',
          source: 'user',
          enabled: true,
        })
      );
      const events: EmittedEvent[] = [];
      const service = new SessionsService(db, appStub(events));
      const params = {
        _agenticConfigResolved: true,
        tenant: { tenant_id: tenantA, source: 'explicit' },
      } as never;

      const session = await runWithTenantDatabaseScope(db, tenantA, async () => {
        const created = await service.create(
          {
            branch_id: owner.branch.branch_id,
            created_by: owner.user.user_id,
            agentic_tool: 'claude-code',
            status: SessionStatus.IDLE,
            mcpServerIds: [owner.server.mcp_server_id, owner.server.mcp_server_id],
          },
          params
        );
        expect(events).toEqual([]);
        return created;
      });

      expect(events).toEqual([
        {
          path: 'session-mcp-servers',
          event: 'created',
          data: expect.objectContaining({
            session_id: session.session_id,
            mcp_server_id: owner.server.mcp_server_id,
          }),
          tenantId: tenantA,
        },
      ]);

      await expect(
        runWithTenantDatabaseScope(db, tenantA, () =>
          service.create(
            {
              branch_id: owner.branch.branch_id,
              created_by: owner.user.user_id,
              agentic_tool: 'claude-code',
              status: SessionStatus.IDLE,
              mcpServerIds: [foreignServer.mcp_server_id],
            },
            params
          )
        )
      ).rejects.toMatchObject({ name: NotFound.name, code: 404 });

      const state = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => ({
        sessions: await new SessionRepository(scoped).findAll(),
        attached: await new SessionMCPServerRepository(scoped).listServers(session.session_id),
      }));
      expect(state.sessions.map((item) => item.session_id)).toEqual([session.session_id]);
      expect(state.attached.map((server) => server.mcp_server_id)).toEqual([
        owner.server.mcp_server_id,
      ]);
      expect(events).toHaveLength(1);
    }, 30_000);
  }
);
