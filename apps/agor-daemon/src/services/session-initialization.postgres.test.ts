import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  enqueueAfterTenantDatabaseCommit,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  MCPServerRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionEnvSelectionRepository,
  SessionMCPServerRepository,
  SessionRepository,
  sql,
  UsersRepository,
} from '@agor/core/db';
import type { SessionID, Task, TenantID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionEnvSelectionsService } from './session-env-selections.js';
import { runSessionInitializationStages } from './session-initialization.js';
import { SessionMCPServersService } from './session-mcp-servers.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = (Date.now() % 1_000_000) + 8_000_000;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'runSessionInitializationStages (PostgreSQL/RLS)',
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

    it('rolls back configuration and publishes only after a successful commit', async () => {
      const tenantId = `session-initialization-${generateId()}` as TenantID;
      const db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'session-initialization-postgres-test',
      });
      const seeded = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${tenantId}@example.test`,
          name: 'PostgreSQL session initialization test',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: tenantId,
          name: tenantId,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/session-initialization.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: tenantId,
          ref: 'main',
          branch_unique_id: branchUnique++,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId() as SessionID,
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'codex',
          status: SessionStatus.IDLE,
          ready_for_prompt: true,
        });
        const servers = new MCPServerRepository(scoped);
        const originalServer = await servers.create({
          name: `original-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          args: ['original.js'],
          scope: 'global',
          source: 'user',
          enabled: true,
        });
        const replacementServer = await servers.create({
          name: `replacement-${generateId()}`,
          transport: 'stdio',
          command: 'node',
          args: ['replacement.js'],
          scope: 'global',
          source: 'user',
          enabled: true,
        });
        await new SessionMCPServerRepository(scoped).setServers(session.session_id, [
          originalServer.mcp_server_id,
        ]);
        await new SessionEnvSelectionRepository(scoped).setAll(session.session_id, [
          'ORIGINAL_ENV',
        ]);
        return { session, originalServer, replacementServer };
      });

      const mcpService = new SessionMCPServersService(db);
      const envService = new SessionEnvSelectionsService(db);
      const readState = () =>
        runWithTenantDatabaseScope(db, tenantId, async (scoped) => ({
          serverIds: (
            await new SessionMCPServerRepository(scoped).listServers(seeded.session.session_id)
          ).map((server) => server.mcp_server_id),
          envVarNames: await new SessionEnvSelectionRepository(scoped).listNames(
            seeded.session.session_id
          ),
        }));
      const rolledBackEvents: string[] = [];
      const admitAfterFailure = vi.fn();

      await expect(
        runSessionInitializationStages({
          db,
          tenantId,
          mcpServerIds: [seeded.replacementServer.mcp_server_id],
          envVarNames: ['REPLACEMENT_ENV'],
          setMcpServers: (ids) => mcpService.setServers(seeded.session.session_id, ids),
          setEnvVarNames: async (names) => {
            await envService.setAll(seeded.session.session_id, names);
            throw new Error('forced environment failure');
          },
          publishMcpServersChanged: () => {
            expect(enqueueAfterTenantDatabaseCommit(() => rolledBackEvents.push('mcp-event'))).toBe(
              true
            );
          },
          publishEnvVarNamesChanged: () => {
            expect(enqueueAfterTenantDatabaseCommit(() => rolledBackEvents.push('env-event'))).toBe(
              true
            );
          },
          admitPrompt: admitAfterFailure,
        })
      ).rejects.toThrow('forced environment failure');

      expect(await readState()).toEqual({
        serverIds: [seeded.originalServer.mcp_server_id],
        envVarNames: ['ORIGINAL_ENV'],
      });
      expect(rolledBackEvents).toEqual([]);
      expect(admitAfterFailure).not.toHaveBeenCalled();

      const stages: string[] = [];
      const admittedTask = { task_id: generateId(), status: TaskStatus.PENDING } as Task;
      const result = await runSessionInitializationStages({
        db,
        tenantId,
        mcpServerIds: [seeded.replacementServer.mcp_server_id],
        envVarNames: ['REPLACEMENT_ENV'],
        setMcpServers: (ids) => mcpService.setServers(seeded.session.session_id, ids),
        setEnvVarNames: (names) => envService.setAll(seeded.session.session_id, names),
        publishMcpServersChanged: () => {
          expect(enqueueAfterTenantDatabaseCommit(() => stages.push('mcp-event'))).toBe(true);
        },
        publishEnvVarNamesChanged: () => {
          expect(enqueueAfterTenantDatabaseCommit(() => stages.push('env-event'))).toBe(true);
        },
        admitPrompt: async () => {
          expect(await readState()).toEqual({
            serverIds: [seeded.replacementServer.mcp_server_id],
            envVarNames: ['REPLACEMENT_ENV'],
          });
          stages.push('prompt');
          return admittedTask;
        },
      });

      expect(result).toBe(admittedTask);
      expect(stages).toEqual(['mcp-event', 'env-event', 'prompt']);
    }, 30_000);
  }
);
