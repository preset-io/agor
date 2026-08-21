import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  enqueueAfterTenantDatabaseCommit,
  generateId,
  initializeDatabase,
  MCPServerRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionEnvSelectionRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { MCPServerID, SessionID, Task, TenantID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionEnvSelectionsService } from './session-env-selections.js';
import { runSessionInitializationStages } from './session-initialization.js';
import { SessionMCPServersService } from './session-mcp-servers.js';

const cleanupDirectories: string[] = [];
let branchUnique = (Date.now() % 1_000_000) + 7_000_000;

afterEach(() => {
  while (cleanupDirectories.length > 0) {
    rmSync(cleanupDirectories.pop()!, { recursive: true, force: true });
  }
});

async function createSqliteHarness() {
  // LibSQL transactions use a second connection, so use a temporary file
  // rather than connection-local :memory: storage.
  const directory = mkdtempSync(join(tmpdir(), 'agor-session-initialization-'));
  cleanupDirectories.push(directory);
  const rawDb = createDatabase({ url: `file:${join(directory, 'test.db')}` });
  await initializeDatabase(rawDb);
  const db = createTenantScopedDatabaseProxy(rawDb, {
    requireScope: true,
    label: 'session-initialization-sqlite-test',
  });
  const tenantId = `session-initialization-${generateId()}` as TenantID;

  const seeded = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}@example.test`,
      name: 'Session initialization test',
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
    await new SessionEnvSelectionRepository(scoped).setAll(session.session_id, ['ORIGINAL_ENV']);
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

  return { db, tenantId, seeded, mcpService, envService, readState };
}

describe('runSessionInitializationStages (SQLite)', () => {
  it('rolls back an MCP replacement when the later environment stage fails', async () => {
    const { db, tenantId, seeded, mcpService, envService, readState } = await createSqliteHarness();
    const events: string[] = [];
    const admitPrompt = vi.fn();

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
          expect(enqueueAfterTenantDatabaseCommit(() => events.push('mcp-event'))).toBe(true);
        },
        publishEnvVarNamesChanged: () => {
          expect(enqueueAfterTenantDatabaseCommit(() => events.push('env-event'))).toBe(true);
        },
        admitPrompt,
      })
    ).rejects.toThrow('forced environment failure');

    expect(await readState()).toEqual({
      serverIds: [seeded.originalServer.mcp_server_id],
      envVarNames: ['ORIGINAL_ENV'],
    });
    expect(events).toEqual([]);
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('publishes after commit and admits the prompt only after configuration is durable', async () => {
    const { db, tenantId, seeded, mcpService, envService, readState } = await createSqliteHarness();
    const stages: string[] = [];
    const admittedTask = { task_id: generateId(), status: TaskStatus.PENDING } as Task;

    const result = await runSessionInitializationStages({
      db,
      tenantId,
      mcpServerIds: [seeded.replacementServer.mcp_server_id as MCPServerID],
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
  });
});
