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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

      const foreignPrefix = foreignServer.mcp_server_id.replaceAll('-', '').slice(0, 31);
      for (const foreignId of [foreignServer.mcp_server_id, foreignPrefix]) {
        await expect(
          runWithTenantDatabaseScope(db, tenantA, () =>
            service.create(
              {
                branch_id: owner.branch.branch_id,
                created_by: owner.user.user_id,
                agentic_tool: 'claude-code',
                status: SessionStatus.IDLE,
                mcpServerIds: [foreignId],
              },
              params
            )
          )
        ).rejects.toMatchObject({ name: NotFound.name, code: 404 });
      }

      const state = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => ({
        sessions: await new SessionRepository(scoped).findAll(),
        attached: await new SessionMCPServerRepository(scoped).listServers(session.session_id),
      }));
      expect(state.sessions.map((item) => item.session_id)).toEqual([session.session_id]);
      expect(state.attached.map((server) => server.mcp_server_id)).toEqual([
        owner.server.mcp_server_id,
      ]);
      expect(events).toHaveLength(1);

      // Foreign-tenant and genuinely deleted default IDs have the same public
      // outcome. Never consult an unscoped inventory to distinguish the two.
      const input = {
        branch_id: owner.branch.branch_id,
        created_by: owner.user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
      } as const;
      for (const unavailable of [foreignServer.mcp_server_id, foreignPrefix, generateId()]) {
        const inherited = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          await new BranchRepository(scoped).update(owner.branch.branch_id, {
            mcp_server_ids: [owner.server.mcp_server_id, unavailable],
          });
          return service.create(input, params);
        });
        expect(inherited.mcp_defaults_skipped).toBe(1);
        expect(Object.getOwnPropertyDescriptor(inherited, 'tenant_id')).toMatchObject({
          value: tenantA,
          enumerable: false,
        });
        expect(JSON.parse(JSON.stringify(inherited))).not.toHaveProperty('tenant_id');
        expect(
          await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
            new SessionMCPServerRepository(scoped).listServers(inherited.session_id)
          )
        ).toMatchObject([{ mcp_server_id: owner.server.mcp_server_id }]);
      }
      expect(
        await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
          new MCPServerRepository(scoped).findById(foreignServer.mcp_server_id)
        )
      ).not.toBeNull();

      // Mixed spellings used to sort in opposite canonical orders. Hold the
      // first creator after its first row lock, then prove the second is waiting
      // in PostgreSQL before it can attach anything. Record every acquisition,
      // including alias deduplication; mere absence of a deadlock is not proof.
      const secondServer = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new MCPServerRepository(scoped).create({
          name: `ordered-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          scope: 'session',
          source: 'user',
          enabled: true,
        })
      );
      const orderedIds = [owner.server.mcp_server_id, secondServer.mcp_server_id].sort();
      const prefix = (id: string) => id.replaceAll('-', '').slice(0, 31);
      const selections = [
        [orderedIds[0], prefix(orderedIds[1]), orderedIds[1]],
        [prefix(orderedIds[0]), orderedIds[1], prefix(orderedIds[1])],
      ];
      // This fixture must reproduce the lexical inversion, not rely on UUID luck.
      expect([prefix(orderedIds[0]), orderedIds[1]].sort()[0]).toBe(orderedIds[1]);
      let firstLocked!: () => void;
      let releaseFirst!: () => void;
      const locked = new Promise<void>((resolve) => {
        firstLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const acquisitions = new Map<string, string[]>();
      const addServer = SessionMCPServerRepository.prototype.addServer;
      const attachmentGate = vi
        .spyOn(SessionMCPServerRepository.prototype, 'addServer')
        .mockImplementation(async function (
          this: SessionMCPServerRepository,
          sessionId,
          serverId,
          ...rest
        ) {
          const acquired = acquisitions.get(sessionId) ?? [];
          acquired.push(serverId);
          acquisitions.set(sessionId, acquired);
          if (acquisitions.size === 1 && acquired.length === 1) {
            firstLocked();
            await release;
          }
          return addServer.call(this, sessionId, serverId, ...rest);
        });
      const firstCreate = runWithTenantDatabaseScope(db, tenantA, () =>
        service.create({ ...input, mcpServerIds: selections[0] }, params)
      );
      let secondCreate: typeof firstCreate | undefined;
      let secondPid: number | undefined;
      try {
        await locked;
        expect([...acquisitions.values()]).toEqual([[orderedIds[0]]]);
        secondCreate = runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          const [connection] = rowsOf(
            await executeRaw(scoped, sql`SELECT pg_backend_pid() AS pid`)
          );
          secondPid = Number(connection.pid);
          return service.create({ ...input, mcpServerIds: selections[1] }, params);
        });
        await vi.waitFor(async () => {
          expect(secondPid).toBeDefined();
          const [locks] = rowsOf(
            await executeRaw(
              rawDb,
              sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid = ${secondPid} AND NOT granted) AS waiting`
            )
          );
          expect(locks.waiting).toBe(true);
        });
        expect([...acquisitions.values()]).toEqual([[orderedIds[0]]]);
      } finally {
        releaseFirst();
        await Promise.all([firstCreate, secondCreate]);
        attachmentGate.mockRestore();
      }
      expect([...acquisitions.values()]).toEqual([orderedIds, orderedIds]);
      for (const created of await Promise.all([firstCreate, secondCreate!])) {
        expect(created.mcp_defaults_skipped).toBeUndefined();
        expect(
          events.filter(
            (event) => (event.data as { session_id?: string }).session_id === created.session_id
          )
        ).toHaveLength(2);
      }

      // Pause only scheduling, not data/authority: a real second transaction
      // deletes after default resolution but before the attachment row lock.
      const doomed = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const server = await new MCPServerRepository(scoped).create({
          name: `race-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          scope: 'session',
          source: 'user',
          enabled: true,
        });
        await new BranchRepository(scoped).update(owner.branch.branch_id, {
          mcp_server_ids: [
            owner.server.mcp_server_id,
            prefix(server.mcp_server_id),
            server.mcp_server_id,
          ],
        });
        return server;
      });
      let signalReached!: () => void;
      let signalResume!: () => void;
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        signalResume = resolve;
      });
      const original = MCPServerRepository.prototype.resolveCanonicalId;
      const gate = vi
        .spyOn(MCPServerRepository.prototype, 'resolveCanonicalId')
        .mockImplementation(async function (this: MCPServerRepository, id: string) {
          const canonical = await original.call(this, id);
          if (id === doomed.mcp_server_id) {
            signalReached();
            await resume;
          }
          return canonical;
        });
      const creating = runWithTenantDatabaseScope(db, tenantA, () => service.create(input, params));
      try {
        await reached;
        await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          new MCPServerRepository(scoped).delete(doomed.mcp_server_id)
        );
      } finally {
        signalResume();
        gate.mockRestore();
      }
      const raced = await creating;
      expect(raced.mcp_defaults_skipped).toBe(2);
      expect(
        await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          new SessionMCPServerRepository(scoped).listServers(raced.session_id)
        )
      ).toMatchObject([{ mcp_server_id: owner.server.mcp_server_id }]);

      // Opposite ordering: once authorization has read a server, delete must
      // wait rather than winning between that read and the FK insert. Observe
      // the actual PostgreSQL wait, not a timing-based "hasn't finished yet".
      const lockedServer = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const server = await new MCPServerRepository(scoped).create({
          name: `locked-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          scope: 'session',
          source: 'user',
          enabled: true,
        });
        await new BranchRepository(scoped).update(owner.branch.branch_id, {
          mcp_server_ids: [
            owner.server.mcp_server_id,
            prefix(server.mcp_server_id),
            server.mcp_server_id,
          ],
        });
        return server;
      });
      let signalRead!: () => void;
      let resumeRead!: () => void;
      const readReached = new Promise<void>((resolve) => {
        signalRead = resolve;
      });
      const readResume = new Promise<void>((resolve) => {
        resumeRead = resolve;
      });
      const findById = MCPServerRepository.prototype.findById;
      const readGate = vi
        .spyOn(MCPServerRepository.prototype, 'findById')
        .mockImplementation(async function (this: MCPServerRepository, id: string) {
          const found = await findById.call(this, id);
          if (id === lockedServer.mcp_server_id) {
            signalRead();
            await readResume;
          }
          return found;
        });
      const lockWinner = runWithTenantDatabaseScope(db, tenantA, () =>
        service.create(input, params)
      );
      let deleting: Promise<void> | undefined;
      let deletePid: number | undefined;
      try {
        await readReached;
        deleting = runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          const [connection] = rowsOf(
            await executeRaw(scoped, sql`SELECT pg_backend_pid() AS pid`)
          );
          deletePid = Number(connection.pid);
          await new MCPServerRepository(scoped).delete(lockedServer.mcp_server_id);
        });
        await vi.waitFor(async () => {
          expect(deletePid).toBeDefined();
          // Test-only connection observability; no tenant rows are read unscoped.
          const [locks] = rowsOf(
            await executeRaw(
              rawDb,
              sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid = ${deletePid} AND NOT granted) AS waiting`
            )
          );
          expect(locks.waiting).toBe(true);
        });
      } finally {
        resumeRead();
        readGate.mockRestore();
        await Promise.all([lockWinner, deleting]);
      }
      const committed = await lockWinner;
      expect(committed.mcp_defaults_skipped).toBeUndefined();
      expect(
        await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          new SessionRepository(scoped).findById(committed.session_id)
        )
      ).not.toBeNull();
      // Deletion happens after admission and cascades only that attachment.
      expect(
        await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          new SessionMCPServerRepository(scoped).listServers(committed.session_id)
        )
      ).toMatchObject([{ mcp_server_id: owner.server.mcp_server_id }]);
    }, 30_000);
  }
);
